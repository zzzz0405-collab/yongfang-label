const CACHE_NAME = 'yongfang-label-v15';
const BASE_PATH = new URL('.', self.location.href).pathname;

function assetPath(file) {
    const base = BASE_PATH.endsWith('/') ? BASE_PATH : `${BASE_PATH}/`;
    return `${base}${file}`;
}

const PRECACHE = [
    'index.html',
    'manifest.webmanifest',
    'icon.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE.map(assetPath)))
            .catch(() => {})
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    const isIndex = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');

    event.respondWith(
        isIndex
            ? fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
            : caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
                    return response;
                });
            })
    );
});
