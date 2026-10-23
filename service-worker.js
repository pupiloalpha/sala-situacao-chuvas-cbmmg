const CACHE_NAME = 'riscos-mg-v1.6.0';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Instalação
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Ativação e limpeza de caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Estratégia: Network First para dados, Cache First para assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIs externas: sempre tenta rede
  if (url.hostname.includes('radarmeteorologico') ||
      url.hostname.includes('cemaden') ||
      url.hostname.includes('cprm') ||
      url.hostname.includes('gov.br')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => response)
        .catch(() => new Response(
          JSON.stringify({ erro: 'Sem conexão. Dados offline indisponíveis.' }),
          { headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // Assets locais: Cache First
  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request))
  );
});
