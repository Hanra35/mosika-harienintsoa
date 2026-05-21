/* sw.js — Melo Service Worker
   Permet la lecture audio en arrière-plan même écran verrouillé
   et met en cache le shell de l'app pour le mode hors-ligne. */

const CACHE_NAME = 'melo-shell-v1';
const SHELL_FILES = ['/', '/index.html', '/logo.png'];

// Installation : mise en cache du shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_FILES).catch(function() {});
    })
  );
  self.skipWaiting();
});

// Activation : nettoyage des anciens caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch : network-first pour l'API, cache-first pour le shell
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  // Laisser passer les requêtes audio/API sans interférer
  if (url.includes('backblazeb2.com') || url.includes('api.') || 
      url.includes('?action=') || url.includes('r2.') ||
      url.includes('lrclib') || url.includes('anthropic')) {
    return; // fetch normal, pas d'interception
  }
  // Shell app : cache-first
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(resp) {
        if (resp && resp.status === 200 && event.request.method === 'GET') {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(event.request, clone); });
        }
        return resp;
      }).catch(function() { return cached; });
    })
  );
});
