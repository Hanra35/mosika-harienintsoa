const { createHash } = require('crypto');

const KEY_ID  = '003ec0649a89f090000000001';
const APP_KEY = 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4';
const BUCKET  = 'melo-music-2026';
const META    = 'melo-metadata.json';

// 👇 Token Musixmatch (web-desktop-app-v1.0)
const MUSIXMATCH_TOKEN = '2605cebe1ce741a292893ca977a106cdd39cbd5af82732947436';

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

    if (action === 'yt-debug') {
      // Endpoint temporaire pour diagnostiquer le problème YouTube
      const q = req.query?.q || 'test';
      const results = {};
      
      // Test 1: InnerTube WEB
      try {
        const r = await fetch('https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'fr' } },
            query: q
          })
        });
        results.web_status = r.status;
        const txt = await r.text();
        results.web_response_length = txt.length;
        results.web_preview = txt.substring(0, 200);
      } catch(e) { results.web_error = e.message; }

      // Test 2: InnerTube ANDROID
      try {
        const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip' },
          body: JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '17.31.35', androidSdkVersion: 30 } },
            videoId: 'dQw4w9WgXcQ'
          })
        });
        results.android_status = r.status;
        const txt = await r.text();
        results.android_response_length = txt.length;
        results.android_preview = txt.substring(0, 200);
      } catch(e) { results.android_error = e.message; }

      // Test 3: Piped
      try {
        const r = await fetch('https://pipedapi.kavin.rocks/search?q=test&filter=videos');
        results.piped_status = r.status;
        const txt = await r.text();
        results.piped_preview = txt.substring(0, 200);
      } catch(e) { results.piped_error = e.message; }

      res.status(200).json(results);
      return;
    }

    if (action === 'yt-search') {
      const q = req.query?.q || '';
      if (!q) { res.status(400).json({ error: 'Query manquante' }); return; }

      const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

      try {
        const r = await fetch(
          `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-YouTube-Client-Name': '1',
              'X-YouTube-Client-Version': '2.20240101.00.00',
              'Origin': 'https://www.youtube.com',
              'Referer': 'https://www.youtube.com/',
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: 'WEB',
                  clientVersion: '2.20240101.00.00',
                  hl: 'fr', gl: 'MG'
                }
              },
              query: q,
              params: 'EgIQAQ%3D%3D' // filter: videos only
            })
          }
        );

        if (!r.ok) {
          res.status(200).json({ results: [], error: `YouTube HTTP ${r.status}` });
          return;
        }

        const data = await r.json();

        // Extraire les vidéos — plusieurs structures possibles selon la réponse
        const results = [];

        // Fonction qui cherche récursivement les videoRenderer
        function extractVideos(obj, depth = 0) {
          if (!obj || typeof obj !== 'object' || depth > 8) return;
          if (obj.videoRenderer && obj.videoRenderer.videoId) {
            const v = obj.videoRenderer;
            const title  = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
            const artist = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
            const durTxt = v.lengthText?.simpleText || v.lengthText?.accessibility?.accessibilityData?.label || '';
            const secs   = durTxt.split(':').reverse().reduce((acc, v, i) => acc + parseInt(v||0) * Math.pow(60, i), 0);
            const thumbs = v.thumbnail?.thumbnails || [];
            const thumb  = thumbs.find(t => t.width >= 300)?.url || thumbs.slice(-1)[0]?.url || '';
            if (title) results.push({ id: v.videoId, title, artist, duration: secs, thumb });
            return;
          }
          if (Array.isArray(obj)) { obj.forEach(i => extractVideos(i, depth+1)); return; }
          Object.values(obj).forEach(v => extractVideos(v, depth+1));
        }

        extractVideos(data);
        res.status(200).json({ results: results.slice(0, 12) });
        return;
      } catch(e) {
        res.status(200).json({ results: [], error: e.message });
        return;
      }
    }

    if (action === 'yt-audio') {
      const videoId = req.query?.id || '';
      if (!videoId) { res.status(400).json({ error: 'ID manquant' }); return; }

      // InnerTube client ANDROID → URLs audio directes non chiffrées
      const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
      const context = {
        client: {
          clientName: 'ANDROID', clientVersion: '17.31.35',
          androidSdkVersion: 30, hl: 'fr', gl: 'MG',
          userAgent: 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip'
        }
      };

      try {
        const r = await fetch(
          `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip'
            },
            body: JSON.stringify({ context, videoId })
          }
        );
        if (!r.ok) throw new Error('YT player HTTP ' + r.status);
        const data = await r.json();

        if (data.playabilityStatus?.status !== 'OK') {
          throw new Error(data.playabilityStatus?.reason || 'Vidéo non disponible');
        }

        const formats = (data.streamingData?.adaptiveFormats || [])
          .filter(f => f.mimeType?.startsWith('audio/') && f.url);

        if (!formats.length) throw new Error('Aucun stream audio trouvé');

        // Préférer m4a/AAC pour iOS Safari
        formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const m4a  = formats.find(f => f.mimeType?.includes('mp4') || f.mimeType?.includes('m4a'));
        const best = m4a || formats[0];

        const title  = data.videoDetails?.title  || '';
        const artist = data.videoDetails?.author || '';

        res.status(200).json({
          url:    best.url,
          type:   best.mimeType?.split(';')[0] || 'audio/mp4',
          title,
          artist
        });
        return;
      } catch(e) {
        res.status(503).json({ error: e.message });
        return;
      }
    }

    if (action === 'musixmatch') {
      const track  = req.query?.track  || '';
      const artist = req.query?.artist || '';
      if (!track) { res.status(400).json({ error: 'Paramètre track manquant' }); return; }

      const base = 'https://api.musixmatch.com/ws/1.1';
      const tok  = MUSIXMATCH_TOKEN;
      const qs   = `usertoken=${tok}&app_id=web-desktop-app-v1.0`;
      const q    = encodeURIComponent(track) + (artist ? '&q_artist=' + encodeURIComponent(artist) : '');

      try {
        // 1. Cherche le track
        const srRes  = await fetch(`${base}/track.search?q_track=${q}&page_size=5&page=1&s_track_rating=desc&${qs}`);
        if (!srRes.ok) { res.status(200).json({ found: false, error: `search ${srRes.status}` }); return; }
        const srData = await srRes.json();
        const status = srData?.message?.header?.status_code;
        if (status !== 200) { res.status(200).json({ found: false, error: `mxm_status ${status}` }); return; }

        const trackList = srData?.message?.body?.track_list || [];
        if (!trackList.length) { res.status(200).json({ found: false }); return; }

        const trackId    = trackList[0].track.track_id;
        const hasSubtitle = trackList[0].track.has_subtitles === 1;

        if (!hasSubtitle) {
          const lyRes  = await fetch(`${base}/track.lyrics.get?track_id=${trackId}&${qs}`);
          const lyData = await lyRes.json();
          const plain  = lyData?.message?.body?.lyrics?.lyrics_body || '';
          res.status(200).json({ found: !!plain, synced: false, plain: plain.replace(/\*+.*$/s, '').trim() });
          return;
        }

        // Paroles synchronisées (LRC)
        const subRes  = await fetch(`${base}/track.subtitle.get?track_id=${trackId}&subtitle_format=lrc&${qs}`);
        const subData = await subRes.json();
        const lrc     = subData?.message?.body?.subtitle?.subtitle_body || '';
        res.status(200).json({ found: !!lrc, synced: true, lrc });
      } catch (err) {
        res.status(200).json({ found: false, error: err.message });
      }
      return;
    }

    if (action === 'stream') {
      const key = req.query?.key;
      if (!key) { res.status(400).json({ error: 'Paramètre key manquant' }); return; }

      const dlUrl = `${a.downloadUrl}/file/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const rangeHeader = req.headers['range'];

      if (rangeHeader) {
        // iOS Safari : requête partielle (Range) — obligatoire pour lire l'audio
        const r = await fetch(dlUrl, {
          headers: { Authorization: a.authorizationToken, Range: rangeHeader }
        });
        if (!r.ok && r.status !== 206) { res.status(r.status).end(); return; }
        const contentType   = r.headers.get('content-type')   || 'audio/mpeg';
        const contentRange  = r.headers.get('content-range')  || '';
        const contentLength = r.headers.get('content-length') || '';
        res.setHeader('Content-Type',  contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        if (contentRange)  res.setHeader('Content-Range',  contentRange);
        if (contentLength) res.setHeader('Content-Length', contentLength);
        const buf = Buffer.from(await r.arrayBuffer());
        res.status(206).send(buf);
        return;
      }

      // Requête complète
      const r = await fetch(dlUrl, { headers: { Authorization: a.authorizationToken } });
      if (!r.ok) { res.status(r.status).json({ error: 'Fichier introuvable dans B2' }); return; }
      const contentType   = r.headers.get('content-type')   || 'audio/mpeg';
      const contentLength = r.headers.get('content-length') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type',  contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.status(200).send(buf);
      return;
    }

    res.status(404).json({ error: 'Action inconnue' });
  } catch (e) {
    console.error('api error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
