// RaceLog Phase 0b service worker: serves the app instantly from its cache and refreshes in the background.
// Cache names start with "racelog-p0b-". This worker only ever deletes caches with that prefix,
// because the Phase 0 app on the same site keeps its own cache that must not be touched.
var CACHE = "racelog-p0b-v1";
var PREFIX = "racelog-p0b-";
var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var hit = await cache.match(req, { ignoreSearch: true });
    var update = fetch(req).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(function () { return null; });
    if (hit) { event.waitUntil(update); return hit; }
    var res = await update;
    if (res) return res;
    if (req.mode === "navigate") {
      var shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return Response.error();
  })());
});
