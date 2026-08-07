const CACHE_NAME = 'koken-board-v1';
const urlsToCache = [
  '/koken-app/board.html',
  '/koken-app/manifest.json'
];

// Install: キャッシュを準備
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    }).then(() => self.skipWaiting())
  );
});

// Activate: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: ネットワーク優先、失敗時にキャッシュ
self.addEventListener('fetch', event => {
  // GAS API 呼び出しはネットワーク優先（常に最新データを取得）
  if (event.request.url.includes('script.google.com') ||
      event.request.url.includes('script.googleusercontent.com')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (!response || response.status !== 200) {
          return caches.match(event.request);
        }
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(() => {
        return caches.match(event.request);
      })
    );
  } else {
    // その他のリソースはネットワーク優先
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request);
      })
    );
  }
});
