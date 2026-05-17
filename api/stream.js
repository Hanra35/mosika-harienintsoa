const KEY_ID  = '003ec0649a89f090000000001';
const APP_KEY = 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4';
const BUCKET  = 'melo-music-2026';

// Cache du token B2 en mémoire (valide 12h, réutilisé entre les requêtes)
let _auth = null;
let _authExpiry = 0;

async function getAuth() {
  if (_auth && Date.now() < _authExpiry) return _auth;
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64') }
  });
  if (!r.ok) throw new Error('B2 auth failed: ' + r.status);
  _auth = await r.json();
  _authExpiry = Date.now() + 11 * 60 * 60 * 1000; // 11h
  return _auth;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const key = req.query?.key;
  if (!key) { res.status(400).json({ error: 'key manquant' }); return; }

  // Sécurité : seulement les fichiers audio du bucket
  if (!key.startsWith('tracks/')) {
    res.status(403).json({ error: 'Accès refusé' });
    return;
  }

  try {
    const a = await getAuth();
    const fileUrl = `${a.downloadUrl}/file/${BUCKET}/${encodeURIComponent(key)}`;

    // Relaie le header Range du navigateur vers B2
    const headers = { Authorization: a.authorizationToken };
    const rangeHeader = req.headers['range'];
    if (rangeHeader) headers['Range'] = rangeHeader;

    const b2Res = await fetch(fileUrl, { headers });

    // Relaie les headers importants de B2 vers le navigateur
    const passHeaders = [
      'content-type', 'content-length', 'content-range',
      'accept-ranges', 'last-modified', 'etag'
    ];
    passHeaders.forEach(h => {
      const v = b2Res.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    // Status 206 si Range Request, 200 sinon
    res.status(b2Res.status);

    // Stream le body directement sans le charger en mémoire
    if (!b2Res.body) {
      res.end();
      return;
    }

    // Node.js : pipe le ReadableStream de fetch vers la réponse HTTP
    const reader = b2Res.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const canContinue = res.write(value);
        // Backpressure : attend que le buffer se vide si nécessaire
        if (!canContinue) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
    };
    await pump();

  } catch (e) {
    console.error('stream error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
};
