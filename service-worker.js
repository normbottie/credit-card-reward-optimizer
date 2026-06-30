const CACHE_NAME = 'card-rewards-v1';
const ASSETS = [
  '/index.html',
  '/manifest.json'
];

// Install: cache core assets
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: stale-while-revalidate — serve cache instantly, update in background
self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(e.request).then(function(cached) {
        var fetchPromise = fetch(e.request).then(function(response) {
          if(e.request.url.includes(self.location.origin)) {
            cache.put(e.request, response.clone());
          }
          return response;
        }).catch(function(){});

        // Serve cached immediately, fetch fresh in background
        return cached || fetchPromise;
      });
    })
  );
});
