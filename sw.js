// Service worker simples: deixa o app instalável e abre a casca mesmo com internet ruim.
// Os dados sempre vêm do Supabase (rede); só os arquivos do app ficam em cache.
const CACHE = 'goodcake-v1';
const ARQUIVOS = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.json', './logo.png', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Supabase e CDNs: sempre rede
  // rede primeiro (pega atualizações), cache como reserva
  e.respondWith(
    fetch(e.request).then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
