const { createHash } = require('crypto');

const KEY_ID  = '003ec0649a89f090000000001';
const APP_KEY = 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4';
const BUCKET  = 'melo-music-2026';
const META    = 'melo-metadata.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function b2Auth() {
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64') }
  });
  if (!r.ok) throw new Error('Auth B2 failed: ' + r.status);
  return r.json();
}

async function getBucketId(a) {
  if (a.allowed?.bucketId) return a.allowed.bucketId;
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: a.accountId, bucketName: BUCKET })
  });
  const d = await r.json();
  if (!d.buckets?.length) throw new Error('Bucket "' + BUCKET + '" introuvable');
  return d.buckets[0].bucketId;
}

async function fixCors(a, bid) {
  await fetch(`${a.apiUrl}/b2api/v2/b2_update_bucket`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: a.accountId, bucketId: bid,
      corsRules: [{
        corsRuleName: 'allowAll', allowedOrigins: ['*'], allowedHeaders: ['*'],
        allowedOperations: ['b2_download_file_by_name','b2_download_file_by_id','b2_upload_file','b2_upload_part'],
        exposeHeaders: ['x-bz-upload-timestamp','X-Bz-File-Name','Content-Length'],
        maxAgeSeconds: 3600
      }]
    })
  });
}

async function getUploadUrl(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid })
  });
  return r.json();
}

async function b2UploadBuf(upUrl, upToken, key, buf, contentType) {
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: {
      Authorization: upToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': contentType,
      'X-Bz-Content-Sha1': sha1,
    },
    body: buf,
  });
  if (!r.ok) throw new Error('B2 upload failed: ' + await r.text());
  return r.json();
}

// Lit TOUJOURS la version la plus récente du fichier meta
// en passant par b2_list_file_versions + download by fileId
async function readLatestMeta(a, bid) {
  const listR = await fetch(`${a.apiUrl}/b2api/v2/b2_list_file_versions`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid, startFileName: META, maxFileCount: 10, prefix: META })
  });
  const listData = await listR.json();
  const versions = (listData.files || []).filter(f => f.fileName === META && f.action === 'upload');

  if (!versions.length) {
    return { tracks: [], playlists: [], albums: [], artists: [], lastModified: 0 };
  }

  // B2 retourne les versions de la plus récente à la plus ancienne
  const latest = versions[0];
  const dlR = await fetch(`${a.apiUrl}/b2api/v2/b2_download_file_by_id?fileId=${latest.fileId}`, {
    headers: { Authorization: a.authorizationToken }
  });
  if (!dlR.ok) return { tracks: [], playlists: [], albums: [], artists: [], lastModified: 0 };

  const parsed = await dlR.json();
  if (Array.isArray(parsed)) {
    return { tracks: parsed, playlists: [], albums: [], artists: [], lastModified: 0 };
  }
  return {
    tracks:       Array.isArray(parsed.tracks)    ? parsed.tracks    : [],
    playlists:    Array.isArray(parsed.playlists)  ? parsed.playlists : [],
    albums:       Array.isArray(parsed.albums)     ? parsed.albums    : [],
    artists:      Array.isArray(parsed.artists)    ? parsed.artists   : [],
    lastModified: parsed.lastModified || 0,
  };
}

// Supprime les anciennes versions du meta après chaque save
async function deleteOldMetaVersions(a, bid, keepFileId) {
  try {
    const listR = await fetch(`${a.apiUrl}/b2api/v2/b2_list_file_versions`, {
      method: 'POST',
      headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketId: bid, startFileName: META, maxFileCount: 50, prefix: META })
    });
    const listData = await listR.json();
    const old = (listData.files || []).filter(f => f.fileName === META && f.fileId !== keepFileId);
    await Promise.all(old.map(f =>
      fetch(`${a.apiUrl}/b2api/v2/b2_delete_file_version`, {
        method: 'POST',
        headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: META, fileId: f.fileId })
      }).catch(() => {})
    ));
  } catch (e) {
    console.warn('deleteOldMeta warning:', e.message);
  }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const action = req.query?.action;

  try {
    const a   = await b2Auth();
    const bid = await getBucketId(a);

    if (action === 'init') {
      await fixCors(a, bid);
      const meta = await readLatestMeta(a, bid);
      const dlR = await fetch(`${a.apiUrl}/b2api/v2/b2_get_download_authorization`, {
        method: 'POST',
        headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: bid, fileNamePrefix: '', validDurationInSeconds: 43200 })
      });
      const dlAuth = await dlR.json();
      res.status(200).json({
        tracks: meta.tracks, playlists: meta.playlists,
        albums: meta.albums, artists: meta.artists,
        lastModified: meta.lastModified,
        downloadUrl: a.downloadUrl, downloadToken: dlAuth.authorizationToken,
      });
      return;
    }

    if (action === 'bucket-info') {
      let totalSize = 0, fileCount = 0, nextFileName = null;
      do {
        const body = { bucketId: bid, maxFileCount: 1000 };
        if (nextFileName) body.startFileName = nextFileName;
        const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_file_names`, {
          method: 'POST',
          headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.files) d.files.forEach(f => { totalSize += f.contentLength || 0; fileCount++; });
        nextFileName = d.nextFileName || null;
      } while (nextFileName);
      res.status(200).json({ usedMB: Math.round(totalSize/1024/1024*10)/10, limitMB: 10240, fileCount });
      return;
    }

    if (action === 'upload-creds') {
      const up = await getUploadUrl(a, bid);
      res.status(200).json({ uploadUrl: up.uploadUrl, authorizationToken: up.authorizationToken });
      return;
    }

    if (action === 'save-meta' && req.method === 'POST') {
      const body = req.body;
      const tracks       = Array.isArray(body?.tracks)    ? body.tracks    : (Array.isArray(body) ? body : []);
      const playlists    = Array.isArray(body?.playlists)  ? body.playlists : [];
      const albums       = Array.isArray(body?.albums)     ? body.albums    : [];
      const artists      = Array.isArray(body?.artists)    ? body.artists   : [];
      const lastModified = body?.lastModified || Date.now();
      const buf = Buffer.from(JSON.stringify({ tracks, playlists, albums, artists, lastModified }), 'utf-8');
      const up  = await getUploadUrl(a, bid);
      const uploaded = await b2UploadBuf(up.uploadUrl, up.authorizationToken, META, buf, 'application/json');
      // Garde seulement la nouvelle version, supprime les anciennes
      await deleteOldMetaVersions(a, bid, uploaded.fileId);
      res.status(200).json({ ok: true, fileId: uploaded.fileId });
      return;
    }

    if (action === 'delete') {
      const { key, fileId } = req.query;
      if (key && fileId) {
        await fetch(`${a.apiUrl}/b2api/v2/b2_delete_file_version`, {
          method: 'POST',
          headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: key, fileId })
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'stream') {
      const key = req.query?.key;
      if (!key) { res.status(400).json({ error: 'Paramètre key manquant' }); return; }
      const dlUrl = `${a.downloadUrl}/file/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(dlUrl, { headers: { Authorization: a.authorizationToken } });
      if (!r.ok) { res.status(r.status).json({ error: 'Fichier introuvable dans B2' }); return; }
      const contentType = r.headers.get('content-type') || 'application/octet-stream';
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.status(200).send(buf);
      return;
    }

    res.status(404).json({ error: 'Action inconnue' });
  } catch (e) {
    console.error('api error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
