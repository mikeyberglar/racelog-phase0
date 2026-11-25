// RaceLog Phase 0b: sync test. Holds no real setup data.
// Design: every entry is saved on the device first. It counts as saved on the server only after
// the app reads it back from the server. Re-sending is always safe because each entry has an id
// made on the phone and the server ignores an id it already has.
(function () {
  "use strict";

  var APP_VERSION = "0b-1";
  var CFG = window.RACELOG_CONFIG || {};
  var BASE = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  var KEY = String(CFG.publishableKey || "");
  var configured = !!(BASE && KEY);
  var TABLE = "p0b_entries";
  var DB_NAME = "racelog_p0b";
  var DB_VER = 1;

  var $ = function (id) { return document.getElementById(id); };
  var st = { entries: [], serverRows: null, session: null, device: "", syncing: false, serverOk: null, authNeeded: false, logs: [], lastEmail: "" };
  var refreshing = null;
  var syncQueued = false;

  /* ---------- IndexedDB ---------- */
  var dbPromise = null;
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
  var delOne = function (store, key) { return run(store, "readwrite", function (s) { return s.delete(key); }); };
  function putMany(store, items) {
    if (!items.length) return Promise.resolve();
    return run(store, "readwrite", function (s) { var last; items.forEach(function (x) { last = s.put(x); }); return last; });
  }

  /* ---------- helpers ---------- */
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (e) { return String(iso); }
  }
  function fmtClock(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (e) { return String(iso); }
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return "e-" + crypto.randomUUID();
    return "e-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function isStandalone() {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }
  function errMsg(e) { return e && e.message ? e.message : String(e); }
  function log(text) {
    st.logs.unshift({ t: new Date().toISOString(), text: text });
    if (st.logs.length > 80) st.logs.pop();
    renderLog();
  }
  function copyText(text, okMsg, target) {
    var done = function () { $(target).textContent = okMsg; };
    var fail = function () {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      $(target).textContent = ok ? okMsg : "Could not copy here.";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  /* ---------- rendering ---------- */
  function unconfirmed() { return st.entries.filter(function (e) { return !e.confirmed; }); }
  function setPill(el, cls, text) { el.className = "pill " + cls; el.textContent = text; }

  function renderConn() {
    var standalone = isStandalone();
    setPill($("mode"), standalone ? "ok" : "", standalone ? "Installed app" : "Browser tab");
    if (!configured) setPill($("conn"), "", "No server set up");
    else if (navigator.onLine === false) setPill($("conn"), "bad", "No signal");
    else if (st.serverOk === false) setPill($("conn"), "bad", "Server not reachable");
    else if (st.serverOk === true) setPill($("conn"), "ok", "Online, server reached");
    else setPill($("conn"), "", "Online, not checked yet");
    $("config-warn").hidden = configured;
  }
  function renderTiles() {
    var waiting = unconfirmed().length;
    $("t-local").textContent = String(st.entries.length);
    $("t-conf").textContent = String(st.entries.length - waiting);
    $("t-wait").textContent = String(waiting);
    $("tile-wait").className = "tile" + (waiting ? " has" : "");
    $("btn-sync").disabled = st.syncing;
    $("btn-sync").textContent = st.syncing ? "Syncing…" : "Sync now";
  }
  function renderAuth() {
    var signedIn = !!st.session;
    $("authform").hidden = signedIn;
    $("btn-signout").hidden = !signedIn;
    var el = $("authstate");
    if (!configured) { el.textContent = "Add the server details first."; return; }
    if (signedIn) {
      var left = Math.max(0, st.session.expires_at - Math.floor(Date.now() / 1000));
      var mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
      el.textContent = "Signed in as " + (st.session.email || "your account") + ". Sign-in token valid for " + mm + ":" + ss + " (it refreshes itself).";
    } else if (st.authNeeded) {
      el.textContent = "Your sign-in expired or was refused. Sign in again. Entries on this device are safe.";
    } else {
      el.textContent = "Not signed in. Entries save on this device only until you sign in.";
    }
  }
  function renderList() {
    var ul = $("list");
    ul.textContent = "";
    var localIds = {};
    st.entries.forEach(function (e) { localIds[e.id] = true; });
    var items = st.entries.slice();
    (st.serverRows || []).forEach(function (r) {
      if (!localIds[r.id]) items.push({ id: r.id, text: r.text, at: r.created_at, device: r.device_id, confirmed: true, receivedAt: r.received_at, attempts: 0, remote: true });
    });
    items.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    $("count").textContent = String(items.length);
    if (!items.length) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No entries yet. Save one above.";
      ul.appendChild(li);
      return;
    }
    items.slice(0, 60).forEach(function (e) {
      var li = document.createElement("li");
      li.className = "entry";
      var b = document.createElement("b");
      b.textContent = e.text;
      var pill = document.createElement("span");
      if (e.confirmed) { pill.className = "pill ok"; pill.textContent = "Confirmed on server"; }
      else if (e.attempts > 0) { pill.className = "pill"; pill.textContent = "Sent, not read back"; }
      else { pill.className = "pill bad"; pill.textContent = "On device only"; }
      var meta = document.createElement("div");
      meta.className = "meta";
      var bits = [fmtTime(e.at), e.device];
      if (e.remote) bits.push("from another device");
      if (e.receivedAt) bits.push("server got it " + fmtClock(e.receivedAt));
      if (e.attempts > 1) bits.push("sent " + e.attempts + " times");
      if (e.lastError) bits.push(e.lastError);
      meta.textContent = bits.filter(Boolean).join(" · ");
      li.appendChild(b); li.appendChild(pill); li.appendChild(meta);
      ul.appendChild(li);
    });
  }
  function renderServerInfo() {
    var el = $("serverinfo");
    if (!st.serverRows) { el.textContent = configured ? "Not read from the server yet." : ""; return; }
    var groups = {}, repeats = 0;
    st.serverRows.forEach(function (r) {
      var k = r.device_id + "|" + r.created_at + "|" + r.text;
      groups[k] = (groups[k] || 0) + 1;
    });
    Object.keys(groups).forEach(function (k) { repeats += groups[k] - 1; });
    el.textContent = "Server holds " + st.serverRows.length + " entries for this account. Possible repeats: " + repeats + ".";
  }
  function renderLog() {
    var ol = $("log");
    ol.textContent = "";
    st.logs.forEach(function (l) {
      var li = document.createElement("li");
      li.textContent = fmtClock(l.t) + "  " + l.text;
      ol.appendChild(li);
    });
  }
  function render() { renderConn(); renderTiles(); renderAuth(); renderList(); renderServerInfo(); }

  /* ---------- network and account ---------- */
  async function apiFetch(path, opts, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 12000);
    try { opts.signal = ctrl.signal; return await fetch(BASE + path, opts); }
    finally { clearTimeout(timer); }
  }
  async function authCall(path, payload) {
    var r = await apiFetch(path, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    var body = {};
    try { body = await r.json(); } catch (e) { body = {}; }
    return { ok: r.ok, status: r.status, body: body || {} };
  }
  function authErrText(res) {
    var b = res.body || {};
    return b.msg || b.error_description || b.message || b.error || ("HTTP " + res.status);
  }
  function sessionFrom(body, email, prev) {
    var now = Math.floor(Date.now() / 1000);
    return {
      key: "session",
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at || (now + (body.expires_in || 3600)),
      email: (body.user && body.user.email) || email || (prev && prev.email) || "",
      user_id: (body.user && body.user.id) || (prev && prev.user_id) || ""
    };
  }
  async function storeSession(s) { st.session = s; st.authNeeded = false; await putOne("meta", s); }
  function tokenNeedsRefresh() {
    return !!st.session && st.session.expires_at - Math.floor(Date.now() / 1000) < 60;
  }
  function refreshSession() {
    if (refreshing) return refreshing;
    refreshing = (async function () {
      try {
        if (!st.session || !st.session.refresh_token) return "refused";
        var res = await authCall("/auth/v1/token?grant_type=refresh_token", { refresh_token: st.session.refresh_token });
        if (res.ok && res.body.access_token) {
          await storeSession(sessionFrom(res.body, "", st.session));
          log("Sign-in token refreshed.");
          return "ok";
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          log("Sign-in refresh refused (" + authErrText(res) + "). Sign in again.");
          st.lastEmail = st.session ? st.session.email : st.lastEmail;
          st.session = null; st.authNeeded = true;
          await delOne("meta", "session");
          return "refused";
        }
        log("Sign-in refresh failed: " + authErrText(res));
        return "error";
      } catch (e) {
        log("Sign-in refresh could not reach the server.");
        return "network";
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function authed(method, path, headers, body) {
    if (!st.session) throw { kind: "auth", message: "Not signed in" };
    if (tokenNeedsRefresh()) {
      var pre = await refreshSession();
      if (pre === "refused") throw { kind: "auth", message: "Sign-in expired" };
    }
    var once = function () {
      var h = { apikey: KEY, Authorization: "Bearer " + st.session.access_token };
      if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
      return apiFetch(path, { method: method, headers: h, body: body }, 15000);
    };
    var res = await once();
    if (res.status === 401) {
      log("Server rejected the token (401). Refreshing and retrying once.");
      var rr = await refreshSession();
      if (rr === "ok") res = await once();
      else if (rr === "refused") throw { kind: "auth", message: "Sign-in expired" };
    }
    return res;
  }

  /* ---------- sync ---------- */
  async function readBack() {
    var res = await authed("GET", "/rest/v1/" + TABLE + "?select=id,device_id,text,created_at,received_at&order=created_at.desc&limit=500");
    if (!res.ok) throw { kind: "http", message: "Read-back failed: HTTP " + res.status };
    var rows = await res.json();
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var changed = [];
    st.entries.forEach(function (e) {
      var r = byId[e.id];
      if (r && (!e.confirmed || !e.receivedAt)) {
        if (!e.confirmed) e.confirmedAt = new Date().toISOString();
        e.confirmed = true; e.receivedAt = r.received_at; e.lastError = "";
        changed.push(e);
      }
    });
    await putMany("entries", changed);
    st.serverRows = rows;
    if (changed.length) log("Read back from the server: " + changed.length + " now Confirmed.");
  }
  function describeError(err) {
    if (err && err.kind) return err.message;
    if (err && err.name === "AbortError") return "No answer from the server (timed out)";
    if (err && err.name === "TypeError") return "No connection to the server";
    return errMsg(err);
  }
  async function syncNow(reason) {
    if (!configured || !st.session || navigator.onLine === false) return;
    if (st.syncing) { syncQueued = true; return; }
    st.syncing = true;
    renderTiles();
    try {
      var pending = unconfirmed().sort(function (a, b) { return a.at < b.at ? -1 : 1; });
      if (pending.length) {
        log("Sync (" + reason + "): sending " + pending.length + " entries.");
        var rows = pending.map(function (e) { return { id: e.id, device_id: e.device, text: e.text, created_at: e.at }; });
        var res = await authed("POST", "/rest/v1/" + TABLE + "?on_conflict=id",
          { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" }, JSON.stringify(rows));
        st.serverOk = true;
        if (!res.ok) {
          var detail = "";
          try { detail = (await res.text()).slice(0, 200); } catch (e) { detail = ""; }
          pending.forEach(function (e) { e.attempts += 1; e.lastError = "Server refused: HTTP " + res.status; });
          await putMany("entries", pending);
          log("Upload refused: HTTP " + res.status + " " + detail);
          return;
        }
        pending.forEach(function (e) { e.attempts += 1; e.lastError = ""; });
        await putMany("entries", pending);
        log("Server accepted the upload of " + pending.length + " entries. Not yet counted as saved.");
        if ($("simlost").checked) {
          $("simlost").checked = false;
          log("Simulated lost reply: acting as if the server never answered. Entries stay unconfirmed until read back.");
          return;
        }
      } else {
        log("Sync (" + reason + "): nothing waiting. Reading from the server.");
      }
      await readBack();
      st.serverOk = true;
    } catch (err) {
      if (err && err.kind === "auth") { st.authNeeded = true; }
      else if (!(err && err.kind === "http")) { st.serverOk = false; }
      log("Sync stopped: " + describeError(err) + ". Entries stay safe on this device.");
    } finally {
      st.syncing = false;
      render();
      if (syncQueued) { syncQueued = false; setTimeout(function () { syncNow("queued"); }, 0); }
    }
  }

  /* ---------- actions ---------- */
  $("f").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var input = $("note");
    var text = input.value.trim();
    var msg = $("msg");
    if (!text) { msg.textContent = "Type something to save."; return; }
    var entry = { id: newId(), text: text, at: new Date().toISOString(), device: st.device, confirmed: false, confirmedAt: null, receivedAt: null, attempts: 0, lastError: "" };
    try {
      await putOne("entries", entry);
    } catch (err) {
      msg.textContent = "NOT SAVED. Device storage refused the write: " + errMsg(err);
      log("Save failed on device: " + errMsg(err));
      return;
    }
    st.entries.push(entry);
    input.value = "";
    msg.textContent = st.session ? "Saved on this device. Uploading when there is signal." : "Saved on this device. Sign in to upload.";
    log("Saved on device: " + text);
    render();
    syncNow("save");
  });

  async function accountAction(kind) {
    var email = $("email").value.trim();
    var password = $("password").value;
    var msg = $("authmsg");
    if (!configured) { msg.textContent = "Server details are not set yet."; return; }
    if (!email || password.length < 6) { msg.textContent = "Enter an email and a password of at least 6 characters."; return; }
    msg.textContent = kind === "up" ? "Creating account…" : "Signing in…";
    try {
      var res = kind === "up"
        ? await authCall("/auth/v1/signup", { email: email, password: password })
        : await authCall("/auth/v1/token?grant_type=password", { email: email, password: password });
      if (res.ok && res.body.access_token) {
        await storeSession(sessionFrom(res.body, email, null));
        $("password").value = "";
        msg.textContent = "";
        log((kind === "up" ? "Account created and signed in as " : "Signed in as ") + email + ".");
        render();
        syncNow("signed in");
      } else if (res.ok && kind === "up") {
        msg.textContent = "Account created, but email confirmation is switched on in Supabase. Turn off Confirm email, then tap Sign in.";
        log("Sign-up worked but returned no session (email confirmation is on).");
      } else {
        msg.textContent = authErrText(res);
        log("Account step refused: " + authErrText(res));
      }
    } catch (err) {
      msg.textContent = "No answer from the server. Check your signal and try again.";
      log("Account step failed: " + describeError(err));
    }
  }
  $("authform").addEventListener("submit", function (ev) { ev.preventDefault(); accountAction("in"); });
  $("btn-signup").addEventListener("click", function () { accountAction("up"); });
  $("btn-signout").addEventListener("click", async function () {
    st.lastEmail = st.session ? st.session.email : "";
    st.session = null; st.serverRows = null;
    await delOne("meta", "session").catch(function () {});
    log("Signed out. Entries stay on this device.");
    render();
  });
  $("btn-sync").addEventListener("click", function () {
    if (navigator.onLine === false) { $("msg").textContent = "No signal right now. Entries stay on this device."; return; }
    if (!st.session) { $("msg").textContent = "Sign in first."; return; }
    syncNow("manual");
  });
  $("btn-backup").addEventListener("click", function () {
    var text = JSON.stringify({ app: "racelog-phase0b", version: APP_VERSION, exportedAt: new Date().toISOString(), device: st.device, entries: st.entries }, null, 2);
    copyText(text, "Backup text copied. Paste it into a note or message.", "msg");
  });
  $("btn-copylog").addEventListener("click", function () {
    var text = "RaceLog Phase 0b " + APP_VERSION + " device " + st.device + "\n" + st.logs.slice().reverse().map(function (l) { return l.t + "  " + l.text; }).join("\n");
    copyText(text, "Event log copied.", "msg");
  });

  /* ---------- triggers ---------- */
  window.addEventListener("online", function () { log("Network came back."); render(); syncNow("reconnect"); });
  window.addEventListener("offline", function () { log("Network lost."); render(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { render(); syncNow("app opened"); }
  });
  setInterval(function () { if (st.session && unconfirmed().length) syncNow("retry"); }, 20000);
  setInterval(renderAuth, 1000);

  /* ---------- start ---------- */
  async function start() {
    $("ver").textContent = APP_VERSION;
    render();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function (e) { log("Offline copy could not be set up: " + errMsg(e)); });
    }
    try {
      var dev = await getOne("meta", "device");
      if (!dev) { dev = { key: "device", id: "D-" + Math.random().toString(36).slice(2, 6).toUpperCase() }; await putOne("meta", dev); }
      st.device = dev.id;
      st.entries = await getAll("entries");
      var sess = await getOne("meta", "session");
      if (sess && sess.access_token) st.session = sess;
    } catch (e) {
      log("Device storage failed: " + errMsg(e));
      $("msg").textContent = "Device storage is not working. Entries will not be kept.";
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function (g) { log("Storage protection: " + (g ? "granted" : "not granted") + "."); }).catch(function () {});
    }
    log("Opened " + APP_VERSION + " on " + (st.device || "unknown device") + ". " + st.entries.length + " entries on device, " + unconfirmed().length + " waiting.");
    render();
    if (st.session) syncNow("app opened");
  }
  start();
})();
