// RaceLog Phase 0: install and offline test. Holds no real data.
(function () {
  "use strict";

  var DB_NAME = "racelog_p0";
  var DB_VER = 1;
  var $ = function (id) { return document.getElementById(id); };
  var dbPromise = null;
  var state = { swState: "Checking", cacheState: "Checking", persist: "Checking", usage: "Checking", storageOk: null, opens: null, entryCount: 0 };

  /* ---------- IndexedDB helpers ---------- */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function run(store, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var req = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  var getAll = function (store) { return run(store, "readonly", function (s) { return s.getAll(); }); };
  var getOne = function (store, key) { return run(store, "readonly", function (s) { return s.get(key); }); };
  var putOne = function (store, value) { return run(store, "readwrite", function (s) { return s.put(value); }); };

  /* ---------- small helpers ---------- */
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (e) { return iso; }
  }
  function fmtBytes(n) {
    if (typeof n !== "number") return "Unknown";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return "e-" + crypto.randomUUID();
    return "e-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function isStandalone() {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }
  function browserName() {
    var ua = navigator.userAgent || "";
    var ios = /iPhone|iPad|iPod/.test(ua);
    if (/CriOS/.test(ua)) return "Chrome on iOS";
    if (/FxiOS/.test(ua)) return "Firefox on iOS";
    if (/EdgiOS/.test(ua)) return "Edge on iOS";
    if (ios && /Safari/.test(ua)) return "Safari on iOS";
    if (ios) return "iOS web view";
    if (/Chrome/.test(ua)) return "Chrome";
    if (/Safari/.test(ua)) return "Safari";
    return "Other";
  }

  /* ---------- status panel ---------- */
  function row(dl, label, value, cls) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    if (cls) dd.className = cls;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  function renderStatus() {
    var dl = $("status");
    dl.textContent = "";
    var standalone = isStandalone();
    var mode = $("mode");
    mode.textContent = standalone ? "Running as installed app" : "Running in a browser tab";
    mode.className = "pill " + (standalone ? "ok" : "");
    row(dl, "Browser", browserName());
    row(dl, "Installed app mode", standalone ? "Yes" : "No", standalone ? "ok" : "warn");
    row(dl, "Network", navigator.onLine === false ? "Offline" : "Online", navigator.onLine === false ? "bad" : "");
    row(dl, "Service worker", state.swState, state.swState === "Active" ? "ok" : "warn");
    row(dl, "Offline copy of app", state.cacheState, /^Ready/.test(state.cacheState) ? "ok" : "warn");
    row(dl, "Device storage", state.storageOk === null ? "Checking" : (state.storageOk ? "Working" : "Failed"), state.storageOk === false ? "bad" : (state.storageOk ? "ok" : ""));
    row(dl, "Protected from clearing", state.persist, state.persist === "Granted" ? "ok" : "warn");
    row(dl, "Storage used", state.usage);
    row(dl, "Entries saved", String(state.entryCount));
    if (state.opens) {
      row(dl, "First opened", fmtTime(state.opens.first));
      row(dl, "Times opened", String(state.opens.list.length >= 30 ? "30 or more" : state.opens.list.length));
      var recent = state.opens.list.slice(-4, -1).reverse().map(fmtTime);
      row(dl, "Earlier opens", recent.length ? recent.join(" · ") : "None yet");
    }
  }

  /* ---------- entries ---------- */
  function renderEntries(items) {
    var ul = $("list");
    ul.textContent = "";
    state.entryCount = items.length;
    $("count").textContent = String(items.length);
    if (!items.length) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No entries yet. Save one above.";
      ul.appendChild(li);
      return;
    }
    items.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    items.forEach(function (e) {
      var li = document.createElement("li");
      li.className = "entry";
      var b = document.createElement("b");
      b.textContent = e.text;
      var s = document.createElement("span");
      s.textContent = fmtTime(e.at);
      li.appendChild(b);
      li.appendChild(s);
      ul.appendChild(li);
    });
  }
  function loadEntries() {
    return getAll("entries").then(function (items) { state.storageOk = true; renderEntries(items); renderStatus(); return items; })
      .catch(function (err) { state.storageOk = false; renderStatus(); $("msg").textContent = "Device storage failed: " + (err && err.message ? err.message : "unknown error"); return []; });
  }

  $("f").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var input = $("note");
    var text = input.value.trim();
    if (!text) { $("msg").textContent = "Type something to save."; return; }
    var entry = { id: newId(), text: text, at: new Date().toISOString() };
    putOne("entries", entry).then(function () {
      input.value = "";
      $("msg").textContent = "Saved on this device.";
      requestPersist();
      return loadEntries();
    }).catch(function (err) {
      state.storageOk = false;
      renderStatus();
      $("msg").textContent = "Not saved: " + (err && err.message ? err.message : "device storage refused the write");
    });
  });

  $("backup").addEventListener("click", function () {
    getAll("entries").then(function (items) {
      var text = JSON.stringify({ app: "racelog-phase0", exportedAt: new Date().toISOString(), entries: items }, null, 2);
      var done = function () { $("msg").textContent = "Backup text copied. Paste it into a note or message."; };
      var fallback = function () {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        $("msg").textContent = ok ? "Backup text copied. Paste it into a note or message." : "Could not copy the backup text here.";
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
  });

  /* ---------- storage persistence and size ---------- */
  function requestPersist() {
    if (!(navigator.storage && navigator.storage.persist)) { state.persist = "Not supported"; renderStatus(); return; }
    navigator.storage.persisted().then(function (already) {
      if (already) return true;
      return navigator.storage.persist();
    }).then(function (granted) { state.persist = granted ? "Granted" : "Not granted"; renderStatus(); })
      .catch(function () { state.persist = "Not supported"; renderStatus(); });
  }
  function readUsage() {
    if (!(navigator.storage && navigator.storage.estimate)) { state.usage = "Unknown"; renderStatus(); return; }
    navigator.storage.estimate().then(function (est) { state.usage = fmtBytes(est.usage); renderStatus(); })
      .catch(function () { state.usage = "Unknown"; renderStatus(); });
  }

  /* ---------- service worker ---------- */
  function checkCache() {
    if (!window.caches) { state.cacheState = "Not supported"; renderStatus(); return; }
    caches.keys().then(function (keys) {
      if (!keys.length) { state.cacheState = "Not yet"; renderStatus(); return; }
      return caches.open(keys[0]).then(function (c) { return c.keys(); }).then(function (reqs) {
        state.cacheState = "Ready (" + reqs.length + " files)";
        renderStatus();
      });
    }).catch(function () { state.cacheState = "Unknown"; renderStatus(); });
  }
  function startServiceWorker() {
    if (!("serviceWorker" in navigator)) { state.swState = "Not supported"; renderStatus(); return; }
    navigator.serviceWorker.register("sw.js").then(function () { return navigator.serviceWorker.ready; })
      .then(function (reg) { state.swState = reg.active ? "Active" : "Installing"; renderStatus(); checkCache(); })
      .catch(function (err) { state.swState = "Failed: " + (err && err.message ? err.message : "unknown"); renderStatus(); });
  }

  /* ---------- open log (shows whether data survives days of disuse) ---------- */
  function recordOpen() {
    var now = new Date().toISOString();
    return getOne("meta", "opens").then(function (rec) {
      rec = rec || { key: "opens", first: now, list: [] };
      rec.list.push(now);
      if (rec.list.length > 30) rec.list = rec.list.slice(-30);
      return putOne("meta", rec).then(function () { state.opens = rec; renderStatus(); });
    }).catch(function () { /* storage status row already reports failures */ });
  }

  /* ---------- start ---------- */
  window.addEventListener("online", renderStatus);
  window.addEventListener("offline", renderStatus);
  renderStatus();
  startServiceWorker();
  requestPersist();
  readUsage();
  loadEntries().then(recordOpen).then(readUsage);
})();
