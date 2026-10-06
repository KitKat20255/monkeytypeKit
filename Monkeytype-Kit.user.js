// ==UserScript==
// @name         Monkeytype Kit Full (Archive + Jail + Hotlist + Dictation + Key Confidence)
// @namespace    https://monkeytype.com/kit
// @version      2.2.31
// @description  Bundle: Eternal Archive, Jail, Hotlist, Dictation, Key Confidence + Best WPM. Single Ape Key in Archive panel.
// @author       kitkat + Grok
// @match        https://monkeytype.com/*
// @match        https://www.monkeytype.com/*
// @icon         https://monkeytype.com/images/favicon/favicon-32x32.png
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.monkeytype.com
// @connect      monkeytype.com
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * MODULES (isolated IIFEs)
 * - Eternal Archive → #ea-* / IndexedDB / Ape Key only here
 * - Jail / Hotlist / Dictation
 * - Key Confidence → #mt-keyconf-* (toggle via KeyConf checkbox)
 */

/*
 * MODULES (isolated IIFEs — separate storage / DOM ids)
 * - Eternal Archive  → #ea-* , IndexedDB, Ape Key via Archive UI only
 * - Jail / Hotlist / Dictation
 * - Key Confidence   → #mt-keyconf-* (enable via KeyConf checkbox)
 */

/*
 * ONE-CLICK INSTALL
 * -----------------
 * 1) Host this file as a public raw URL (GitHub raw, Gist raw, or your site)
 *    Example: https://raw.githubusercontent.com/YOU/mt-kit/main/Monkeytype-Kit.user.js
 * 2) Share that URL. With Tampermonkey installed, opening the .user.js URL offers Install.
 * 3) Optional Tampermonkey helper link:
 *    https://www.tampermonkey.net/script_installation.php?url=ENCODED_RAW_URL
 * 4) Or publish on https://greasyfork.org for a store-style install button.
 *
 * MODULES (isolated IIFEs — separate storage keys / DOM ids)
 * - Eternal Archive  → #ea-* , IndexedDB, Ape Key via UI (APE_KEY constant left empty)
 * - Jail Mode        → #mt-jail-*
 * - Hotlist Multi    → original hotlist storage (poem#3305 credits)
 * - Kokoro Dictation → #mt-dict-* , needs local Kokoro API on localhost:8880
 */



/* ========== 1. ETERNAL ARCHIVE ========== */
(function () {
  'use strict';

  // Tampermonkey sandbox: page globals live on unsafeWindow
  function pageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (e) {}
    return window;
  }
  const PAGE = pageWindow();

  /** Chart.js lives on the page window when loaded via <script> tags */
  function getChart() {
    try {
      if (PAGE.Chart) return PAGE.Chart;
    } catch (e) {}
    try {
      if (typeof Chart !== 'undefined') return Chart;
    } catch (e) {}
    return null;
  }

  /*********************************************************************
   *  CONFIG
   *********************************************************************/
  // >>> EDIT / CLEAR THIS before sharing the script <<<
  // Leave empty string '' to disable API auto-sync (snapshot/import still work).
  // ========== APE KEY (only place — leave empty when sharing) ==========
  const APE_KEY = '';
  // ====================================================================


  const DB_NAME = 'MonkeytypeEternalArchive';
  const DB_VERSION = 2;
  const STORE_NAME = 'results';
  const META_STORE = 'meta';
  const AUTO_SYNC_INTERVAL_HOURS = 6;          // light background sync
  const MAX_POINTS_DRAW = 4000;                // downsample scatter if more (averages still exact)
  const IMPROVE_BLOCK_HOURS = 10;              // non-overlapping blocks of effective test time

  /*********************************************************************
   *  INDEXEDDB
   *********************************************************************/
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('mode', 'mode', { unique: false });
          store.createIndex('language', 'language', { unique: false });
          store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
    });
  }

  async function idbPut(storeName, value) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(storeName, key) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function ensureResultId(result) {
    if (result._id) {
      result.id = String(result._id);
    } else if (!result.id) {
      // Stable id — NO random suffix (random caused +3 rows per test)
      const ts = Math.round(Number(result.timestamp) || Date.now());
      const wpm = Math.round((Number(result.wpm) || 0) * 100);
      const acc = Math.round((Number(result.acc) || 0) * 100);
      result.id = 'r_' + ts + '_' + wpm + '_' + acc;
    }
    return result.id;
  }

  /** Find existing row for same test (within a few seconds, same wpm) */
  function resultTsMs(r) {
    let ts = Number(r && r.timestamp) || 0;
    if (ts && ts < 1e12) ts *= 1000;
    if (!ts || ts < 946684800000) return 0;
    return ts;
  }

  /** Match same test only — tight time + wpm + accuracy so consecutive quotes never merge */
  async function findDuplicateResult(result, windowMs) {
    try {
      const all = await getAllResults();
      const ts = resultTsMs(result);
      const wpm = Number(result.wpm);
      if (!ts || !wpm) return null;
      const acc = result.acc != null ? Number(result.acc) : null;
      // Official id match always; otherwise only ~12s window (not 120s)
      const win = windowMs != null ? windowMs : 12000;
      let best = null;
      let bestScore = Infinity;
      for (const r of all) {
        // Exact official id
        if (result._id && r._id && String(result._id) === String(r._id)) return r;
        if (result.id && r.id && String(result.id) === String(r.id) &&
            !String(result.id).startsWith('live_')) return r;

        const rts = resultTsMs(r);
        const dt = Math.abs(rts - ts);
        if (dt > win) continue;
        if (Math.abs(Number(r.wpm) - wpm) > 0.15) continue;
        // Accuracy must match when both known — separates two tests with same wpm
        if (acc != null && r.acc != null && Math.abs(Number(r.acc) - acc) > 0.6) continue;

        const score = dt + Math.abs(Number(r.wpm) - wpm) * 1000 +
          (acc != null && r.acc != null ? Math.abs(Number(r.acc) - acc) * 10 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = r;
        }
      }
      return best;
    } catch (e) {}
    return null;
  }

  /** Find a live row with stumble data for the same test (same day + wpm + acc).
   *  Used when API/CSV import would otherwise drop stumble from a prior live save. */
  async function findStumbleDonor(result) {
    try {
      if (!result || result.stumblePct != null) return null;
      const all = await getAllResults();
      const ts = resultTsMs(result);
      const wpm = Number(result.wpm);
      if (!ts || !wpm) return null;
      const acc = result.acc != null ? Number(result.acc) : null;
      let best = null;
      let bestScore = Infinity;
      for (const r of all) {
        if (r.stumblePct == null && r.stumbledWords == null) continue;
        if (Math.abs(Number(r.wpm) - wpm) > 0.2) continue;
        if (acc != null && r.acc != null && Math.abs(Number(r.acc) - acc) > 1.0) continue;
        const rts = resultTsMs(r);
        const dt = Math.abs(rts - ts);
        // Same calendar day (or ±36h for timezone edge)
        if (dt > 36 * 60 * 60 * 1000) continue;
        const score = dt + Math.abs(Number(r.wpm) - wpm) * 5000;
        if (score < bestScore) {
          bestScore = score;
          best = r;
        }
      }
      return best;
    } catch (e) { return null; }
  }

  function mergeStumbleFromExisting(result, existing) {
    if (!existing) return result;
    const incS = result.stumbledWords != null ? Number(result.stumbledWords) : null;
    const exS = existing.stumbledWords != null ? Number(existing.stumbledWords) : null;
    const incPct = result.stumblePct != null ? Number(result.stumblePct) : null;
    const exPct = existing.stumblePct != null ? Number(existing.stumblePct) : null;
    // Prefer existing when incoming is missing OR zero while existing has a real count
    const incomingEmpty = (incS == null && incPct == null) ||
      (incS === 0 && (incPct == null || incPct === 0) && (exS > 0 || exPct > 0));
    if (incomingEmpty && (exS != null || exPct != null)) {
      result.stumbledWords = existing.stumbledWords;
      result.cleanWords = existing.cleanWords;
      result.totalWords = existing.totalWords != null ? existing.totalWords : result.totalWords;
      result.stumblePct = existing.stumblePct;
    } else if (exS != null && incS != null && exS > incS) {
      // Later capture under-counted (quick restart) — keep higher stumble
      result.stumbledWords = existing.stumbledWords;
      result.cleanWords = existing.cleanWords;
      result.totalWords = existing.totalWords != null ? existing.totalWords : result.totalWords;
      result.stumblePct = existing.stumblePct;
    }
    return result;
  }

  /** Server/API row corrects incomplete live row; keep stumble from live */
  function mergeServerOverLive(server, live) {
    if (!live) return server;
    if (!server) return live;
    const out = { ...live };
    // Official identity
    if (server._id) {
      out._id = server._id;
      out.id = String(server._id);
    } else if (server.id && !String(server.id).startsWith('live_')) {
      out.id = String(server.id);
    }
    // Prefer server metadata when present
    const prefer = ['wpm','rawWpm','acc','consistency','mode','mode2','language','difficulty',
      'punctuation','numbers','funbox','quoteLength','testDuration','isPb','timestamp','charStats'];
    for (const k of prefer) {
      if (server[k] != null && server[k] !== '' && server[k] !== 'none') out[k] = server[k];
    }
    // Tags: prefer non-empty server tags
    if (Array.isArray(server.tags) && server.tags.length) out.tags = server.tags.map(String);
    else if (Array.isArray(live.tags) && live.tags.length) out.tags = live.tags.map(String);
    else out.tags = out.tags || [];
    // Fix mangled language from old live scrape
    if (out.language && /shortenglish|mediumenglish|longenglish/i.test(String(out.language))) {
      out.language = server.language || 'english';
    }
    // Stumble: keep live if server has none
    mergeStumbleFromExisting(out, live);
    out._source = server._id ? 'server' : (live._source || out._source);
    out._liveId = String(live.id || '').startsWith('live_') ? live.id : live._liveId;
    return out;
  }

    // Pending stumbles survive tab close (localStorage) so later API/CSV import can attach them
  const SS_PENDING = 'ea_pending_stumbles';
  const LS_PENDING = 'ea_pending_stumbles_v2';
  const LS_STUMBLE_INDEX = 'ea_stumble_index_v1';

  function stumbleKey(r) {
    if (!r) return null;
    if (r._id) return 'id:' + String(r._id);
    if (r.id && !String(r.id).startsWith('live_')) return 'id:' + String(r.id);
    let ts = Number(r.timestamp) || 0;
    if (ts && ts < 1e12) ts *= 1000;
    if (!ts || r.wpm == null) return null;
    return 't:' + ts + '|w:' + Number(r.wpm).toFixed(2) + '|a:' + (r.acc != null ? Number(r.acc).toFixed(2) : '');
  }

  function loadStumbleIndex() {
    try {
      const raw = localStorage.getItem(LS_STUMBLE_INDEX);
      const o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }

  function saveStumbleIndex(map) {
    try {
      const keys = Object.keys(map || {});
      // Cap ~5000 entries, drop oldest by t
      if (keys.length > 5000) {
        const entries = keys.map(k => ({ k, t: map[k] && map[k].t || 0 }))
          .sort((a, b) => b.t - a.t)
          .slice(0, 5000);
        const next = {};
        for (const e of entries) next[e.k] = map[e.k];
        map = next;
      }
      localStorage.setItem(LS_STUMBLE_INDEX, JSON.stringify(map));
    } catch (e) {}
  }

  /** Persist stumble permanently (survives CSV reimport / pending consume) */
  function rememberStumble(result) {
    if (!result || result.stumblePct == null || !(Number(result.totalWords) > 0)) return;
    const map = loadStumbleIndex();
    const entry = {
      stumbledWords: Number(result.stumbledWords) || 0,
      cleanWords: Number(result.cleanWords) || 0,
      totalWords: Number(result.totalWords) || 0,
      stumblePct: Number(result.stumblePct),
      t: Date.now()
    };
    const k = stumbleKey(result);
    if (k) map[k] = entry;
    // Secondary key without id for live→server merge
    if (result.wpm != null) {
      let ts = Number(result.timestamp) || 0;
      if (ts && ts < 1e12) ts *= 1000;
      if (ts) {
        const k2 = 't:' + ts + '|w:' + Number(result.wpm).toFixed(2) + '|a:' + (result.acc != null ? Number(result.acc).toFixed(2) : '');
        map[k2] = entry;
      }
    }
    saveStumbleIndex(map);
  }

  /** Restore stumble from permanent index if result is missing it */
  function applyStumbleIndex(result) {
    if (!result) return result;
    if (result.stumblePct != null && Number(result.totalWords) > 0) return result;
    const map = loadStumbleIndex();
    const k = stumbleKey(result);
    let hit = k && map[k];
    if (!hit && result.wpm != null) {
      let ts = Number(result.timestamp) || 0;
      if (ts && ts < 1e12) ts *= 1000;
      if (ts) {
        const k2 = 't:' + ts + '|w:' + Number(result.wpm).toFixed(2) + '|a:' + (result.acc != null ? Number(result.acc).toFixed(2) : '');
        hit = map[k2];
      }
    }
    if (!hit) return result;
    result.stumbledWords = hit.stumbledWords;
    result.cleanWords = hit.cleanWords;
    result.totalWords = hit.totalWords;
    result.stumblePct = hit.stumblePct;
    return result;
  }

  /**
   * Re-attach stumbles to last N results from index + pending.
   * Never clears an existing stumble value.
   */
  async function reconcileStumblesLastN(n) {
    n = n || 1000;
    const all = await getAllResults();
    const sorted = all.slice().sort((a, b) => {
      let ta = Number(a.timestamp) || 0; let tb = Number(b.timestamp) || 0;
      if (ta && ta < 1e12) ta *= 1000; if (tb && tb < 1e12) tb *= 1000;
      return tb - ta;
    }).slice(0, n);
    let fixed = 0;
    for (const r of sorted) {
      if (r.stumblePct != null && Number(r.totalWords) > 0) {
        rememberStumble(r); // backfill index from existing good data
        continue;
      }
      const before = r.stumblePct;
      applyStumbleIndex(r);
      matchPendingStumble(r); // consume pending if matches
      if (r.stumblePct != null && r.stumblePct !== before) {
        rememberStumble(r);
        try { await saveResult(r); } catch (e) {}
        fixed++;
      }
    }
    console.log('[EA] reconcile stumbles last', n, 'fixed', fixed);
    return fixed;
  }

  function loadPendingStumbles() {
    try {
      let arr = [];
      const ls = localStorage.getItem(LS_PENDING);
      if (ls) arr = JSON.parse(ls) || [];
      if (!Array.isArray(arr) || !arr.length) {
        const ss = sessionStorage.getItem(SS_PENDING);
        if (ss) arr = JSON.parse(ss) || [];
      }
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function savePendingStumbles(arr) {
    try {
      // Keep last 500, drop older than 2 days
      const now = Date.now();
      const trimmed = (arr || [])
        .filter(p => p && now - (p.t || 0) < 2 * 24 * 60 * 60 * 1000)
        .slice(-500);
      localStorage.setItem(LS_PENDING, JSON.stringify(trimmed));
      sessionStorage.setItem(SS_PENDING, JSON.stringify(trimmed));
    } catch (e) {}
  }

  function queuePendingStumble(s, wpmHint, extra) {
    if (!s || !s.total) return;
    const list = loadPendingStumbles();
    const entry = {
      t: Date.now(),
      wpm: wpmHint != null ? Number(wpmHint) : null,
      acc: extra && extra.acc != null ? Number(extra.acc) : null,
      mode: extra && extra.mode != null ? String(extra.mode) : null,
      mode2: extra && extra.mode2 != null ? String(extra.mode2) : null,
      stumbled: s.stumbled,
      clean: s.clean,
      total: s.total,
      stumblePct: s.stumblePct
    };
    // Drop near-duplicate within 8s (same test fired multiple freezes)
    const filtered = list.filter(p => Math.abs((p.t || 0) - entry.t) > 8000);
    filtered.push(entry);
    savePendingStumbles(filtered);
  }

  
  /** Fallback when MT no longer uses .group classes — parse #result.innerText */
  function scrapeResultFromInnerText() {
    const root = document.querySelector('#result') || document.querySelector('.pageResult');
    if (!root) return null;
    let block = '';
    try {
      const clone = root.cloneNode(true);
      clone.querySelectorAll(
        '#kc-root, .kc-panel, [id*="keyconf"], [class*="keyconf"], [class*="KeyConf"]'
      ).forEach(el => { try { el.remove(); } catch (e) {} });
      clone.querySelectorAll('*').forEach(el => {
        try {
          const t = (el.textContent || '').trim().slice(0, 40);
          if (/^best possible/i.test(t)) el.remove();
        } catch (e) {}
      });
      block = clone.innerText || clone.textContent || '';
    } catch (e) {
      block = root.innerText || root.textContent || '';
    }
    block = block.replace(/best possible[^\n]*/gi, ' ');
    if (!block || block.length < 10) return null;

    const out = {};
    // Collect all wpm candidates; NEVER take a number that is the "100" from "100%" 
    const allWpm = [];
    const re = /\bwpm\b([^\d%]{0,15})(\d+(?:\.\d+)?)(\s*%)?/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
      if (m[3]) continue; // followed by % → not wpm
      const n = parseFloat(m[2]);
      if (!isNaN(n) && n >= 5 && n < 400) allWpm.push(n);
    }
    if (allWpm.length) {
      const decimals = allWpm.filter(n => n % 1 !== 0);
      const non100 = allWpm.filter(n => n !== 100);
      if (decimals.length) out.wpm = decimals[0];
      else if (non100.length) out.wpm = non100[0];
      else out.wpm = allWpm[0];
    }

    const accM = block.match(/\bacc(?:uracy)?\b[^\d]{0,12}(\d+(?:\.\d+)?)\s*%?/i);
    if (accM) {
      const n = parseFloat(accM[1]);
      if (!isNaN(n) && n > 0 && n <= 100) out.acc = n;
    }
    const rawM = block.match(/\braw\b([^\d%]{0,12})(\d+(?:\.\d+)?)(\s*%)?/i);
    if (rawM && !rawM[3]) {
      const n = parseFloat(rawM[2]);
      if (!isNaN(n) && n >= 5 && n < 400) out.rawWpm = n;
    }
    // If wpm still 100 but raw is sensible, prefer raw
    if (out.wpm === 100 && out.rawWpm && Math.abs(out.rawWpm - 100) > 3) {
      out.wpm = out.rawWpm;
    }

    if (/\bquote\b/i.test(block)) {
      out.mode = 'quote';
      if (/\bshort\b/i.test(block)) { out.type = 'short'; out.quoteLength = 0; out.mode2 = '0'; }
      else if (/\bmedium\b/i.test(block)) { out.type = 'medium'; out.quoteLength = 1; out.mode2 = '1'; }
      else if (/\blong\b/i.test(block)) { out.type = 'long'; out.quoteLength = 2; out.mode2 = '2'; }
      else if (/\bthicc\b|\bthick\b/i.test(block)) { out.type = 'thicc'; out.quoteLength = 3; out.mode2 = '3'; }
      else { out.type = 'short'; out.mode2 = '0'; }
    } else if (/\bzen\b/i.test(block)) {
      out.mode = 'zen'; out.type = 'zen'; out.mode2 = 'zen';
    } else if (/\bwords\b/i.test(block)) {
      out.mode = 'words';
      const wm = block.match(/\b(10|25|50|100)\b/);
      out.type = wm ? wm[1] : 'custom'; out.mode2 = out.type;
    } else if (/\btime\b/i.test(block)) {
      out.mode = 'time';
      const tm = block.match(/\b(15|30|60|120)\b/);
      out.type = tm ? tm[1] : '60'; out.mode2 = out.type;
    }
    if (/\benglish\b/i.test(block)) out.language = 'english';
    if (/\beclipse\b/i.test(block)) {
      try { out.tags = resolveTagNamesToIds(['eclipse']); } catch (e) { out.tags = ['eclipse']; }
    }
    if (out.wpm) return out;
    return null;
  }

  
  function readWpmFromResultDOM() {
    try {
      const parseNum = (t, min, max) => {
        if (t == null) return null;
        const m = String(t).trim().match(/(\d+(?:\.\d+)?)/);
        if (!m) return null;
        const n = parseFloat(m[1]);
        if (isNaN(n) || n < (min ?? 5) || n >= (max ?? 400)) return null;
        return n;
      };

      // 1) Classic selectors
      for (const sel of [
        '#result .group.wpm .bottom',
        '#result .group.wpm .bottom span',
        '#result .stats .group.wpm .bottom',
        '.pageResult .group.wpm .bottom',
        '#result [class*="wpm"] .bottom',
        '#result .wpm'
      ]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const n = parseNum(el.innerText || el.textContent);
        if (n != null) return n;
      }

      // 2) Any element under #result whose own text is exactly "wpm" → sibling/parent number
      const root = document.querySelector('#result') || document.querySelector('.pageResult');
      if (root) {
        const walk = root.querySelectorAll('div, span, p, td, li, label');
        for (const el of walk) {
          // only leaf-ish labels
          const own = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
            ? el.textContent.trim().toLowerCase()
            : (el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild.textContent.trim().toLowerCase() : '');
          if (own !== 'wpm' && own !== 'words per minute') continue;
          const parent = el.parentElement;
          if (!parent) continue;
          // number often in next sibling or parent's other child
          let n = null;
          for (const sib of parent.children) {
            if (sib === el) continue;
            n = parseNum(sib.innerText || sib.textContent);
            if (n != null) return n;
          }
          n = parseNum(parent.innerText);
          if (n != null) return n;
        }

        // 3) innerText block parse: "wpm\n37.54" or "wpm 37.54"
        const block = root.innerText || root.textContent || '';
        let m = block.match(/\bwpm\b[^\d]{0,10}(\d+(?:\.\d+)?)/i);
        if (m) {
          const n = parseFloat(m[1]);
          if (!isNaN(n) && n >= 5 && n < 400) return n;
        }
      }

      return null;
    } catch (e) {
      console.warn('[EA] readWpm error', e);
      return null;
    }
  }

  
  function readNumFromResultGroup(groupClass) {
    try {
      const parseNum = (t) => {
        if (t == null) return null;
        const m = String(t).trim().match(/(\d+(?:\.\d+)?)/);
        if (!m) return null;
        const n = parseFloat(m[1]);
        return isNaN(n) ? null : n;
      };
      const want = groupClass.toLowerCase();
      const aliases = want === 'acc' || want === 'accuracy' ? ['acc', 'accuracy']
        : want === 'raw' ? ['raw', 'raw wpm']
        : want === 'consistency' ? ['consistency', 'cons']
        : [want];

      for (const a of aliases) {
        const el = document.querySelector('#result .group.' + a + ' .bottom')
          || document.querySelector('.pageResult .group.' + a + ' .bottom');
        if (el) {
          const n = parseNum(el.innerText || el.textContent);
          if (n != null) return n;
        }
      }

      const root = document.querySelector('#result') || document.querySelector('.pageResult');
      if (!root) return null;

      // Label walk
      for (const el of root.querySelectorAll('div, span, p, label')) {
        const own = (el.childNodes.length && el.childNodes[0].nodeType === 3)
          ? el.childNodes[0].textContent.trim().toLowerCase()
          : '';
        if (!aliases.includes(own)) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        for (const sib of parent.children) {
          if (sib === el) continue;
          const n = parseNum(sib.innerText || sib.textContent);
          if (n != null) return n;
        }
      }

      // innerText: "acc\n95.45%" or "accuracy 95.45"
      const block = root.innerText || '';
      for (const a of aliases) {
        const re = new RegExp('\\\\b' + a + '\\\\b[^\\\\d]{0,10}(\\\\d+(?:\\\\.\\\\d+)?)', 'i');
        const m = block.match(re);
        if (m) {
          const n = parseFloat(m[1]);
          if (!isNaN(n)) return n;
        }
      }
      return null;
    } catch (e) { return null; }
  }

  
  function readResultGroupMap() {
    // Parse #result .group blocks: { "test type": "quote short english", "tags": "eclipse", ... }
    const map = {};
    try {
      document.querySelectorAll('#result .group, .pageResult .group, #result .infoGroup').forEach(g => {
        const top = g.querySelector('.top, .label, .title');
        const bottom = g.querySelector('.bottom, .val, .value');
        let key = (top ? top.textContent : '').trim().toLowerCase();
        // strip icons / buttons text noise ("tags ✎")
        key = key.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        let val = '';
        if (bottom) {
          val = (bottom.textContent || '').trim();
        } else if (top) {
          val = (g.textContent || '').replace(top.textContent, '').trim();
        } else {
          val = (g.textContent || '').trim();
        }
        val = val.replace(/\s+/g, ' ').trim();
        if (key) map[key] = val;
        // also index by first word (tags, language, …)
        const first = key.split(' ')[0];
        if (first && !map[first]) map[first] = val;
      });
      // Dedicated tags selectors (Monkeytype markup varies)
      if (!map.tags && !map['tags']) {
        const tagEls = document.querySelectorAll(
          '#result .tags .bottom, #result .group.tags .bottom, #result .tagsAndDate .bottom, ' +
          '#result .tags .textButton, #result [class*="tag"] .bottom'
        );
        const names = [];
        tagEls.forEach(el => {
          const t = (el.textContent || '').trim();
          if (t && !/^tags$/i.test(t) && t.length < 40) names.push(t);
        });
        // Fallback: look for line after "tags" label in result text
        if (!names.length) {
          const res = document.querySelector('#result');
          if (res) {
            const lines = (res.innerText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
              if (/^tags$/i.test(lines[i]) && lines[i + 1] && !/input history|raw|consistency/i.test(lines[i + 1])) {
                names.push(lines[i + 1]);
                break;
              }
            }
          }
        }
        if (names.length) map.tags = names.join(' ');
      }
    } catch (e) {}
    return map;
  }

  function resolveTagNamesToIds(names) {
    const map = window.__eaTagNameMap || (typeof PAGE !== 'undefined' && PAGE.__eaTagNameMap) || {};
    const rev = {};
    Object.entries(map).forEach(([id, n]) => { rev[String(n).toLowerCase()] = String(id); });
    return (names || []).map(t => {
      const s = String(t).trim();
      if (!s) return null;
      if (map[s]) return s;
      return rev[s.toLowerCase()] || s;
    }).filter(Boolean);
  }

  function readResultFromDOM() {
    let wpm = readWpmFromResultDOM();
    let acc = readNumFromResultGroup('acc') ?? readNumFromResultGroup('accuracy');
    let scraped = null;
    if (wpm == null || wpm <= 0 || acc == null) {
      scraped = scrapeResultFromInnerText();
      if (scraped) {
        if (wpm == null || wpm <= 0) wpm = scraped.wpm;
        if (acc == null && scraped.acc != null) acc = scraped.acc;
      }
    }
    if (wpm == null || wpm <= 0) return null;
    const raw = readNumFromResultGroup('raw');
    const cons = readNumFromResultGroup('consistency');

    let mode = null;
    let mode2 = null;
    let language = 'english';
    let punctuation = false;
    let numbers = false;
    let tags = [];
    let quoteLength = undefined;
    let difficulty = 'normal';
    let funbox = 'none';

    // 1) Authoritative: result screen groups (visible text: "quote short", "eclipse", …)
    try {
      const groups = readResultGroupMap();
      // Gather test-type text from group + raw multi-line bottom (MT shows mode\nlang)
      let testType = groups['test type'] || groups['testtype'] || '';
      try {
        const tg = Array.from(document.querySelectorAll('#result .group, .pageResult .group')).find((g) => {
          const top = (g.querySelector('.top, .label, .title')?.textContent || '').toLowerCase();
          return /test\s*type/.test(top);
        });
        if (tg) {
          const bot = tg.querySelector('.bottom, .val, .value');
          if (bot) testType = (bot.innerText || bot.textContent || testType);
        }
      } catch (e) {}
      const ttRaw = String(testType || '');
      const tt = ttRaw.toLowerCase().replace(/\u00a0/g, ' ');
      const ttFlat = tt.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();

      // Mode detection — order matters (zen before time, etc.)
      if (/\bzen\b/.test(ttFlat) || /^\s*zen\b/m.test(tt)) {
        mode = 'zen';
        mode2 = 'zen';
      } else if (/\bquote\b/.test(ttFlat)) {
        mode = 'quote';
        if (/\bshort\b/.test(ttFlat)) quoteLength = 0;
        else if (/\bmedium\b/.test(ttFlat)) quoteLength = 1;
        else if (/\blong\b/.test(ttFlat)) quoteLength = 2;
        else if (/\bthicc\b|\bthick\b/.test(ttFlat)) quoteLength = 3;
        else if (/\bfavou?rite\b|\ball\b/.test(ttFlat)) quoteLength = -1;
        mode2 = String(quoteLength != null ? quoteLength : '-1');
      } else if (/\bwords\b/.test(ttFlat)) {
        mode = 'words';
        const wm = ttFlat.match(/\bwords\b(?:\s*[:x]?\s*|\s+)(\d+)\b/) || ttFlat.match(/\b(10|25|50|100)\b/);
        mode2 = wm ? wm[1] : 'custom';
      } else if (/\btime\b/.test(ttFlat)) {
        mode = 'time';
        const tm = ttFlat.match(/\btime\b(?:\s*[:x]?\s*|\s+)(\d+)\b/) || ttFlat.match(/\b(15|30|60|120)\b/);
        mode2 = tm ? tm[1] : 'custom';
      } else if (/\bcustom\b/.test(ttFlat)) {
        mode = 'custom';
        mode2 = 'other';
      }

      // Language: prefer explicit language group; never glue digits (avoid "10english")
      if (groups['language']) {
        language = groups['language'].toLowerCase().replace(/\s+/g, '_');
        language = language.replace(/^\d+/, '').replace(/[^a-z0-9_]/g, '') || language;
      }
      const lines = ttRaw.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
      // Last non-mode line is often the language (zen / english)
      const MODE_WORDS = new Set(['zen','quote','words','time','custom','short','medium','long','thicc','thick','favorite','favourite','all','punctuation','numbers']);
      for (let li = lines.length - 1; li >= 0; li--) {
        let line = lines[li].toLowerCase().replace(/\s+/g, '_');
        line = line.replace(/[^a-z0-9_]/g, '');
        // strip leading digits from "10english" mistakes
        line = line.replace(/^\d+/, '');
        if (!line || MODE_WORDS.has(line) || /^\d+$/.test(line)) continue;
        if (line.length >= 2) { language = line; break; }
      }
      if (/\benglish\b/i.test(ttFlat)) language = 'english';
      language = fixLanguageName(language);
      // tags: "eclipse" or multiple (group key may be "tags" after icon strip)
      const tagStr = groups['tags'] || groups['tag'] || '';
      if (tagStr) {
        const rawTags = tagStr.split(/[,\s]+/).map(s => s.trim())
          .filter(s => s && !/^tags?$/i.test(s) && s.length < 40);
        tags = resolveTagNamesToIds(rawTags);
      }
      // Fallback: active tags from config (chip on result / top bar)
      if (!tags.length) {
        try {
          const w = typeof pageWin === 'function' ? pageWin() : window;
          const cfgTags = w?.config?.tags || w?.db?.getSnapshot?.()?.tags || [];
          const active = (Array.isArray(cfgTags) ? cfgTags : [])
            .filter(t => t && (t.active === true || t.active === 'true'))
            .map(t => String(t._id || t.id || t.name || t))
            .filter(Boolean);
          if (active.length) tags = resolveTagNamesToIds(active);
        } catch (e) {}
      }
      // Fallback: visible tag text on result (e.g. "eclipse" under tags)
      if (!tags.length) {
        try {
          const tagEls = document.querySelectorAll(
            '#result .tags .tag, #result .group.tags .bottom .tag, .pageResult .tags .tag, #result .tags'
          );
          const raw = [];
          tagEls.forEach(el => {
            const t = (el.textContent || '').trim();
            if (t && t.length < 40 && !/^tags?$/i.test(t)) raw.push(t);
          });
          if (raw.length) tags = resolveTagNamesToIds(raw);
        } catch (e) {}
      }
      if (groups['difficulty']) {
        const d = groups['difficulty'].toLowerCase();
        if (['normal','expert','master'].includes(d)) difficulty = d;
      }
      // funbox group if present
      const fbStr = groups['funbox'] || groups['fun box'] || groups['funboxes'] || '';
      if (fbStr && !/^none$/i.test(fbStr.trim())) {
        funbox = fbStr.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_#|,]/g, '');
      }
    } catch (e) {}

    // Funbox often appears as extra line under test type (e.g. "read ahead easy")
    try {
      if (!funbox || funbox === 'none') {
        const bottoms = document.querySelectorAll('#result .group .bottom, #result .infoGroup .bottom, .pageResult .group .bottom');
        const phrases = [];
        bottoms.forEach(el => {
          const raw = (el.innerText || el.textContent || '');
          raw.split(/[\n|/]+/).forEach(line => {
            const t = line.trim().toLowerCase();
            if (t && t.length > 2 && t.length < 40) phrases.push(t);
          });
        });
        // Also whole result text lines
        const resEl = document.querySelector('#result, .pageResult');
        if (resEl) {
          (resEl.innerText || '').split('\n').forEach(line => {
            const t = line.trim().toLowerCase();
            if (/^(read ahead|memory|mirror|upside down|arrows|nausea|flip|rpe|tts|layoutfluid|alphabet|wordsflip|nobrains|advanced|handsoff)/.test(t)) {
              phrases.push(t);
            }
          });
        }
        for (const p of phrases) {
          if (/read\s*ahead\s*easy/.test(p)) { funbox = 'read_ahead_easy'; break; }
          if (/read\s*ahead\s*hard/.test(p)) { funbox = 'read_ahead_hard'; break; }
          if (/read\s*ahead/.test(p)) { funbox = 'read_ahead'; break; }
          if (/^(memory|mirror|nausea|arrows|rpe|tts|alphabet|nobrains)$/.test(p)) { funbox = p; break; }
          if (/upside\s*down/.test(p)) { funbox = 'upside_down'; break; }
          if (/layout\s*fluid|layoutfluid/.test(p)) { funbox = 'layoutfluid'; break; }
          // generic: multi-word non-mode line under test type
          if (/read_ahead|memory|mirror/.test(p.replace(/\s+/g, '_'))) {
            funbox = p.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
            break;
          }
        }
      }
    } catch (e) {}

    // 2) Config buttons — only fill gaps; never overwrite result-page mode/mode2
    try {
      if (!mode) {
        const modeBtn = document.querySelector('#testConfig .mode .textButton.active, .pageTest .mode .textButton.active');
        if (modeBtn) {
          const t = (modeBtn.textContent || '').trim().toLowerCase();
          if (['time', 'words', 'quote', 'zen', 'custom'].includes(t)) mode = t;
        }
      }
      const wordBtn = document.querySelector('#testConfig .wordCount .textButton.active, .pageTest .wordCount .textButton.active');
      const timeBtn = document.querySelector('#testConfig .time .textButton.active, .pageTest .time .textButton.active');
      if (mode === 'words' && (mode2 == null || mode2 === '') && wordBtn) {
        const w = (wordBtn.textContent || '').trim();
        mode2 = /^(10|25|50|100)$/.test(w) ? w : 'custom';
      } else if (mode === 'time' && (mode2 == null || mode2 === '') && timeBtn) {
        const t = (timeBtn.textContent || '').trim();
        mode2 = /^(15|30|60|120)$/.test(t) ? t : 'custom';
      } else if (mode === 'zen') {
        mode2 = 'zen';
      } else if (mode === 'quote' && (mode2 == null || mode2 === '')) {
        mode2 = String(quoteLength != null ? quoteLength : '-1');
      }
      const langEl = document.querySelector('#testConfig .language .textButton.active, .pageTest .language .textButton.active, .current-language');
      if (langEl && (!language || language === 'english')) {
        let lt = (langEl.textContent || language).trim().toLowerCase().replace(/\s+/g, '_');
        lt = lt.replace(/^\d+/, ''); // never "10english"
        if (lt) language = fixLanguageName(lt);
      }
      const punct = document.querySelector('#testConfig .punctuation.active, .pageTest .punctuation.active');
      punctuation = !!punct;
      const nums = document.querySelector('#testConfig .numbers.active, .pageTest .numbers.active');
      numbers = !!nums;
      if (!tags.length) {
        document.querySelectorAll('#testConfig .tags .textButton.active, .pageTest .tags .textButton.active, .tagsBtn .active').forEach((el) => {
          const id = el.getAttribute('data-tag-id') || el.dataset?.tagId;
          const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
          if (id) tags.push(String(id));
          else if (name && name.toLowerCase() !== 'tags') tags.push(name);
        });
        tags = resolveTagNamesToIds(tags);
      }
    } catch (e) {}

    // 3) Snapshot config.tags (active ids)
    try {
      const w = pageWin();
      const snap = (typeof w.db?.getSnapshot === 'function') ? w.db.getSnapshot() : findSnapshot();
      if (snap?.config?.tags?.length) {
        const ids = snap.config.tags.map(String);
        tags = [...new Set([...tags, ...ids])];
      }
      if (snap?.tags?.length) {
        snap.tags.forEach(t => {
          if (t && t.active) {
            const id = String(t._id || t.id || '');
            if (id) tags.push(id);
          }
        });
        tags = [...new Set(tags)];
      }
    } catch (e) {}

    // Quote number from source line
    try {
      const more = document.querySelector('#result .moreinfo, #result .group.info, #result .source');
      const txt = ((more && more.textContent) || '') + ' ' + (document.querySelector('#result')?.textContent || '');
      const qm = txt.match(/quote\s*#?\s*(\d+)/i);
      if (qm && mode === 'quote') mode2 = qm[1];
    } catch (e) {}

    // testDuration for quotes ≈ time field on result
    let testDuration = 0;
    try {
      const t = readNumFromResultGroup('time');
      if (t != null && t > 0) testDuration = t;
    } catch (e) {}
    if (!testDuration && mode === 'time') testDuration = Number(mode2) || 0;

    // Final defaults only if still missing
    if (!mode) mode = 'time';
    if (mode2 == null || mode2 === '') {
      if (mode === 'time') mode2 = '60';
      else if (mode === 'words') mode2 = 'custom';
      else if (mode === 'quote') mode2 = String(quoteLength != null ? quoteLength : '-1');
      else if (mode === 'zen') mode2 = 'zen';
      else if (mode === 'custom') mode2 = 'other';
      else mode2 = '';
    }
    language = fixLanguageName(String(language || 'english').replace(/^\d+/, ''));

    // Custom subtype: jail / low_confidence / tag list / other
    if (mode === 'custom') {
      let cname = '';
      try {
        const el = document.querySelector(
          '#result .group.customText .bottom, #result .customText, ' +
          '.pageResult .customText, #testConfig .customText .active, ' +
          '.pageTest .view-line, #words'
        );
        cname = (el && (el.getAttribute('data-name') || el.textContent) || '').toLowerCase();
        // Active custom list name from MT UI
        const activeList = document.querySelector('.customTextList .active, .savedTexts .active, [data-custom-text].active');
        if (activeList) cname = (activeList.textContent || cname).toLowerCase();
        // Jail UI indicator
        if (document.querySelector('#mt-jail-active:checked, .jail-active, [data-jail="1"]')) cname += ' jail';
      } catch (e) {}
      if (/\bjail\b/.test(cname)) mode2 = 'jail';
      else if (/low[_\s-]?confidence/.test(cname)) mode2 = 'low_confidence';
      else if (/graphite|eclipse|tag[_\s-]?custom|custom\s*list/.test(cname)) mode2 = 'tag_list';
      else if (mode2 === 'other' || !mode2) mode2 = 'other';
    }

    return {
      timestamp: Date.now(),
      wpm,
      rawWpm: raw != null ? raw : wpm,
      acc: acc != null ? acc : 0,
      consistency: cons != null ? cons : 0,
      mode,
      mode2: String(mode2),
      language,
      punctuation,
      numbers,
      funbox: funbox || 'none',
      tags,
      difficulty,
      isPb: !!document.querySelector('#result .group.wpm .badge, #result .pb, #result .crown'),
      testDuration,
      quoteLength,
      _source: 'ea-live-dom'
    };
  }

  function matchPendingStumble(result, opts) {
    if (!result) return result;
    const consume = !(opts && opts.noConsume);
    // Already has a real non-null stumblePct with word counts
    if (result.stumblePct != null && result.totalWords > 0) return result;

    const list = loadPendingStumbles();
    if (!list.length) return result;

    let ts = Number(result.timestamp) || 0;
    if (ts && ts < 1e12) ts *= 1000;
    if (!ts) ts = Date.now();
    const wpm = Number(result.wpm) || 0;
    const acc = Number(result.acc) || 0;

    let best = null;
    let bestIdx = -1;
    let bestScore = Infinity;
    const MAX_DT = 2 * 24 * 60 * 60 * 1000; // 2 days — match live stumbles to later CSV import
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p._used) continue;
      const dt = Math.abs((p.t || 0) - ts);
      if (dt > MAX_DT) continue;
      let score = dt / 1000;
      if (p.wpm != null && wpm) {
        const dw = Math.abs(Number(p.wpm) - wpm);
        if (dw > 1.5) continue;
        score += dw * 40;
      } else {
        score += 80;
      }
      if (p.acc != null && acc) {
        const da = Math.abs(Number(p.acc) - acc);
        if (da > 2) continue;
        score += da * 15;
      }
      if (p.mode && result.mode && String(p.mode) !== String(result.mode)) continue;
      if (score < bestScore) {
        bestScore = score;
        best = p;
        bestIdx = i;
      }
    }
    if (!best) return result;

    result.stumbledWords = best.stumbled;
    result.cleanWords = best.clean;
    result.totalWords = best.total;
    result.stumblePct = best.stumblePct;

    if (consume && bestIdx >= 0) {
      list.splice(bestIdx, 1);
      try { savePendingStumbles(list); } catch (e) {}
    }
    return result;
  }

  function applyPendingToResults(results) {
    return (results || []).map(r => matchPendingStumble(r, { noConsume: true }));
  }

  async function saveResult(result) {
    applyStumbleIndex(result);
    matchPendingStumble(result);
    if (result.stumblePct != null) rememberStumble(result);
    const dup = await findDuplicateResult(result);
    let oldLiveId = null;
    if (dup) {
      const incomingOfficial = !!(result._id || (result.id && !String(result.id).startsWith('live_')));
      const dupLive = String(dup.id || '').startsWith('live_') || dup._source === 'ea-live-dom';
      if (incomingOfficial && dupLive) {
        result = mergeServerOverLive(result, dup);
        oldLiveId = dup.id;
      } else if (!incomingOfficial && dup) {
        // Live save hitting existing — keep official id if any, merge stumble
        result.id = dup._id ? String(dup._id) : dup.id;
        if (dup._id) result._id = dup._id;
        if (Array.isArray(dup.tags) && dup.tags.length && !(result.tags && result.tags.length)) {
          result.tags = dup.tags.map(String);
        }
        mergeStumbleFromExisting(result, dup);
      } else {
        result.id = dup._id ? String(dup._id) : (result._id ? String(result._id) : dup.id);
        if (result._id) result.id = String(result._id);
        mergeStumbleFromExisting(result, dup);
        if (Array.isArray(result.tags) && result.tags.length === 0 && dup.tags?.length) {
          result.tags = dup.tags.map(String);
        }
      }
    } else {
      ensureResultId(result);
    }
    // If still no stumble (typical after API/CSV), pull from a same-day live twin or pending queue
    if (result.stumblePct == null) {
      matchPendingStumble(result);
    }
    if (result.stumblePct == null) {
      try {
        const donor = await findStumbleDonor(result);
        if (donor) mergeStumbleFromExisting(result, donor);
      } catch (e) {}
    }
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(result.id);
      req.onsuccess = () => {
        mergeStumbleFromExisting(result, req.result);
        store.put(result);
        // Remove temporary live_ row if we promoted to official id
        if (oldLiveId && oldLiveId !== result.id) {
          try { store.delete(oldLiveId); } catch (e) {}
        }
        // Also drop any other live_ twin that donated stumble (same wpm/acc/day)
        if (result.stumblePct != null && result._id) {
          // cleanup handled in bulk path
        }
      };
      req.onerror = () => store.put(result);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveResultsBulk(results) {
    if (!results.length) return 0;
    // Use saveResult per row so live_ temps are merged/corrected and not duplicated
    let count = 0;
    for (const raw of results) {
      try {
        const r = normalizeResult(raw);
        await saveResult(r);
        count++;
      } catch (e) {
        console.warn('[EA] saveResultsBulk row', e);
      }
    }
    // Cleanup: delete orphan live_ rows that now have an official twin
    try {
      const all = await getAllResults();
      const official = all.filter(r => r._id || (r.id && !String(r.id).startsWith('live_')));
      const lives = all.filter(r => String(r.id || '').startsWith('live_'));
      const database = await openDB();
      await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const live of lives) {
          const lts = resultTsMs(live);
          const match = official.find(o => {
            const ots = resultTsMs(o);
            return Math.abs(ots - lts) < 15000 &&
              Math.abs(Number(o.wpm) - Number(live.wpm)) < 0.15 &&
              (o.acc == null || live.acc == null || Math.abs(Number(o.acc) - Number(live.acc)) < 0.6);
          });
          if (match) {
            // Ensure stumble transferred
            if (live.stumblePct != null && match.stumblePct == null) {
              match.stumbledWords = live.stumbledWords;
              match.cleanWords = live.cleanWords;
              match.totalWords = live.totalWords;
              match.stumblePct = live.stumblePct;
              store.put(match);
            }
            store.delete(live.id);
          } else if (live.language && /shortenglish|mediumenglish|longenglish/i.test(String(live.language))) {
            live.language = 'english';
            store.put(live);
          }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[EA] live cleanup', e);
    }
    return count;
  }

  async function getAllResults() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteResultById(id) {
    if (id == null || id === '') return false;
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Newest N results via timestamp index (no full table scan) */
  async function getLastNResults(n) {
    const fallback = async () => {
      const all = await getAllResults();
      return all.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-n);
    };
    try {
      const database = await openDB();
      const out = await new Promise((resolve, reject) => {
        try {
          const tx = database.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          if (!store.indexNames.contains('timestamp')) {
            resolve(null);
            return;
          }
          const idx = store.index('timestamp');
          const acc = [];
          const req = idx.openCursor(null, 'prev');
          req.onsuccess = (e) => {
            const cur = e.target.result;
            if (cur && acc.length < n) {
              acc.push(cur.value);
              cur.continue();
            } else {
              resolve(acc);
            }
          };
          req.onerror = () => resolve(null);
        } catch (err) {
          resolve(null);
        }
      });
      if (out && out.length) return out.reverse();
    } catch (e) {
      console.warn('[EA] getLastN cursor', e);
    }
    return fallback();
  }

  /** Tag ids / funbox / language discovered without loading every field-heavy path */
  async function scanFilterOptions(maxScan) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const idx = tx.objectStore(STORE_NAME).index('timestamp');
      const tagIds = new Set();
      const langs = new Set();
      const fbs = new Set();
      let scanned = 0;
      const limit = maxScan || 500;
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || scanned >= limit) {
          resolve({ tagIds, langs, fbs, scanned });
          return;
        }
        const r = cur.value || {};
        (r.tags || []).forEach(t => {
          if (t == null || t === '') return;
          if (Array.isArray(t)) t.forEach(x => tagIds.add(String(x)));
          else tagIds.add(String(t));
        });
        if (r.language) langs.add(String(r.language));
        if (r.funbox && r.funbox !== 'none') {
          String(r.funbox).split(/[#|,]/).map(s => s.trim()).filter(s => s && s !== 'none').forEach(x => fbs.add(x));
        }
        scanned++;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getResultCount() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAllResults() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /*********************************************************************
   *  META / SETTINGS (legend state, last sync, known tags…)
   *********************************************************************/
  async function getMeta(key, fallback = null) {
    const row = await idbGet(META_STORE, key);
    return row ? row.value : fallback;
  }
  async function setMeta(key, value) {
    await idbPut(META_STORE, { key, value });
  }

  // Legend visibility (persisted)
  let legendState = {
    'WPM': true,
    'Avg of 10 (WPM)': true,
    'Avg of 100 (WPM)': true,
    'Accuracy': true,
    'Avg of 10 (Acc)': true,
    'Avg of 100 (Acc)': true
  };

  // UI prefs (persisted)
  let persistentTooltips = false;
  let bigDots = false;
  let trueAverage = false;
  try {
    persistentTooltips = localStorage.getItem('ea_persistent_tooltips') === '1';
    bigDots = localStorage.getItem('ea_big_dots') === '1';
    trueAverage = localStorage.getItem('ea_true_average') === '1';
  } catch (e) {}
  function saveUiPrefs() {
    try {
      localStorage.setItem('ea_persistent_tooltips', persistentTooltips ? '1' : '0');
      localStorage.setItem('ea_big_dots', bigDots ? '1' : '0');
      localStorage.setItem('ea_true_average', trueAverage ? '1' : '0');
    } catch (e) {}
    try { setMeta('uiPrefs', { persistentTooltips, bigDots, trueAverage }); } catch (e) {}
  }
  function baseDotRadius() { return bigDots ? 3.6 : 1.3; }
  function baseHoverRadius() { return bigDots ? 7 : 4; }
  function baseAggDotRadius() { return bigDots ? 4.5 : 2; }

  /** +1px when zoomed in on X (scriptable Chart.js radius) */
  function zoomBoost(chart) {
    try {
      const x = chart && chart.scales && chart.scales.x;
      if (!x) return 0;
      const full = chart.$eaFullX;
      if (!full || !(full.max > full.min)) return 0;
      const cur = x.max - x.min;
      if (!(cur > 0)) return 0;
      const zoom = (full.max - full.min) / cur;
      return zoom > 1.15 ? 1 : 0;
    } catch (e) { return 0; }
  }
  function dotRadius(ctx) {
    const base = baseDotRadius();
    const chart = ctx && ctx.chart;
    return base + zoomBoost(chart);
  }
  function dotHoverRadius(ctx) {
    const base = baseHoverRadius();
    const chart = ctx && ctx.chart;
    return base + zoomBoost(chart);
  }
  function aggDotRadius(ctx) {
    const base = baseAggDotRadius();
    const chart = ctx && ctx.chart;
    return base + zoomBoost(chart);
  }


  /*********************************************************************
   *  NORMALIZE
   *********************************************************************/
  function fixLanguageName(lang) {
    if (lang == null || lang === '') return 'english';
    let s = String(lang).toLowerCase().trim().replace(/\s+/g, '_');
    // Live-scrape / API quirks: quote length or zen glued onto language
    s = s.replace(/^(short|medium|long|thicc|thick)/, '');
    s = s.replace(/zenenglish/g, 'english');
    s = s.replace(/^zen_?/, '');
    if (!s || s === 'english' || s === 'zen') return 'english';
    if (/shortenglish|mediumenglish|longenglish|thiccenglish/.test(String(lang).toLowerCase().replace(/\s+/g, ''))) return 'english';
    if (!s) return 'english';
    return s;
  }

  function repairResultMeta(r) {
    if (!r) return r;
    const langRaw = String(r.language || '').toLowerCase();
    const modeRaw = String(r.mode || '').toLowerCase();
    const isZen = modeRaw === 'zen' || langRaw === 'zen' || langRaw.startsWith('zen') ||
      /zenenglish|zen_english/.test(langRaw);
    if (isZen) {
      r.mode = 'zen';
      let lang = fixLanguageName(langRaw.replace(/zenenglish/g, 'english').replace(/^zen_?/, ''));
      if (!lang || lang === 'zen') lang = 'english';
      r.language = lang;
    }
    if (r.mode) r.mode = String(r.mode).toLowerCase();
    return applyTypeFields(r);
  }

  /** Map quoteLength index / legacy mode2 → type label */
  function quoteTypeFromLength(ql) {
    const n = Number(ql);
    if (n === 0) return 'short';
    if (n === 1) return 'medium';
    if (n === 2) return 'long';
    if (n === 3) return 'thicc';
    // -1 means "all" on MT UI — never store as type for archive graphs
    return null;
  }

  /** Infer quote size from word/char counts when only quote id was stored */
  function inferQuoteTypeFromSize(r) {
    let chars = 0;
    if (Array.isArray(r.charStats) && r.charStats.length) {
      chars = Number(r.charStats[0]) || 0;
    }
    if (!chars && r.totalWords) chars = Number(r.totalWords) * 5;
    if (!chars && r.wpm && r.testDuration) chars = (Number(r.wpm) / 60) * 5 * Number(r.testDuration);
    const words = Number(r.totalWords) || (chars ? chars / 5 : 0);
    // Monkeytype-ish thresholds
    if (chars > 0) {
      if (chars <= 100) return 'short';
      if (chars <= 300) return 'medium';
      if (chars <= 600) return 'long';
      return 'thicc';
    }
    if (words > 0) {
      if (words <= 20) return 'short';
      if (words <= 55) return 'medium';
      if (words <= 110) return 'long';
      return 'thicc';
    }
    return null;
  }

  /**
   * Ensure separate mode + type fields.
   * mode: time|words|quote|zen|custom
   * type: 15/30/60/120/custom | 10/25/50/100/custom | all/short/medium/long/thicc/favorite | zen | jail|low_confidence|tag_list|other
   */
  function applyTypeFields(r) {
    if (!r) return r;
    let mode = String(r.mode || 'time').toLowerCase();
    let mode2 = r.mode2 != null ? String(r.mode2) : '';
    let type = r.type != null ? String(r.type) : '';

    // Legacy: mode was "time 60" combined
    if (mode.includes(' ')) {
      const parts = mode.split(/\s+/);
      mode = parts[0];
      if (!mode2 && parts[1]) mode2 = parts[1];
    }

    if (mode === 'time') {
      if (['15','30','60','120'].includes(mode2)) type = mode2;
      else if (['15','30','60','120'].includes(type)) { /* keep */ }
      else type = type && type !== 'zen' ? type : (mode2 && mode2 !== 'time' ? mode2 : 'custom');
      if (!['15','30','60','120','custom'].includes(type)) type = 'custom';
    } else if (mode === 'words') {
      if (['10','25','50','100'].includes(mode2)) type = mode2;
      else if (['10','25','50','100'].includes(type)) { /* keep */ }
      else type = 'custom';
      if (!['10','25','50','100','custom'].includes(type)) type = 'custom';
    } else if (mode === 'quote') {
      // Prefer explicit quoteLength 0–3 only (never "all"/"favorite" as stored type)
      let qt = quoteTypeFromLength(r.quoteLength);
      if (!qt && ['0','1','2','3'].includes(mode2)) qt = quoteTypeFromLength(mode2);
      if (!qt && ['short','medium','long','thicc'].includes(mode2)) qt = mode2;
      if (!qt && ['short','medium','long','thicc'].includes(type)) qt = type;
      // mode2 is a large number → quote id, not length
      if (!qt && mode2 && /^\d+$/.test(mode2) && Number(mode2) > 3) {
        r.quoteId = Number(mode2);
        qt = inferQuoteTypeFromSize(r);
      }
      // mode2 -1 or type all/favorite/unknown → infer from size
      if (!qt || qt === 'all' || qt === 'favorite' || qt === 'favourite' || qt === 'unknown') {
        qt = inferQuoteTypeFromSize(r);
      }
      // Still nothing? bucket by totalWords / duration heuristics, else medium
      if (!qt) {
        const w = Number(r.totalWords) || 0;
        if (w > 0) {
          if (w <= 20) qt = 'short';
          else if (w <= 55) qt = 'medium';
          else if (w <= 110) qt = 'long';
          else qt = 'thicc';
        } else {
          qt = 'medium';
        }
      }
      type = qt;
      const qlMap = { short: 0, medium: 1, long: 2, thicc: 3 };
      if (qlMap[type] != null) r.quoteLength = qlMap[type];
    } else if (mode === 'zen') {
      type = 'zen';
    } else if (mode === 'custom') {
      if (['jail','low_confidence','tag_list','other'].includes(mode2)) type = mode2;
      else if (['jail','low_confidence','tag_list','other'].includes(type)) { /* keep */ }
      else type = 'other';
    } else {
      type = type || mode2 || '';
    }

    r.mode = mode;
    r.type = type;
    // Preserve mode2 for backward compat (mirrors type for simple modes)
    if (mode === 'quote') {
      const qlMap = { short: 0, medium: 1, long: 2, thicc: 3, all: -1, favorite: -1 };
      r.mode2 = qlMap[type] != null ? String(qlMap[type]) : mode2;
    } else {
      r.mode2 = type || mode2;
    }
    return r;
  }

  function normalizeResult(raw) {
    const r = { ...raw };
    {
      let ts = Number(r.timestamp);
      if (ts && ts < 1e12) ts *= 1000; // seconds → ms
      // Reject epoch / pre-2000 (1/1/1970 bug)
      if (!ts || ts < 946684800000 || ts > Date.now() + 864e5) ts = Date.now();
      r.timestamp = ts;
    }
    r.wpm = Number(r.wpm) || 0;
    r.rawWpm = Number(r.rawWpm || r.raw) || r.wpm;
    // Keep null when unknown — do NOT invent 0% acc or time/60
    if (r.acc != null && r.acc !== '') r.acc = Number(r.acc);
    else r.acc = null;
    if (r.consistency != null && r.consistency !== '') r.consistency = Number(r.consistency);
    else r.consistency = null;
    if (r.mode) r.mode = String(r.mode);
    else r.mode = null;
    if (r.mode2 != null && r.mode2 !== '') r.mode2 = String(r.mode2);
    else r.mode2 = null;
    r.language = fixLanguageName(r.language);
    r.difficulty = r.difficulty || 'normal';
    r.punctuation = !!r.punctuation;
    r.numbers = !!r.numbers;
    if (Array.isArray(r.funbox)) {
      r.funbox = r.funbox.filter(Boolean).map(s => String(s).toLowerCase().replace(/\s+/g, '_')).join('#') || 'none';
    } else {
      r.funbox = (r.funbox != null && r.funbox !== '') ? String(r.funbox).toLowerCase().replace(/\s+/g, '_') : 'none';
    }
    if (!r.funbox) r.funbox = 'none';
    r.tags = Array.isArray(r.tags) ? r.tags.map(String) : (r.tags ? [String(r.tags)] : []);
    r.isPb = !!r.isPb;
    r.quoteLength = r.quoteLength;
    r.testDuration = r.testDuration || Number(r.mode2) || 0;
    r.restartCount = r.restartCount || 0;
    r.bailedOut = !!r.bailedOut;
    r.blindMode = !!r.blindMode;
    r.lazyMode = !!r.lazyMode;
    // Stumble metric: words with ≥1 mistake count as 1 stumble
    if (r.stumbledWords != null) r.stumbledWords = Number(r.stumbledWords);
    if (r.cleanWords != null) r.cleanWords = Number(r.cleanWords);
    if (r.totalWords != null) r.totalWords = Number(r.totalWords);
    if (r.stumblePct != null) {
      r.stumblePct = Number(r.stumblePct);
    } else if (r.stumbledWords != null && r.totalWords > 0) {
      r.stumblePct = (r.stumbledWords / r.totalWords) * 100;
    } else {
      r.stumblePct = null;
    }
    return repairResultMeta(r);
  }

  /**
   * Stumble tracking v3 — lightweight (no full-document MutationObserver)
   */
  // ---------- Stumble tracking (aligned with Jail Mode) ----------
  // Track by target word TEXT when active/typed word shows real error letters.
  // Do NOT use letter.corrected (overcounts) or data-wordindex (inflates totals).
  const stumbledWordTexts = new Set();
  let lastStumbleSnapshot = null;
  let scanScheduled = false;
  let lastScanAt = 0;

  const SS_STUMBLE = 'ea_stumble_words';
  const SS_MAX = 'ea_stumble_max'; // kept for compat clear

  function pageWin() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (e) {}
    return window;
  }

  function persistStumbleState() {
    try {
      sessionStorage.setItem(SS_STUMBLE, JSON.stringify([...stumbledWordTexts]));
    } catch (e) {}
  }

  function restoreStumbleState() {
    try {
      const raw = sessionStorage.getItem(SS_STUMBLE);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((t) => { if (t) stumbledWordTexts.add(String(t)); });
      }
    } catch (e) {}
  }

  function clearStumbleState() {
    stumbledWordTexts.clear();
    lastStumbleSnapshot = null;
    try {
      sessionStorage.removeItem(SS_STUMBLE);
      sessionStorage.removeItem(SS_MAX);
    } catch (e) {}
  }

  function cleanWordText(w) {
    let t = String(w || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'’-]+$/u, '');
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return '';
    return t;
  }

  /** Target word only — never typed .extra letters from textContent */
  function wordTargetText(el) {
    if (!el) return '';
    const dw = el.getAttribute('data-word');
    if (dw) return cleanWordText(dw);
    let s = '';
    el.querySelectorAll('letter, .letter').forEach((l) => {
      if (l.classList.contains('extra')) return;
      s += (l.textContent || '');
    });
    if (s) return cleanWordText(s);
    return cleanWordText(el.textContent || '');
  }

  function letterErrorSelector() {
    // Same as Jail Mode — NOT corrected, NOT speed heatmap
    return (
      'letter.incorrect, letter.extra, letter.missed, ' +
      '.letter.incorrect, .letter.extra, .letter.missed'
    );
  }

  function wordHasMistake(w) {
    if (!w) return false;
    return !!w.querySelector(letterErrorSelector());
  }

  function isRealWordEl(w) {
    if (!w || !w.classList || !w.classList.contains('word')) return false;
    const dw = (w.getAttribute('data-word') || '').trim();
    if (dw && /[\p{L}\p{N}]/u.test(dw)) return true;
    const letters = w.querySelectorAll('letter, .letter');
    if (!letters.length) return false;
    let t = '';
    letters.forEach((l) => { t += (l.textContent || ''); });
    return /[\p{L}\p{N}]/u.test(t.trim());
  }

  function getTestWordElements() {
    const pick = (nodeList) => Array.from(nodeList || []).filter(isRealWordEl);
    // Prefer full result history when present
    const hist = pick(document.querySelectorAll('#resultWordsHistory .word'));
    if (hist.length) return hist;
    const live = pick(document.querySelectorAll('#words .word'));
    return live;
  }

  function captureMistakesImmediate() {
    try {
      if (isResultScreenVisible()) return;
      const sel = letterErrorSelector();
      const active = document.querySelector('#words .word.active');
      if (active && active.querySelector(sel)) {
        const t = wordTargetText(active);
        if (t) stumbledWordTexts.add(t);
      }
      // Any word that still shows hard error letters
      document.querySelectorAll('#words .word').forEach((w) => {
        if (w.querySelector(sel)) {
          const t = wordTargetText(w);
          if (t) stumbledWordTexts.add(t);
        }
      });
      if (stumbledWordTexts.size) persistStumbleState();
    } catch (e) {}
  }

  function scanWordsNow() {
    lastScanAt = Date.now();
    captureMistakesImmediate();
    // Final/history DOM still showing hard errors
    const sel = letterErrorSelector();
    document.querySelectorAll('#resultWordsHistory .word, #words .word').forEach((w) => {
      if (!isRealWordEl(w)) return;
      if (w.querySelector(sel)) {
        const t = wordTargetText(w);
        if (t) stumbledWordTexts.add(t);
      }
    });
    persistStumbleState();
    updateStumbleHud();
    finalizeSnapshotFromState();
  }

  // Observe letter class changes while typing (more reliable than keys alone)
  let wordsMistakeObserver = null;
  function bindWordsMistakeObserver() {
    const root = document.getElementById('words');
    if (!root) return;
    if (wordsMistakeObserver) {
      try { wordsMistakeObserver.disconnect(); } catch (e) {}
    }
    wordsMistakeObserver = new MutationObserver(() => {
      if (!isResultScreenVisible()) captureMistakesImmediate();
    });
    try {
      wordsMistakeObserver.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class']
      });
    } catch (e) {}
  }
  setInterval(bindWordsMistakeObserver, 1000);
  setTimeout(bindWordsMistakeObserver, 300);

  function finalizeSnapshotFromState() {
    const words = getTestWordElements();
    const total = words.length;
    // Count unique jailed-style targets that appear in this test's words
    const present = new Set(words.map(wordTargetText).filter(Boolean));
    let stumbled = 0;
    for (const t of stumbledWordTexts) {
      if (present.has(t)) stumbled++;
    }
    // Also count hard-error words still on DOM even if text set missed them
    const sel = letterErrorSelector();
    words.forEach((w) => {
      if (w.querySelector(sel)) {
        const t = wordTargetText(w);
        if (t && !stumbledWordTexts.has(t)) {
          stumbledWordTexts.add(t);
          stumbled++;
        }
      }
    });
    if (total > 0) stumbled = Math.min(stumbled, total);
    if (total > 0 || stumbled > 0) {
      const tot = total > 0 ? total : Math.max(stumbled, 1);
      lastStumbleSnapshot = {
        stumbled,
        clean: Math.max(0, tot - stumbled),
        total: tot,
        stumblePct: tot ? (stumbled / tot) * 100 : 0
      };
      try {
        pageWin().__eaLastStumble = lastStumbleSnapshot;
        window.__eaLastStumble = lastStumbleSnapshot;
      } catch (e) {}
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      if (Date.now() - lastScanAt < 80) return;
      try { scanWordsNow(); } catch (e) {}
    });
  }

  function countStumblesFromResultDOM() {
    // Force history open if needed
    try {
      const hist = document.querySelector('#resultWordsHistory');
      const btn = document.getElementById('showWordHistoryButton');
      if (btn && hist && hist.querySelectorAll('.word').length === 0) btn.click();
    } catch (e) {}
    restoreStumbleState();
    scanWordsNow();
    finalizeSnapshotFromState();
    return lastStumbleSnapshot;
  }

  function buildStumbleSnapshot() {
    // Prefer freeze from rising edge of result (live error classes often gone by now)
    if (frozenStumbleSnapshot && frozenStumbleSnapshot.total > 0) {
      return frozenStumbleSnapshot;
    }
    const onResult = !!document.querySelector(
      '#result .group.wpm, #result .wrapper, #resultWordsHistory .word'
    );
    if (onResult) {
      restoreStumbleState();
      try { scanWordsNow(); } catch (e) {}
      finalizeSnapshotFromState();
      if (lastStumbleSnapshot && lastStumbleSnapshot.total > 0) {
        if (!frozenStumbleSnapshot) frozenStumbleSnapshot = { ...lastStumbleSnapshot };
        queuePendingStumble(lastStumbleSnapshot, readWpmFromResultDOM(), { acc: readNumFromResultGroup("acc") });
        return lastStumbleSnapshot;
      }
    }
    restoreStumbleState();
    try { scanWordsNow(); } catch (e) {}
    return lastStumbleSnapshot;
  }

  // no-op stubs so old calls don't break
  function updateStumbleHud() {}
  function ensureStumbleHud() { return null; }

  function attachStumble(result) {
    const s = buildStumbleSnapshot() || lastStumbleSnapshot;
    if (!s || !s.total) return result;
    result.stumbledWords = s.stumbled;
    result.cleanWords = s.clean;
    result.totalWords = s.total;
    result.stumblePct = s.stumblePct;
    return result;
  }

  function countStumblesFromDOM() {
    return buildStumbleSnapshot();
  }

  // Light polling only (no document-wide MutationObserver)
  setInterval(() => {
    try {
      if (document.querySelector('#words .word')) scheduleScan();
    } catch (e) {}
  }, 400);

  document.addEventListener('keyup', () => {
    requestAnimationFrame(captureMistakesImmediate);
    scheduleScan();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') return;
    requestAnimationFrame(captureMistakesImmediate);
  }, true);
  document.addEventListener('input', () => {
    requestAnimationFrame(captureMistakesImmediate);
    scheduleScan();
  }, true);

  // Observe ONLY #words when it exists — not the whole document
  let wordsObserver = null;
  function bindWordsObserver() {
    const root = document.getElementById('words');
    if (!root || wordsObserver) return;
    wordsObserver = new MutationObserver(() => scheduleScan());
    try {
      wordsObserver.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class']
      });
    } catch (e) {}
  }
  setInterval(bindWordsObserver, 2000);
  setTimeout(bindWordsObserver, 500);

  function isResultScreenVisible() {
    if (document.getElementById('resultWordsHistory') ||
        document.querySelector('#resultWordsHistory, .resultWordsHistory')) return true;
    const r = document.querySelector('#result');
    if (!r || r.classList.contains('hidden')) return false;
    try {
      const style = window.getComputedStyle(r);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch (e) {}
    const wpmEl = r.querySelector('.group.wpm .bottom, .wpm .bottom, .group.wpm');
    if (wpmEl) {
      const n = parseFloat(String(wpmEl.textContent || '').replace(/[^0-9.]/g, ''));
      if (!isNaN(n) && n > 0) return true;
    }
    return !!(r.offsetHeight > 40 && r.querySelector('.group.wpm, .group.acc'));
  }

  function isTestActive() {
    const words = document.querySelector('#words');
    const input = document.querySelector('#wordsInput');
    const wordsLive = !!(words && words.querySelector('.word') && words.offsetHeight > 0);
    // Only treat as result-screen when WPM score is actually painted (not a hidden shell)
    const r = document.querySelector('#result');
    let resultDone = false;
    if (r && !r.classList.contains('hidden')) {
      const st = window.getComputedStyle(r);
      if (st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05) {
        const wpmEl = r.querySelector('.group.wpm .bottom, .wpm .bottom');
        const wpmTxt = (wpmEl && wpmEl.textContent || '').trim();
        if (wpmTxt && /\d/.test(wpmTxt) && r.offsetHeight > 40) resultDone = true;
      }
    }
    if (resultDone) return false;
    if (input && document.activeElement === input) return true;
    if (wordsLive) return true;
    // Keep session alive briefly if we were mid-test (focus loss)
    if (session && session.started && !session._finalized && session.keys && session.keys.length) {
      const last = session.keys[session.keys.length - 1];
      if (last && Date.now() - last.ts < 3000) return true;
    }
    return false;
  }

  // ---------- Lifetime keys / kcal (persistent) ----------
  // Excess only vs sitting still. MET literature: quiet sit ~1.0, desk typing ~1.2–1.35.
  // Fat tissue (with water): ~7000 kcal per kg.
  const LS_KEYS = 'ea_lifetime_keys';
  const LS_KCAL = 'ea_lifetime_kcal';
  const LS_BODY = 'ea_body_profile'; // {age, gender, weightKg, avgWpm, kcalPerKey}
  const KCAL_PER_KG_FAT = 7000;
  let lifetimeKeys = 0;
  let lifetimeKcal = 0;
  let kcalPerKey = 0.0012; // default until body profile set
  let bodyProfile = null;

  function computeKcalPerKey(age, gender, weightKg, avgWpm) {
    age = Math.min(130, Math.max(2, Number(age) || 30));
    weightKg = Number(weightKg);
    avgWpm = Math.max(5, Math.min(300, Number(avgWpm) || 60));
    const g = String(gender || 'm').toLowerCase().startsWith('f') ? 'f' : 'm';

    if (!(weightKg >= 5 && weightKg <= 300)) {
      return { error: weightKg > 300 ? 'Lose some weight and come back.' : 'Drink your milk, baby' };
    }

    // Compendium: quiet sit 1.0 MET, computer typing ~1.3 MET → excess ~0.30 at normal pace.
    // Pure finger mechanical work is tiny; most excess is neuromuscular + attention.
    // Competitive speed raises heart rate / co-contraction / CNS load roughly with rate.
    // Model: excess MET grows nearly linearly with WPM so total kcal/h scales with effort,
    // while kcal/key still falls moderately (more keys share the base posture cost).
    //
    // kcal/min = MET × 3.5 × kg / 200  →  kcal/h = MET × 1.05 × kg
    //
    // Targets (81 kg male, age-adjusted separately):
    //   60 wpm  → ~0.30 excess MET → ~25 kcal/h
    //  120 wpm  → ~0.52 excess MET → ~44 kcal/h
    //  200 wpm  → ~0.80 excess MET → ~68 kcal/h
    //  260 wpm  → ~1.00 excess MET → ~85 kcal/h
    const speedRatio = avgWpm / 60;
    let excessMet = 0.08 + 0.22 * speedRatio; // 60→0.30, 260→1.03
    excessMet = Math.min(1.35, Math.max(0.12, excessMet)); // clamp: sit-to-light-exercise band
    // Sex: small muscle-mass / RMR adjustment
    excessMet *= (g === 'm' ? 1.03 : 0.97);
    // Age: RMR declines ~1–2% per decade after 30
    if (age < 18) excessMet *= 0.97;
    else if (age > 30) excessMet *= (1 - Math.min(0.10, (age - 30) * 0.0015));

    const kcalPerHour = excessMet * 1.05 * weightKg;
    const keysPerHour = avgWpm * 5 * 60; // 5 keystrokes per "word"
    const kpk = kcalPerHour / Math.max(1, keysPerHour);

    return {
      kcalPerKey: kpk,
      excessMet,
      kcalPerHour,
      keysPerHour,
      age,
      gender: g,
      weightKg,
      avgWpm
    };
  }

  function loadLifetimeKeys() {
    try {
      lifetimeKeys = parseInt(localStorage.getItem(LS_KEYS) || '0', 10) || 0;
      lifetimeKcal = parseFloat(localStorage.getItem(LS_KCAL) || '0') || 0;
      const body = JSON.parse(localStorage.getItem(LS_BODY) || 'null');
      if (body && typeof body.kcalPerKey === 'number' && body.kcalPerKey > 0) {
        kcalPerKey = body.kcalPerKey;
        bodyProfile = body;
      }
    } catch (e) {}
    updateKeysHud();
  }

  function addLifetimeKeys(n) {
    n = Number(n) || 0;
    if (n <= 0) return;
    lifetimeKeys += n;
    lifetimeKcal += n * kcalPerKey;
    try {
      localStorage.setItem(LS_KEYS, String(lifetimeKeys));
      localStorage.setItem(LS_KCAL, String(lifetimeKcal));
    } catch (e) {}
    updateKeysHud();
  }

  function formatKeys(n) {
    return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function updateKeysHud() {
    let el = document.getElementById('ea-keys-hud');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ea-keys-hud';
      el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:190;font:12px/1.35 monospace;color:var(--text-color,#d1d0c5);background:color-mix(in srgb,var(--bg-color,#323437) 88%,transparent);padding:8px 10px;border-radius:10px;pointer-events:auto;max-width:220px;';
      el.innerHTML = '<div class="k"></div><div class="p"></div><div class="c"></div><div class="f"></div><button type="button" id="ea-body-btn" style="margin-top:4px;font:11px monospace;cursor:pointer;border:1px solid var(--sub-color,#646669);background:var(--sub-alt-color,#2c2e31);color:inherit;border-radius:6px;padding:2px 8px;">body</button>';
      document.body.appendChild(el);
      el.querySelector('#ea-body-btn').onclick = openBodyDialog;
    }
    const fatKg = lifetimeKcal / KCAL_PER_KG_FAT;
    el.querySelector('.k').textContent = 'Keys: ' + formatKeys(lifetimeKeys);
    el.querySelector('.p').textContent = 'kcal/key: ' + kcalPerKey.toFixed(6);
    el.querySelector('.c').textContent = 'Spent kcal: ' + lifetimeKcal.toFixed(1) + ' (vs sitting)';
    el.querySelector('.f').textContent = '≈ fat: ' + fatKg.toFixed(3) + ' kg';
  }

  function openBodyDialog() {
    const prev = bodyProfile || {};
    const age = prompt('Age (2-130):', String(prev.age != null ? prev.age : 30));
    if (age === null) return;
    const gender = prompt('Gender (m/f):', String(prev.gender || 'm'));
    if (gender === null) return;
    const weight = prompt('Bodyweight kg (5-300):', String(prev.weightKg != null ? prev.weightKg : 70));
    if (weight === null) return;
    const wpm = prompt('Average WPM:', String(prev.avgWpm != null ? prev.avgWpm : 60));
    if (wpm === null) return;

    const result = computeKcalPerKey(age, gender, weight, wpm);
    if (result.error) {
      alert(result.error);
      return;
    }

    kcalPerKey = result.kcalPerKey;
    bodyProfile = {
      age: result.age,
      gender: result.gender,
      weightKg: result.weightKg,
      avgWpm: result.avgWpm,
      kcalPerKey: result.kcalPerKey,
      excessMet: result.excessMet,
      kcalPerHour: result.kcalPerHour
    };
    try {
      localStorage.setItem(LS_BODY, JSON.stringify(bodyProfile));
    } catch (e) {}
    updateKeysHud();
    showToast(
      'Body saved — ' + result.kcalPerHour.toFixed(1) + ' kcal/h excess @ ' +
      result.avgWpm + ' wpm → ' + result.kcalPerKey.toFixed(6) + ' kcal/key',
      'success',
      5000
    );
  }

  // Count keypresses once per physical press (keydown only — no beforeinput / duplicate binds)
  let lastKeyCountAt = 0;
  let lastKeyCountCode = '';
  function handleTypingKey(e) {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (!(k === 'Backspace' || k === ' ' || k.length === 1)) return;
    if (!isTestActive()) return;
    // Dedupe: same code within 30ms = one press (Kanata / dual listeners)
    const now = performance.now();
    const code = e.code || e.key;
    if (code === lastKeyCountCode && now - lastKeyCountAt < 30) return;
    lastKeyCountAt = now;
    lastKeyCountCode = code;
    addLifetimeKeys(1);
  }
  document.addEventListener('keydown', handleTypingKey, true);

  // Frozen snapshot when result appears (survives #words teardown + clear races)
  let frozenStumbleSnapshot = null;
  let wasResultVisible = false;

  function freezeStumbleIfNeeded() {
    restoreStumbleState();
    try { captureMistakesImmediate(); } catch (e) {}
    try { scanWordsNow(); } catch (e) {}
    finalizeSnapshotFromState();
    // If we tracked mistake texts, force count even when result DOM lost error classes
    if (stumbledWordTexts.size && lastStumbleSnapshot) {
      const words = getTestWordElements();
      const total = words.length || lastStumbleSnapshot.total || stumbledWordTexts.size;
      const present = new Set(words.map(wordTargetText).filter(Boolean));
      let stumbled = 0;
      for (const t of stumbledWordTexts) {
        // Count if present in test, OR if present set empty (history not open yet)
        if (!present.size || present.has(t)) stumbled++;
      }
      stumbled = Math.min(stumbled, total || stumbled);
      lastStumbleSnapshot = {
        stumbled,
        clean: Math.max(0, (total || stumbled) - stumbled),
        total: total || stumbled,
        stumblePct: (total || stumbled) ? (stumbled / (total || stumbled)) * 100 : 0
      };
    }
    if (lastStumbleSnapshot && lastStumbleSnapshot.total > 0) {
      // Keep best freeze (don't overwrite a good freeze with a later 0)
      if (
        !frozenStumbleSnapshot ||
        (lastStumbleSnapshot.stumbled > (frozenStumbleSnapshot.stumbled || 0))
      ) {
        frozenStumbleSnapshot = { ...lastStumbleSnapshot };
      }
      try {
        pageWin().__eaLastStumble = frozenStumbleSnapshot;
        window.__eaLastStumble = frozenStumbleSnapshot;
      } catch (e) {}
      queuePendingStumble(frozenStumbleSnapshot, readWpmFromResultDOM(), { acc: readNumFromResultGroup("acc") });
      console.log('[EA] freeze stumble', frozenStumbleSnapshot, [...stumbledWordTexts]);
    }
  }

  // Rising edge of result panel — freeze stumble + auto-save test into IndexedDB
  let eaCaptureGen = 0;
  let eaLastGoodStumble = null; // survives quick restart long enough for delayed saves
  setInterval(() => {
    const vis = isResultScreenVisible();
    if (vis && !wasResultVisible) {
      const gen = ++eaCaptureGen;
      freezeStumbleIfNeeded();
      setTimeout(freezeStumbleIfNeeded, 100);
      setTimeout(() => {
        if (gen !== eaCaptureGen) return;
        freezeStumbleIfNeeded();
        tryCaptureFromPage();
        if (frozenStumbleSnapshot) {
          eaLastGoodStumble = {
            ...frozenStumbleSnapshot,
            t: Date.now(),
            wpm: readWpmFromResultDOM(),
            acc: readNumFromResultGroup('acc')
          };
          patchLatestResultWithStumble(frozenStumbleSnapshot);
        }
      }, 200);
      setTimeout(() => { if (gen === eaCaptureGen) tryCaptureFromPage(); }, 400);
      setTimeout(() => { if (gen === eaCaptureGen) tryCaptureFromPage(); }, 900);
      setTimeout(() => { if (gen === eaCaptureGen) tryCaptureFromPage(); }, 1800);
      setTimeout(() => { if (gen === eaCaptureGen) tryCaptureFromPage(); }, 3000);
    }
    if (!vis && wasResultVisible) {
      // Leaving result (incl. quick Enter restart): bump gen so delayed captures stop.
      // Keep eaLastGoodStumble for a few seconds so a late save can still attach.
      eaCaptureGen++;
      if (frozenStumbleSnapshot && frozenStumbleSnapshot.total > 0 &&
          (frozenStumbleSnapshot.stumbled > 0 || frozenStumbleSnapshot.stumblePct > 0)) {
        eaLastGoodStumble = {
          ...frozenStumbleSnapshot,
          t: Date.now(),
          wpm: readWpmFromResultDOM(),
          acc: readNumFromResultGroup('acc')
        };
      }
      frozenStumbleSnapshot = null;
      clearStumbleState();
    }
    wasResultVisible = vis;
  }, 150);

  // Enter or Tab on result → finalize. Mid-test restart → clear.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const onResult = isResultScreenVisible();
    if (onResult) {
      try {
        freezeStumbleIfNeeded();
        const s = frozenStumbleSnapshot || lastStumbleSnapshot;
        if (s && s.total) {
          if (s.stumbled > 0 || s.stumblePct > 0) {
            eaLastGoodStumble = {
              ...s,
              t: Date.now(),
              wpm: readWpmFromResultDOM(),
              acc: readNumFromResultGroup('acc')
            };
          }
          queuePendingStumble(s, readWpmFromResultDOM());
          patchLatestResultWithStumble(s);
        }
        // Save now before quick-restart tears the result screen down
        tryCaptureFromPage();
      } catch (err) {}
      return;
    }
    // Restart mid-test (Enter/Tab while words still active)
    if (document.querySelector('#words .word')) {
      frozenStumbleSnapshot = null;
      clearStumbleState();
      console.log('[EA] mid-test restart — stumble cleared');
    }
  }, true);

  // Restart button click
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest(
      '#restartTestButton, #restart-test-button, .restart, [data-command="restartTest"]'
    );
    if (!t) return;
    if (!isResultScreenVisible()) {
      frozenStumbleSnapshot = null;
      clearStumbleState();
      console.log('[EA] restart button — stumble cleared');
    }
  }, true);

  // Do NOT fingerprint-clear during a run. Only clear when leaving result
  // (handled in wasResultVisible interval above).

  try {
    const api = {
      scan: () => buildStumbleSnapshot(),
      words: () => [...stumbledWordTexts],
      frozen: () => frozenStumbleSnapshot,
      force: () => captureStumbleAfterResult()
    };
    pageWin().__eaStumble = api;
    window.__eaStumble = api;
  } catch (e) {}

  async function patchLatestResultWithStumble(s) {
    if (!s || !s.total) return false;
    // Never use an empty (0 stumble) patch to erase a previous good value
    if (!(s.stumbled > 0) && !(s.stumblePct > 0)) {
      // Still allow 0% when it is a genuine perfect run (total words, on result)
      if (!isResultScreenVisible()) return false;
    }
    const wpmHint = readWpmFromResultDOM();
    queuePendingStumble(s, wpmHint);
    try {
      const all = await getAllResults();
      if (!all.length) return false;
      const now = Date.now();
      // Prefer match by wpm + recent timestamp
      let best = null;
      let bestScore = Infinity;
      for (const r of all) {
        if (r.stumblePct != null && r.stumbledWords != null) continue;
        let ts = Number(r.timestamp) || 0;
        if (ts && ts < 1e12) ts *= 1000;
        const dt = Math.abs((ts || now) - now);
        if (dt > 30 * 60 * 1000) continue;
        let score = dt;
        if (wpmHint != null && r.wpm != null) {
          const dw = Math.abs(Number(r.wpm) - wpmHint);
          if (dw > 3) continue;
          score = dt + dw * 1000;
        }
        if (score < bestScore) {
          bestScore = score;
          best = r;
        }
      }
      // fallback: newest without stumble
      if (!best) {
        all.sort((a, b) => {
          let ta = Number(a.timestamp) || 0;
          let tb = Number(b.timestamp) || 0;
          if (ta < 1e12) ta *= 1000;
          if (tb < 1e12) tb *= 1000;
          return tb - ta;
        });
        const latest = all[0];
        let ts = Number(latest.timestamp) || 0;
        if (ts < 1e12) ts *= 1000;
        if (latest && now - ts <= 30 * 60 * 1000 && latest.stumblePct == null) best = latest;
      }
      if (!best) return false;
      best.stumbledWords = s.stumbled;
      best.cleanWords = s.clean;
      best.totalWords = s.total;
      best.stumblePct = s.stumblePct;
      await saveResult(best);
      try {
        // silent — live save toast already covers this
      } catch (e) {}
      updateBadge();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function captureStumbleAfterResult() {
    try {
      const btn = document.getElementById('showWordHistoryButton');
      const hist = document.querySelector('#resultWordsHistory');
      if (btn && hist && hist.querySelectorAll('.word').length === 0) {
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (e) {}
    const s = buildStumbleSnapshot();
    if (s) {
      queuePendingStumble(s, readWpmFromResultDOM());
      await patchLatestResultWithStumble(s);
    }
    return s;
  }

  function observeNewResults() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (
            node.id === 'result' ||
            node.classList?.contains('result') ||
            node.querySelector?.('.group.wpm')
          ) {
            // Fast path — do not require user to wait
            tryCaptureFromPage();
            captureStumbleAfterResult();
            setTimeout(tryCaptureFromPage, 250);
            setTimeout(() => captureStumbleAfterResult(), 250);
            setTimeout(tryCaptureFromPage, 800);
            setTimeout(() => captureStumbleAfterResult(), 800);
          }
        }
      }
    });
    // Only childList on body — not attributes on entire tree
    observer.observe(document.body, { childList: true, subtree: true });
  }

  let _eaLastCaptureKey = '';
  let _eaLastCaptureAt = 0;
  async function tryCaptureFromPage() {
    try {
      // Only capture while result screen is visible — avoids writing stale/wrong WPM after restart
      if (!isResultScreenVisible() && !document.querySelector('#result .group.wpm, #result .wrapper')) {
        return;
      }
      const s = buildStumbleSnapshot() || frozenStumbleSnapshot || lastStumbleSnapshot;
      const w = pageWin();
      let r = null;
      let snap = null;
      try {
        snap = (typeof w.db?.getSnapshot === 'function') ? w.db.getSnapshot() : findSnapshot();
      } catch (e) {}

      // DOM is the authority for "what is on screen right now"
      const domRaw = readResultFromDOM();
      const dom = domRaw ? normalizeResult(domRaw) : null;

      // Newest result in snapshot (results[0] is often NOT the latest)
      let snapNewest = null;
      try {
        if (snap?.results?.length) {
          const sorted = [...snap.results].sort((a, b) => {
            let ta = Number(a.timestamp) || 0;
            let tb = Number(b.timestamp) || 0;
            if (ta && ta < 1e12) ta *= 1000;
            if (tb && tb < 1e12) tb *= 1000;
            return tb - ta;
          });
          snapNewest = normalizeResult(sorted[0]);
        }
      } catch (e) {}

      // Prefer DOM when it has a wpm; merge official id/tags from snapshot if same test
      if (dom && dom.wpm) {
        r = dom;
        if (snapNewest && Math.abs(Number(snapNewest.wpm) - Number(dom.wpm)) <= 0.51) {
          // Same test — keep server id / tags / richer fields
          if (snapNewest._id) r._id = snapNewest._id;
          if (snapNewest.id && String(snapNewest.id).length > 8) r.id = snapNewest.id;
          if (snapNewest.tags?.length && !r.tags?.length) r.tags = snapNewest.tags.map(String);
          if (snapNewest.mode) r.mode = snapNewest.mode;
          if (snapNewest.mode2 != null) r.mode2 = String(snapNewest.mode2);
          if (snapNewest.language) r.language = snapNewest.language;
          if (snapNewest.quoteLength != null) r.quoteLength = snapNewest.quoteLength;
          if (snapNewest.timestamp) r.timestamp = Number(snapNewest.timestamp) < 1e12
            ? Number(snapNewest.timestamp) * 1000
            : Number(snapNewest.timestamp);
        } else if (snap?.results?.length) {
          // Find snapshot entry matching on-screen wpm
          const match = snap.results.find(sr => Math.abs(Number(sr.wpm) - Number(dom.wpm)) <= 0.51);
          if (match) {
            const m = normalizeResult(match);
            if (m._id) r._id = m._id;
            if (m.id) r.id = m.id;
            if (m.tags?.length) r.tags = m.tags.map(String);
            if (m.timestamp) r.timestamp = Number(m.timestamp) < 1e12 ? Number(m.timestamp) * 1000 : Number(m.timestamp);
          }
        }
      } else if (snapNewest && snapNewest.wpm && !dom) {
        // Only use snapshot when result DOM is not available
        r = snapNewest;
      }

      if (!r || !r.wpm) {
        // Last-chance: scan #result for wpm-labeled group text
        try {
          let w = readWpmFromResultDOM();
          let a = readNumFromResultGroup('acc') ?? readNumFromResultGroup('accuracy');
          const scraped = scrapeResultFromInnerText();
          if (scraped) {
            if (w == null) w = scraped.wpm;
            if (a == null) a = scraped.acc;
            console.log('[EA] innerText scrape', scraped);
          }
          if (w) {
            r = Object.assign({}, scraped || {}, r || {});
            r.wpm = w;
            if (a != null) r.acc = a;
            if (scraped) {
              if (scraped.mode && !r.mode) r.mode = scraped.mode;
              if (scraped.type && !r.type) r.type = scraped.type;
              if (scraped.mode2 != null && r.mode2 == null) r.mode2 = scraped.mode2;
              if (scraped.tags && scraped.tags.length && !(r.tags && r.tags.length)) r.tags = scraped.tags;
              if (scraped.language && !r.language) r.language = scraped.language;
            }
            console.log('[EA] last-chance wpm', w, 'acc', a, 'mode', r.mode);
          }
        } catch (e) { console.warn('[EA] last-chance', e); }
      }
      if (!r || !r.wpm) {
        // Debug: what groups exist on result screen?
        try {
          const groups = [];
          document.querySelectorAll('#result .group, .pageResult .group').forEach(g => {
            const top = (g.querySelector('.top, .label, .title')?.textContent || '').trim();
            const bot = (g.querySelector('.bottom, .val, .value')?.textContent || '').trim().slice(0, 40);
            groups.push(top + '=' + bot);
          });
          console.warn('[EA] capture skip — no wpm from DOM/snapshot', {
            dom: dom && dom.wpm, snap: snapNewest && snapNewest.wpm,
            hist: !!(document.getElementById('resultWordsHistory') || document.querySelector('.resultWordsHistory')),
            resultEl: !!document.querySelector('#result'),
            groups: groups.slice(0, 20)
          });
        } catch (e) {
          console.warn('[EA] capture skip — no wpm', e);
        }
        if (s) await patchLatestResultWithStumble(s);
        return;
      }
      // Reject obvious garbage (failed parse placeholders)
      let accN = (r.acc != null && r.acc !== '') ? Number(r.acc)
        : (r.accuracy != null && r.accuracy !== '') ? Number(r.accuracy) : null;
      if (accN != null && isNaN(accN)) accN = null;

      if (!(Number(r.wpm) > 0 && Number(r.wpm) < 400)) {
        console.warn('[EA] capture skip — absurd wpm', r.wpm);
        return;
      }
      // Recover acc when null/0 (Number(null)===0 was rejecting every live save)
      if (accN == null || (accN === 0 && Number(r.wpm) >= 15)) {
        const retryAcc = readNumFromResultGroup('acc') ?? readNumFromResultGroup('accuracy');
        if (retryAcc != null && retryAcc > 0 && retryAcc <= 100) {
          r.acc = retryAcc;
          accN = retryAcc;
          console.log('[EA] acc recovered from DOM', retryAcc);
        }
      }
      if ((accN == null || accN === 0) && snapNewest && Number(snapNewest.acc) > 0) {
        if (Math.abs(Number(snapNewest.wpm) - Number(r.wpm)) <= 1.5) {
          r.acc = Number(snapNewest.acc);
          accN = r.acc;
          if (snapNewest.mode && !r.mode) r.mode = snapNewest.mode;
          console.log('[EA] acc recovered from snapshot', accN);
        }
      }
      // NEVER skip just because acc is missing/0 — that blocked 72.49 saves
      if (accN != null && (accN < 0 || accN > 100)) {
        console.warn('[EA] capture skip — absurd acc', accN);
        return;
      }
      if (!r.mode) {
        try {
          const dom2 = readResultFromDOM();
          if (dom2 && dom2.mode) {
            r.mode = dom2.mode;
            if (dom2.mode2 != null) r.mode2 = dom2.mode2;
            if (dom2.type) r.type = dom2.type;
            if (dom2.tags && dom2.tags.length && !(r.tags && r.tags.length)) r.tags = dom2.tags;
            if (dom2.acc != null && (accN == null || accN === 0)) { r.acc = dom2.acc; accN = dom2.acc; }
          }
        } catch (e) {}
        if (!r.mode) {
          if (document.getElementById('resultWordsHistory') || document.querySelector('.resultWordsHistory')) {
            r.mode = 'quote';
            r.type = r.type || 'short';
            console.log('[EA] mode defaulted to quote');
          } else {
            console.warn('[EA] capture skip — missing mode', r.wpm, accN);
            return;
          }
        }
      }
      // DOM is the only source of truth for on-screen result
      {
        const domW = readWpmFromResultDOM();
        const domA = readNumFromResultGroup('acc') ?? readNumFromResultGroup('accuracy');
        if (domW != null) r.wpm = domW;
        if (domA != null && domA > 0) { r.acc = domA; accN = domA; }
        try {
          const d = readResultFromDOM();
          if (d) {
            if (d.wpm != null) r.wpm = d.wpm;
            if (d.acc != null && d.acc > 0) { r.acc = d.acc; accN = d.acc; }
            if (d.mode) r.mode = d.mode;
            if (d.mode2 != null) r.mode2 = d.mode2;
            if (d.type) r.type = d.type;
            if (d.language) r.language = d.language;
            if (d.tags && d.tags.length) r.tags = d.tags;
            if (d.quoteLength != null) r.quoteLength = d.quoteLength;
          }
        } catch (e) {}
        // KeyConf "Best possible: X wpm 100% acc" was parsed as wpm=100
        if (Number(r.wpm) === 100) {
          const raw = Number(r.rawWpm || r.raw);
          if (raw > 0 && Math.abs(raw - 100) > 3) {
            console.warn('[EA] wpm 100 looks like parse of 100% — using raw', raw);
            r.wpm = raw;
          } else {
            // Try one more scrape
            const s2 = scrapeResultFromInnerText();
            if (s2 && s2.wpm && s2.wpm !== 100) {
              console.warn('[EA] wpm 100 rejected, using scrape', s2.wpm);
              r.wpm = s2.wpm;
              if (s2.acc) { r.acc = s2.acc; accN = s2.acc; }
              if (s2.mode) r.mode = s2.mode;
              if (s2.type) r.type = s2.type;
            } else if (accN == null || Number(accN) === 0) {
              console.warn('[EA] capture skip — garbage 100/0 parse');
              return;
            }
          }
        }
        // Force mode quote when test type text says quote
        try {
          const rt = (document.querySelector('#result') || document.body).innerText || '';
          if (/\bquote\b/i.test(rt) && r.mode === 'time') {
            r.mode = 'quote';
            if (/\bshort\b/i.test(rt)) { r.type = 'short'; r.mode2 = '0'; }
          }
        } catch (e) {}
      }
      // Force valid timestamp (never 1970/epoch)
      {
        let ts = Number(r.timestamp) || 0;
        if (ts && ts < 1e12) ts *= 1000;
        if (!ts || ts < 946684800000 || ts > Date.now() + 60000) r.timestamp = Date.now();
        else r.timestamp = ts;
      }
      console.log('[EA] capturing live result', r.wpm, r.mode, r.type || r.mode2, 'acc', r.acc != null ? r.acc : accN, 'ts', r.timestamp);
      // Guard: never save a result whose wpm is not on the result screen
      if (dom && dom.wpm && Math.abs(Number(r.wpm) - Number(dom.wpm)) > 0.51) {
        r.wpm = dom.wpm;
        if (dom.acc != null) r.acc = dom.acc;
      }

      // Attach stumble metric — prefer freeze / last-good; never write 0 over a real count
      let stumbleSrc = null;
      if (s && s.total > 0 && (s.stumbled > 0 || s.stumblePct > 0 || isResultScreenVisible())) {
        stumbleSrc = s;
      } else if (eaLastGoodStumble && eaLastGoodStumble.total > 0 &&
                 (Date.now() - (eaLastGoodStumble.t || 0)) < 8000) {
        // Only for SAME test (wpm match) — never bleed into a faster next quote
        const lw = Number(eaLastGoodStumble.wpm);
        const rw = Number(r.wpm);
        if (lw > 0 && rw > 0 && Math.abs(lw - rw) <= 0.25) {
          stumbleSrc = eaLastGoodStumble;
        }
      }
      if (stumbleSrc && stumbleSrc.total > 0) {
        // Real finish: has word count from freeze (0 stumbles is valid — perfect quote)
        {
          r.stumbledWords = stumbleSrc.stumbled;
          r.cleanWords = stumbleSrc.clean;
          r.totalWords = stumbleSrc.total;
          r.stumblePct = stumbleSrc.stumblePct != null
            ? stumbleSrc.stumblePct
            : (stumbleSrc.total ? (100 * stumbleSrc.stumbled / stumbleSrc.total) : 0);
          queuePendingStumble(stumbleSrc, r.wpm, { acc: r.acc, mode: r.mode, mode2: r.mode2 });
          try { rememberStumble(r); } catch (e) {}
        }
      } else {
        const a = buildStumbleSnapshot() || lastStumbleSnapshot;
        if (a && a.total > 0) {
          r.stumbledWords = a.stumbled;
          r.cleanWords = a.clean;
          r.totalWords = a.total;
          r.stumblePct = a.stumblePct != null
            ? a.stumblePct
            : (100 * (a.stumbled || 0) / a.total);
          queuePendingStumble(a, r.wpm, { acc: r.acc, mode: r.mode, mode2: r.mode2 });
        }
      }

      // Resolve / attach tags so tag filters (e.g. eclipse) include this live result
      try {
        const map = (window.__eaTagNameMap || PAGE.__eaTagNameMap || {});
        const rev = {};
        Object.entries(map).forEach(([id, n]) => { rev[String(n).toLowerCase()] = String(id); });

        let tagSet = new Set((r.tags || []).map(String));

        // Names → ids
        tagSet = new Set([...tagSet].map(t => {
          if (map[t]) return t; // already an id present in map
          const byName = rev[t.toLowerCase()];
          return byName || t;
        }));

        // Monkeytype active tags live in config.tags (array of ids)
        if (snap?.config?.tags && Array.isArray(snap.config.tags)) {
          snap.config.tags.forEach(t => tagSet.add(String(t)));
        }
        // tags list entries with active:true
        if (snap?.tags && Array.isArray(snap.tags)) {
          snap.tags.forEach(t => {
            if (t && (t.active === true || t.active === 1)) {
              const id = String(t._id || t.id || '');
              if (id) tagSet.add(id);
            }
          });
        }
        // Matching snapshot result by wpm
        if (snap?.results?.length) {
          const match = snap.results.find(sr => Math.abs(Number(sr.wpm) - Number(r.wpm)) <= 0.51);
          if (match?.tags?.length) match.tags.forEach(t => tagSet.add(String(t)));
        }
        // DOM active tag buttons
        document.querySelectorAll(
          '#testConfig .tags .textButton.active, .pageTest .tags .textButton.active, ' +
          '.tagsBtn .active, .tags .textButton.active, .tagsButton.active'
        ).forEach(el => {
          const id = el.getAttribute('data-tag-id') || el.dataset?.tagId || el.getAttribute('tagid');
          const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
          if (id) tagSet.add(String(id));
          else if (name && name.toLowerCase() !== 'tags') {
            tagSet.add(rev[name.toLowerCase()] || name);
          }
        });

        r.tags = [...tagSet].filter(Boolean);
      } catch (e) {
        console.warn('[EA] tag resolve', e);
      }

      // Stable local id if Monkeytype did not give _id yet
      // Bucket timestamp to 5s so delayed re-saves of the SAME test share one id
      if (!r._id && !String(r.id || '').match(/^[a-f0-9]{20,}$/i)) {
        const ts = Math.round(Number(r.timestamp) || Date.now());
        const bucket = Math.floor(ts / 5000) * 5000;
        const w = Math.round(Number(r.wpm) * 100);
        const a = Math.round(Number(r.acc) * 100);
        r.id = 'live_' + bucket + '_' + w + '_' + a;
      }

      // Toast only once per finished test (wpm+acc within 20s) — updates stay silent
      const capKey = Math.round(Number(r.wpm) * 100) + '_' + Math.round(Number(r.acc) * 100);
      const now = Date.now();
      const isRepeat = (capKey === _eaLastCaptureKey && (now - _eaLastCaptureAt) < 45000);
      if (!isRepeat) {
        _eaLastCaptureKey = capKey;
        _eaLastCaptureAt = now;
      }

      await saveResult(r);
      // Verify it is actually in IndexedDB
      try {
        const all = await getAllResults();
        const found = all.some(x =>
          x.id === r.id ||
          (Math.abs(Number(x.wpm) - Number(r.wpm)) < 0.05 &&
           Math.abs((Number(x.timestamp) || 0) - (Number(r.timestamp) || 0)) < 15000)
        );
        console.log('[EA] live save', {
          id: r.id,
          wpm: r.wpm,
          acc: r.acc,
          tags: r.tags,
          stumblePct: r.stumblePct,
          verified: found,
          totalInDb: all.length,
          silent: isRepeat
        });
        if (!found) console.warn('[EA] save not found after put — id', r.id);
      } catch (e) { console.warn('[EA] verify save', e); }

      // O(1) append to chart if filters match — never full refilter
      try {
        if (!isRepeat) {
          const ok = appendLiveToCharts(r);
          console.log('[EA] live append result', ok, r.wpm, r.mode, r.type, r.tags, r.timestamp);
        }
      } catch (e) { console.warn('[EA] live append', e); }

      updateBadge();
      if (!isRepeat) {
        try {
          const st = r.stumblePct != null
            ? (' · stumble ' + r.stumbledWords + '/' + r.totalWords)
            : '';
          try {
            localStorage.setItem('ea_last_live_save', JSON.stringify({
              wpm: r.wpm, acc: r.acc, tags: r.tags, id: r.id, t: Date.now()
            }));
          } catch (e) {}
          const tagHint = (r.tags && r.tags.length) ? '' : ' · no tags';
          showToast('Saved test: ' + Number(r.wpm).toFixed(2) + ' wpm' + st + tagHint, 'success', 2200);
        } catch (e) {}
      }
      // Clear last-good after a successful attach so it cannot bleed into next test
      if (r.stumblePct != null && eaLastGoodStumble &&
          Math.abs(Number(eaLastGoodStumble.wpm) - Number(r.wpm)) <= 0.25) {
        eaLastGoodStumble = null;
      }

      // Always refresh open archive so the new point appears without Import/Update
      if (typeof panelOpen !== 'undefined' && panelOpen) {
        try {
          // Clear zoom on main chart so the newest test is not off-screen
          if (chartInstance) {
            try {
              if (chartInstance.options?.scales?.x) {
                delete chartInstance.options.scales.x.min;
                delete chartInstance.options.scales.x.max;
              }
              chartInstance.$eaFullX = null;
            } catch (e) {}
          }
          await renderArchive();
        } catch (e) { console.warn('[EA] refresh after save', e); }
      }
    } catch (e) {
      console.warn('[EA] tryCaptureFromPage', e);
    }
  }

  /*********************************************************************
   *  AUTO-SYNC / FETCH RESULTS FROM MONKEYTYPE
   *********************************************************************/
  function findSnapshot() {
    const w = pageWindow();
    const candidates = [
      () => w.db?.getSnapshot?.(),
      () => w.DB?.getSnapshot?.(),
      () => w.snapshot,
      () => w.dbSnapshot,
      () => w.Monkeytype?.db?.getSnapshot?.(),
      () => w.monkeytype?.db?.getSnapshot?.(),
    ];
    for (const fn of candidates) {
      try {
        const snap = fn();
        if (snap && (Array.isArray(snap.results) || snap.tags)) return snap;
      } catch (e) {}
    }
    return null;
  }

  function getApeKey() {
    try {
      const fromGm = (typeof GM_getValue === 'function') ? GM_getValue('apeKey', '') : '';
      return (APE_KEY || fromGm || '').trim();
    } catch (e) {
      return (APE_KEY || '').trim();
    }
  }

  function setApeKey(key) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue('apeKey', (key || '').trim());
    } catch (e) {}
  }

  function updateApeKeyStatus() {
    const el = document.getElementById('ea-apekey-status');
    if (!el) return;
    const k = getApeKey();
    if (k) {
      el.innerHTML = `Ape Key: <span style="color:#7ec8e3">set (${k.slice(0, 6)}…)</span>`;
    } else {
      el.innerHTML = `Ape Key: <span style="color:#e76f51">not set</span> — set APE_KEY at top of script or click "Ape Key"`;
    }
  }

  async function fetchResultsFromPage() {
    const snap = findSnapshot();
    if (snap && Array.isArray(snap.results) && snap.results.length) {
      return snap.results.map(normalizeResult);
    }
    return [];
  }

  async function fetchResultsViaAPI(offset = 0, limit = 1000) {
    const apeKey = getApeKey();
    if (!apeKey) return null;
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `https://api.monkeytype.com/results?offset=${offset}&limit=${limit}`,
          headers: {
            'Accept': 'application/json',
            'Authorization': `ApeKey ${apeKey}`
          },
          onload: (res) => {
            try {
              if (res.status >= 200 && res.status < 300) {
                const json = JSON.parse(res.responseText);
                const data = json.data || json;
                if (Array.isArray(data)) return resolve(data.map(normalizeResult));
                if (data && Array.isArray(data.results)) return resolve(data.results.map(normalizeResult));
              }
            } catch (e) {}
            resolve(null);
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null)
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function fetchAllResultsViaAPI() {
    const all = [];
    let offset = 0;
    const limit = 1000;
    for (let i = 0; i < 50; i++) {
      const batch = await fetchResultsViaAPI(offset, limit);
      if (!batch || !batch.length) break;
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async function syncResults({ silent = false } = {}) {
    try {
      if (!silent) showToast('Syncing results…', 'info', 2000);

      let allNew = [];

      // 1) Prefer in-page snapshot (no network)
      try {
        const page = await fetchResultsFromPage();
        if (page && page.length) allNew = page;
      } catch (e) {}

      // 2) Ape Key API
      if (!allNew.length) {
        const api = await fetchAllResultsViaAPI();
        if (api && api.length) allNew = api;
      }

      if (!allNew.length) {
        if (!silent) {
          showToast(
            'No results fetched. Check that your Ape Key is valid/active, or use Import / Export CSV on Account page.',
            'error',
            5000
          );
        }
        return 0;
      }

      let normalized = allNew.map(normalizeResult);
      // Restore per-test stumbles from permanent index, then pending queue
      normalized = normalized.map(r => applyStumbleIndex(r));
      normalized = applyPendingToResults(normalized);
      const added = await saveResultsBulk(normalized);
      try {
        const fixed = await reconcileStumblesLastN(1000);
        if (fixed && !silent) showToast('Corrected stumble on ' + fixed + ' recent results', 'info', 3000);
      } catch (e) { console.warn('[EA] reconcile', e); }
      // Second pass: patch any still-missing recent results from pending queue
      try {
        const pending = loadPendingStumbles();
        if (pending.length) {
          const all = await getAllResults();
          let patched = 0;
          for (const r of all) {
            if (r.stumblePct != null) continue;
            const before = r.stumblePct;
            matchPendingStumble(r);
            if (r.stumblePct != null && r.stumblePct !== before) {
              await saveResult(r);
              patched++;
            }
          }
          if (patched && !silent) {
            showToast('Attached stumble data to ' + patched + ' synced result(s)', 'info', 3000);
          }
        }
        // Also try live snapshot if result screen is open
        const s = buildStumbleSnapshot();
        if (s && s.total) await patchLatestResultWithStumble(s);
      } catch (e) {}
      await setMeta('lastSync', Date.now());
      updateBadge();
      if (!silent) showToast(`Synced — ${added} results processed`, 'success');
      try {
        if (document.getElementById('ea-root')?.style.display === 'flex') {
          renderArchive();
        }
      } catch (e) {}
      return added;
    } catch (e) {
      if (!silent) showToast('Sync failed: ' + (e && e.message ? e.message : e), 'error');
      return 0;
    }
  }

  function scheduleBackgroundSync() {
    const TICK_MS = 30 * 60 * 1000; // check every 30 min
    const MIN_GAP = 6 * 60 * 60 * 1000; // sync at most every 6h
    const run = async () => {
      try {
        const last = await getMeta('lastSync', 0);
        if (!last || Date.now() - Number(last) > MIN_GAP) {
          await syncResults({ silent: true });
        }
      } catch (e) {}
      setTimeout(run, TICK_MS);
    };
    // light delayed first check on load
    setTimeout(run, 8000);
  }

  function installExportInterceptor() {
    // Hijack blob downloads that look like results JSON/CSV
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      try {
        if (blob && blob.type && /json|csv|text/.test(blob.type) && blob.size > 50) {
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const text = String(reader.result || '');
              let results = null;
              if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
                const json = JSON.parse(text);
                if (Array.isArray(json)) results = json;
                else if (json && Array.isArray(json.results)) results = json.results;
              } else if (text.includes('wpm') && text.includes(',')) {
                results = parseCSV(text);
              }
              if (results && results.length) {
                const added = await saveResultsBulk(results.map(normalizeResult));
                updateBadge();
                showToast(`Imported ${added} results from export`, 'success');
              }
            } catch (e) {}
          };
          try { reader.readAsText(blob.slice(0, Math.min(blob.size, 50 * 1024 * 1024))); } catch (e) {}
        }
      } catch (e) {}
      return origCreate.apply(this, arguments);
    };
  }

  const defaultFilters = {
    timePeriod: 'all',
    difficulty: { normal: true, expert: true, master: true },
    pb: { no: true, yes: true },
    mode: { words: true, time: true, quote: true, zen: true, custom: true },
    quoteLength: { short: true, medium: true, long: true, thicc: true },
    words: { '10': true, '25': true, '50': true, '100': true, custom: true },
    time: { '15': true, '30': true, '60': true, '120': true, custom: true },
    punctuation: { on: true, off: true },
    numbers: { on: true, off: true },
    tags: [],       // empty = all
    funbox: [],
    language: []
  };
  let currentFilters = JSON.parse(JSON.stringify(defaultFilters));

  // Available options discovered from data (for the + picker)
  let availableTags = [];      // [{id, name}]
  let availableFunboxes = [];  // string[]
  let availableLanguages = []; // string[]
  const LS_AVAIL_LANG = 'ea_available_languages';
  const LS_AVAIL_FB = 'ea_available_funboxes';

  function loadPersistedAvail() {
    try {
      const langs = JSON.parse(GM_getValue(LS_AVAIL_LANG, '[]') || '[]');
      const fbs = JSON.parse(GM_getValue(LS_AVAIL_FB, '[]') || '[]');
      if (Array.isArray(langs)) {
        availableLanguages = [...new Set([...(availableLanguages || []), ...langs.map(String)])]
          .sort((a, b) => a.localeCompare(b));
      }
      if (Array.isArray(fbs)) {
        availableFunboxes = [...new Set([...(availableFunboxes || []), ...fbs.map(String)])]
          .sort((a, b) => a.localeCompare(b));
      }
    } catch (e) { console.warn('[EA] loadPersistedAvail', e); }
  }

  function savePersistedAvail() {
    try {
      GM_setValue(LS_AVAIL_LANG, JSON.stringify(availableLanguages || []));
      GM_setValue(LS_AVAIL_FB, JSON.stringify(availableFunboxes || []));
    } catch (e) { console.warn('[EA] savePersistedAvail', e); }
  }

  function applyFilters(results) {
    const now = Date.now();
    // Repair mis-tagged zen/language so mode filters work on old data too
    let filtered = (results || []).map((r) => {
      const x = repairResultMeta({ ...r });
      let ts = Number(x.timestamp) || 0;
      if (ts && ts < 1e12) ts *= 1000;
      if (!ts || ts < 946684800000) x.timestamp = now;
      else x.timestamp = ts;
      return x;
    }).filter((x) => {
      if (Number(x.wpm) === 100 && Number(x.acc) === 0) return false;
      if (x.id && String(x.id).includes('_10000_') && Number(x.wpm) === 100) return false;
      if (!(Number(x.wpm) > 0)) return false;
      let ts = Number(x.timestamp) || 0;
      if (ts && ts < 1e12) ts *= 1000;
      if (ts && ts < 946684800000) return false;
      return true;
    });

    if (currentFilters.timePeriod !== 'all') {
      const periods = {
        'last day': 864e5,
        'last week': 6048e5,
        'last month': 2592e6,
        'last 3 months': 7776e6
      };
      const ms = periods[currentFilters.timePeriod];
      if (ms) filtered = filtered.filter(r => now - r.timestamp <= ms);
    }

    filtered = filtered.filter(r => currentFilters.difficulty[r.difficulty] !== false);
    filtered = filtered.filter(r => r.isPb ? currentFilters.pb.yes : currentFilters.pb.no);
    filtered = filtered.filter(r => currentFilters.mode[r.mode] !== false);

    filtered = filtered.filter(r => {
      if (r.mode !== 'quote') return true;
      const map = { 0: 'short', 1: 'medium', 2: 'long', 3: 'thicc' };
      const t = r.type || map[r.quoteLength] || (['0','1','2','3'].includes(String(r.mode2)) ? map[r.mode2] : null) || 'short';
      const key = (t === 'all' || t === 'favorite') ? 'short' : t; // fall through if no all filter
      if (currentFilters.quoteLength[t] !== undefined) return currentFilters.quoteLength[t] !== false;
      return currentFilters.quoteLength[map[r.quoteLength] || 'short'] !== false;
    });

    filtered = filtered.filter(r => {
      if (r.mode === 'words') {
        const t = r.type || r.mode2;
        const key = ['10','25','50','100'].includes(String(t)) ? String(t) : 'custom';
        return currentFilters.words[key] !== false;
      }
      if (r.mode === 'time') {
        const t = r.type || r.mode2;
        const key = ['15','30','60','120'].includes(String(t)) ? String(t) : 'custom';
        return currentFilters.time[key] !== false;
      }
      return true;
    });

    filtered = filtered.filter(r => {
      const pOk = r.punctuation ? currentFilters.punctuation.on : currentFilters.punctuation.off;
      const nOk = r.numbers ? currentFilters.numbers.on : currentFilters.numbers.off;
      return pOk && nOk;
    });

    // empty selection = all
    if (currentFilters.tags.length) {
      const nameMap = (typeof window !== 'undefined' && window.__eaTagNameMap) || {};
      // reverse map name→id
      const nameToIds = {};
      Object.entries(nameMap).forEach(([id, name]) => {
        const n = String(name).toLowerCase();
        if (!nameToIds[n]) nameToIds[n] = [];
        nameToIds[n].push(String(id));
      });
      filtered = filtered.filter(r => {
        if (!r.tags?.length) return currentFilters.tags.includes('none');
        return r.tags.some(t => {
          const ts = String(t);
          if (currentFilters.tags.includes(ts)) return true;
          // filter stores ids; also allow name match
          const display = nameMap[ts] || ts;
          if (currentFilters.tags.includes(display)) return true;
          const ids = nameToIds[ts.toLowerCase()] || [];
          return ids.some(id => currentFilters.tags.includes(id));
        });
      });
    }

    if (currentFilters.funbox.length) {
      filtered = filtered.filter(r => {
        const fb = String(r.funbox || 'none');
        const parts = fb.split(/[#|,]/).map(s => s.trim()).filter(Boolean);
        return currentFilters.funbox.some(f => fb === f || parts.includes(f));
      });
    }

    if (currentFilters.language.length) {
      filtered = filtered.filter(r => currentFilters.language.includes(r.language));
    }

    filtered.sort((a, b) => a.timestamp - b.timestamp);
    return filtered;
  }

  /*********************************************************************
   *  GRAPH + CROSSHAIR + LEGEND MEMORY
   *********************************************************************/
  let chartInstance = null;

  /** Characters typed — weight for true average */
  function resultCharCount(r) {
    if (!r) return 1;
    try {
      if (Array.isArray(r.charStats)) {
        const sum = r.charStats.reduce((s, n) => s + (Number(n) || 0), 0);
        if (sum > 0) return sum;
      } else if (r.charStats && typeof r.charStats === 'object') {
        const sum = Object.values(r.charStats).reduce((s, n) => s + (Number(n) || 0), 0);
        if (sum > 0) return sum;
      }
    } catch (e) {}
    if (r.characters != null && Number(r.characters) > 0) return Number(r.characters);
    const dur = resultDurationSec(r);
    if (dur > 0 && Number(r.wpm) > 0) {
      return Math.max(1, Number(r.wpm) * 5 * (dur / 60));
    }
    if (r.mode === 'words' && Number(r.mode2) > 0) return Number(r.mode2) * 5;
    if (r.totalWords > 0) return Number(r.totalWords) * 5;
    return 1;
  }

  function weightedMeanFromResults(list, getter) {
    if (!list || !list.length) return null;
    if (!trueAverage) {
      let sum = 0, n = 0;
      for (const r of list) {
        const v = getter(r);
        if (v == null || !isFinite(v)) continue;
        sum += v;
        n++;
      }
      return n ? sum / n : null;
    }
    let sum = 0, wsum = 0;
    for (const r of list) {
      const v = getter(r);
      if (v == null || !isFinite(v)) continue;
      const w = resultCharCount(r);
      sum += v * w;
      wsum += w;
    }
    return wsum ? sum / wsum : null;
  }

  function computeMovingAvg(data, window, weights) {
    const out = [];
    const useW = !!(trueAverage && weights && weights.length === data.length);
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - window + 1);
      if (!useW) {
        let sum = 0, n = 0;
        for (let j = start; j <= i; j++) {
          const v = data[j];
          if (v == null || !isFinite(v)) continue;
          sum += v;
          n++;
        }
        out.push(n ? sum / n : null);
      } else {
        let sum = 0, wsum = 0;
        for (let j = start; j <= i; j++) {
          const v = data[j];
          if (v == null || !isFinite(v)) continue;
          const w = weights[j] || 1;
          sum += v * w;
          wsum += w;
        }
        out.push(wsum ? sum / wsum : null);
      }
    }
    return out;
  }

  // Per-chart free horizontal crosshair (mouse Y). Values shown on fixed side borders.
  function createCrosshairPlugin(opts = {}) {
    const leftUnit = opts.leftUnit || '';
    const rightUnit = opts.rightUnit || '%';
    const leftDecimals = opts.leftDecimals ?? 2;
    const rightDecimals = opts.rightDecimals ?? 2;

    return {
      id: 'eaCrosshair_' + Math.random().toString(36).slice(2, 7),
      afterInit(chart) {
        chart.$eaCrossY = null;
        chart.$eaDestroyed = false;
        const canvas = chart.canvas;
        if (!canvas) return;
        const frame = canvas.closest('.ea-chart-frame');
        if (frame) {
          chart.$eaSideLeft = frame.querySelector('.ea-yside.left .ea-cross-val');
          chart.$eaSideRight = frame.querySelector('.ea-yside.right .ea-cross-val');
          chart.$eaSideStumble = frame.querySelector('.ea-yside.right .ea-cross-val-stumble');
        }

        const onMove = (e) => {
          if (chart.$eaDestroyed) return;
          let x, y;
          try {
            const C = getChart();
            const helper = C && C.helpers && C.helpers.getRelativePosition;
            if (typeof helper === 'function') {
              const pos = helper(e, chart);
              x = pos.x;
              y = pos.y;
            }
          } catch (err) {}
          if (x == null || y == null) {
            const rect = canvas.getBoundingClientRect();
            // chart.width/height = CSS space used by chartArea & scales
            const scaleX = (chart.width || rect.width) / (rect.width || 1);
            const scaleY = (chart.height || rect.height) / (rect.height || 1);
            x = (e.clientX - rect.left) * scaleX;
            y = (e.clientY - rect.top) * scaleY;
          }
          const area = chart.chartArea;
          // Manual cursor-tip calibration (user-tuned)
          x += 1;
          y += 4;
          if (area && y >= area.top && y <= area.bottom && x >= area.left && x <= area.right) {
            chart.$eaCrossY = y;
            chart.$eaCrossX = x;
          } else {
            chart.$eaCrossY = null;
            chart.$eaCrossX = null;
          }
          try { chart.draw(); } catch (err) {}
        };
        const onLeave = () => {
          if (chart.$eaDestroyed) return;
          chart.$eaCrossY = null;
          chart.$eaCrossX = null;
          if (chart.$eaSideLeft) chart.$eaSideLeft.textContent = '';
          if (chart.$eaSideRight) chart.$eaSideRight.textContent = '';
          if (chart.$eaSideStumble) chart.$eaSideStumble.textContent = '';
          try { chart.draw(); } catch (err) {}
        };
        chart.$eaCrossOnMove = onMove;
        chart.$eaCrossOnLeave = onLeave;
        canvas.addEventListener('mousemove', onMove);
        canvas.addEventListener('mouseleave', onLeave);
      },
      afterDestroy(chart) {
        chart.$eaDestroyed = true;
        const canvas = chart.canvas;
        try {
          if (canvas && chart.$eaCrossOnMove) canvas.removeEventListener('mousemove', chart.$eaCrossOnMove);
          if (canvas && chart.$eaCrossOnLeave) canvas.removeEventListener('mouseleave', chart.$eaCrossOnLeave);
          if (canvas && canvas.$eaWheelHandler) canvas.removeEventListener('wheel', canvas.$eaWheelHandler);
          if (typeof chart.$eaDragCleanup === 'function') chart.$eaDragCleanup();
        } catch (e) {}
      },
      afterDraw(chart) {
        if (!chart || chart.$eaDestroyed || !chart.canvas || chart.canvas.width === 0) return;
        let ctx;
        try { ctx = chart.ctx || chart.canvas.getContext('2d'); } catch (e) { return; }
        if (!ctx) return;

        const y = chart.$eaCrossY;
        const xPix = chart.$eaCrossX;
        const xScale = chart.scales && chart.scales.x;
        const yScale = chart.scales && chart.scales.y;
        const y1Scale = chart.scales && chart.scales.y1;
        if (!xScale || !yScale) return;

        if (y == null && xPix == null) {
          if (chart.$eaSideLeft) chart.$eaSideLeft.textContent = '';
          if (chart.$eaSideRight) chart.$eaSideRight.textContent = '';
          return;
        }

        ctx.save();
        // Horizontal line
        if (y != null) {
          ctx.beginPath();
          ctx.moveTo(xScale.left, y);
          ctx.lineTo(xScale.right, y);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.setLineDash([5, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Thin vertical line through cursor
        if (xPix != null) {
          ctx.beginPath();
          ctx.moveTo(xPix, yScale.top);
          ctx.lineTo(xPix, yScale.bottom);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();

        const leftVal = yScale.getValueForPixel(y);
        const rightVal = y1Scale ? y1Scale.getValueForPixel(y) : NaN;
        if (chart.$eaSideLeft) {
          chart.$eaSideLeft.textContent = isFinite(leftVal)
            ? leftVal.toFixed(leftDecimals) + leftUnit
            : '';
        }
        if (chart.$eaSideRight) {
          chart.$eaSideRight.textContent = isFinite(rightVal)
            ? rightVal.toFixed(rightDecimals) + rightUnit
            : '';
        }
        // Stumble on same horizontal line (y2 scale), under accuracy
        if (chart.$eaSideStumble) {
          const y2Scale = chart.scales && chart.scales.y2;
          if (y2Scale && y != null) {
            let stVal = y2Scale.getValueForPixel(y);
            if (isFinite(stVal) && y2Scale.min != null && Number(y2Scale.min) >= 0 && stVal < 0) stVal = 0;
            chart.$eaSideStumble.textContent = isFinite(stVal)
              ? stVal.toFixed(1) + '%'
              : '';
          } else {
            chart.$eaSideStumble.textContent = '';
          }
        }
      }
    };
  }


  /** Wheel zoom (cursor-centered) + shift-wheel pan on X axis. Double-click resets. */
  function createWheelZoomPlugin() {
    return {
      id: 'eaWheelZoom_' + Math.random().toString(36).slice(2, 7),
      afterInit(chart) {
        bindWheelZoomToChart(chart);
      }
    };
  }

  function bindWheelZoomToChart(chart) {
    if (!chart || !chart.canvas) return;
    const canvas = chart.canvas;
    canvas.__eaChart = chart;
    const frame = canvas.closest('.ea-chart-frame');
    if (frame) frame.__eaChart = chart;

    // Disable chartjs-plugin-zoom if it was registered earlier (avoids Hammer null errors)
    try {
      if (!chart.options.plugins) chart.options.plugins = {};
      chart.options.plugins.zoom = false;
    } catch (e) {}

    // Rebind after chart recreate (canvas flag was sticking and blocking zoom)
    if (chart.$eaZoomBound) return;
    chart.$eaZoomBound = true;
    // Remove any stale canvas-level listener from previous chart instance
    if (canvas.$eaWheelHandler) {
      try { canvas.removeEventListener('wheel', canvas.$eaWheelHandler); } catch (e) {}
    }

    requestAnimationFrame(() => {
      try {
        const x = chart.scales && chart.scales.x;
        if (x && (x.max - x.min) > 0) chart.$eaFullX = { min: x.min, max: x.max };
      } catch (e) {}
    });

    // Plain wheel → scroll archive panel (always). Shift+wheel → zoom X.
    const onWheel = (e) => {
      try {
        if (chart.$eaDestroyed) return;
        if (!e.shiftKey) {
          const panel = document.getElementById('ea-panel');
          if (panel) panel.scrollTop += e.deltaY * 6;
          e.preventDefault();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const x = chart.scales && chart.scales.x;
        if (!x) return;
        // Refresh full range if never set or data grew
        if (!chart.$eaFullX || (x.max - x.min) > (chart.$eaFullX.max - chart.$eaFullX.min + 0.5)) {
          chart.$eaFullX = { min: x.min, max: x.max };
        }
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const rect = canvas.getBoundingClientRect();
        const scaleX = (chart.width || rect.width) / (rect.width || 1);
        const mx = (e.clientX - rect.left) * scaleX;
        let mouseVal = x.getValueForPixel(mx);
        if (!isFinite(mouseVal)) mouseVal = (x.min + x.max) / 2;
        const curMin = (chart.options.scales && chart.options.scales.x && chart.options.scales.x.min != null)
          ? chart.options.scales.x.min : x.min;
        const curMax = (chart.options.scales && chart.options.scales.x && chart.options.scales.x.max != null)
          ? chart.options.scales.x.max : x.max;
        const range = curMax - curMin;
        if (!(range > 0)) return;
        let newRange = range / factor;
        const fullRange = chart.$eaFullX.max - chart.$eaFullX.min;
        if (newRange > fullRange) newRange = fullRange;
        if (newRange < Math.max(2, fullRange * 0.015)) newRange = Math.max(2, fullRange * 0.015);
        const ratio = Math.min(1, Math.max(0, (mouseVal - curMin) / range));
        let nMin = mouseVal - ratio * newRange;
        let nMax = mouseVal + (1 - ratio) * newRange;
        if (nMin < chart.$eaFullX.min) { nMax += chart.$eaFullX.min - nMin; nMin = chart.$eaFullX.min; }
        if (nMax > chart.$eaFullX.max) { nMin -= nMax - chart.$eaFullX.max; nMax = chart.$eaFullX.max; }
        nMin = Math.max(chart.$eaFullX.min, nMin);
        nMax = Math.min(chart.$eaFullX.max, nMax);
        // Always set options + update (works without zoom plugin / zoomScale)
        if (!chart.options.scales) chart.options.scales = {};
        if (!chart.options.scales.x) chart.options.scales.x = { type: 'linear' };
        chart.options.scales.x.min = nMin;
        chart.options.scales.x.max = nMax;
        if (chart.scales.x) {
          chart.scales.x.options.min = nMin;
          chart.scales.x.options.max = nMax;
        }
        chart.update('none');
      } catch (err) {
        console.warn('[EA] zoom', err);
      }
    };
    canvas.$eaWheelHandler = onWheel;
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Click-drag to pan left/right (no Hammer dependency)
    let drag = null;
    const onDown = (e) => {
      if (e.button !== 0) return;
      if (chart.$eaDestroyed) return;
      const x = chart.scales && chart.scales.x;
      if (!x) return;
      drag = {
        startClientX: e.clientX,
        min: (chart.options.scales && chart.options.scales.x && chart.options.scales.x.min != null)
          ? chart.options.scales.x.min : x.min,
        max: (chart.options.scales && chart.options.scales.x && chart.options.scales.x.max != null)
          ? chart.options.scales.x.max : x.max
      };
      if (!chart.$eaFullX) chart.$eaFullX = { min: x.min, max: x.max };
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    };
    const onMoveDrag = (e) => {
      if (!drag || chart.$eaDestroyed) return;
      const rect = canvas.getBoundingClientRect();
      const x = chart.scales && chart.scales.x;
      if (!x || !rect.width) return;
      const range = drag.max - drag.min;
      const dxPx = e.clientX - drag.startClientX;
      const dxVal = -(dxPx / rect.width) * range;
      let nMin = drag.min + dxVal;
      let nMax = drag.max + dxVal;
      const full = chart.$eaFullX;
      if (full) {
        if (nMin < full.min) { nMax += full.min - nMin; nMin = full.min; }
        if (nMax > full.max) { nMin -= nMax - full.max; nMax = full.max; }
        nMin = Math.max(full.min, nMin);
        nMax = Math.min(full.max, nMax);
      }
      if (!chart.options.scales) chart.options.scales = {};
      if (!chart.options.scales.x) chart.options.scales.x = { type: 'linear' };
      chart.options.scales.x.min = nMin;
      chart.options.scales.x.max = nMax;
      if (chart.scales.x) {
        chart.scales.x.options.min = nMin;
        chart.scales.x.options.max = nMax;
      }
      chart.update('none');
    };
    const onUp = () => {
      drag = null;
      canvas.style.cursor = '';
    };
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMoveDrag);
    window.addEventListener('mouseup', onUp);
    chart.$eaDragCleanup = () => {
      try {
        canvas.removeEventListener('mousedown', onDown);
        window.removeEventListener('mousemove', onMoveDrag);
        window.removeEventListener('mouseup', onUp);
      } catch (e) {}
    };
  }

  // Wheel on side scale gutters → scroll the archive panel
  if (!window.__eaSideScrollInstalled) {
    window.__eaSideScrollInstalled = true;
    document.addEventListener('wheel', (e) => {
      try {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || !el.closest) return;
        if (!el.closest('#ea-panel')) return;
        // Already handled when over canvas; for gutters scroll panel
        const panel = document.getElementById('ea-panel');
        if (panel && !e.shiftKey) {
          panel.scrollTop += e.deltaY * 6;
          e.preventDefault();
        }
      } catch (err) {}
    }, { passive: false, capture: true });
  }






  const crosshairPlugin = createCrosshairPlugin({ leftDecimals: 2, rightDecimals: 2, rightUnit: '%' });


  let __eaChartLoading = null;
  function ensureChartWithZoom(cb) {
    const ChartRef = () => getChart();

    const done = () => {
      try { cb && cb(); } catch (e) { console.warn(e); }
    };

    if (ChartRef()) {
      done();
      return;
    }
    if (__eaChartLoading) {
      __eaChartLoading.then(done);
      return;
    }
    __eaChartLoading = new Promise((resolve) => {
      const load = (src) => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => res();
        s.onerror = () => rej(new Error('fail ' + src));
        (PAGE.document || document).head.appendChild(s);
      });
      (async () => {
        try {
          if (!ChartRef()) {
            await load('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js');
          }
          // Skip hammer + zoom plugin (broken in TM sandbox). We implement shift+wheel ourselves.
          console.log('[EA] Chart ready', !!ChartRef());
        } catch (e) {
          console.warn('[EA] chart zoom load', e);
        }
        resolve();
      })();
    });
    __eaChartLoading.then(done);
  }

  function zoomPluginOptions() {
    // Pan disabled — Hammer often missing in TM sandbox (causes addEventListener/pan errors).
    // Zoom via our shift+wheel handler; drag-pan optional via plugin only if hammer present.
    const hasHammer = !!(typeof Hammer !== 'undefined' || (PAGE && PAGE.Hammer));
    return {
      zoom: {
        wheel: { enabled: false }, // we handle wheel ourselves
        pinch: { enabled: !!hasHammer },
        mode: 'x'
      },
      pan: {
        enabled: !!hasHammer,
        mode: 'x',
        modifierKey: null,
        threshold: 8
      },
      limits: {
        x: { min: 'original', max: 'original', minRange: 2 }
      }
    };
  }

  function renderGraph(results) {
    const canvas = document.getElementById('ea-graph');
    if (!canvas) return;

    if (chartInstance) {
      // Save current legend state before destroy
      try {
        chartInstance.legend.legendItems.forEach(item => {
          legendState[item.text] = !item.hidden;
        });
        setMeta('legendState', legendState);
      } catch (e) {}
      chartInstance.destroy();
      chartInstance = null;
    }

    if (!results.length) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#666';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No results match the current filters', canvas.width / 2, canvas.height / 2);
      return;
    }

    if (!getChart()) {
      ensureChartWithZoom(() => renderGraph(results));
      return;
    }

    // Downsample scatter points if too many (keep averages exact)
    let drawIndexes = results.map((_, i) => i);
    if (results.length > MAX_POINTS_DRAW) {
      const step = results.length / MAX_POINTS_DRAW;
      drawIndexes = [];
      for (let i = 0; i < MAX_POINTS_DRAW; i++) drawIndexes.push(Math.floor(i * step));
      // always include last point
      if (drawIndexes[drawIndexes.length - 1] !== results.length - 1) {
        drawIndexes.push(results.length - 1);
      }
    }

    const wpmData = results.map(r => r.wpm);
    const accData = results.map(r => r.acc);
    const stumbleData = results.map(r => (r.stumblePct != null ? r.stumblePct : null));
    const charWeights = results.map(r => resultCharCount(r));
    const avg10Wpm = computeMovingAvg(wpmData, 10, charWeights);
    const avg100Wpm = computeMovingAvg(wpmData, 100, charWeights);
    const avg10Acc = computeMovingAvg(accData, 10, charWeights);
    const avg100Acc = computeMovingAvg(accData, 100, charWeights);
    // Moving avg only over points that have stumble data
    const stumbleForAvg = stumbleData.map(v => (v == null ? NaN : v));
    function movingAvgSparse(data, window) {
      const out = new Array(data.length).fill(null);
      const useW = !!trueAverage;
      for (let i = 0; i < data.length; i++) {
        let sum = 0, wsum = 0, n = 0;
        for (let j = Math.max(0, i - window + 1); j <= i; j++) {
          if (data[j] == null || Number.isNaN(data[j])) continue;
          if (useW) {
            const w = charWeights[j] || 1;
            sum += data[j] * w;
            wsum += w;
          } else {
            sum += data[j];
            n++;
          }
        }
        out[i] = useW ? (wsum ? sum / wsum : null) : (n ? sum / n : null);
      }
      return out;
    }
    const avg10Stumble = movingAvgSparse(stumbleForAvg, 10);
    const avg100Stumble = movingAvgSparse(stumbleForAvg, 100);

    const accVals = accData.filter(v => v != null && !Number.isNaN(v));
    // Always pin accuracy axis to 90–100 for readability (user request)
    let accAxisMin = 90; // visual floor; dots below 90 clamped in datasets, tooltips use real acc
    const stumbleVals = stumbleData.filter(v => v != null && !Number.isNaN(v));
    let stumbleMax = 25;
    if (stumbleVals.length) {
      const mx = Math.max(...stumbleVals);
      // Tight scale: pad ~10% then round up to nice step of 5
      stumbleMax = Math.min(100, Math.max(10, Math.ceil((mx * 1.08) / 5) * 5));
    }

    const ctx = canvas.getContext('2d');
    chartInstance = new (getChart())(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'WPM',
            data: drawIndexes.map(i => ({ x: i, y: wpmData[i] })),
            backgroundColor: 'rgba(233, 196, 106, 0.55)',
            pointRadius: dotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y',
            hidden: legendState['WPM'] === false
          },
          {
            label: 'Avg of 10 (WPM)',
            data: results.map((_, i) => ({ x: i, y: avg10Wpm[i] })),
            type: 'line',
            borderColor: 'rgba(233, 196, 106, 0.95)',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            yAxisID: 'y',
            hidden: legendState['Avg of 10 (WPM)'] === false
          },
          {
            label: 'Avg of 100 (WPM)',
            data: results.map((_, i) => ({ x: i, y: avg100Wpm[i] })),
            type: 'line',
            borderColor: 'rgba(244, 162, 97, 0.95)',
            borderWidth: 2.4,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            yAxisID: 'y',
            hidden: legendState['Avg of 100 (WPM)'] === false
          },
          {
            label: 'Accuracy',
            data: drawIndexes.map(i => ({ x: i, y: (accData[i] == null ? null : Math.max(90, accData[i])) })),
            backgroundColor: 'rgba(231, 111, 81, 0.6)',
            pointRadius: dotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y1',
            hidden: legendState['Accuracy'] === false
          },
          {
            label: 'Avg of 10 (Acc)',
            data: results.map((_, i) => ({ x: i, y: avg10Acc[i] == null ? null : Math.max(90, avg10Acc[i]) })),
            type: 'line',
            borderColor: 'rgba(231, 111, 81, 0.95)',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            yAxisID: 'y1',
            hidden: legendState['Avg of 10 (Acc)'] === false
          },
          {
            label: 'Avg of 100 (Acc)',
            data: results.map((_, i) => ({ x: i, y: avg100Acc[i] == null ? null : Math.max(90, avg100Acc[i]) })),
            type: 'line',
            borderColor: 'rgba(214, 40, 40, 0.9)',
            borderWidth: 2.4,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            yAxisID: 'y1',
            hidden: legendState['Avg of 100 (Acc)'] === false
          },
          {
            label: 'Stumble %',
            data: drawIndexes
              .filter(i => stumbleData[i] != null)
              .map(i => ({ x: i, y: stumbleData[i] })),
            backgroundColor: 'rgba(110, 198, 255, 0.85)',
            borderColor: 'rgba(110, 198, 255, 1)',
            pointRadius: dotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y2',
            hidden: legendState['Stumble %'] === false
          },
          {
            label: 'Avg of 10 (Stumble %)',
            data: results.map((_, i) => ({
              x: i,
              y: avg10Stumble[i] == null ? NaN : avg10Stumble[i]
            })),
            type: 'line',
            borderColor: 'rgba(110, 198, 255, 0.95)',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            spanGaps: true,
            yAxisID: 'y2',
            hidden: legendState['Avg of 10 (Stumble %)'] === false
          },
          {
            label: 'Avg of 100 (Stumble %)',
            data: results.map((_, i) => ({
              x: i,
              y: avg100Stumble[i] == null ? NaN : avg100Stumble[i]
            })),
            type: 'line',
            borderColor: 'rgba(80, 170, 230, 0.95)',
            borderWidth: 2.4,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            spanGaps: true,
            yAxisID: 'y2',
            hidden: legendState['Avg of 100 (Stumble %)'] === false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: persistentTooltips
          ? { mode: 'index', intersect: false }
          : { mode: 'nearest', intersect: true },
        onClick: () => {}, // keep legend working
        onHover: (evt, elements) => {
          try {
            if (elements && elements.length) {
              const el = elements[0];
              const parsedX = el.element && el.element.$context && el.element.$context.parsed
                ? el.element.$context.parsed.x
                : null;
              let idx = (typeof parsedX === 'number' && !isNaN(parsedX))
                ? Math.round(parsedX)
                : el.index;
              // Any metric (WPM / Acc / Stumble) maps to the same full result
              if (results[idx]) {
                window.__eaHoveredResult = results[idx];
                window.__eaHoveredIndex = idx;
                return;
              }
            }
            // only clear when leaving chart area
            if (!evt || !evt.native || evt.native.target === undefined) {
              window.__eaHoveredResult = null;
              window.__eaHoveredIndex = null;
            }
          } catch (e) {}
        },
        plugins: {
                    legend: {
            labels: { color: '#d1d0c5', boxWidth: 12, font: { size: 11 } },
            onClick: (e, legendItem, legend) => {
              // default toggle + persist
              const index = legendItem.datasetIndex;
              const ci = legend.chart;
              if (ci.isDatasetVisible(index)) {
                ci.hide(index);
                legendItem.hidden = true;
              } else {
                ci.show(index);
                legendItem.hidden = false;
              }
              legendState[legendItem.text] = !legendItem.hidden;
              setMeta('legendState', legendState);
            }
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = items[0].parsed?.x;
                const realIndex = (typeof x === 'number' && results[Math.round(x)])
                  ? Math.round(x)
                  : (results.length > MAX_POINTS_DRAW ? drawIndexes[items[0].dataIndex] : items[0].dataIndex);
                {
                  let ts = Number(results[realIndex]?.timestamp) || 0;
                  if (ts && ts < 1e12) ts *= 1000;
                  if (!ts || ts < 946684800000) ts = Date.now();
                  return new Date(ts).toLocaleString();
                }
              },
              // Suppress per-dataset lines — we always show full metrics below
              label: () => null,
              afterBody: (items) => {
                const x = items[0].parsed?.x;
                const realIndex = (typeof x === 'number' && results[Math.round(x)])
                  ? Math.round(x)
                  : (results.length > MAX_POINTS_DRAW ? drawIndexes[items[0].dataIndex] : items[0].dataIndex);
                const r = results[realIndex];
                if (!r) return [];
                const nameMap = (typeof window !== 'undefined' && window.__eaTagNameMap) || {};
                const tagNames = (r.tags || []).map(id => nameMap[String(id)] || id);
                const wpm = r.wpm != null ? Number(r.wpm).toFixed(2) : '—';
                const acc = r.acc != null ? Number(r.acc).toFixed(2) + '%' : '—';
                let stumbleLine = 'Stumble: (not recorded)';
                if (r.stumblePct != null) {
                  stumbleLine = `Stumble: ${r.stumbledWords}/${r.totalWords} words (${Number(r.stumblePct).toFixed(2)}%)`;
                }
                return [
                  `WPM: ${wpm}`,
                  `Accuracy: ${acc}`,
                  stumbleLine,
                  `Mode: ${r.mode}`,
                  `Type: ${r.type || r.mode2 || '—'}`,
                  `Lang: ${r.language}`,
                  `Tags: ${tagNames.length ? tagNames.join(', ') : 'none'}`,
                  `Funbox: ${r.funbox && r.funbox !== 'none' ? r.funbox : 'none'}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Test # (filtered chronological)', color: '#888' },
            ticks: { color: '#888', maxTicksLimit: 12 },
            grid: { color: 'rgba(255,255,255,0.05)' },
            // Keep same right gap for last-day (few points) as all-time/week
            min: results.length ? -0.5 : 0,
            max: (function () {
              const n = results.length;
              if (!n) return 1;
              // ~4% pad on the right, minimum 2 units so last point isn't on the edge
              const pad = Math.max(2, Math.ceil(n * 0.04));
              return (n - 1) + pad;
            })()
          },
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'WPM', color: '#e9c46a' },
            ticks: { color: '#e9c46a' },
            grid: { color: 'rgba(255,255,255,0.06)' },
            suggestedMin: (function() {
              const vals = wpmData.filter(v => v != null && v > 0);
              if (!vals.length) return 0;
              return Math.max(0, Math.floor(Math.min(...vals) * 0.9));
            })(),
            suggestedMax: (function() {
              const vals = wpmData.filter(v => v != null && v > 0);
              if (!vals.length) return 100;
              return Math.ceil(Math.max(...vals) * 1.05);
            })()
          },
          y1: {
            type: 'linear',
            position: 'right',
            min: accAxisMin,
            max: 100,
            title: { display: true, text: 'Accuracy %', color: '#e76f51' },
            ticks: { color: '#e76f51' },
            grid: { drawOnChartArea: false }
          },
          y2: {
            type: 'linear',
            position: 'right',
            min: 0,
            max: stumbleMax,
            reverse: true, // 0 at same top as accuracy 100%
            title: { display: true, text: 'Stumble % ↓ better', color: '#6ec6ff' },
            ticks: { color: '#6ec6ff' },
            grid: { drawOnChartArea: false }
            // no offset — keep 0 aligned with acc 100%
          }
        }
      },
      plugins: [createCrosshairPlugin({ leftDecimals: 2, rightDecimals: 2, rightUnit: '%' }), createWheelZoomPlugin()]
    });
    try { bindWheelZoomToChart(chartInstance); } catch (e) {}
    try { pinScaleLabels(chartInstance, '#ea-main-frame'); } catch (e) {}
    try { window.__eaLastFiltered = results; } catch (e) {}
  }

  /** Append one matching result to existing per-test chart — O(1), no full refilter */
  function appendLiveToCharts(r) {
    if (!r) return false;
    try {
      // Always keep full cache in sync (dedupe)
      // Only mutate cache if it already holds the full archive (or a real Apply load).
      // Never start a 1–N item cache from live captures alone — that hid the 6k history.
      if (Array.isArray(window.__eaCachedAll) && window.__eaCachedAll.length > 50) {
        const exists = window.__eaCachedAll.some(x =>
          x.id === r.id ||
          (Math.abs(Number(x.wpm) - Number(r.wpm)) < 0.05 &&
           Math.abs((Number(x.timestamp) || 0) - (Number(r.timestamp) || 0)) < 15000)
        );
        if (!exists) window.__eaCachedAll.push(r);
      } else if (window.__eaEverFiltered) {
        // User already filtered once — refresh full list in background
        try {
          Promise.resolve(getAllResults()).then((all) => {
            if (Array.isArray(all) && all.length) window.__eaCachedAll = all;
          }).catch(() => {});
        } catch (e) {}
      }

      // Match filters; loose fallback so live tests still appear on graph
      let matches = true;
      try {
        matches = applyFilters([r]).length > 0;
        if (!matches && Array.isArray(window.__eaLastFiltered) && window.__eaLastFiltered.length) {
          const sample = window.__eaLastFiltered[window.__eaLastFiltered.length - 1];
          const sameMode = sample && r.mode && sample.mode === r.mode;
          const rTags = (r.tags || []).map(String);
          const sTags = (sample.tags || []).map(String);
          const tagOk = !rTags.length || !sTags.length || rTags.some(t => sTags.includes(t));
          if (sameMode && tagOk) matches = true;
        }
      } catch (e) { matches = true; }
      if (!matches) {
        // Last resort: tag name overlap with selected filters (eclipse etc.)
        try {
          const nameMap = window.__eaTagNameMap || {};
          const sel = (currentFilters.tags || []).map(String);
          const rTags = (r.tags || []).map(String);
          const rNames = rTags.map(t => String(nameMap[t] || t).toLowerCase());
          const selNames = sel.map(t => String(nameMap[t] || t).toLowerCase());
          if (sel.length && rNames.some(n => selNames.includes(n) || sel.includes(n))) {
            matches = true;
          }
          // If only tag filter is active and mode is present, allow
          if (!matches && r.mode && currentFilters.mode && currentFilters.mode[r.mode] !== false) {
            if (!sel.length) matches = true;
          }
        } catch (e) {}
      }
      if (!matches) {
        console.log('[EA] live saved, filters mismatch', {
          mode: r.mode, type: r.type, tags: r.tags, wpm: r.wpm,
          filterTags: currentFilters.tags, filterModes: currentFilters.mode
        });
        return false;
      }
      // Always force a real wall-clock timestamp before graph/DB use
      {
        let ts = Number(r.timestamp) || 0;
        if (ts && ts < 1e12) ts *= 1000;
        if (!ts || ts < 946684800000 || ts > Date.now() + 60000) {
          r.timestamp = Date.now();
        } else {
          r.timestamp = ts;
        }
      }
      console.log('[EA] live append try', r.wpm, r.mode, r.type, r.tags, 'stumble', r.stumblePct, 'ts', r.timestamp);

      if (!window.__eaPendingLive) window.__eaPendingLive = [];
      // dedupe pending
      if (!window.__eaPendingLive.some(x => x.id === r.id ||
          (Math.abs(Number(x.wpm) - Number(r.wpm)) < 0.05 &&
           Math.abs((Number(x.timestamp) || 0) - (Number(r.timestamp) || 0)) < 15000))) {
        window.__eaPendingLive.push(r);
      }

      // CRITICAL: tooltip reads results[realIndex].timestamp from __eaLastFiltered.
      // Must push r here or the new point shows 1/1/1970.
      if (!window.__eaLastFiltered) window.__eaLastFiltered = [];
      if (!window.__eaLastFiltered.some(x =>
          x.id === r.id ||
          (Math.abs(Number(x.wpm) - Number(r.wpm)) < 0.05 &&
           Math.abs((Number(x.timestamp) || 0) - (Number(r.timestamp) || 0)) < 15000))) {
        window.__eaLastFiltered.push(r);
      }

      if (!chartInstance || !chartInstance.data || !chartInstance.data.datasets) {
        window.__eaDirtyCharts = true;
        return true;
      }

      // Append single scatter points
      const ds = chartInstance.data.datasets;
      const findDs = (label) => ds.find(d => d.label === label);
      const wpmDs = findDs('WPM');
      const accDs = findDs('Accuracy');
      const stDs = findDs('Stumble %');
      let x = 0;
      if (wpmDs && wpmDs.data && wpmDs.data.length) {
        const last = wpmDs.data[wpmDs.data.length - 1];
        x = (last && last.x != null) ? last.x + 1 : wpmDs.data.length;
      } else if (window.__eaLastFiltered) {
        x = Math.max(0, window.__eaLastFiltered.length - 1);
      }
      if (wpmDs) wpmDs.data.push({ x, y: r.wpm });
      if (accDs) accDs.data.push({ x, y: r.acc == null ? null : Math.max(90, r.acc) });
      if (stDs && r.stumblePct != null) stDs.data.push({ x, y: r.stumblePct });

      // Rolling averages INCLUDE the new point (already in __eaLastFiltered)
      try {
        const slice10 = window.__eaLastFiltered.slice(-10);
        const slice100 = window.__eaLastFiltered.slice(-100);
        const avg = (arr, key) => {
          const vals = arr.map(z => z[key]).filter(v => v != null && !Number.isNaN(v));
          if (!vals.length) return null;
          return vals.reduce((a, b) => a + b, 0) / vals.length;
        };
        const a10w = avg(slice10, 'wpm');
        const a100w = avg(slice100, 'wpm');
        const a10a = avg(slice10, 'acc');
        const a100a = avg(slice100, 'acc');
        const a10s = avg(slice10, 'stumblePct');
        const a100s = avg(slice100, 'stumblePct');
        const pushAvg = (label, y) => {
          const d = findDs(label);
          if (!d || y == null) return;
          d.data.push({ x, y: label.includes('Acc') ? Math.max(90, y) : y });
        };
        pushAvg('Avg of 10 (WPM)', a10w);
        pushAvg('Avg of 100 (WPM)', a100w);
        pushAvg('Avg of 10 (Acc)', a10a);
        pushAvg('Avg of 100 (Acc)', a100a);
        pushAvg('Avg of 10 (Stumble %)', a10s);
        pushAvg('Avg of 100 (Stumble %)', a100s);
      } catch (e) {}

      chartInstance.update('none');
      // remove from pending once drawn
      window.__eaPendingLive = (window.__eaPendingLive || []).filter(x => x.id !== r.id);
      window.__eaDirtyCharts = (window.__eaPendingLive && window.__eaPendingLive.length > 0);
      return true;
    } catch (e) {
      console.warn('[EA] appendLiveToCharts', e);
      window.__eaDirtyCharts = true;
      return false;
    }
  }

  function flushPendingLiveToCharts() {
    const pending = window.__eaPendingLive || [];
    if (!pending.length) {
      window.__eaDirtyCharts = false;
      return;
    }
    // Append each pending point once — no full refilter
    const list = pending.slice();
    window.__eaPendingLive = [];
    for (const r of list) {
      try { appendLiveToCharts(r); } catch (e) {}
    }
    window.__eaDirtyCharts = false;
  }

  /*********************************************************************
   *  UI
   *********************************************************************/
  let panelOpen = false;

  // Delete hovered per-test point with Delete key (archive open)
  if (!window.__eaDeleteKeyBound) {
    window.__eaDeleteKeyBound = true;
    document.addEventListener('keydown', async (e) => {
      if (e.key !== 'Delete') return;
      const root = document.getElementById('ea-root');
      if (!root || (!root.classList.contains('open') && getComputedStyle(root).display === 'none')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const r = window.__eaHoveredResult;
      if (!r || !r.id) return;
      e.preventDefault();
      e.stopPropagation();
      const when = new Date(r.timestamp || 0).toLocaleString();
      const msg = 'Delete this result permanently from the local archive?\n\n' +
        'WPM: ' + Number(r.wpm).toFixed(2) + '\n' +
        'Accuracy: ' + Number(r.acc).toFixed(2) + '%\n' +
        'Date: ' + when + '\n' +
        'Mode: ' + (r.mode || '') + ' ' + (r.mode2 != null ? r.mode2 : '');
      if (!confirm(msg)) return;
      try {
        const rid = r.id;
        const rts = Number(r.timestamp) || 0;
        const rwpm = Number(r.wpm);
        // One result record = WPM + Acc + Stumble — delete the whole thing
        try { await deleteResultById(rid); } catch (e1) {
          console.warn('[EA] deleteResultById', e1);
        }
        const isSame = (x) => {
          if (!x) return false;
          if (rid != null && x.id != null && String(x.id) === String(rid)) return true;
          if (rts && Math.abs((Number(x.timestamp) || 0) - rts) < 2000 &&
              Math.abs(Number(x.wpm) - rwpm) < 0.05) return true;
          return false;
        };
        for (const key of ['__eaCachedAll', '__eaLastFiltered', '__eaFirstOpenSlice']) {
          if (Array.isArray(window[key])) window[key] = window[key].filter((x) => !isSame(x));
        }
        // Destroy charts so leftover acc/stumble dots cannot linger
        try {
          if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        } catch (e) {}
        try {
          if (typeof dailyChart !== 'undefined' && dailyChart) { dailyChart.destroy(); dailyChart = null; }
        } catch (e) {}
        try {
          if (typeof monthlyChart !== 'undefined' && monthlyChart) { monthlyChart.destroy(); monthlyChart = null; }
        } catch (e) {}
        try {
          document.querySelectorAll('#ea-root canvas').forEach((c) => {
            try { if (c.__eaChart) { c.__eaChart.destroy(); c.__eaChart = null; } } catch (e) {}
          });
        } catch (e) {}
        window.__eaHoveredResult = null;
        window.__eaHoveredIndex = null;
        try { showToast('Result deleted (wpm + acc + stumble)'); } catch (e2) {}
        window.__eaDirtyCharts = false;
        await renderArchive();
      } catch (err) {
        console.warn('[EA] delete failed', err);
        alert('Delete failed: ' + (err && err.message ? err.message : err));
      }
    }, true);
  }

  function injectStyles() {
    GM_addStyle(`
      #ea-root {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.78);
        z-index: 99999;
        display: none;
        font-family: 'Roboto Mono', 'Lexend Deca', monospace, sans-serif;
        color: #d1d0c5;
        overflow: auto;
      }
      #ea-root.open { display: flex; justify-content: center; padding: 24px 12px; }
      .ea-sub { margin: 0 0 12px; font-size: 12px; color: #888; font-weight: 400; }
      #ea-panel {
        background: #2c2e31;
        border-radius: 12px;
        width: min(1100px, 100%);
        max-height: 96vh;
        overflow: auto;
        scroll-behavior: smooth;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        box-shadow: 0 20px 60px rgba(0,0,0,0.6);
        padding: 18px 22px 28px;
      }
      #ea-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 14px; border-bottom: 1px solid #444; padding-bottom: 10px;
      }
      #ea-header h2 { margin: 0; font-size: 1.3rem; color: #e2b714; }
      #ea-close { background: transparent; border: none; color: #d1d0c5; font-size: 1.6rem; cursor: pointer; }

      .ea-filters { margin-bottom: 16px; }
      .ea-filter-row { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; }
      .ea-filter-group { flex: 1; min-width: 190px; }
      .ea-filter-group.wide { flex: 1 1 100%; }
      .ea-label { font-size: 0.72rem; color: #e2b714; margin-bottom: 5px; text-transform: lowercase; }
      .ea-buttons { display: flex; flex-wrap: wrap; gap: 5px; }
      .ea-buttons button {
        background: #323437; border: none; color: #d1d0c5;
        padding: 5px 11px; border-radius: 5px; cursor: pointer; font-size: 0.82rem;
      }
      .ea-buttons button:hover { background: #3c3e42; }
      .ea-buttons button.active {
        background: #e2b714; color: #2c2e31; font-weight: 600;
      }

      /* Chip-style multi-select for tags / funbox / language */
      .ea-chip-row {
        display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 32px;
      }
      .ea-chip {
        display: inline-flex; align-items: center; gap: 5px;
        background: #e2b714; color: #2c2e31; font-weight: 600;
        padding: 4px 8px 4px 10px; border-radius: 5px; font-size: 0.82rem;
      }
      .ea-chip .ea-chip-x {
        background: transparent; border: none; color: #2c2e31;
        cursor: pointer; font-size: 0.95rem; line-height: 1; padding: 0 2px;
        opacity: 0.7;
      }
      .ea-chip .ea-chip-x:hover { opacity: 1; }
      .ea-chip-add {
        background: #323437; border: 1px dashed #666; color: #d1d0c5;
        width: 28px; height: 28px; border-radius: 5px; cursor: pointer;
        font-size: 1.1rem; line-height: 1; display: flex; align-items: center; justify-content: center;
      }
      .ea-chip-add:hover { background: #3c3e42; border-color: #e2b714; color: #e2b714; }
      .ea-chip-picker {
        z-index: 2147483646 !important;
        position: absolute; z-index: 100010;
        background: #2c2e31; border: 1px solid #555; border-radius: 8px;
        max-height: 220px; overflow-y: auto; min-width: 180px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5); padding: 4px 0;
      }
      .ea-picker-row {
        display: flex; align-items: center; gap: 0;
        width: 100%;
      }
      .ea-picker-row .ea-picker-item {
        flex: 1 1 auto; width: auto !important; text-align: left;
        border: none; border-radius: 0;
        background: transparent; color: #d1d0c5; padding: 7px 10px;
        cursor: pointer; font-size: 0.85rem;
      }
      .ea-picker-row .ea-picker-item:hover { background: #3a3c40; color: #e2b714; }
      .ea-picker-del {
        flex: 0 0 28px; width: 28px !important; height: 28px;
        border: none; background: transparent; color: #e76f51;
        padding: 0; cursor: pointer; font-size: 1.1rem; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      .ea-picker-del:hover { background: rgba(231,111,81,0.25); color: #ff8a70; }
      .ea-picker-prune {
        display: block; width: 100%; border: none; border-top: 1px solid #555;
        background: #252629; color: #e9c46a; padding: 8px 10px;
        cursor: pointer; font-size: 0.8rem; text-align: left;
      }
      .ea-picker-prune:hover { background: #3a3c40; }

      .ea-chip-picker .ea-picker-empty {
        padding: 10px 14px; color: #888; font-size: 0.82rem;
      }
      .ea-filter-actions { display: flex; gap: 8px; margin-top: 8px; }
      .ea-filter-actions button {
        padding: 7px 14px; border-radius: 5px; border: none; cursor: pointer; font-size: 0.87rem;
      }
      #ea-clear-filters { background: #444; color: #ddd; }
      .ea-check-btn {
        display: inline-flex; align-items: center; gap: 6px;
        background: #3c3e42; color: #ddd; border-radius: 6px;
        padding: 6px 10px; font: 12px sans-serif; cursor: pointer;
        user-select: none;
      }
      .ea-check-btn input { accent-color: #e2b714; cursor: pointer; }
      #ea-apply-filters { background: #e2b714; color: #2c2e31; font-weight: 600; }

      #ea-stats {
        display: flex; gap: 12px; margin: 10px 0 14px; flex-wrap: wrap; font-size: 0.9rem;
      }
      #ea-stats span { background: #323437; padding: 5px 11px; border-radius: 5px; }

      #ea-graph-container {
        position: relative; height: 400px;
        background: #24262a; border-radius: 10px; padding: 8px; margin-bottom: 12px;
      }
      #ea-graph, #ea-daily-graph, #ea-monthly-graph, #ea-improve-graph {
        width: 100% !important; height: 100% !important;
      }
      /* Fixed side borders + scrollable plot */
      .ea-chart-frame {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        background: #24262a;
        border-radius: 10px;
        margin-bottom: 12px;
        overflow: hidden;
      }
      .ea-yside {
        flex: 0 0 72px;
        width: 72px;
        min-width: 72px;
        max-width: 72px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        pointer-events: auto;
        cursor: ns-resize;
        z-index: 5;
        padding: 28px 4px 20px;
        box-sizing: border-box;
        user-select: none;
      }
      .ea-yside.left { color: #e9c46a; text-align: right; align-items: flex-end; }
      .ea-yside.right { color: #e76f51; text-align: left; align-items: flex-start; }
      .ea-yside .ea-smax,
      .ea-yside .ea-smin {
        display: block;
        width: 100%;
        overflow: hidden;
        white-space: nowrap;
      }
      .ea-yside .ea-cross-val {
        display: block;
        width: 100%;
        box-sizing: border-box;
        background: rgba(233,196,106,0.92);
        color: #111;
        border-radius: 3px;
        padding: 2px 2px;
        font-weight: 700;
        min-height: 15px;
        line-height: 15px;
        overflow: hidden;
        white-space: nowrap;
        text-align: center;
      }
      .ea-yside.right .ea-cross-val {
        background: rgba(231,111,81,0.92);
      }
      .ea-yside .ea-cross-val-stumble {
        display: block;
        width: 100%;
        box-sizing: border-box;
        background: rgba(110, 198, 255, 0.92);
        color: #111;
        border-radius: 3px;
        padding: 1px 2px;
        font-weight: 700;
        min-height: 14px;
        line-height: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-align: center;
        margin-top: 2px;
      }
      .ea-hscroll {
        flex: 1 1 auto;
        overflow-x: auto;
        overflow-y: hidden;
        position: relative;
        min-width: 0;
        overscroll-behavior: contain;
      }
      .ea-chart-frame {
        overscroll-behavior: contain;
      }
      .ea-hscroll > .ea-graph-box {
        min-width: 100%;
        height: 360px;
        position: relative;
        margin: 0;
        padding: 8px;
        box-sizing: border-box;
        background: #24262a;
      }
      .ea-graph-title {
        font-size: 0.85rem; color: #e2b714; margin: 14px 0 6px; font-weight: 600;
      }
      .ea-graph-subtitle {
        font-size: 0.75rem; color: #888; margin: -2px 0 6px;
      }

      #ea-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
      #ea-toolbar #ea-clear { margin-left: auto; }
      #ea-toolbar button {
        background: #323437; border: none; color: #d1d0c5;
        padding: 7px 13px; border-radius: 5px; cursor: pointer; font-size: 0.84rem;
      }
      #ea-toolbar button:hover { background: #3c3e42; }
      #ea-toolbar button.primary { background: #e2b714; color: #2c2e31; font-weight: 600; }
      #ea-toolbar button.danger { background: #9b2226; }

      #ea-fab {
        position: fixed; bottom: 22px; right: 22px; z-index: 99990;
        background: #e2b714; color: #2c2e31; border: none; border-radius: 50px;
        padding: 11px 16px; font-weight: 700; font-size: 0.92rem; cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,0.4);
        display: flex; align-items: center; gap: 7px;
      }
      #ea-fab:hover { filter: brightness(1.08); }
      #ea-badge {
        background: #2c2e31; color: #e2b714; border-radius: 20px;
        padding: 2px 7px; font-size: 0.78rem;
      }

      .ea-toast {
        position: fixed; bottom: 85px; right: 22px;
        background: #323437; color: #d1d0c5; padding: 11px 16px;
        border-radius: 8px; z-index: 100000; max-width: 340px;
        opacity: 0; transition: opacity 0.3s; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      }
      .ea-toast.show { opacity: 1; }
      .ea-toast.success { border-left: 4px solid #2a9d8f; }
      .ea-toast.info { border-left: 4px solid #e2b714; }
      .ea-toast.error { border-left: 4px solid #e76f51; }
    `);
  }

  function showToast(msg, type = 'info', duration = 3800) {
    const t = document.createElement('div');
    t.className = `ea-toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, duration);
  }

  async function updateBadge() {
    const count = await getResultCount();
    const badge = document.getElementById('ea-badge');
    if (badge) badge.textContent = count.toLocaleString();
  }

  function createFAB() {
    if (document.getElementById('ea-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'ea-fab';
    fab.innerHTML = `📦 Archive <span id="ea-badge">0</span>`;
    fab.addEventListener('click', openPanel);
    document.body.appendChild(fab);
    updateBadge();
  }

  function buildFilterHTML() {
    return `
      <div class="ea-filters">
        <div class="ea-filter-row">
          <div class="ea-filter-group">
            <div class="ea-label">time period</div>
            <div class="ea-buttons" data-filter="timePeriod">
              <button data-value="last day">last day</button>
              <button data-value="last week">last week</button>
              <button data-value="last month">last month</button>
              <button data-value="last 3 months">last 3 months</button>
              <button data-value="all" class="active">all time</button>
            </div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group">
            <div class="ea-label">★ difficulty</div>
            <div class="ea-buttons multi" data-filter="difficulty">
              <button data-value="normal" class="active">normal</button>
              <button data-value="expert" class="active">expert</button>
              <button data-value="master" class="active">master</button>
            </div>
          </div>
          <div class="ea-filter-group">
            <div class="ea-label">♛ personal best</div>
            <div class="ea-buttons multi" data-filter="pb">
              <button data-value="no" class="active">no</button>
              <button data-value="yes" class="active">yes</button>
            </div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group">
            <div class="ea-label">☰ mode</div>
            <div class="ea-buttons multi" data-filter="mode">
              <button data-value="words" class="active">words</button>
              <button data-value="time" class="active">time</button>
              <button data-value="quote" class="active">quote</button>
              <button data-value="zen" class="active">zen</button>
              <button data-value="custom" class="active">custom</button>
            </div>
          </div>
          <div class="ea-filter-group">
            <div class="ea-label">❝ quote length</div>
            <div class="ea-buttons multi" data-filter="quoteLength">
              <button data-value="short" class="active">short</button>
              <button data-value="medium" class="active">medium</button>
              <button data-value="long" class="active">long</button>
              <button data-value="thicc" class="active">thicc</button>
            </div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group">
            <div class="ea-label">A words</div>
            <div class="ea-buttons multi" data-filter="words">
              <button data-value="10" class="active">10</button>
              <button data-value="25" class="active">25</button>
              <button data-value="50" class="active">50</button>
              <button data-value="100" class="active">100</button>
              <button data-value="custom" class="active">custom</button>
            </div>
          </div>
          <div class="ea-filter-group">
            <div class="ea-label">⏱ time</div>
            <div class="ea-buttons multi" data-filter="time">
              <button data-value="15" class="active">15</button>
              <button data-value="30" class="active">30</button>
              <button data-value="60" class="active">60</button>
              <button data-value="120" class="active">120</button>
              <button data-value="custom" class="active">custom</button>
            </div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group">
            <div class="ea-label">@ punctuation</div>
            <div class="ea-buttons multi" data-filter="punctuation">
              <button data-value="on" class="active">on</button>
              <button data-value="off" class="active">off</button>
            </div>
          </div>
          <div class="ea-filter-group">
            <div class="ea-label"># numbers</div>
            <div class="ea-buttons multi" data-filter="numbers">
              <button data-value="on" class="active">on</button>
              <button data-value="off" class="active">off</button>
            </div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group wide">
            <div class="ea-label">🏷 tags</div>
            <div class="ea-chip-row" id="ea-tags-container" data-kind="tags"></div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group wide">
            <div class="ea-label">∞ funbox</div>
            <div class="ea-chip-row" id="ea-funbox-container" data-kind="funbox"></div>
          </div>
        </div>

        <div class="ea-filter-row">
          <div class="ea-filter-group wide">
            <div class="ea-label">🌐 language</div>
            <div class="ea-chip-row" id="ea-language-container" data-kind="language"></div>
          </div>
        </div>

        <div class="ea-filter-actions">
          <button id="ea-clear-filters">clear filters</button>
          <button id="ea-apply-filters">apply / refresh graph</button>
          <label class="ea-check-btn" title="Show tooltip for nearest test while mouse is inside the graph">
            <input type="checkbox" id="ea-persistent-tooltips" /> persistent tooltips
          </label>
          <label class="ea-check-btn" title="Larger result dots on all graphs">
            <input type="checkbox" id="ea-big-dots" /> big dots
          </label>
          <label class="ea-check-btn" title="Weight averages by characters typed (long tests count more than short ones)">
            <input type="checkbox" id="ea-true-average" /> true average
          </label>
        </div>
      </div>
    `;
  }

  function openPanel() {
    let root = document.getElementById('ea-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ea-root';
      root.innerHTML = `
        <div id="ea-panel">
          <div id="ea-header">
            <h2>Monkeytype Eternal Archive</h2><p class="ea-sub">Local results · filters · evolution graphs</p>
            <button id="ea-close">×</button>
          </div>
          <div id="ea-toolbar">
            <button id="ea-update" class="primary">↻ Update now</button>
            <button id="ea-import">Import JSON/CSV</button>
            <button id="ea-export">Export results JSON</button>
            <button id="ea-backup">Backup full DB</button>
            <button id="ea-restore">Restore full DB</button>
            <button id="ea-apekey">Ape Key</button>
            <span id="ea-apekey-status" style="font-size:0.8rem;opacity:0.85;margin-left:4px;"></span>
            <button id="ea-clear" class="danger" style="margin-left:auto;">Clear local archive</button>
          </div>
          ${buildFilterHTML()}
          <div id="ea-stats"></div>
          <div class="ea-graph-title">Per-test evolution</div>
          <div class="ea-chart-frame" id="ea-main-frame">
            <div class="ea-yside left"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-smin"></span></div>
            <div class="ea-hscroll" id="ea-main-scroll" style="overflow:hidden">
              <div class="ea-graph-box" id="ea-graph-container" style="height:400px">
                <canvas id="ea-graph"></canvas>
              </div>
            </div>
            <div class="ea-yside right"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-cross-val-stumble"></span><span class="ea-smin"></span></div>
          </div>
          <div class="ea-graph-title">Daily averages (one point per day)</div>
          <div class="ea-chart-frame" id="ea-daily-frame">
            <div class="ea-yside left"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-smin"></span></div>
            <div class="ea-hscroll" id="ea-daily-scroll">
              <div class="ea-graph-box" id="ea-daily-graph-container">
                <canvas id="ea-daily-graph"></canvas>
              </div>
            </div>
            <div class="ea-yside right"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-cross-val-stumble"></span><span class="ea-smin"></span></div>
          </div>
          <div class="ea-graph-title">Monthly averages (one point per month)</div>
          <div class="ea-chart-frame" id="ea-monthly-frame">
            <div class="ea-yside left"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-smin"></span></div>
            <div class="ea-hscroll" id="ea-monthly-scroll">
              <div class="ea-graph-box" id="ea-monthly-graph-container">
                <canvas id="ea-monthly-graph"></canvas>
              </div>
            </div>
            <div class="ea-yside right"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-cross-val-stumble"></span><span class="ea-smin"></span></div>
          </div>
          <div class="ea-graph-title">Improvement rate (Δ WPM per ~10 h effective typing)</div>
          <div class="ea-graph-subtitle">Sums test durations only. Each block ≈ 10 h of tests. First point is baseline (0). Later points = change vs previous block average.</div>
          <div class="ea-chart-frame" id="ea-improve-frame">
            <div class="ea-yside left"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-smin"></span></div>
            <div class="ea-hscroll" id="ea-improve-scroll">
              <div class="ea-graph-box" id="ea-improve-graph-container">
                <canvas id="ea-improve-graph"></canvas>
              </div>
            </div>
            <div class="ea-yside right"><span class="ea-smax"></span><span class="ea-cross-val"></span><span class="ea-cross-val-stumble"></span><span class="ea-smin"></span></div>
          </div>
        </div>
      `;
      document.body.appendChild(root);

      root.querySelector('#ea-close').onclick = closePanel;
      // Only close on true click on backdrop, not after a drag that ends outside the panel
      let eaDown = null;
      root.addEventListener('mousedown', e => {
        if (e.target === root) eaDown = { x: e.clientX, y: e.clientY };
        else eaDown = null;
      });
      root.addEventListener('click', e => {
        if (e.target !== root || !eaDown) return;
        const dx = Math.abs(e.clientX - eaDown.x);
        const dy = Math.abs(e.clientY - eaDown.y);
        eaDown = null;
        if (dx < 6 && dy < 6) closePanel();
      });

      const pt = root.querySelector('#ea-persistent-tooltips');
      const bd = root.querySelector('#ea-big-dots');
      const ta = root.querySelector('#ea-true-average');
      if (pt) {
        pt.checked = !!persistentTooltips;
        pt.onchange = () => {
          persistentTooltips = !!pt.checked;
          saveUiPrefs();
          renderArchive();
        };
      }
      if (bd) {
        bd.checked = !!bigDots;
        bd.onchange = () => {
          bigDots = !!bd.checked;
          saveUiPrefs();
          renderArchive();
        };
      }
      if (ta) {
        ta.checked = !!trueAverage;
        ta.onchange = () => {
          trueAverage = !!ta.checked;
          saveUiPrefs();
          renderArchive();
        };
      }

      root.querySelector('#ea-update').onclick = () => syncResults({ silent: false });
      root.querySelector('#ea-import').onclick = importFile;
      root.querySelector('#ea-export').onclick = exportAll;
      root.querySelector('#ea-backup').onclick = backupFullDB;
      root.querySelector('#ea-restore').onclick = restoreFullDB;
      root.querySelector('#ea-apekey').onclick = () => {
        const current = getApeKey();
        const next = prompt(
          'Paste your Monkeytype Ape Key (Account → Ape Keys).\nLeave empty to clear.',
          current
        );
        if (next === null) return; // cancelled
        setApeKey(next);
        updateApeKeyStatus();
        showToast(next.trim() ? 'Ape Key saved' : 'Ape Key cleared', 'info');
      };
      root.querySelector('#ea-clear').onclick = async () => {
        if (confirm('Delete ALL locally saved results? This cannot be undone.')) {
          await clearAllResults();
          updateBadge();
          renderArchive();
          showToast('Local archive cleared', 'info');
        }
      };
      updateApeKeyStatus();
      root.querySelector('#ea-clear-filters').onclick = () => {
        currentFilters = JSON.parse(JSON.stringify(defaultFilters));
        root.querySelectorAll('.ea-buttons button').forEach(btn => {
          const v = btn.dataset.value;
          btn.classList.toggle('active', v === 'all' || v === 'all time' || btn.closest('.multi'));
        });
        root.querySelectorAll('.ea-buttons.multi button').forEach(b => b.classList.add('active'));
        // re-render empty chips
        renderChipRow('ea-tags-container', currentFilters.tags, availableTags, { isTag: true });
        renderChipRow('ea-funbox-container', currentFilters.funbox, availableFunboxes);
        renderChipRow('ea-language-container', currentFilters.language, availableLanguages);
        persistFilters();
        renderArchive();
      };
      root.querySelector('#ea-apply-filters').onclick = async () => {
        window.__eaEverFiltered = true;
        window.__eaPanelReady = true;
        collectFiltersFromUI();
        // Always reload from IndexedDB so live-saved tests appear
        try {
          window.__eaCachedAll = await getAllResults();
          console.log('[EA] Apply reloaded', window.__eaCachedAll.length, 'from DB');
        } catch (e) {
          if (!window.__eaCachedAll) {
            try { window.__eaCachedAll = await getAllResults(); } catch (e2) {}
          }
        }
        // Harvest every language/funbox seen in full history → persistent lists
        try {
          const all = window.__eaCachedAll || [];
          const langs = new Set(availableLanguages || []);
          const fbs = new Set(availableFunboxes || []);
          all.forEach(r => {
            if (r.language) langs.add(String(r.language));
            if (r.funbox && r.funbox !== 'none') {
              String(r.funbox).split(/[#|,]/).map(s => s.trim()).filter(s => s && s !== 'none').forEach(x => fbs.add(x));
            }
          });
          availableLanguages = [...langs].sort((a,b)=>a.localeCompare(b));
          availableFunboxes = [...fbs].sort((a,b)=>a.localeCompare(b));
          savePersistedAvail();
          renderChipRow('ea-language-container', currentFilters.language || [], availableLanguages);
          renderChipRow('ea-funbox-container', currentFilters.funbox || [], availableFunboxes);
        } catch (e) {}
        renderArchive();
      };

      // single-select groups
      root.querySelectorAll('.ea-buttons:not(.multi)').forEach(group => {
        group.addEventListener('click', e => {
          const btn = e.target.closest('button');
          if (!btn) return;
          group.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      // multi-select groups
      root.querySelectorAll('.ea-buttons.multi').forEach(group => {
        group.addEventListener('click', e => {
          const btn = e.target.closest('button');
          if (!btn) return;
          btn.classList.toggle('active');
        });
      });
    }

    root.classList.add('open');
    panelOpen = true;
    const rootEl = document.getElementById('ea-root');
    if (rootEl) rootEl.classList.add('open');

    // Always ensure + chips visible
    setTimeout(() => ensureFilterChips(), 0);
    setTimeout(() => ensureFilterChips(), 200);

    // Reopen: keep existing graphs if they exist — instant
    if (window.__eaPanelReady) {
      updateBadge();
      const hasChart = !!document.querySelector('#ea-graph');
      const chartEmpty = hasChart && (!window.mainChartInstance && typeof mainChartInstance !== 'undefined' ? !mainChartInstance : false);
      // New matching tests → append dots only (no full search / refilter)
      if (window.__eaDirtyCharts || (window.__eaPendingLive && window.__eaPendingLive.length)) {
        try {
          ensureFilterChips();
          flushPendingLiveToCharts();
          window.__eaHadCharts = true;
          return;
        } catch (e) { console.warn('[EA] pending append', e); }
      }
      // If canvas exists and was drawn before, skip full reload
      try {
        const canvas = document.getElementById('ea-graph');
        if (canvas && canvas.getContext('2d') && window.__eaHadCharts) {
          ensureFilterChips();
          return;
        }
      } catch (e) {}
      // Fall through to rebuild if charts missing
    }

    // First open only: load prefs, filters, light data, charts
    getMeta('legendState').then(s => { if (s) legendState = { ...legendState, ...s }; });
    getMeta('uiPrefs').then(p => {
      if (p && typeof p === 'object') {
        if (p.persistentTooltips != null) persistentTooltips = !!p.persistentTooltips;
        if (p.bigDots != null) bigDots = !!p.bigDots;
        if (p.trueAverage != null) trueAverage = !!p.trueAverage;
        try {
          localStorage.setItem('ea_persistent_tooltips', persistentTooltips ? '1' : '0');
          localStorage.setItem('ea_big_dots', bigDots ? '1' : '0');
          localStorage.setItem('ea_true_average', trueAverage ? '1' : '0');
        } catch (e) {}
      }
    });
    restoreFilters();
    loadPersistedAvail();
    applyFiltersToUI();
    const paintChips = () => {
      try {
        renderChipRow('ea-tags-container', currentFilters.tags || [], availableTags || [], { isTag: true });
        renderChipRow('ea-funbox-container', currentFilters.funbox || [], availableFunboxes || []);
        renderChipRow('ea-language-container', currentFilters.language || [], availableLanguages || []);
      } catch (e) { console.warn('[EA] chips', e); }
    };
    populateDynamicFilters()
      .then(() => { paintChips(); return renderArchive(); })
      .then(() => { window.__eaPanelReady = true; window.__eaHadCharts = true; ensureFilterChips(); })
      .catch((e) => { console.warn('[EA] populate', e); ensureFilterChips(); try { renderArchive(); } catch (e2) {} window.__eaPanelReady = true; });
    setTimeout(paintChips, 150);
    setTimeout(paintChips, 600);
  }

  function closePanel() {
    document.getElementById('ea-root')?.classList.remove('open');
    panelOpen = false;
    // Keep __eaPanelReady + charts in memory for instant reopen
  }

  function collectFiltersFromUI() {
    const root = document.getElementById('ea-root');
    const tp = root.querySelector('[data-filter="timePeriod"] button.active');
    currentFilters.timePeriod = tp ? tp.dataset.value : 'all';

    ['difficulty', 'pb', 'mode', 'quoteLength', 'words', 'time', 'punctuation', 'numbers'].forEach(key => {
      const group = root.querySelector(`[data-filter="${key}"]`);
      if (!group) return;
      currentFilters[key] = {};
      group.querySelectorAll('button').forEach(btn => {
        currentFilters[key][btn.dataset.value] = btn.classList.contains('active');
      });
    });
    // tags / funbox / language are already kept in sync by the chip UI
    persistFilters();
  }

  function persistFilters() {
    try {
      GM_setValue('savedFilters', JSON.stringify(currentFilters));
    } catch (e) {}
  }

  function restoreFilters() {
    try {
      const raw = GM_getValue('savedFilters', null);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      // merge onto defaults so new filter keys still exist
      currentFilters = { ...JSON.parse(JSON.stringify(defaultFilters)), ...saved };
      // ensure chip arrays exist
      if (!Array.isArray(currentFilters.tags)) currentFilters.tags = [];
      if (!Array.isArray(currentFilters.funbox)) currentFilters.funbox = [];
      if (!Array.isArray(currentFilters.language)) currentFilters.language = [];
    } catch (e) {}
  }

  function applyFiltersToUI() {
    const root = document.getElementById('ea-root');
    if (!root) return;

    // time period
    const tpGroup = root.querySelector('[data-filter="timePeriod"]');
    if (tpGroup) {
      tpGroup.querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === currentFilters.timePeriod);
      });
    }

    ['difficulty', 'pb', 'mode', 'quoteLength', 'words', 'time', 'punctuation', 'numbers'].forEach(key => {
      const group = root.querySelector(`[data-filter="${key}"]`);
      if (!group || !currentFilters[key]) return;
      group.querySelectorAll('button').forEach(btn => {
        const v = btn.dataset.value;
        btn.classList.toggle('active', currentFilters[key][v] !== false);
      });
    });
  }

  // tagId → display name map (persisted so deleted tags keep their names)
  async function getTagNameMap() {
    return (await getMeta('tagNameMap', {})) || {};
  }
  async function setTagNameMap(map) {
    await setMeta('tagNameMap', map);
  }

  async function fetchTagsFromAPI() {
    const apeKey = getApeKey();
    if (!apeKey) return null;
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: 'https://api.monkeytype.com/users/tags',
          headers: {
            'Accept': 'application/json',
            'Authorization': `ApeKey ${apeKey}`
          },
          onload: (res) => {
            try {
              if (res.status >= 200 && res.status < 300) {
                const json = JSON.parse(res.responseText);
                const data = json.data || json;
                if (Array.isArray(data)) return resolve(data);
              }
            } catch (e) {}
            resolve(null);
          },
          onerror: () => resolve(null)
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function refreshTagNameMap() {
    const map = await getTagNameMap();

    // Official API – current tags with real names
    const apiTags = await fetchTagsFromAPI();
    if (apiTags) {
      apiTags.forEach(t => {
        const id = String(t._id || t.id || '');
        const name = t.name || id;
        if (id) map[id] = name;
      });
    }

    // Live snapshot fallback
    try {
      const snap = findSnapshot();
      if (snap?.tags) {
        snap.tags.forEach(t => {
          const id = String(t._id || t.id || '');
          const name = t.name || id;
          if (id) map[id] = name;
        });
      }
    } catch (e) {}

    await setTagNameMap(map);
    try { window.__eaTagNameMap = map; PAGE.__eaTagNameMap = map; } catch (e) {}
    return map;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function closeAllPickers() {
    document.querySelectorAll('.ea-chip-picker').forEach(p => p.remove());
  }

  async function getHiddenTags() {
    const h = await getMeta('hiddenTags', []);
    return Array.isArray(h) ? h.map(String) : [];
  }
  async function setHiddenTags(arr) {
    await setMeta('hiddenTags', [...new Set((arr || []).map(String))]);
  }
  async function hideTagFromList(idOrName) {
    const key = String(idOrName || '').trim();
    if (!key) return;
    const h = new Set(await getHiddenTags());
    h.add(key);
    h.add(key.toLowerCase());
    // Hide every id that displays as this name
    try {
      const map = await getTagNameMap();
      const want = key.toLowerCase();
      for (const [id, nm] of Object.entries(map || {})) {
        if (String(id).toLowerCase() === want || String(nm).toLowerCase() === want) {
          h.add(String(id));
          h.add(String(nm));
          h.add(String(nm).toLowerCase());
        }
      }
    } catch (e) {}
    await setHiddenTags([...h]);
  }

  /** Tag ids currently on the Monkeytype account (API or snapshot) */
  async function getSiteTagIds() {
    const ids = new Set();
    const names = new Set();
    try {
      const apiTags = await fetchTagsFromAPI();
      if (apiTags) {
        apiTags.forEach(t => {
          const id = String(t._id || t.id || '');
          if (id) ids.add(id);
          if (t.name) names.add(String(t.name).toLowerCase());
        });
      }
    } catch (e) {}
    try {
      const snap = findSnapshot();
      if (snap?.tags) {
        snap.tags.forEach(t => {
          const id = String(t._id || t.id || '');
          if (id) ids.add(id);
          if (t.name) names.add(String(t.name).toLowerCase());
        });
      }
    } catch (e) {}
    return { ids, names };
  }

  function renderChipRow(containerId, selectedValues, availableItems, { isTag = false } = {}) {
    const cont = document.getElementById(containerId);
    if (!cont) return;
    cont.innerHTML = '';
    if (!Array.isArray(selectedValues)) selectedValues = [];
    if (!Array.isArray(availableItems)) availableItems = [];

    // Active chips
    selectedValues.forEach(val => {
      const chip = document.createElement('span');
      chip.className = 'ea-chip';
      let label = val;
      if (isTag) {
        const found = availableItems.find(t => t.id === val || t.name === val);
        label = found ? found.name : val;
      }
      chip.innerHTML = `${escapeHtml(label)} <button class="ea-chip-x" title="remove">×</button>`;
      chip.querySelector('.ea-chip-x').onclick = (e) => {
        e.stopPropagation();
        const idx = selectedValues.indexOf(val);
        if (idx >= 0) selectedValues.splice(idx, 1);
        // Language / funbox: X also drops from persistent available list
        if (containerId === 'ea-language-container') {
          availableLanguages = (availableLanguages || []).filter(x => x !== val);
          const ai = availableItems.indexOf(val);
          if (ai >= 0) availableItems.splice(ai, 1);
          savePersistedAvail();
        } else if (containerId === 'ea-funbox-container') {
          availableFunboxes = (availableFunboxes || []).filter(x => x !== val);
          const ai = availableItems.indexOf(val);
          if (ai >= 0) availableItems.splice(ai, 1);
          savePersistedAvail();
        }
        renderChipRow(containerId, selectedValues, availableItems, { isTag });
        persistFilters();
      };
      cont.appendChild(chip);
    });

    // + button
    const addBtn = document.createElement('button');
    addBtn.className = 'ea-chip-add';
    addBtn.textContent = '+';
    addBtn.title = 'Add…';
    addBtn.onclick = async (e) => {
      e.stopPropagation();
      closeAllPickers();

      let options;
      if (isTag) {
        const seen = new Set();
        options = [];
        for (const t of availableItems) {
          if (selectedValues.includes(t.id) || selectedValues.includes(t.name)) continue;
          const ln = String(t.name).toLowerCase().trim();
          if (seen.has(ln)) continue;
          seen.add(ln);
          options.push({ value: t.id, label: t.name, deletable: true });
        }
        if (!selectedValues.includes('none')) {
          options.push({ value: 'none', label: 'no tag', deletable: false });
        }
      } else {
        options = availableItems
          .filter(v => !selectedValues.includes(v))
          .map(v => ({ value: v, label: v, deletable: false }));
        if (containerId.includes('funbox') && !selectedValues.includes('none')) {
          options.push({ value: 'none', label: 'none', deletable: false });
        }
      }

      const picker = document.createElement('div');
      picker.className = 'ea-chip-picker';

      if (!options.length) {
        picker.innerHTML = '<div class="ea-picker-empty">Nothing more to add</div>';
      } else {
        options.forEach(opt => {
          const row = document.createElement('div');
          row.className = 'ea-picker-row';
          const b = document.createElement('button');
          b.className = 'ea-picker-item';
          b.textContent = opt.label;
          b.onclick = () => {
            selectedValues.push(opt.value);
            closeAllPickers();
            window.__eaEverFiltered = true;
            renderChipRow(containerId, selectedValues, availableItems, { isTag });
            persistFilters();
          };
          row.appendChild(b);
          if (isTag && opt.deletable && opt.value !== 'none') {
            const del = document.createElement('button');
            del.className = 'ea-picker-del';
            del.title = 'Remove from list (tag gone from site or unwanted)';
            del.textContent = '×';
            del.onclick = async (ev) => {
              ev.stopPropagation();
              ev.preventDefault();
              await hideTagFromList(opt.label);
              await hideTagFromList(opt.value);
              // Remove any selected filter matching this tag name/id
              for (let i = selectedValues.length - 1; i >= 0; i--) {
                const v = String(selectedValues[i]);
                if (v === opt.value || v === opt.label ||
                    v.toLowerCase() === String(opt.label).toLowerCase()) {
                  selectedValues.splice(i, 1);
                }
              }
              closeAllPickers();
              await populateDynamicFilters();
              persistFilters();
              showToast('Removed tag from list: ' + opt.label, 'info', 2000);
            };
            row.appendChild(del);
          }
          picker.appendChild(row);
        });
      }

      // Tags only: prune everything not on the Monkeytype account
      if (isTag) {
        const prune = document.createElement('button');
        prune.className = 'ea-picker-prune';
        prune.textContent = 'Remove tags not on site';
        prune.title = 'Hide tags that are no longer on your Monkeytype account';
        prune.onclick = async (ev) => {
          ev.stopPropagation();
          const site = await getSiteTagIds();
          if (!site.ids.size && !site.names.size) {
            showToast('Could not load site tags (set Ape Key or open account)', 'error', 3000);
            return;
          }
          const hidden = await getHiddenTags();
          let n = 0;
          for (const t of availableItems) {
            const id = String(t.id);
            const name = String(t.name || '').toLowerCase();
            const onSite = site.ids.has(id) || site.names.has(name);
            if (!onSite) {
              hidden.push(id);
              if (t.name) hidden.push(String(t.name));
              n++;
              const ix = selectedValues.indexOf(id);
              if (ix >= 0) selectedValues.splice(ix, 1);
            }
          }
          await setHiddenTags(hidden);
          closeAllPickers();
          await populateDynamicFilters();
          persistFilters();
          showToast(n ? ('Removed ' + n + ' tag(s) not on site') : 'No stale tags found', 'info', 2500);
        };
        picker.appendChild(prune);
      }

      const rect = addBtn.getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.left = rect.left + 'px';
      picker.style.top = (rect.bottom + 4) + 'px';
      document.body.appendChild(picker);

      const closer = (ev) => {
        if (!picker.contains(ev.target) && ev.target !== addBtn) {
          closeAllPickers();
          document.removeEventListener('click', closer);
        }
      };
      setTimeout(() => document.addEventListener('click', closer), 0);
    };
    cont.appendChild(addBtn);
  }

  async function populateDynamicFilters() {
    const tagIdsSeen = new Set();
    const langSet = new Set();
    const fbSet = new Set();

    // Prefer API tag names; scan recent results for options (avoid full DB on first open)
    try {
      const scan = await scanFilterOptions(window.__eaEverFiltered ? 5000 : 800);
      scan.tagIds.forEach(t => tagIdsSeen.add(t));
      scan.langs.forEach(l => langSet.add(l));
      scan.fbs.forEach(f => fbSet.add(f));
    } catch (e) {
      const all = await getAllResults();
      all.forEach(r => {
        (r.tags || []).forEach(t => {
          if (t == null || t === '') return;
          if (Array.isArray(t)) t.forEach(x => { if (x != null && x !== '') tagIdsSeen.add(String(x)); });
          else tagIdsSeen.add(String(t));
        });
        if (r.language) langSet.add(String(r.language));
        if (r.funbox && r.funbox !== 'none') {
          String(r.funbox).split(/[#|,]/).map(s => s.trim()).filter(s => s && s !== 'none').forEach(x => fbSet.add(x));
        }
      });
    }

    const nameMap = await refreshTagNameMap();
    window.__eaTagNameMap = nameMap;
    Object.keys(nameMap).forEach(id => tagIdsSeen.add(id));

    const hidden = new Set((await getHiddenTags()).map(x => String(x).toLowerCase()));
    const isHidden = (id, name) => {
      const a = String(id).toLowerCase();
      const b = String(name || '').toLowerCase();
      return hidden.has(a) || hidden.has(b);
    };
    availableTags = [...tagIdsSeen]
      .map(id => ({ id: String(id), name: String(nameMap[id] || id) }))
      .filter(t => !isHidden(t.id, t.name))
      .filter(t => {
        const n = t.name.toLowerCase().trim();
        if (!n || n === 'no' || n === 'tags' || n === 'tag' || n === 'none') return false;
        // pure noise from bad scrapes
        if (n === 'test' && t.id === 'test') return false;
        return true;
      });

    // Prefer official map entries (name ≠ raw id) when deduping by display name
    availableTags.sort((a, b) => {
      const aOff = (nameMap[a.id] && nameMap[a.id] !== a.id) ? 0 : 1;
      const bOff = (nameMap[b.id] && nameMap[b.id] !== b.id) ? 0 : 1;
      if (aOff !== bOff) return aOff - bOff;
      return a.name.localeCompare(b.name);
    });
    const seenNames = new Set();
    availableTags = availableTags.filter(t => {
      const n = t.name.toLowerCase().trim();
      if (seenNames.has(n)) return false;
      seenNames.add(n);
      return true;
    });
    availableTags.sort((a, b) => a.name.localeCompare(b.name));

    loadPersistedAvail();
    availableLanguages = [...new Set([...(availableLanguages||[]), ...langSet])].sort((a, b) => a.localeCompare(b));
    availableFunboxes = [...new Set([...(availableFunboxes||[]), ...fbSet])].sort((a, b) => a.localeCompare(b));
    savePersistedAvail();
    console.log('[EA] populate done', availableTags.length, 'tags', availableFunboxes.length, 'funbox', availableLanguages.length, 'lang');

    renderChipRow('ea-tags-container', currentFilters.tags || [], availableTags, { isTag: true });
    renderChipRow('ea-funbox-container', currentFilters.funbox || [], availableFunboxes);
    renderChipRow('ea-language-container', currentFilters.language, availableLanguages);
  }

  function ensureFilterChips() {
    try {
      loadPersistedAvail();
      renderChipRow('ea-tags-container', (currentFilters && currentFilters.tags) || [], availableTags || [], { isTag: true });
      renderChipRow('ea-funbox-container', (currentFilters && currentFilters.funbox) || [], availableFunboxes || []);
      renderChipRow('ea-language-container', (currentFilters && currentFilters.language) || [], availableLanguages || []);
    } catch (e) {
      console.warn('[EA] ensureFilterChips', e);
    }
  }

  let dailyChartInstance = null;
  let monthlyChartInstance = null;
  let improveChartInstance = null;

  function avgStumblePct(list) {
    const withS = list.filter(r => r.stumblePct != null && isFinite(r.stumblePct));
    if (!withS.length) return null;
    return withS.reduce((s, r) => s + r.stumblePct, 0) / withS.length;
  }
  function countWithStumble(list) {
    return list.filter(r => r.stumblePct != null && isFinite(r.stumblePct)).length;
  }

  function buildDailyAggregates(results) {
    const byDay = new Map();
    results.forEach(r => {
      const d = new Date(r.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    });
    const days = [...byDay.keys()].sort();
    if (!days.length) return [];
    const start = new Date(days[0] + 'T00:00:00');
    return days.map((day, idx) => {
      const list = byDay.get(day);
      const cur = new Date(day + 'T00:00:00');
      const daysSinceStart = Math.round((cur - start) / 86400000); // 0 for first day
      const stumbleN = countWithStumble(list);
      return {
        label: day,
        shortLabel: day.slice(5), // MM-DD
        daysSinceStart,
        pointIndex: idx + 1,
        avgWpm: weightedMeanFromResults(list, r => r.wpm),
        avgAcc: weightedMeanFromResults(list, r => r.acc),
        avgStumble: weightedMeanFromResults(
          list.filter(r => r.stumblePct != null && isFinite(r.stumblePct)),
          r => r.stumblePct
        ),
        stumbleCount: stumbleN,
        count: list.length
      };
    });
  }

  function buildMonthlyAggregates(results) {
    const byMonth = new Map();
    results.forEach(r => {
      const d = new Date(r.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(r);
    });
    const months = [...byMonth.keys()].sort();
    if (!months.length) return [];
    const [sy, sm] = months[0].split('-').map(Number);
    return months.map((month, idx) => {
      const list = byMonth.get(month);
      const [y, m] = month.split('-').map(Number);
      const monthsSinceStart = (y - sy) * 12 + (m - sm);
      return {
        label: month,
        shortLabel: month,
        monthsSinceStart,
        pointIndex: idx + 1,
        avgWpm: weightedMeanFromResults(list, r => r.wpm),
        avgAcc: weightedMeanFromResults(list, r => r.acc),
        avgStumble: weightedMeanFromResults(
          list.filter(r => r.stumblePct != null && isFinite(r.stumblePct)),
          r => r.stumblePct
        ),
        stumbleCount: countWithStumble(list),
        count: list.length
      };
    });
  }

  // Effective duration of a result in seconds (never use mode2 — that's words/seconds setting).
  function resultDurationSec(r) {
    let d = Number(r.testDuration);
    if (isFinite(d) && d > 0 && d < 3600 * 6) return d;
    // Fallback estimate: for time mode mode2 is seconds; for words use rough estimate
    if (r.mode === 'time') {
      const m2 = Number(r.mode2);
      if (isFinite(m2) && m2 > 0 && m2 <= 3600) return m2;
    }
    return 60;
  }

  // Non-overlapping ~10 h blocks of effective test time.
  // Points: #1 = (0,0) baseline; #n = avg(block n) − avg(block n-1)
  function buildImprovementSeries(results) {
    const sorted = results.slice().sort((a, b) => a.timestamp - b.timestamp);
    if (!sorted.length) return [];

    const BLOCK_SEC = IMPROVE_BLOCK_HOURS * 3600;
    const blocks = [];
    let i = 0;

    while (i < sorted.length) {
      let sec = 0;
      const windowTests = [];
      while (i < sorted.length && sec < BLOCK_SEC) {
        const dur = resultDurationSec(sorted[i]);
        windowTests.push(sorted[i]);
        sec += dur;
        i++;
      }
      if (!windowTests.length) break;
      // Drop a trailing partial block if < 50% full (except if it's the only block)
      if (sec < BLOCK_SEC * 0.5 && blocks.length > 0) break;

      blocks.push({
        avgWpm: weightedMeanFromResults(windowTests, r => r.wpm),
        avgAcc: weightedMeanFromResults(windowTests, r => r.acc),
        avgStumble: weightedMeanFromResults(
          windowTests.filter(r => r.stumblePct != null && isFinite(r.stumblePct)),
          r => r.stumblePct
        ),
        hours: sec / 3600,
        count: windowTests.length
      });
    }

    if (!blocks.length) return [];

    const series = [{
      label: '1',
      block: 1,
      deltaWpm: 0,
      deltaAcc: 0,
      deltaStumble: 0,
      avgWpm: blocks[0].avgWpm,
      avgAcc: blocks[0].avgAcc,
      avgStumble: blocks[0].avgStumble,
      prevWpm: null,
      prevAcc: null,
      prevStumble: null,
      count: blocks[0].count,
      hoursInBlock: blocks[0].hours
    }];

    for (let k = 1; k < blocks.length; k++) {
      const prevS = blocks[k - 1].avgStumble;
      const curS = blocks[k].avgStumble;
      series.push({
        label: String(k + 1),
        block: k + 1,
        deltaWpm: blocks[k].avgWpm - blocks[k - 1].avgWpm,
        deltaAcc: blocks[k].avgAcc - blocks[k - 1].avgAcc,
        deltaStumble: (prevS != null && curS != null) ? (prevS - curS) : null,
        avgWpm: blocks[k].avgWpm,
        avgAcc: blocks[k].avgAcc,
        avgStumble: curS,
        prevWpm: blocks[k - 1].avgWpm,
        prevAcc: blocks[k - 1].avgAcc,
        prevStumble: prevS,
        count: blocks[k].count,
        hoursInBlock: blocks[k].hours
      });
    }
    return series;
  }

  // Unique integer ticks only — prevents Chart.js from repeating the same label
  function uniqueIndexTicks(labels) {
    return {
      color: '#888',
      autoSkip: false,
      maxRotation: 45,
      callback: function (val) {
        const i = Math.round(val);
        if (i !== val) return '';           // skip non-integer positions
        if (i < 0 || i >= labels.length) return '';
        return labels[i];
      }
    };
  }

  function makeAggregateChart(canvasId, containerId, points, {
    wpmLabel, accLabel, xTitle, mode // 'day' | 'month'
  }) {
    const canvas = document.getElementById(canvasId);
    const container = document.getElementById(containerId);
    if (!canvas || !container || !getChart()) return null;

    if (!points.length) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return null;
    }

    // Compress spacing when many days/months; scrollable; pin to latest
    const nPts = points.length;
    let minPx = 28;
    if (nPts > 45) minPx = 18;
    if (nPts > 90) minPx = 12;
    if (nPts > 150) minPx = 8;
    if (nPts > 250) minPx = 5;
    const parentW = (container.parentElement?.clientWidth || container.closest('.ea-hscroll')?.clientWidth || 600) - 16;
    const width = Math.max(parentW, nPts * minPx);
    container.style.width = width + 'px';
    container.style.minWidth = width + 'px';

    const labels = points.map(p => p.shortLabel || p.label);

    return new (getChart())(canvas.getContext('2d'), {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: wpmLabel,
            data: points.map((d, i) => ({ x: i, y: d.avgWpm })),
            backgroundColor: 'rgba(233, 196, 106, 0.85)',
            pointRadius: aggDotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y'
          },
          {
            label: accLabel,
            data: points.map((d, i) => ({ x: i, y: d.avgAcc == null ? null : Math.max(90, d.avgAcc) })),
            
            backgroundColor: 'rgba(231, 111, 81, 0.85)',
            pointRadius: aggDotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y1'
          },
          {
            label: 'WPM trend',
            data: points.map((d, i) => ({ x: i, y: d.avgWpm })),
            type: 'line',
            borderColor: 'rgba(233, 196, 106, 0.35)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
            yAxisID: 'y',
            tooltip: { enabled: false }
          },
          {
            label: 'Acc trend',
            data: points.map((d, i) => ({ x: i, y: d.avgAcc })),
            type: 'line',
            borderColor: 'rgba(231, 111, 81, 0.35)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
            yAxisID: 'y1',
            tooltip: { enabled: false }
          },
          {
            label: 'Stumble %',
            data: points.map((d, i) => (
              d.avgStumble == null ? null : { x: i, y: d.avgStumble }
            )).filter(Boolean),
            backgroundColor: 'rgba(110, 198, 255, 0.85)',
            borderColor: 'rgba(110, 198, 255, 0.95)',
            pointRadius: aggDotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y2'
          },
          {
            label: 'Stumble trend',
            data: points.map((d, i) => (
              d.avgStumble == null ? null : { x: i, y: d.avgStumble }
            )).filter(Boolean),
            type: 'line',
            borderColor: 'rgba(110, 198, 255, 0.45)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
            yAxisID: 'y2',
            tooltip: { enabled: false }
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: persistentTooltips
          ? { mode: 'index', intersect: false }
          : { mode: 'nearest', intersect: true },
        plugins: {
                    legend: {
            labels: {
              color: '#d1d0c5', boxWidth: 12, font: { size: 11 },
              filter: (item) => !item.text.includes('trend')
            }
          },
          tooltip: {
            filter: (item) => !item.dataset.label?.includes('trend'),
            callbacks: {
              title: (items) => {
                const i = items[0].dataIndex;
                const d = points[i];
                if (!d) return '';
                return `${d.label}  (${d.count} tests)`;
              },
              label: () => null,
              afterBody: (items) => {
                const i = items[0].dataIndex;
                const d = points[i];
                if (!d) return [];
                const lines = [
                  `WPM: ${Number(d.avgWpm).toFixed(2)}`,
                  `Accuracy: ${Number(d.avgAcc).toFixed(2)}%`,
                  d.avgStumble != null
                    ? `Stumble: ${Number(d.avgStumble).toFixed(2)}% (${d.stumbleCount || 0}/${d.count} tests with data)`
                    : 'Stumble: (not recorded)'
                ];
                if (mode === 'day') {
                  lines.push(`Days since first day on graph: ${d.daysSinceStart}`);
                }
                if (mode === 'month') {
                  lines.push(`Months since first month on graph: ${d.monthsSinceStart}`);
                }
                return lines;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: -0.5,
            max: Math.max(points.length - 1 + Math.max(2, Math.ceil(points.length * 0.04)), 2),
            title: { display: true, text: xTitle, color: '#888' },
            ticks: uniqueIndexTicks(labels),
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'WPM', color: '#e9c46a' },
            ticks: { color: '#e9c46a' },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          y1: {
            type: 'linear',
            position: 'right',
            min: 90,
            max: 100,
            title: { display: true, text: 'Accuracy %', color: '#e76f51' },
            ticks: { color: '#e76f51' },
            grid: { drawOnChartArea: false }
          },
          y2: {
            type: 'linear',
            position: 'right',
            min: 0,
            max: (function() {
              const vals = points.map(p => p.avgStumble).filter(v => v != null);
              if (!vals.length) return 25;
              const mx = Math.max(...vals);
              return Math.min(100, Math.max(10, Math.ceil((mx * 1.08) / 5) * 5));
            })(),
            reverse: true,
            title: { display: true, text: 'Stumble % ↓ better', color: '#6ec6ff' },
            ticks: { color: '#6ec6ff' },
            grid: { drawOnChartArea: false }
          }
        }
      },
      plugins: [createCrosshairPlugin({ leftDecimals: 2, rightDecimals: 2, rightUnit: '%' }), createWheelZoomPlugin()]
    });
    // Default: show the latest days/months (scroll fully right)
    requestAnimationFrame(() => {
      try {
        const sc = container.closest('.ea-hscroll');
        if (sc) sc.scrollLeft = sc.scrollWidth;
      } catch (e) {}
    });
    setTimeout(() => {
      try {
        const sc = container.closest('.ea-hscroll');
        if (sc) sc.scrollLeft = sc.scrollWidth;
      } catch (e) {}
    }, 50);
    return chart;
  }

  function pinScaleLabels(chart, frameSelector) {
    if (!chart || !chart.canvas) return;
    try { if (!chart.canvas.getContext) return; } catch (e) { return; }
    const frame = document.querySelector(frameSelector);
    if (!frame) return;
    const y = chart.scales.y;
    const y1 = chart.scales.y1;
    const left = frame.querySelector('.ea-yside.left');
    const right = frame.querySelector('.ea-yside.right');
    if (left && y) {
      left.querySelector('.ea-smax').textContent = Number(y.max).toFixed(Math.abs(y.max) < 15 ? 1 : 0);
      left.querySelector('.ea-smin').textContent = Number(y.min).toFixed(Math.abs(y.min) < 15 ? 1 : 0);
    }
    if (right && y1) {
      const dec = Math.abs(y1.max) <= 10 ? 1 : 0;
      right.querySelector('.ea-smax').textContent = Number(y1.max).toFixed(dec);
      right.querySelector('.ea-smin').textContent = Number(y1.min).toFixed(dec);
    }
  }

  function renderDailyGraph(results) {
    if (!getChart()) {
      ensureChartWithZoom(() => renderDailyGraph(results));
      return;
    }
    if (dailyChartInstance) { dailyChartInstance.destroy(); dailyChartInstance = null; }
    dailyChartInstance = makeAggregateChart(
      'ea-daily-graph', 'ea-daily-graph-container',
      buildDailyAggregates(results),
      { wpmLabel: 'Daily avg WPM', accLabel: 'Daily avg Accuracy', xTitle: 'Day', mode: 'day' }
    );
    pinScaleLabels(dailyChartInstance, '#ea-daily-frame');
    try { bindWheelZoomToChart(dailyChartInstance); } catch (e) {}
  }

  function renderMonthlyGraph(results) {
    if (!getChart()) {
      ensureChartWithZoom(() => renderMonthlyGraph(results));
      return;
    }
    if (monthlyChartInstance) { monthlyChartInstance.destroy(); monthlyChartInstance = null; }
    monthlyChartInstance = makeAggregateChart(
      'ea-monthly-graph', 'ea-monthly-graph-container',
      buildMonthlyAggregates(results),
      { wpmLabel: 'Monthly avg WPM', accLabel: 'Monthly avg Accuracy', xTitle: 'Month', mode: 'month' }
    );
    pinScaleLabels(monthlyChartInstance, '#ea-monthly-frame');
    try { bindWheelZoomToChart(monthlyChartInstance); } catch (e) {}
  }

  function renderImproveGraph(results) {
    if (!getChart()) {
      ensureChartWithZoom(() => renderImproveGraph(results));
      return;
    }
    const canvas = document.getElementById('ea-improve-graph');
    const container = document.getElementById('ea-improve-graph-container');
    if (!canvas || !container) return;

    if (improveChartInstance) {
      improveChartInstance.destroy();
      improveChartInstance = null;
    }

    const series = buildImprovementSeries(results);
    if (!series.length || !getChart()) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width || 300, canvas.height || 150);
      return;
    }

    const minPx = 40;
    const width = Math.max(
      (container.parentElement?.clientWidth || 600) - 16,
      series.length * minPx
    );
    container.style.width = width + 'px';

    const labels = series.map(s => s.label); // "1", "2", "3"…

    // Symmetric ranges so 0 sits on a real grid line
    const maxAbsW = Math.max(1, ...series.map(s => Math.abs(s.deltaWpm)));
    const maxAbsS = Math.max(1, ...series.map(s => s.deltaStumble == null ? 0 : Math.abs(s.deltaStumble)));
    const maxAbsA = Math.max(
      0.5,
      ...series.map(s => Math.abs(s.deltaAcc)),
      ...series.map(s => (s.deltaStumble != null ? Math.abs(s.deltaStumble) : 0))
    );
    const wpmBound = Math.ceil(maxAbsW * 1.15);
    const accBound = Math.ceil(maxAbsA * 1.15 * 2) / 2; // 0.5 steps

    const zeroLinePlugin = {
      id: 'eaZeroLine',
      // Draw under datasets/tooltip so it never covers the tooltip
      beforeDatasetsDraw(chart) {
        const yScale = chart.scales.y;
        const y1Scale = chart.scales.y1;
        const area = chart.chartArea;
        const ctx = chart.ctx;
        if (!area) return;
        ctx.save();
        if (yScale) {
          const y0 = yScale.getPixelForValue(0);
          if (y0 >= area.top && y0 <= area.bottom) {
            ctx.beginPath();
            ctx.moveTo(area.left, y0);
            ctx.lineTo(area.right, y0);
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = 'rgba(233, 196, 106, 0.5)';
            ctx.stroke();
          }
        }
        if (y1Scale) {
          const y0a = y1Scale.getPixelForValue(0);
          if (y0a >= area.top && y0a <= area.bottom) {
            ctx.beginPath();
            ctx.moveTo(area.left, y0a);
            ctx.lineTo(area.right, y0a);
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(231, 111, 81, 0.4)';
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        ctx.restore();
      }
    };

    improveChartInstance = new (getChart())(canvas.getContext('2d'), {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Δ WPM vs previous block',
            data: series.map((d, i) => ({ x: i, y: d.deltaWpm })),
            backgroundColor: 'rgba(233, 196, 106, 0.9)',
            pointRadius: aggDotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y'
          },
          {
            label: 'Δ Acc vs previous block',
            data: series.map((d, i) => ({ x: i, y: d.deltaAcc })),
            backgroundColor: 'rgba(231, 111, 81, 0.9)',
            pointRadius: aggDotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y1'
          },
          {
            label: 'Δ WPM trend',
            data: series.map((d, i) => ({ x: i, y: d.deltaWpm })),
            type: 'line',
            borderColor: 'rgba(233, 196, 106, 0.4)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
            yAxisID: 'y'
          },
          {
            label: 'Δ Acc trend',
            data: series.map((d, i) => ({ x: i, y: d.deltaAcc })),
            type: 'line',
            borderColor: 'rgba(231, 111, 81, 0.4)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
            yAxisID: 'y1'
          },
          {
            label: 'Δ Stumble % vs previous block',
            data: series.map((d, i) => (
              d.deltaStumble == null ? null : { x: i, y: d.deltaStumble }
            )).filter(Boolean),
            backgroundColor: 'rgba(110, 198, 255, 0.9)',
            pointRadius: aggDotRadius,
            pointHoverRadius: dotHoverRadius,
            yAxisID: 'y2'
          },
          {
            label: 'Δ Stumble trend',
            data: series.map((d, i) => (
              d.deltaStumble == null ? null : { x: i, y: d.deltaStumble }
            )).filter(Boolean),
            type: 'line',
            borderColor: 'rgba(110, 198, 255, 0.45)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
            yAxisID: 'y2'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: persistentTooltips
          ? { mode: 'index', intersect: false }
          : { mode: 'nearest', intersect: true },
        plugins: {
                    legend: {
            labels: {
              color: '#d1d0c5', boxWidth: 12, font: { size: 11 },
              filter: (item) => !item.text.includes('trend')
            }
          },
          tooltip: {
            filter: (item) => !item.dataset.label?.includes('trend'),
            callbacks: {
              title: (items) => {
                const d = series[items[0].dataIndex];
                return d ? `Block ${d.block}` : '';
              },
              label: () => null, // suppress default dataset lines; we use afterBody
              afterBody: (items) => {
                const d = series[items[0].dataIndex];
                if (!d) return [];
                if (d.block === 1) {
                  const lines = [
                    `Baseline (plotted at 0)`,
                    `Block avg WPM: ${d.avgWpm.toFixed(2)}`,
                    `Block avg Acc: ${d.avgAcc.toFixed(2)}%`,
                    `Tests in block: ${d.count}`,
                    `Hours in block: ${d.hoursInBlock.toFixed(2)}`
                  ];
                  if (d.avgStumble != null) {
                    lines.splice(3, 0, `Block avg Stumble: ${d.avgStumble.toFixed(2)}%`);
                  }
                  return lines;
                }
                const lines = [
                  `Δ WPM: ${d.deltaWpm >= 0 ? '+' : ''}${d.deltaWpm.toFixed(2)}  (${d.prevWpm.toFixed(2)} → ${d.avgWpm.toFixed(2)})`,
                  `Δ Acc: ${d.deltaAcc >= 0 ? '+' : ''}${d.deltaAcc.toFixed(2)}%  (${d.prevAcc.toFixed(2)} → ${d.avgAcc.toFixed(2)})`,
                  `Tests in block: ${d.count}`,
                  `Hours in block: ${d.hoursInBlock.toFixed(2)}`
                ];
                if (d.deltaStumble != null && d.prevStumble != null && d.avgStumble != null) {
                  lines.splice(2, 0,
                    `Δ Stumble: ${((d.avgStumble - d.prevStumble) >= 0 ? '+' : '')}${(d.avgStumble - d.prevStumble).toFixed(2)}%  (${d.prevStumble.toFixed(2)} → ${d.avgStumble.toFixed(2)})`
                  );
                }
                return lines;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: -0.5,
            max: series.length - 1 + Math.max(2, Math.ceil(series.length * 0.04)),
            title: { display: true, text: 'Block # (each ≈ 10 h effective typing)', color: '#888' },
            ticks: uniqueIndexTicks(labels),
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          y: {
            type: 'linear',
            position: 'left',
            min: -wpmBound,
            max: wpmBound,
            title: { display: true, text: 'Δ WPM', color: '#e9c46a' },
            ticks: { color: '#e9c46a', stepSize: wpmBound <= 5 ? 1 : undefined },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          y1: {
            type: 'linear',
            position: 'right',
            min: -accBound,
            max: accBound,
            title: { display: true, text: 'Δ Accuracy %', color: '#e76f51' },
            ticks: { color: '#e76f51', stepSize: accBound <= 3 ? 0.5 : undefined },
            grid: { drawOnChartArea: false }
          },
          y2: {
            type: 'linear',
            position: 'right',
            min: -Math.max(1, typeof maxAbsS === 'number' ? maxAbsS : 5),
            max: Math.max(1, typeof maxAbsS === 'number' ? maxAbsS : 5),
            title: { display: true, text: 'Δ Stumble % (+ better ↑)', color: '#6ec6ff' },
            ticks: { color: '#6ec6ff' },
            grid: { drawOnChartArea: false },
            offset: true
          }
        }
      },
      plugins: [
        zeroLinePlugin,
        createCrosshairPlugin({ leftDecimals: 2, rightDecimals: 2, rightUnit: '%', stumbleDecimals: 2 }),
        createWheelZoomPlugin()
      ]
    });
    pinScaleLabels(improveChartInstance, '#ea-improve-frame');
    try { bindWheelZoomToChart(improveChartInstance); } catch (e) {}
  }

  async function renderArchive() {
    let all;
    // Fast path: first open / no user filter yet → last 10 only (instant)
    if (!window.__eaEverFiltered) {
      try {
        all = await getLastNResults(10);
        if (!all || !all.length) {
          const everything = await getAllResults();
          all = everything.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-10);
        }
        window.__eaFirstOpenSlice = all;
        console.log('[EA] first-open tests', all.length);
      } catch (e) {
        console.warn('[EA] first-open', e);
        const everything = await getAllResults();
        all = everything.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-10);
      }
    } else if (window.__eaCachedAll && window.__eaCachedAll.length > 50) {
      all = window.__eaCachedAll;
    } else {
      all = await getAllResults();
      window.__eaCachedAll = all;
      console.log('[EA] render loaded full archive', all.length);
    }
    // Repair mangled languages + re-attach pending stumbles where missing
    try {
      let fixed = 0;
      for (const r of all) {
        let changed = false;
        const fixedLang = fixLanguageName(r.language);
        if (fixedLang !== r.language) {
          r.language = fixedLang;
          changed = true;
        }
        const before = r.stumblePct;
        matchPendingStumble(r);
        if (r.stumblePct != null && r.stumblePct !== before) changed = true;
        if (changed) {
          await saveResult(r);
          fixed++;
        }
      }
      if (fixed) all = await getAllResults();
    } catch (e) {}
    let filtered = applyFilters(all);
    // On light path, `all` is already last-10


    const stats = document.getElementById('ea-stats');
    if (stats) {
      const avgWpm = filtered.length ? Number(weightedMeanFromResults(filtered, r => r.wpm)).toFixed(2) : '–';
      const avgAcc = filtered.length ? Number(weightedMeanFromResults(filtered, r => r.acc)).toFixed(2) : '–';
      const best = filtered.length ? Math.max(...filtered.map(r => r.wpm)).toFixed(2) : '–';
      stats.innerHTML = `
        <span>Showing <b>${filtered.length.toLocaleString()}</b> / ${all.length.toLocaleString()} results</span>
        <span>Avg WPM: <b>${avgWpm}</b></span>
        <span>Avg Acc: <b>${avgAcc}%</b></span>
        <span>Best WPM: <b>${best}</b></span>
      `;
    }
    // Defer heavy chart builds so the panel chrome paints first (big DBs)
    const runCharts = () => {
      try { renderGraph(filtered); } catch (e) { console.warn(e); }
      try { renderDailyGraph(filtered); } catch (e) { console.warn(e); }
      try { renderMonthlyGraph(filtered); } catch (e) { console.warn(e); }
      try { renderImproveGraph(filtered); } catch (e) { console.warn(e); }
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(runCharts, { timeout: 200 });
    } else {
      requestAnimationFrame(() => setTimeout(runCharts, 0));
    }
  }

  /*********************************************************************
   *  IMPORT / EXPORT (still available)
   *********************************************************************/
  function importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,application/json,text/csv';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        let results = [];
        if (file.name.endsWith('.csv') || text.startsWith('wpm') || text.includes('wpm,')) {
          results = parseCSV(text);
        } else {
          const json = JSON.parse(text);
          results = Array.isArray(json) ? json : (json.results || json.data || []);
        }
        let normalized = results.map(normalizeResult);
        normalized = normalized.map(r => applyStumbleIndex(r));
        normalized = applyPendingToResults(normalized);
        const added = await saveResultsBulk(normalized);
        try {
          const fixed = await reconcileStumblesLastN(1000);
          if (fixed) showToast('Corrected stumble on ' + fixed + ' recent results', 'info', 3000);
        } catch (e) {}
        // Second pass: patch already-stored recent results from pending queue
        try {
          const s = buildStumbleSnapshot();
          if (s) await patchLatestResultWithStumble(s);
          const pending = loadPendingStumbles();
          if (pending.length) {
            const all = await getAllResults();
            let patched = 0;
            for (const r of all) {
              if (r.stumblePct != null) continue;
              const before = r.stumblePct;
              matchPendingStumble(r);
              if (r.stumblePct != null && r.stumblePct !== before) {
                await saveResult(r);
                patched++;
              }
            }
            if (patched) showToast('Attached stumble data to ' + patched + ' imported result(s)', 'info', 3000);
          }
        } catch (e) {}
        showToast(`Imported ${added} results`, 'success');
        updateBadge();
        if (panelOpen) { await populateDynamicFilters(); renderArchive(); }
      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
      }
    };
    input.click();
  }

  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const results = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const obj = {};
      headers.forEach((h, idx) => {
        let v = (cols[idx] || '').trim().replace(/^"|"$/g, '');
        if (['wpm','rawWpm','acc','consistency','timestamp','testDuration','restartCount'].includes(h)) v = Number(v) || 0;
        else if (['punctuation','numbers','isPb','bailedOut','blindMode','lazyMode'].includes(h)) v = v === 'true' || v === '1';
        else if (h === 'tags') v = v ? v.split(';') : [];
        obj[h] = v;
      });
      results.push(obj);
    }
    return results;
  }


  /** Full local backup: IndexedDB results + meta + body/keys/kcal/pending/filters */
  async function backupFullDB() {
    try {
      const results = await getAllResults();
      let meta = {};
      try {
        const database = await openDB();
        const tx = database.transaction('meta', 'readonly');
        const store = tx.objectStore('meta');
        const all = await new Promise((res, rej) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => rej(req.error);
        });
        // meta store may be key-value entries
        if (Array.isArray(all)) {
          for (const row of all) {
            if (row && row.key != null) meta[row.key] = row.value;
            else if (row && row.id != null) meta[row.id] = row;
          }
        }
      } catch (e) {
        // fallback individual keys
        try { meta.legendState = await getMeta('legendState'); } catch (e2) {}
        try { meta.tagNameMap = await getMeta('tagNameMap'); } catch (e2) {}
        try { meta.lastSync = await getMeta('lastSync'); } catch (e2) {}
      }

      const ls = {};
      const lsKeys = [
        'ea_lifetime_keys', 'ea_lifetime_kcal', 'ea_body_profile',
        'ea_pending_stumbles_v2', 'ea_pending_stumbles'
      ];
      for (const k of lsKeys) {
        try { const v = localStorage.getItem(k); if (v != null) ls[k] = v; } catch (e) {}
      }
      // Also dump any ea_* keys
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('ea_') && !(k in ls)) ls[k] = localStorage.getItem(k);
        }
      } catch (e) {}

      let gm = {};
      try {
        if (typeof GM_getValue === 'function') {
          const ape = GM_getValue('apeKey', '');
          if (ape) gm.apeKey = ape;
          const sf = GM_getValue('savedFilters', null);
          if (sf) gm.savedFilters = sf;
        }
      } catch (e) {}

      const payload = {
        _eaBackupVersion: 1,
        exportedAt: new Date().toISOString(),
        results,
        meta,
        localStorage: ls,
        gm
      };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'monkeytype-eternal-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Full backup downloaded (' + results.length + ' results)', 'success');
    } catch (err) {
      showToast('Backup failed: ' + err.message, 'error');
    }
  }

  function restoreFullDB() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || data._eaBackupVersion == null) {
          showToast('Not a full EA backup file (use Import for results-only JSON)', 'error');
          return;
        }
        if (!confirm('Restore full backup? This merges results and overwrites body/keys/settings from the file.')) return;

        const results = (data.results || []).map(normalizeResult);
        const added = await saveResultsBulk(results);

        if (data.meta && typeof data.meta === 'object') {
          for (const [k, v] of Object.entries(data.meta)) {
            try { await setMeta(k, v); } catch (e) {}
          }
        }
        if (data.localStorage && typeof data.localStorage === 'object') {
          for (const [k, v] of Object.entries(data.localStorage)) {
            try { localStorage.setItem(k, v); } catch (e) {}
          }
          // reload in-memory lifetime counters
          try {
            lifetimeKeys = parseInt(localStorage.getItem('ea_lifetime_keys') || '0', 10) || 0;
            lifetimeKcal = parseFloat(localStorage.getItem('ea_lifetime_kcal') || '0') || 0;
            updateKeysHud();
          } catch (e) {}
        }
        if (data.gm && typeof data.gm === 'object') {
          try {
            if (data.gm.apeKey != null && typeof GM_setValue === 'function') GM_setValue('apeKey', data.gm.apeKey);
            if (data.gm.savedFilters != null && typeof GM_setValue === 'function') GM_setValue('savedFilters', data.gm.savedFilters);
          } catch (e) {}
        }

        showToast('Restored backup: ' + added + ' results merged', 'success', 4000);
        updateBadge();
        if (panelOpen) { await populateDynamicFilters(); renderArchive(); }
      } catch (err) {
        showToast('Restore failed: ' + err.message, 'error');
      }
    };
    input.click();
  }

  async function exportAll() {
    const all = await getAllResults();
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monkeytype-archive-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${all.length} results`, 'success');
  }

  /*********************************************************************
   *  INIT
   *********************************************************************/
  async function init() {
    injectStyles();
    createFAB();
    observeNewResults();
    scheduleBackgroundSync();
    installExportInterceptor();
    loadLifetimeKeys();

    // restore legend
    const savedLegend = await getMeta('legendState');
    if (savedLegend) legendState = { ...legendState, ...savedLegend };

    // first-time gentle sync if empty
    const count = await getResultCount();
    if (count === 0) {
      setTimeout(() => syncResults({ silent: true }), 4000);
    }

    const _rec = (n) => reconcileStumblesLastN(n || 1000);
    try { window.__eaReconcileStumbles = _rec; } catch (e) {}
    try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.__eaReconcileStumbles = _rec; } catch (e) {}
    try { globalThis.__eaReconcileStumbles = _rec; } catch (e) {}
  
    // Auto-sync every 6h only when idle (no typing / no test for 60s)
    if (!window.__eaIdleSyncScheduled) {
      window.__eaIdleSyncScheduled = true;
      let lastActivity = Date.now();
      const bump = () => { lastActivity = Date.now(); };
      ['keydown','mousemove','click','scroll'].forEach(ev => {
        try { document.addEventListener(ev, bump, { passive: true, capture: true }); } catch (e) {}
      });
      const SIX_H = 6 * 60 * 60 * 1000;
      const lastSyncKey = 'ea_last_auto_sync_ts';
      setInterval(async () => {
        try {
          const last = Number(localStorage.getItem(lastSyncKey) || 0);
          if (Date.now() - last < SIX_H) return;
          if (Date.now() - lastActivity < 60000) return; // user active in last minute
          if (document.querySelector('#words .word.active, #wordsInput, .pageTest #words')) {
            // in a test
            const active = document.querySelector('#words .word.active');
            if (active) return;
          }
          if (typeof isTestActive === 'function' && isTestActive()) return;
          localStorage.setItem(lastSyncKey, String(Date.now()));
          console.log('[EA] idle auto-sync starting');
          await syncResults({ silent: true });
          try { await reconcileStumblesLastN(1000); } catch (e) {}
        } catch (e) { console.warn('[EA] idle sync', e); }
      }, 60000); // check every minute
    }

  console.log('[Monkeytype Eternal Archive] v2.2.31 ready — mode/type + migrate');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


/* ========== 2. JAIL MODE ========== */
(function () {
  'use strict';

  const STORAGE_ENABLED = 'mt_jail_enabled';
  const STORAGE_REPS = 'mt_jail_reps';
  const STORAGE_MIN_CORRECT = 'mt_jail_min_correct';
  const STORAGE_WORDS = 'mt_jail_unique_words';
  const JAIL_LIST_NAME = 'jail';

  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  let jailEnabled = GM_getValue(STORAGE_ENABLED, false);
  let jailReps = clampReps(GM_getValue(STORAGE_REPS, 3));
  let jailMinCorrect = clampMinCorrect(GM_getValue(STORAGE_MIN_CORRECT, jailReps), jailReps);

  const erroredWordTexts = new Set();
  const erroredWordIndexes = new Set();
  /** Word indexes that ever showed a real MT incorrect/extra/missed letter this test */
  const everErroredIndexes = new Set();
  let wordTexts = [];
  let maxTypedIndex = -1;
  let lastProcessedResultKey = '';
  let sawTypingThisTest = false;
  /** Frozen mistakes when test ends (survives #words teardown) */
  let resultSnapshotMistakes = [];
  let resultSnapshotStats = null; // Map-like object word -> {total,correct} frozen at result

  function clampReps(n) {
    n = parseInt(n, 10);
    if (!Number.isFinite(n)) return 3;
    return Math.min(9, Math.max(1, n));
  }

  function clampMinCorrect(n, reps) {
    const r = clampReps(reps != null ? reps : jailReps);
    n = parseInt(n, 10);
    if (!Number.isFinite(n)) return r;
    return Math.min(r, Math.max(1, n));
  }

  function savePrefs() {
    GM_setValue(STORAGE_ENABLED, !!jailEnabled);
    GM_setValue(STORAGE_REPS, jailReps);
    GM_setValue(STORAGE_MIN_CORRECT, jailMinCorrect);
  }

  GM_addStyle(`
    #mt-jail-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      justify-content: center;
      font-size: 0.85rem;
      color: var(--text-color, #d1d0c5);
      user-select: none;
      flex-wrap: nowrap;
      width: auto;
      position: fixed;
      left: 50%;
      bottom: 10px;
      transform: translateX(-50%);
      z-index: 200;
      padding: 4px 10px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--bg-color, #323437) 88%, transparent);
      backdrop-filter: blur(4px);
    }
    #mt-jail-bar label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    #mt-jail-bar input[type="checkbox"] {
      cursor: pointer;
      accent-color: var(--main-color, #e2b714);
    }
    #mt-jail-reps-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    #mt-jail-reps-btn {
      min-width: 28px;
      height: 22px;
      border-radius: 8px;
      border: 1px solid var(--sub-color, #646669);
      background: var(--sub-alt-color, #2c2e31);
      color: var(--text-color, #d1d0c5);
      cursor: pointer;
      font: inherit;
      line-height: 1;
    }
    #mt-jail-reps-list {
      display: none;
      position: absolute;
      bottom: 100%;
      top: auto;
      left: 0;
      margin-bottom: 4px;
      margin-top: 0;
      max-height: 220px;
      overflow-y: auto;
      overscroll-behavior: contain;
      background: var(--sub-alt-color, #2c2e31);
      border: 1px solid var(--sub-color, #646669);
      border-radius: 8px;
      z-index: 100050;
      min-width: 40px;
    }
    #mt-jail-reps-list.open { display: block; }
    #mt-jail-reps-list div {
      padding: 4px 10px;
      cursor: pointer;
      text-align: center;
    }
    #mt-jail-reps-list div:hover,
    #mt-jail-reps-list div.active {
      background: var(--main-color, #e2b714);
      color: var(--bg-color, #323437);
    }
    #mt-jail-need-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    #mt-jail-need-wrap .mt-jail-need-label {
      font-size: 0.72rem;
      opacity: 0.75;
    }
    #mt-jail-need-btn {
      min-width: 28px;
      height: 22px;
      border-radius: 8px;
      border: 1px solid var(--sub-color, #646669);
      background: var(--sub-alt-color, #2c2e31);
      color: var(--text-color, #d1d0c5);
      cursor: pointer;
      font: inherit;
      line-height: 1;
    }
    #mt-jail-need-list {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 0;
      margin-bottom: 4px;
      max-height: 220px;
      overflow-y: auto;
      overscroll-behavior: contain;
      background: var(--sub-alt-color, #2c2e31);
      border: 1px solid var(--sub-color, #646669);
      border-radius: 8px;
      z-index: 100050;
      min-width: 40px;
    }
    #mt-jail-need-list.open { display: block; }
    #mt-jail-need-list div {
      padding: 4px 10px;
      cursor: pointer;
      text-align: center;
    }
    #mt-jail-need-list div:hover,
    #mt-jail-need-list div.active {
      background: var(--main-color, #e2b714);
      color: var(--bg-color, #323437);
    }
    #mt-jail-toast {
      position: fixed;
      bottom: 72px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 100100;
      background: rgba(30, 32, 36, 0.95);
      color: var(--text-color, #d1d0c5);
      border: 1px solid var(--main-color, #e2b714);
      border-radius: 10px;
      padding: 10px 16px;
      font-size: 0.9rem;
      box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.25s ease;
      max-width: 90vw;
      text-align: center;
    }
    #mt-jail-toast.show { opacity: 1; }
    #mt-jail-toast strong { color: var(--main-color, #e2b714); }
    #mt-jail-status {
      opacity: 0.85;
      font-size: 0.8rem;
    }
    #mt-jail-status.has-words {
      color: var(--error-color, #ca4754);
    }
    #mt-jail-edit, #mt-jail-clear {
      height: 22px;
      border-radius: 8px;
      border: 1px solid var(--sub-color, #646669);
      background: var(--sub-alt-color, #2c2e31);
      color: var(--text-color, #d1d0c5);
      cursor: pointer;
      font: 0.75rem monospace;
      padding: 0 8px;
      line-height: 1;
    }
    .mt-jail-pet {
      position: relative;
      width: 56px;
      height: 56px;
      border-radius: 8px;
      overflow: hidden;
      flex-shrink: 0;
      border: 1px solid var(--sub-color, #646669);
      background: #111;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.25);
    }
    .mt-jail-pet[hidden] {
      display: none !important;
    }
    .mt-jail-pet img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    #mt-jail-edit:hover, #mt-jail-clear:hover {
      border-color: var(--main-color, #e2b714);
      color: var(--main-color, #e2b714);
    }
    #mt-jail-clear:hover {
      border-color: var(--error-color, #ca4754);
      color: var(--error-color, #ca4754);
    }
    #mt-jail-editor-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: rgba(0,0,0,0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
    }
    #mt-jail-editor-panel {
      width: min(720px, 100%);
      height: min(80vh, 700px);
      background: var(--bg-color, #323437);
      color: var(--text-color, #d1d0c5);
      border: 1px solid var(--sub-color, #646669);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
    }
    #mt-jail-editor-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--sub-color, #646669);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #mt-jail-editor-header .sub {
      font-size: 0.8rem;
      color: var(--sub-color, #646669);
    }
    #mt-jail-editor-ta {
      flex: 1;
      width: 100%;
      border: none;
      resize: none;
      padding: 16px;
      box-sizing: border-box;
      background: var(--sub-alt-color, #2c2e31);
      color: var(--text-color, #d1d0c5);
      font: 14px/1.5 monospace;
      outline: none;
      overflow-y: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      pointer-events: auto !important;
      user-select: text !important;
      -webkit-user-select: text !important;
      caret-color: var(--main-color, #e2b714);
    }
    #mt-jail-editor-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding: 12px 16px;
      border-top: 1px solid var(--sub-color, #646669);
    }
    #mt-jail-editor-actions button {
      border-radius: 8px;
      border: 1px solid var(--sub-color, #646669);
      background: var(--sub-alt-color, #2c2e31);
      color: var(--text-color, #d1d0c5);
      cursor: pointer;
      font: 0.85rem monospace;
      padding: 6px 14px;
    }
    #mt-jail-editor-actions button.primary {
      background: var(--main-color, #e2b714);
      color: var(--bg-color, #323437);
      border-color: var(--main-color, #e2b714);
    }
    #mt-jail-editor-actions button:hover {
      filter: brightness(1.08);
    }
  `);

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = 'mt-jail-bar';
    bar.innerHTML = `
      <div id="mt-jail-pet-kitten" class="mt-jail-pet" title="222+ unique words jailed — free the kitty" hidden>
        <img alt="stuck kitty" src="https://media1.tenor.com/m/CzX27wJysBQAAAAC/kitty-stuck.gif"/>
      </div>
      <label title="Add quote mistakes to the custom list named 'jail'">
        <input type="checkbox" id="mt-jail-check" ${jailEnabled ? 'checked' : ''}/>
        <span>jail</span>
      </label>
      <div id="mt-jail-reps-wrap">
        <button type="button" id="mt-jail-reps-btn" title="Repeat each word N times in the saved list">${jailReps}</button>
        <div id="mt-jail-reps-list"></div>
      </div>
      <div id="mt-jail-need-wrap" title="Correct writes needed to free a word (e.g. 5 of 7)">
        <span class="mt-jail-need-label">need</span>
        <button type="button" id="mt-jail-need-btn">${jailMinCorrect}</button>
        <div id="mt-jail-need-list"></div>
      </div>
      <button type="button" id="mt-jail-edit" title="Edit internal jail words">edit</button>
      <button type="button" id="mt-jail-clear" title="Clear entire jail list">clear</button>
      <span id="mt-jail-status"></span>
    `;

    const list = bar.querySelector('#mt-jail-reps-list');
    for (let i = 1; i <= 9; i++) {
      const d = document.createElement('div');
      d.textContent = String(i);
      d.dataset.val = String(i);
      if (i === jailReps) d.classList.add('active');
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        jailReps = i;
        jailMinCorrect = clampMinCorrect(jailMinCorrect, jailReps);
        const btn = document.querySelector('#mt-jail-reps-btn');
        if (btn) btn.textContent = String(i);
        const nb = document.querySelector('#mt-jail-need-btn');
        if (nb) nb.textContent = String(jailMinCorrect);
        list.querySelectorAll('div').forEach((el) =>
          el.classList.toggle('active', el.dataset.val === String(i))
        );
        list.classList.remove('open');
        savePrefs();
        try {
          const needListEl = document.querySelector('#mt-jail-need-list');
          if (needListEl) {
            needListEl.innerHTML = '';
            for (let j = 1; j <= jailReps; j++) {
              const dd = document.createElement('div');
              dd.textContent = String(j);
              dd.dataset.val = String(j);
              if (j === jailMinCorrect) dd.classList.add('active');
              dd.addEventListener('click', (ev) => {
                ev.stopPropagation();
                jailMinCorrect = clampMinCorrect(j, jailReps);
                if (nb) nb.textContent = String(jailMinCorrect);
                needListEl.querySelectorAll('div').forEach((el) =>
                  el.classList.toggle('active', el.dataset.val === String(jailMinCorrect))
                );
                needListEl.classList.remove('open');
                savePrefs();
              });
              needListEl.appendChild(dd);
            }
          }
        } catch (err) {}
        // Re-expand Monkeytype list with new N
        syncExpandedListToMonkeytype(loadUniqueWords());
      });
      list.appendChild(d);
    }

    // "need" threshold: min correct occurrences to free a word
    const needList = bar.querySelector('#mt-jail-need-list');
    const needBtn = bar.querySelector('#mt-jail-need-btn');
    function rebuildNeedList() {
      needList.innerHTML = '';
      for (let i = 1; i <= jailReps; i++) {
        const d = document.createElement('div');
        d.textContent = String(i);
        d.dataset.val = String(i);
        if (i === jailMinCorrect) d.classList.add('active');
        d.addEventListener('click', (e) => {
          e.stopPropagation();
          jailMinCorrect = clampMinCorrect(i, jailReps);
          needBtn.textContent = String(jailMinCorrect);
          needList.querySelectorAll('div').forEach((el) =>
            el.classList.toggle('active', el.dataset.val === String(jailMinCorrect))
          );
          needList.classList.remove('open');
          savePrefs();
        });
        needList.appendChild(d);
      }
    }
    rebuildNeedList();
    needBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      needList.classList.toggle('open');
      list.classList.remove('open');
    });
    needBtn.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = clampMinCorrect(jailMinCorrect + dir, jailReps);
      if (next === jailMinCorrect) return;
      jailMinCorrect = next;
      needBtn.textContent = String(jailMinCorrect);
      needList.querySelectorAll('div').forEach(d => {
        d.classList.toggle('active', d.dataset.val === String(jailMinCorrect));
      });
      savePrefs();
    }, { passive: false });

    bar.querySelector('#mt-jail-check').addEventListener('change', (e) => {
      jailEnabled = !!e.target.checked;
      savePrefs();
      updateStatus();
      updateJailPets();
    });

    bar.querySelector('#mt-jail-reps-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      list.classList.toggle('open');
      if (list.classList.contains('open')) {
        const active = list.querySelector('div.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
      }
    });
    bar.querySelector('#mt-jail-reps-btn').addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = clampReps(jailReps + dir);
      if (next === jailReps) return;
      jailReps = next;
      jailMinCorrect = clampMinCorrect(jailMinCorrect, jailReps);
      savePrefs();
      const btn = bar.querySelector('#mt-jail-reps-btn');
      if (btn) btn.textContent = String(jailReps);
      const nb = bar.querySelector('#mt-jail-need-btn');
      if (nb) nb.textContent = String(jailMinCorrect);
      list.querySelectorAll('div').forEach(d => {
        d.classList.toggle('active', d.dataset.val === String(jailReps));
      });
      try { rebuildNeedList(); } catch (err) {}
      try { syncExpandedListToMonkeytype(loadUniqueWords()); } catch (err) {}
    }, { passive: false });

    bar.querySelector('#mt-jail-edit').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openJailEditor();
    });
    bar.querySelector('#mt-jail-clear').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm('Clear all words from the jail list?')) {
        saveUniqueWords([]);
        console.log('[Jail] cleared');
      }
      updateJailPets();
    });

    updateJailPets();
    return bar;
  }

  function openJailEditor() {
    const existing = document.getElementById('mt-jail-editor-overlay');
    if (existing) existing.remove();

    const current = loadUniqueWords();
    const overlay = document.createElement('div');
    overlay.id = 'mt-jail-editor-overlay';
    overlay.innerHTML = `
      <div id="mt-jail-editor-panel">
        <div id="mt-jail-editor-header">
          <strong>Jail words</strong>
          <span class="sub">${current.length} unique · each repeated ×${clampReps(jailReps)} in saved list (shuffled)</span>
        </div>
        <textarea id="mt-jail-editor-ta" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
        <div id="mt-jail-editor-actions">
          <button type="button" id="mt-jail-editor-cancel">Cancel</button>
          <button type="button" id="mt-jail-editor-clear">Clear all</button>
          <button type="button" id="mt-jail-editor-save" class="primary">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const ta = overlay.querySelector('#mt-jail-editor-ta');
    ta.value = current.join(' ');

    // Monkeytype captures keys on window — stop them while this editor is open
    const stopMT = (e) => {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };
    const blockEvents = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'cut'];
    blockEvents.forEach((ev) => {
      ta.addEventListener(ev, stopMT, true);
      overlay.addEventListener(ev, (e) => {
        if (e.target === ta || (e.target && ta.contains(e.target))) stopMT(e);
      }, true);
    });
    try {
      pageWin.addEventListener('keydown', stopMT, true);
      pageWin.addEventListener('keyup', stopMT, true);
      pageWin.addEventListener('keypress', stopMT, true);
    } catch (err) {}

    const close = () => {
      try {
        pageWin.removeEventListener('keydown', stopMT, true);
        pageWin.removeEventListener('keyup', stopMT, true);
        pageWin.removeEventListener('keypress', stopMT, true);
      } catch (err) {}
      overlay.remove();
    };

    ta.addEventListener('keydown', (e) => {
      stopMT(e);
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        overlay.querySelector('#mt-jail-editor-save').click();
      }
    }, true);

    overlay.querySelector('#mt-jail-editor-cancel').onclick = (e) => {
      e.preventDefault();
      close();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#mt-jail-editor-clear').onclick = (e) => {
      e.preventDefault();
      ta.value = '';
      ta.focus();
    };
    overlay.querySelector('#mt-jail-editor-save').onclick = (e) => {
      e.preventDefault();
      const words = ta.value.split(/[\s\n\r]+/).map(cleanWord).filter(Boolean);
      saveUniqueWords(words);
      updateStatus();
      console.log('[Jail] edited →', words.length, 'words (reshuffled)');
      close();
    };

    setTimeout(() => {
      ta.focus();
      try {
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } catch (err) {}
    }, 30);
  }

  function findInsertTarget() {
    const quoteBtn = document.querySelector('[mode="quote"]');
    if (quoteBtn && quoteBtn.parentElement) {
      return {
        parent: quoteBtn.parentElement.parentElement || quoteBtn.parentElement,
        after: quoteBtn.parentElement
      };
    }
    const modeRow =
      document.querySelector('#testConfig .mode') ||
      document.querySelector('.pageTest .mode') ||
      document.querySelector('#testConfig');
    if (modeRow) {
      return { parent: modeRow.parentElement || modeRow, after: modeRow };
    }
    const testConfig = document.querySelector('#testConfig') || document.querySelector('.pageTest');
    if (testConfig) return { parent: testConfig, after: null };
    return null;
  }

  function injectUi() {
    const existing = document.getElementById('mt-jail-bar');
    if (existing && document.body.contains(existing)) {
      const cb = existing.querySelector('#mt-jail-check');
      if (cb) cb.checked = !!jailEnabled;
      const btn = existing.querySelector('#mt-jail-reps-btn');
      if (btn) btn.textContent = String(jailReps);
      updateStatus();
      return;
    }
    if (existing) existing.remove();

    const target = findInsertTarget();
    if (!target) return;

    const bar = buildBar();
    if (target.after && target.after.parentElement === target.parent) {
      target.after.insertAdjacentElement('afterend', bar);
    } else {
      target.parent.appendChild(bar);
    }

    if (!document.__mtJailOutsideClose) {
      document.__mtJailOutsideClose = true;
      document.addEventListener('click', () => {
        const list = document.querySelector('#mt-jail-reps-list');
        if (list) list.classList.remove('open');
        const needL = document.querySelector('#mt-jail-need-list');
        if (needL) needL.classList.remove('open');
      });
    }
    updateStatus();
  }

  let guardObserver = null;
  function startUiGuard() {
    if (guardObserver) return;
    const root = document.getElementById('app') || document.getElementById('centerContent') || document.body;
    guardObserver = new MutationObserver(() => {
      if (!document.getElementById('mt-jail-bar')) {
        requestAnimationFrame(() => injectUi());
      }
    });
    try {
      guardObserver.observe(root, { childList: true, subtree: true });
    } catch (e) {}
  }

  function updateStatus() {
    const el = document.getElementById('mt-jail-status');
    if (el) {
      el.textContent = '';
      el.classList.remove('has-words');
    }
    updateJailPets();
  }

  function updateJailPets() {
    const n = loadUniqueWords().length;
    const kit = document.getElementById('mt-jail-pet-kitten');
    if (kit) kit.hidden = !(jailEnabled && n > 222);
  }

  // ---------- Internal unique word list (GM) + expanded customText["jail"] ----------
  function loadUniqueWords() {
    try {
      const v = GM_getValue(STORAGE_WORDS, '[]');
      const arr = typeof v === 'string' ? JSON.parse(v) : v;
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function saveUniqueWords(words) {
    const seen = new Set();
    const unique = [];
    for (const w of words || []) {
      const t = cleanWord(w);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      unique.push(t);
    }
    GM_setValue(STORAGE_WORDS, JSON.stringify(unique));
    // Expand each word × jailReps into Monkeytype saved list "jail"
    syncExpandedListToMonkeytype(unique);
    return unique;
  }

  function cleanWord(w) {
    let t = String(w || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'’-]+$/u, '');
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return '';
    return t;
  }

  /** Target word only — never include typed .extra letters from textContent */
  function wordTargetText(el) {
    if (!el) return '';
    const dw = el.getAttribute('data-word');
    if (dw) return cleanWord(dw);
    // Fallback: letters excluding extras
    let s = '';
    el.querySelectorAll('letter, .letter').forEach((l) => {
      if (l.classList.contains('extra')) return;
      s += (l.textContent || '');
    });
    if (s) return cleanWord(s);
    return cleanWord(el.textContent || '');
  }

  function readJailList() {
    return loadUniqueWords();
  }

  function expandWords(unique) {
    const reps = clampReps(jailReps);
    const out = [];
    for (const w of unique) {
      for (let i = 0; i < reps; i++) out.push(w);
    }
    return out;
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function syncExpandedListToMonkeytype(unique) {
    // Expand ×N then shuffle every write (edit/clear/add/prune)
    const expanded = shuffleInPlace(expandWords(shuffleInPlace(unique.slice())));
    let obj = {};
    try {
      obj = JSON.parse(localStorage.getItem('customText') || '{}') || {};
    } catch (e) {
      obj = {};
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
    if (typeof obj.text === 'string' && Object.keys(obj).every((k) => k === 'text')) {
      obj = {};
    }

    if (expanded.length) {
      obj[JAIL_LIST_NAME] = expanded.join(' ');
    } else {
      delete obj[JAIL_LIST_NAME];
    }

    try {
      localStorage.setItem('customText', JSON.stringify(obj));
    } catch (e) {
      console.warn('[Jail] localStorage set failed', e);
    }

    // Active custom settings: one pass over shuffled tokens (limit = length)
    try {
      if (expanded.length) {
        const settings = {
          text: expanded.slice(),
          mode: 'repeat',
          limit: { value: expanded.length, mode: 'word' },
          pipeDelimiter: false
        };
        localStorage.setItem('customTextSettings', JSON.stringify(settings));
      }
    } catch (e) {}

    tryPushIntoMonkeytypeCache(obj);
    console.log(
      '[Jail] synced shuffled ×' + clampReps(jailReps),
      'unique=', unique.length,
      'tokens=', expanded.length,
      unique.slice(0, 12)
    );
  }

  function tryPushIntoMonkeytypeCache(obj) {
    try {
      const CT = pageWin.CustomText;
      if (CT && typeof CT.setCustomText === 'function') {
        const text = obj[JAIL_LIST_NAME] || '';
        if (text) CT.setCustomText(JAIL_LIST_NAME, text, false);
        else if (typeof CT.deleteCustomText === 'function') CT.deleteCustomText(JAIL_LIST_NAME, false);
        return true;
      }
    } catch (e) {}
    try {
      const chunks = pageWin.webpackChunkmonkeytype || pageWin.webpackChunk_monkeytype_frontend;
      if (!chunks || !Array.isArray(chunks)) return false;
      let found = null;
      chunks.push([
        [Symbol('jail-ct')],
        {},
        (require) => {
          try {
            if (!require || !require.cache) return;
            for (const id of Object.keys(require.cache)) {
              const exp = require.cache[id] && require.cache[id].exports;
              if (!exp) continue;
              if (typeof exp.setCustomText === 'function' && typeof exp.getCustomTextNames === 'function') {
                found = exp;
                break;
              }
              if (exp.default && typeof exp.default.setCustomText === 'function') {
                found = exp.default;
                break;
              }
            }
          } catch (e) {}
        }
      ]);
      if (found) {
        const text = obj[JAIL_LIST_NAME] || '';
        if (text) found.setCustomText(JAIL_LIST_NAME, text, false);
        else if (typeof found.deleteCustomText === 'function') found.deleteCustomText(JAIL_LIST_NAME, false);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function addMistakesToJail(mistakeWords) {
    const current = loadUniqueWords();
    const seen = new Set(current);
    for (const w of mistakeWords || []) {
      const t = cleanWord(w);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      current.push(t);
    }
    return saveUniqueWords(current);
  }

  function removeCorrectFromJail(correctWords) {
    const remove = new Set(
      (correctWords || []).map(cleanWord).filter(Boolean)
    );
    const next = loadUniqueWords().filter((w) => !remove.has(w));
    return saveUniqueWords(next);
  }

  function showJailToast(msg, ms) {
    let el = document.getElementById('mt-jail-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mt-jail-toast';
      document.body.appendChild(el);
    }
    el.innerHTML = msg;
    el.classList.add('show');
    clearTimeout(showJailToast._t);
    showJailToast._t = setTimeout(() => el.classList.remove('show'), ms || 10000);
  }

  /**
   * Build per-word stats from LIVE index tracking (errors during typing).
   */
  function collectWordAttemptStatsFromIndexes() {
    const stats = new Map();
    const limit = Math.max(maxTypedIndex, wordTexts.length - 1);
    for (let i = 0; i <= limit; i++) {
      const t = cleanWord(wordTexts[i] || '');
      if (!t || !/[\p{L}\p{N}]/u.test(t)) continue;
      let s = stats.get(t);
      if (!s) {
        s = { total: 0, correct: 0 };
        stats.set(t, s);
      }
      s.total++;
      if (!everErroredIndexes.has(i) && !erroredWordIndexes.has(i)) {
        s.correct++;
      }
    }
    return stats;
  }

  /**
   * Single history root. A word occurrence is a STUMBLE if it has
   * incorrect/extra/missed OR corrected (fixed typo) letters.
   * Pure .correct-only words count as clean — this matches input history underlines.
   */
  function collectWordAttemptStatsFromRoot(root) {
    const stats = new Map();
    if (!root) return stats;
    // corrected = had an error that was fixed — still a stumble for jail practice
    const stumbleSel =
      'letter.incorrect, letter.extra, letter.missed, letter.corrected, ' +
      '.letter.incorrect, .letter.extra, .letter.missed, .letter.corrected, ' +
      'letter.error, .letter.error';

    root.querySelectorAll('.word').forEach((w) => {
      const letters = w.querySelectorAll('letter, .letter');
      if (!letters.length) return;

      const t = cleanWord(w.getAttribute('data-word') || wordTargetText(w) || w.textContent || '');
      if (!t || !/[\p{L}\p{N}]/u.test(t)) return;

      const hasStumble =
        w.classList.contains('error') ||
        !!w.querySelector(stumbleSel);

      let s = stats.get(t);
      if (!s) {
        s = { total: 0, correct: 0 };
        stats.set(t, s);
      }
      s.total++;
      if (!hasStumble) s.correct++;
    });
    return stats;
  }

  function collectWordAttemptStats() {
    // Prefer result input history (one sequence, includes corrected class)
    const roots = [
      document.getElementById('resultWordsHistory'),
      document.querySelector('#result .words'),
      document.getElementById('wordsHistory'),
      document.querySelector('.inputHistory'),
      document.getElementById('words')
    ];
    for (const root of roots) {
      if (!root) continue;
      const words = root.querySelectorAll('.word');
      if (words && words.length >= 1) {
        const stats = collectWordAttemptStatsFromRoot(root);
        if (stats.size) {
          console.log('[Jail] stats from', root.id || root.className, [...stats.entries()]);
          return stats;
        }
      }
    }
    // Last resort: live indexes
    return collectWordAttemptStatsFromIndexes();
  }

  /**
   * Free when history shows >= need clean occurrences (no incorrect/corrected letters).
   */
  function pruneJailByThreshold() {
    const minNeed = clampMinCorrect(jailMinCorrect, jailReps);

    // Always re-read history at prune time (result panel is visible)
    let stats = collectWordAttemptStats();
    if (!stats.size && resultSnapshotStats && resultSnapshotStats.size) {
      stats = resultSnapshotStats;
    }

    const beforeList = loadUniqueWords();
    const removed = [];
    const kept = [];
    for (const w of beforeList) {
      const key = cleanWord(w);
      const s = stats.get(key);
      if (!s || s.total < 1) {
        // Not in this test — keep
        kept.push(w);
        continue;
      }
      if (s.correct >= minNeed) {
        removed.push(w);
      } else {
        kept.push(w);
      }
    }
    saveUniqueWords(kept);
    console.log('[Jail] prune detail', {
      minNeed,
      stats: [...stats.entries()],
      removed,
      kept
    });
    return {
      before: beforeList.length,
      after: kept.length,
      removed: removed.length,
      removedWords: removed,
      minNeed,
      statsSize: stats.size
    };
  }

  function getCurrentMode() {
    try {
      const active = document.querySelector(
        '.mode .active[mode], [mode].active, .textButton.active[mode]'
      );
      if (active && active.getAttribute('mode')) return active.getAttribute('mode');
    } catch (e) {}
    try {
      const cfg = JSON.parse(localStorage.getItem('config') || '{}');
      if (cfg && cfg.mode) return cfg.mode;
    } catch (e) {}
    return null;
  }

  function isResultVisible() {
    const result = document.querySelector('#result');
    if (!result) return false;
    const style = window.getComputedStyle(result);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return !!(result.offsetParent || result.getClientRects().length);
  }

  function isTestActive() {
    // Zen mode: ignore (spam keys would pollute records)
    try {
      if (document.querySelector('#words.zen, .pageTest.zen, body.zen, #typingTest.zen')) return false;
      const modeBtn = document.querySelector('#testConfig .mode .textButton.active, .pageTest .mode .active');
      if (modeBtn && /zen/i.test(modeBtn.textContent || '')) return false;
      if (document.querySelector('.view-line[data-mode="zen"], [data-mode="zen"].active')) return false;
    } catch (e) {}
    if (isResultVisible()) return false;
    const words = document.getElementById('words');
    if (!words) return false;
    const style = window.getComputedStyle(words);
    if (style.display === 'none') return false;
    return !!document.querySelector('#words .word');
  }

  function resultKey() {
    const wpm = document.querySelector('#result .group.wpm .bottom, #result .wpm .bottom');
    const time = document.querySelector('#result .group.time .bottom, #result .time .bottom');
    const acc = document.querySelector('#result .group.acc .bottom, #result .acc .bottom');
    return [wpm, time, acc]
      .map((el) => (el && el.textContent) || '')
      .join('|');
  }

  function isJailCustomActive() {
    if (getCurrentMode() !== 'custom') return false;
    const jail = readJailList();
    if (!jail.length) return false;

    try {
      const settings = JSON.parse(localStorage.getItem('customTextSettings') || 'null');
      if (settings && Array.isArray(settings.text)) {
        const setB = new Set(jail);
        if (settings.text.some((w) => setB.has(String(w)))) return true;
      }
    } catch (e) {}

    const onScreen = [];
    document.querySelectorAll('#words .word').forEach((w) => {
      const t = (w.getAttribute('data-word') || w.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) onScreen.push(t);
    });
    if (onScreen.length && onScreen.every((w) => jail.includes(w))) return true;

    return false;
  }

  function clearLiveTracking() {
    erroredWordTexts.clear();
    erroredWordIndexes.clear();
    everErroredIndexes.clear();
    wordTexts = [];
    maxTypedIndex = -1;
    resultSnapshotMistakes = [];
    resultSnapshotStats = null;
    lastProcessedResultKey = '';
  }

  /** Full reset of in-test mistake state (same as a fresh page load for tracking) */
  function resetAttemptState() {
    clearLiveTracking();
    sawTypingThisTest = false;
    console.log('[Jail] attempt state reset');
  }

  function letterErrorSelector() {
    // Only hard error classes — NOT corrected, NOT speed heatmap
    return (
      'letter.incorrect, letter.extra, letter.missed, ' +
      '.letter.incorrect, .letter.extra, .letter.missed'
    );
  }

  function scanWords() {
    captureActiveWordErrors();
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (isTestActive()) captureActiveWordErrors();
    }, 20);
  }

  /** Track every word index that ever had a real error letter (survives corrections). */
  function captureActiveWordErrors() {
    if (!jailEnabled || !isTestActive()) return;
    const sel = letterErrorSelector();
    const nodes = document.querySelectorAll('#words .word');
    if (!nodes || !nodes.length) return;

    nodes.forEach((w, i) => {
      const t = cleanWord(wordTargetText(w) || w.getAttribute('data-word') || '');
      if (t) wordTexts[i] = t;

      const hasErr =
        w.classList.contains('error') ||
        !!w.querySelector(sel);

      if (hasErr) {
        everErroredIndexes.add(i);
        erroredWordIndexes.add(i);
        if (t) erroredWordTexts.add(t);
      }

      if (
        w.classList.contains('typed') ||
        w.classList.contains('active') ||
        w.querySelector('letter.correct, letter.incorrect, .letter.correct, .letter.incorrect')
      ) {
        if (i > maxTypedIndex) maxTypedIndex = i;
      }
    });
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!jailEnabled) return;
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') return;
      if (!isTestActive()) return;
      requestAnimationFrame(captureActiveWordErrors);
    },
    true
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (!jailEnabled || !isTestActive()) return;
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') return;
      requestAnimationFrame(captureActiveWordErrors);
    },
    true
  );

  document.addEventListener('keyup', () => scheduleScan(), true);
  document.addEventListener('input', () => scheduleScan(), true);

  // Catch error classes even when key events are missed / debounced
  try {
    const mo = new MutationObserver(() => {
      if (!jailEnabled || !isTestActive()) return;
      scheduleScan();
    });
    const startMo = () => {
      const w = document.getElementById('words');
      if (w) mo.observe(w, { subtree: true, attributes: true, attributeFilter: ['class'] });
    };
    startMo();
    setInterval(() => {
      const w = document.getElementById('words');
      if (w && jailEnabled) {
        try { mo.observe(w, { subtree: true, attributes: true, attributeFilter: ['class'] }); } catch (e) {}
      }
    }, 2000);
  } catch (e) {}

  // Only mark a pending clear on explicit restart — never clear mid-keystroke during a run
  let pendingRestartClear = false;

  function isRestartKey(e) {
    return e.key === 'Enter' || e.key === 'Tab' || e.code === 'Enter' || e.code === 'Tab';
  }
  function onPossibleRestart(e) {
    if (!jailEnabled) return;
    if (!isRestartKey(e)) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTestActive() && !isResultVisible()) {
      // Mid-test restart: clear once for the next attempt
      pendingRestartClear = true;
      resetAttemptState();
      pendingRestartClear = false;
    }
    // On result screen Enter starts next test — clear happens when result hides
  }
  document.addEventListener('keydown', onPossibleRestart, true);
  try {
    pageWin.addEventListener('keydown', onPossibleRestart, true);
  } catch (e) {}

  document.addEventListener('click', (e) => {
    if (!jailEnabled) return;
    const t = e.target && e.target.closest && e.target.closest(
      '#restartTestButton, #restart-test-button, .restart, [data-command="restartTest"], #next-test-button'
    );
    if (t) {
      pendingRestartClear = true;
      resetAttemptState();
      pendingRestartClear = false;
    }
  }, true);

  function collectErroredWordTexts() {
    const out = [];
    const seen = new Set();
    const add = (t) => {
      t = cleanWord(t);
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };

    // 1) Words we saw with real error letters on the active word while typing
    for (const t of erroredWordTexts) add(t);

    // 2) Try Monkeytype internal missed / input history APIs
    try {
      const missed = tryGetMissedWordsFromPage();
      if (missed && missed.length) missed.forEach(add);
    } catch (e) {}

    // 3) Final DOM: still-visible incorrect/extra/missed only
    const sel = letterErrorSelector();
    const roots = [
      document.getElementById('words'),
      document.getElementById('resultWordsHistory'),
      document.getElementById('wordsHistory'),
      document.querySelector('#result .words'),
      document.querySelector('.inputHistory')
    ].filter(Boolean);
    for (const root of roots) {
      root.querySelectorAll('.word').forEach((w) => {
        if (w.querySelector(sel)) add(wordTargetText(w));
      });
    }

    return out;
  }

  function tryGetMissedWordsFromPage() {
    const out = [];
    // Common globals / stats modules
    const candidates = [
      () => pageWin.TestStats && pageWin.TestStats.missedWords,
      () => pageWin.TestInput && pageWin.TestInput.missedWords,
      () => pageWin.getMissedWords && pageWin.getMissedWords(),
    ];
    for (const fn of candidates) {
      try {
        const v = fn();
        if (!v) continue;
        if (Array.isArray(v)) return v.map(String);
        if (v instanceof Set) return [...v].map(String);
        if (typeof v === 'object') return Object.keys(v);
      } catch (e) {}
    }
    // Webpack probe for getMissedWords
    try {
      const chunks = pageWin.webpackChunkmonkeytype || pageWin.webpackChunk_monkeytype_frontend;
      if (!chunks || !Array.isArray(chunks)) return out;
      let found = null;
      chunks.push([
        [Symbol('jail-missed')],
        {},
        (require) => {
          try {
            if (!require || !require.cache) return;
            for (const id of Object.keys(require.cache)) {
              const exp = require.cache[id] && require.cache[id].exports;
              if (!exp) continue;
              if (typeof exp.getMissedWords === 'function') {
                found = exp;
                break;
              }
            }
          } catch (e) {}
        }
      ]);
      if (found) {
        const v = found.getMissedWords();
        if (v instanceof Set) return [...v].map(String);
        if (Array.isArray(v)) return v.map(String);
        if (v && typeof v === 'object') return Object.keys(v);
      }
    } catch (e) {}
    return out;
  }

  function collectCorrectWordTexts() {
    scanWords();
    const errored = new Set(collectErroredWordTexts());
    const out = [];
    const seen = new Set();

    const addIfClean = (t) => {
      t = (t || '').replace(/\s+/g, ' ').trim();
      if (!t || seen.has(t) || errored.has(t)) return;
      if (!/[\p{L}\p{N}]/u.test(t)) return;
      seen.add(t);
      out.push(t);
    };

    document.querySelectorAll('#words .word').forEach((w) => {
      const t = (w.getAttribute('data-word') || w.textContent || '').replace(/\s+/g, ' ').trim();
      const hasErr = !!w.querySelector(
        'letter.incorrect, letter.extra, letter.missed, ' +
        '.letter.incorrect, .letter.extra, .letter.missed'
      );
      if (!hasErr) addIfClean(t);
    });

    const roots = [
      document.getElementById('resultWordsHistory'),
      document.getElementById('wordsHistory'),
      document.querySelector('#result .words')
    ].filter(Boolean);
    for (const root of roots) {
      root.querySelectorAll('.word').forEach((w) => {
        const t = (w.getAttribute('data-word') || w.textContent || '').replace(/\s+/g, ' ').trim();
        const hasErr =
          w.classList.contains('error') ||
          !!w.querySelector('.letter.incorrect, .letter.extra, .letter.missed, .incorrect');
        if (!hasErr) addIfClean(t);
      });
    }

    return out;
  }

  function processResultIfNeeded() {
    if (!jailEnabled) return;
    if (!isResultVisible()) return;

    const key = resultKey();
    if (!key || key === lastProcessedResultKey) return;
    lastProcessedResultKey = key;

    let mode = getCurrentMode();
    try {
      const typeEl = document.querySelector(
        '#result .testType, #result .group.testType, #result .test-type, .result .testType, #result .group.testType .bottom, #result .testType .bottom'
      );
      const typeText = (typeEl && typeEl.textContent || '').toLowerCase();
      if (typeText.includes('quote')) mode = 'quote';
      else if (typeText.includes('custom')) mode = 'custom';
    } catch (e) {}
    // Fallback: quote length buttons / source line often present on quote results
    if (mode !== 'custom' && mode !== 'quote') {
      if (document.querySelector('#result .source, #result .group.source')) mode = 'quote';
    }

    // Prefer snapshot taken on rising edge of result (before DOM teardown)
    let mistakes = resultSnapshotMistakes.length
      ? resultSnapshotMistakes.slice()
      : collectErroredWordTexts();
    if (!mistakes.length) {
      mistakes = collectErroredWordTexts();
    }
    console.log('[Jail] result', {
      mode,
      mistakes,
      snapshot: resultSnapshotMistakes.slice(),
      ever: [...everErroredIndexes],
      live: [...erroredWordTexts]
    });

    if (mode === 'quote' || (mode !== 'custom' && mistakes.length)) {
      if (mistakes.length) {
        const updated = addMistakesToJail(mistakes);
        console.log('[Jail] quote finished — added', mistakes, '→ unique', updated.length);
      } else {
        console.log('[Jail] quote finished — no mistakes detected');
      }
      updateStatus();
      return;
    }

    if (mode === 'custom' && isJailCustomActive()) {
      const result = pruneJailByThreshold();
      console.log('[Jail] custom(jail) finished', result);
      try {
        const settings = JSON.parse(localStorage.getItem('customTextSettings') || 'null');
        if (settings && Array.isArray(settings.text)) {
          const expanded = expandWords(loadUniqueWords());
          settings.text = shuffleInPlace(expanded.slice());
          settings.limit = {
            value: Math.max(settings.text.length, 1),
            mode: (settings.limit && settings.limit.mode) || 'word'
          };
          localStorage.setItem('customTextSettings', JSON.stringify(settings));
        }
      } catch (e) {}
      updateStatus();
      showJailToast(
        'Jail: <strong>' + result.removed + '</strong> freed' +
        ' (need ≥' + result.minNeed + ' correct) · <strong>' + result.after + '</strong> left' +
        (result.after === 0 ? ' — jail empty!' : ''),
        10000
      );
    }
  }

  function fillWordTextsFromDom() {
    const roots = [
      document.getElementById('words'),
      document.getElementById('resultWordsHistory'),
      document.getElementById('wordsHistory'),
      document.querySelector('#result .words')
    ];
    for (const root of roots) {
      if (!root) continue;
      const nodes = root.querySelectorAll('.word');
      if (!nodes.length) continue;
      let filled = 0;
      nodes.forEach((w, i) => {
        const t = cleanWord(w.getAttribute('data-word') || wordTargetText(w) || '');
        if (t) {
          // Prefer live #words values; only fill gaps from history
          if (root.id === 'words' || !wordTexts[i]) {
            wordTexts[i] = t;
            filled++;
          }
        }
      });
      if (nodes.length - 1 > maxTypedIndex) maxTypedIndex = nodes.length - 1;
      if (filled || root.id === 'words') break;
    }
  }

  function snapshotMistakesNow() {
    try { captureActiveWordErrors(); } catch (e) {}
    try { fillWordTextsFromDom(); } catch (e) {}
    const m = collectErroredWordTexts();
    resultSnapshotMistakes = m.slice();
    try {
      // Prefer input-history stats (corrected class visible on result screen)
      resultSnapshotStats = collectWordAttemptStats();
      console.log('[Jail] snapshot', {
        mistakes: resultSnapshotMistakes.slice(),
        stats: resultSnapshotStats ? [...resultSnapshotStats.entries()] : []
      });
    } catch (e) {
      resultSnapshotStats = null;
    }
  }

  // When result panel appears, freeze mistakes BEFORE #words is destroyed
  let wasResultVisible = false;
  setInterval(() => {
    const vis = isResultVisible();
    if (vis && !wasResultVisible) {
      // Rising edge — test just finished
      snapshotMistakesNow();
      processResultIfNeeded();
    } else if (vis) {
      processResultIfNeeded();
    } else if (!vis && wasResultVisible) {
      // Left result — full reset so next attempt does not inherit mistakes
      resetAttemptState();
    }
    wasResultVisible = vis;
  }, 200);

  // Track whether user has typed in this attempt (no clearing here — that wiped early mistakes)
  setInterval(() => {
    if (isResultVisible()) {
      sawTypingThisTest = false;
      return;
    }
    const typed = document.querySelector(
      '#words .letter.correct, #words .letter.incorrect, #words .word.typed'
    );
    if (typed) sawTypingThisTest = true;
  }, 300);

  let wordsObserver = null;
  function bindWordsObserver() {
    const root = document.getElementById('words');
    if (!root || wordsObserver) return;
    wordsObserver = new MutationObserver(() => scheduleScan());
    try {
      wordsObserver.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class']
      });
    } catch (e) {}
  }

  function boot() {
    injectUi();
    startUiGuard();
    bindWordsObserver();
    updateStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  setInterval(() => {
    injectUi();
    bindWordsObserver();
  }, 1000);

  console.log('[Monkeytype Jail Mode] v2.0.15 ready — no Enter hijack; list key:', JAIL_LIST_NAME);
})();


/* ========== 3. HOTLIST MULTI ========== */
/**
 * Credits: original Hotlist by poem#3305
 * Multi-list + light preset binding added later.
 *
 * v1.1.0 — safer: no capture click on document, no second MutationObserver,
 * no blocking alerts, closer to original observer behavior.
 */

(function () {
  'use strict';

  try {

  const MAIN_COLOR = 'var(--main-color)';
  const RED_COLOR = '#EE4B2B';
  const SEPARATOR = ';';
  const LISTS_SEPARATOR = '|';
  const STORAGE_KEY = 'HotlistMultiDataV1';
  const LEGACY_KEY = 'HotlistDataItemV3';
  const ENABLED_KEY = 'HotlistEnabled';
  const COMMAND_ID = 'hotlistToggle';
  const COMMAND_ID_ON = 'hotlistSetOn';
  const COMMAND_ID_OFF = 'hotlistSetOff';

  let mainSet = new Set();
  let redSet = new Set();
  let mainList = [];
  let redList = [];
  let mainExact = [];
  let redExact = [];
  let settingsVersion = 0;
  let enabled = true;
  let lastPresetName = '';

  /** @type {{ lists: Record<string,{name:string,main:string[],red:string[]}>, activeId: string, presetMap: Record<string,string> }} */
  let store = null;

  const pending = new Set();
  let flushScheduled = false;
  const lettersCache = new WeakMap();

  GM_addStyle(`
    .word letter[data-hotlist="main"] {
      filter: drop-shadow(0 0 1px ${MAIN_COLOR}) drop-shadow(0 0 3px ${MAIN_COLOR}) !important;
      -webkit-text-stroke: 0.35px rgba(255,255,255,0.55) !important;
      text-shadow: 0 0 2px ${MAIN_COLOR}, 0 0 4px ${MAIN_COLOR} !important;
    }
    .word letter[data-hotlist="red"] {
      filter: drop-shadow(0 0 1px ${RED_COLOR}) drop-shadow(0 0 3px ${RED_COLOR}) !important;
      -webkit-text-stroke: 0.35px rgba(255,255,255,0.55) !important;
      text-shadow: 0 0 2px ${RED_COLOR}, 0 0 4px ${RED_COLOR} !important;
    }
    .word.nocursor letter[data-hotlist="main"] {
      filter: drop-shadow(0 0 2px ${MAIN_COLOR}) !important;
      -webkit-text-stroke: 0.3px rgba(255,255,255,0.45) !important;
      text-shadow: 0 0 3px ${MAIN_COLOR} !important;
    }
    .word.nocursor letter[data-hotlist="red"] {
      filter: drop-shadow(0 0 2px ${RED_COLOR}) !important;
      -webkit-text-stroke: 0.3px rgba(255,255,255,0.45) !important;
      text-shadow: 0 0 3px ${RED_COLOR} !important;
    }

    .section.hotlist.fullWidth {
      width: 100% !important;
      display: grid;
      grid-template-columns: 2fr 1fr;
      grid-template-rows: auto auto 1fr;
      grid-template-areas: "title title" "text buttons" "content content";
      column-gap: 2rem;
      row-gap: 0.5rem;
      align-items: start;
    }
    .section.hotlist.fullWidth .inputs,
    .section.hotlist.fullWidth .buttons { width: 100% !important; }
    .section.hotlist .groupTitle { grid-area: title; }
    .section.hotlist .text { grid-area: text; margin-bottom: 0; }
    .section.hotlist .buttons {
      grid-area: buttons;
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }
    .section.hotlist .hotlistContent {
      grid-area: content;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-top: 0.5rem;
    }
    .section.hotlist .hotlistListBar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--sub-alt-color);
      margin-bottom: 0.25rem;
    }
    .section.hotlist .hotlistListBar select {
      min-width: 10rem;
      height: 2.25rem;
      padding: 0 0.6rem;
      border-radius: var(--roundness);
      background: var(--sub-alt-color);
      border: none;
      color: var(--text-color);
      font-family: var(--font);
      font-size: 0.9rem;
    }
    .section.hotlist .hotlistListBar button {
      height: 2.25rem;
      padding: 0 0.75rem;
      font-size: 0.8rem;
    }
    .section.hotlist .hotlistListBar .presetBind {
      margin-left: auto;
      font-size: 0.8rem;
      color: var(--sub-color);
      opacity: 0.85;
      max-width: 40%;
      text-align: right;
    }
    .section.hotlist .hotlistColumns {
      padding-left: 3px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2rem;
    }
    .section.hotlist .hotlistColumn {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .section.hotlist .hotlistMetaRow {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--sub-color);
    }
    .section.hotlist .hotlistMetaRow .left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .section.hotlist .hotlistMetaRow .right {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .section.hotlist .hotlistMetaRow .swatch {
      width: 0.75rem;
      height: 0.75rem;
      border-radius: 0.2rem;
      background: var(--main-color);
    }
    .section.hotlist .hotlistMetaRow .swatch.red { background: ${RED_COLOR}; }
    .section.hotlist .hotlistMetaRow .count { opacity: 0.7; }
    .section.hotlist .hotlistMetaRow .clearBtn {
      opacity: 0.5;
      cursor: pointer;
      font-size: 0.85rem;
      transition: opacity 0.125s;
    }
    .section.hotlist .hotlistMetaRow .clearBtn:hover { opacity: 1; }
    .section.hotlist .hotlistAddRow {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
    }
    .section.hotlist .hotlistAddRow input.input {
      flex: 1;
      min-width: 0;
      height: 2.5rem;
      padding: 0 0.75rem;
      border-radius: var(--roundness);
      background: var(--sub-alt-color);
      border: none;
      color: var(--text-color);
      font-size: 1rem;
      font-family: var(--font);
    }
    .section.hotlist .hotlistAddRow input.input::placeholder {
      color: var(--sub-color);
      opacity: 0.5;
    }
    .section.hotlist .hotlistAddRow button {
      height: 2.5rem;
      width: 2.5rem;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .section.hotlist .hotlistAddRow button i { line-height: 1; }
    .section.hotlist .hotlistAddRow .exactToggle {
      width: auto;
      padding: 0 0.75rem;
      font-size: 0.8rem;
      opacity: 0.5;
    }
    .section.hotlist .hotlistAddRow .exactToggle.active {
      opacity: 1;
      background: var(--main-color);
      color: var(--bg-color);
    }
    .section.hotlist .hotlistChips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      min-height: 3rem;
      max-height: 16rem;
      overflow-y: auto;
      padding: 0.25rem 0;
      align-content: flex-start;
    }
    .section.hotlist .hotlistChips:empty::after {
      content: 'No items yet';
      color: var(--sub-color);
      opacity: 0.4;
      font-style: italic;
    }
    .section.hotlist .hotlistChip {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      height: 2rem;
      padding: 0 0.75rem;
      border-radius: var(--roundness);
      background: var(--sub-alt-color);
      color: var(--text-color);
      font-size: 0.875rem;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: background 0.125s, color 0.125s;
    }
    .section.hotlist .hotlistChip:hover {
      color: var(--bg-color);
      background: var(--text-color);
    }
    .section.hotlist .hotlistChip i {
      font-size: 0.75rem;
      opacity: 0.7;
    }
    .section.hotlist .hotlistChip:hover i { opacity: 1; }
    .section.hotlist .hotlistChip .exactBadge {
      font-size: 0.625rem;
      opacity: 0.6;
      margin-left: 0.1rem;
    }
    @media (max-width: 700px) {
      .section.hotlist .hotlistColumns { grid-template-columns: 1fr; }
    }

    .suggestions.hotlist-managed .command:not(.hotlist-hover) {
      color: var(--sub-color) !important;
      background: transparent !important;
    }
    .suggestions.hotlist-managed .command.hotlist-hover {
      color: var(--bg-color) !important;
      background: var(--text-color) !important;
    }
  `);

  function uid() {
    return 'hl_' + Math.random().toString(36).slice(2, 10);
  }

  function defaultStore() {
    const id = uid();
    return {
      lists: { [id]: { name: 'Default', main: [], red: [] } },
      activeId: id,
      presetMap: {}
    };
  }

  function persistStore() {
    try {
      if (store && store.activeId && store.lists[store.activeId]) {
        store.lists[store.activeId].main = [...mainSet];
        store.lists[store.activeId].red = [...redSet];
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {}
  }

  function loadActiveIntoSets() {
    const list = store && store.lists[store.activeId];
    if (!list) return;
    mainSet = new Set(list.main || []);
    redSet = new Set(list.red || []);
    rebuildLists();
  }

  function migrateFromLegacy() {
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (!legacy) return null;
      const [main = '', red = ''] = legacy.split(LISTS_SEPARATOR);
      const parse = (s) => s.split(SEPARATOR).map((x) => x.trim()).filter(Boolean);
      const id = uid();
      return {
        lists: {
          [id]: { name: 'Default (imported)', main: parse(main), red: parse(red) }
        },
        activeId: id,
        presetMap: {}
      };
    } catch (e) {
      return null;
    }
  }

  function loadStore() {
    try {
      const enabledData = localStorage.getItem(ENABLED_KEY);
      enabled = enabledData !== '0';

      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        store = JSON.parse(raw);
        if (!store || !store.lists || !store.activeId) store = defaultStore();
      } else {
        store = migrateFromLegacy() || defaultStore();
        persistStore();
      }
      if (!store.lists[store.activeId]) {
        store.activeId = Object.keys(store.lists)[0];
      }
      loadActiveIntoSets();
    } catch (e) {
      store = defaultStore();
      loadActiveIntoSets();
    }
  }

  function switchList(id) {
    if (!store.lists[id] || id === store.activeId) return;
    persistStore();
    store.activeId = id;
    loadActiveIntoSets();
    persistStore();
    reapplyAll();
    renderAll();
  }

  function createList(name) {
    const id = uid();
    store.lists[id] = {
      name: name || ('List ' + (Object.keys(store.lists).length + 1)),
      main: [],
      red: []
    };
    persistStore();
    switchList(id);
  }

  function renameActiveList(name) {
    if (!name || !store.lists[store.activeId]) return;
    store.lists[store.activeId].name = name;
    persistStore();
    updateListSelect();
  }

  function deleteActiveList() {
    const ids = Object.keys(store.lists);
    if (ids.length <= 1) return;
    if (!confirm('Delete hotlist "' + store.lists[store.activeId].name + '"?')) return;
    const doomed = store.activeId;
    delete store.lists[doomed];
    for (const [k, v] of Object.entries(store.presetMap || {})) {
      if (v === doomed) delete store.presetMap[k];
    }
    store.activeId = Object.keys(store.lists)[0];
    loadActiveIntoSets();
    persistStore();
    reapplyAll();
    renderAll();
  }

  function normalizePresetKey(key) {
    return String(key || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_');
  }

  function bindPreset(presetKey) {
    if (!presetKey || !store) return;
    if (!store.presetMap) store.presetMap = {};
    const raw = String(presetKey).trim();
    const norm = normalizePresetKey(raw);
    // store under several forms so apply can find it
    store.presetMap[raw] = store.activeId;
    store.presetMap[norm] = store.activeId;
    if (raw !== raw.replace(/\s+/g, '_')) {
      store.presetMap[raw.replace(/\s+/g, '_')] = store.activeId;
    }
    persistStore();
    updatePresetBindLabel();
  }

  function applyPresetBinding(presetKey) {
    if (!presetKey || !store || !store.presetMap) return;
    const raw = String(presetKey).trim();
    const norm = normalizePresetKey(raw);
    const candidates = [raw, norm, raw.replace(/\s+/g, '_'), raw.replace(/_/g, ' ')];

    let listId = null;
    for (const c of candidates) {
      if (store.presetMap[c]) {
        listId = store.presetMap[c];
        break;
      }
    }
    // last resort: case-insensitive scan of map keys
    if (!listId) {
      for (const [k, id] of Object.entries(store.presetMap)) {
        if (normalizePresetKey(k) === norm) {
          listId = id;
          break;
        }
      }
    }
    if (listId && store.lists[listId] && listId !== store.activeId) {
      switchList(listId);
    }
  }

  function saveEnabled() {
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    } catch (e) {}
  }

  function isExact(val) {
    return val.startsWith('"') && val.endsWith('"') && val.length > 2;
  }

  function unwrap(val) {
    return isExact(val) ? val.slice(1, -1) : val;
  }

  function wrap(val) {
    return `"${val}"`;
  }

  function rebuildLists() {
    mainList = [];
    mainExact = [];
    redList = [];
    redExact = [];
    for (const val of mainSet) {
      (isExact(val) ? mainExact : mainList).push(unwrap(val));
    }
    for (const val of redSet) {
      (isExact(val) ? redExact : redList).push(unwrap(val));
    }
    mainList.sort((a, b) => b.length - a.length);
    redList.sort((a, b) => b.length - a.length);
    settingsVersion++;
  }

  function commit() {
    persistStore();
    rebuildLists();
    reapplyAll();
  }

  // Case-insensitive substring search; ranges map onto the original string
  function findSubstringRanges(text, needles) {
    const ranges = [];
    const lower = text.toLowerCase();
    for (const needle of needles) {
      if (!needle) continue;
      const n = needle.toLowerCase();
      let idx = lower.indexOf(n);
      while (idx !== -1) {
        ranges.push([idx, idx + needle.length]);
        idx = lower.indexOf(n, idx + 1);
      }
    }
    return ranges;
  }

  // Whole-word match, case-insensitive
  function findExactRanges(text, words) {
    const lower = text.toLowerCase();
    for (const word of words) {
      if (lower === String(word).toLowerCase()) return [[0, text.length]];
    }
    return [];
  }

  function practiceListNameForActive() {
    const name = (store && store.lists[store.activeId] && store.lists[store.activeId].name) || 'default';
    return String(name).trim() + ' custom list';
  }

  function isQuoteMode() {
    try {
      const notice = document.getElementById('testModesNotice');
      if (notice && /quote/i.test(notice.textContent || '')) return true;
      const raw = localStorage.getItem('config');
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg && cfg.mode === 'quote') return true;
      }
    } catch (e) {}
    return false;
  }

  // Monkeytype stores saved customs here:
  //   localStorage["customText"] = { "graphite custom list": "word1 word2", ... }
  function readCustomTextObject() {
    try {
      return JSON.parse(localStorage.getItem('customText') || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function uniqueWordsFromText(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const seen = new Set();
    const out = [];
    for (const w of text.split(/\s+/)) {
      if (!w) continue;
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  }

  /**
   * Add one triggered quote word to the active hotlist's custom text.
   * Always re-reads localStorage first so deletions in Monkeytype UI stick.
   * Each word is stored once (case-insensitive).
   */
  function addTriggeredWord(word) {
    if (!word || !enabled) return;
    if (!isQuoteMode()) return;
    if (!store || !store.activeId) return;

    const cleaned = String(word).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!cleaned) return;
    const key = cleaned.toLowerCase();

    try {
      const obj = readCustomTextObject();
      const listName = practiceListNameForActive();
      const words = uniqueWordsFromText(obj[listName] || '');
      if (words.includes(key)) return;
      words.push(key);
      obj[listName] = words.join(' ');
      localStorage.setItem('customText', JSON.stringify(obj));
    } catch (e) {}
  }

  function loadPracticeWordsFromLS() {
    // localStorage is the only source of truth — nothing to cache
  }

  function mergeRanges(ranges) {
    if (ranges.length <= 1) return ranges;
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      const cur = ranges[i];
      if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
      else merged.push(cur);
    }
    return merged;
  }

  function getLetters(wordEl) {
    let cached = lettersCache.get(wordEl);
    if (cached) return cached;
    const arr = Array.from(wordEl.getElementsByTagName('letter'));
    lettersCache.set(wordEl, arr);
    return arr;
  }

  // Original prompt letters only — never Monkeytype "extra" (overtyped) letters
  function getOriginalLetters(wordEl) {
    return Array.from(wordEl.querySelectorAll('letter:not(.extra)'));
  }

  function getOriginalWordText(wordEl) {
    return getOriginalLetters(wordEl).map((l) => l.textContent || '').join('');
  }

  function applyHighlights(letters, ranges, mark) {
    const len = letters.length;
    for (const [start, end] of ranges) {
      for (let i = Math.max(0, start); i < Math.min(end, len); i++) {
        letters[i].dataset.hotlist = mark;
      }
    }
  }

  function processWord(el) {
    const version = String(settingsVersion);

    // Always evaluate against the original word, not typed extras
    const word = getOriginalWordText(el);
    const letters = getOriginalLetters(el);

    if (el.dataset.hotlistDirty === '1') {
      delete el.dataset.hotlistDirty;
    } else {
      if (el.dataset.hotlistV === version && el.dataset.hotlistW === word) return;
    }

    // Clear marks on all letters including extras
    for (const letter of getLetters(el)) delete letter.dataset.hotlist;

    if (!letters.length) {
      el.dataset.hotlistV = version;
      el.dataset.hotlistW = word;
      return;
    }

    if (!enabled) {
      el.dataset.hotlistV = version;
      el.dataset.hotlistW = word;
      return;
    }

    const mainRanges = [
      ...findExactRanges(word, mainExact),
      ...findSubstringRanges(word, mainList)
    ];

    if (mainRanges.length) {
      applyHighlights(letters, mergeRanges(mainRanges), 'main');
      addTriggeredWord(word);
      el.dataset.hotlistV = version;
      el.dataset.hotlistW = word;
      return;
    }

    const redRanges = [
      ...findExactRanges(word, redExact),
      ...findSubstringRanges(word, redList)
    ];

    if (redRanges.length) {
      applyHighlights(letters, mergeRanges(redRanges), 'red');
      addTriggeredWord(word);
    }

    el.dataset.hotlistV = version;
    el.dataset.hotlistW = word;
  }

  function flush() {
    flushScheduled = false;
    for (const el of pending) processWord(el);
    pending.clear();
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flush);
  }

  function markDirty(wordEl) {
    wordEl.dataset.hotlistDirty = '1';
    pending.add(wordEl);
  }

  function reapplyAll() {
    const words = document.getElementsByClassName('word');
    for (const word of words) markDirty(word);
    if (pending.size) scheduleFlush();
  }

  function renderChips(container, set, countEl) {
    if (!container || !countEl) return;
    container.textContent = '';
    countEl.textContent = String(set.size);
    for (const val of set) {
      const chip = document.createElement('div');
      chip.className = 'hotlistChip';
      const display = unwrap(val);
      const badge = isExact(val) ? '<span class="exactBadge">[exact]</span>' : '';
      chip.innerHTML = `<i class="fas fa-times fa-fw"></i><span>${display}</span>${badge}`;
      chip.title = 'Click to remove';
      chip.onclick = () => {
        set.delete(val);
        commit();
        renderAll();
      };
      container.appendChild(chip);
    }
  }

  function updateListSelect() {
    const sel = document.getElementById('hotlistListSelect');
    if (!sel || !store) return;
    sel.innerHTML = '';
    for (const [id, list] of Object.entries(store.lists)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = list.name;
      if (id === store.activeId) opt.selected = true;
      sel.appendChild(opt);
    }
    updatePresetBindLabel();
  }

  function updatePresetBindLabel() {
    const el = document.getElementById('hotlistPresetBind');
    if (!el || !store) return;
    const bound = Object.entries(store.presetMap || {})
      .filter(([, id]) => id === store.activeId)
      .map(([k]) => k);
    el.textContent = bound.length
      ? 'Bound to: ' + bound.join(', ')
      : 'Not bound to any preset yet';
  }

  function renderAll() {
    const chips = document.getElementById('hotlistChips');
    const redChips = document.getElementById('redHotlistChips');
    if (!chips || !redChips) return;
    renderChips(chips, mainSet, document.getElementById('hotlistCount'));
    renderChips(redChips, redSet, document.getElementById('redHotlistCount'));
    updateListSelect();
  }

  function updateToggleButtons() {
    const offBtn = document.getElementById('hotlistOffBtn');
    const onBtn = document.getElementById('hotlistOnBtn');
    if (!offBtn || !onBtn) return;
    offBtn.classList.toggle('active', !enabled);
    onBtn.classList.toggle('active', enabled);
  }

  function setEnabled(val) {
    enabled = val;
    saveEnabled();
    settingsVersion++;
    updateToggleButtons();
    reapplyAll();
  }

  function addItem(input, set, exactToggle) {
    let val = input.value.trim();
    if (!val) return;
    if (exactToggle.classList.contains('active')) val = wrap(val);
    set.add(val);
    input.value = '';
    commit();
    renderAll();
  }

  function clearList(set) {
    if (!set.size) return;
    set.clear();
    commit();
    renderAll();
  }

  function createMenu() {
    const hotlistId = 'mtHotlistMenu';
    if (document.getElementById(hotlistId)) return;

    const sections = document.getElementById('group_behavior');
    if (!sections) return;

    const container = document.createElement('div');
    container.className = 'section hotlist fullWidth';
    container.id = hotlistId;
    container.innerHTML = `
      <div class="groupTitle">
        <i class="fas fa-highlighter"></i> <span>hotlist</span>
      </div>
      <div class="text">
        Multiple word lists with preset binding. Original by <b>poem#3305</b>.<br>
        <span style="opacity: 0.7">
          Create separate lists (e.g. per layout). Matching is case-insensitive.
          During <b>quote</b> tests, triggered words are saved to a custom text named
          after the active list (e.g. <b>graphite custom list</b>).
        </span>
      </div>
      <div class="buttons">
        <button id="hotlistOffBtn" type="button">off</button>
        <button id="hotlistOnBtn" type="button">on</button>
      </div>
      <div class="hotlistContent">
        <div class="hotlistListBar">
          <select id="hotlistListSelect" title="Active hotlist"></select>
          <button id="hotlistNewBtn" type="button">new</button>
          <button id="hotlistRenameBtn" type="button">rename</button>
          <button id="hotlistDeleteBtn" type="button">delete</button>
          <button id="hotlistBindBtn" type="button" title="Bind active list to a preset name">bind preset</button>
          <span id="hotlistPresetBind" class="presetBind"></span>
        </div>
        <div class="hotlistColumns">
          <div class="hotlistColumn">
            <div class="hotlistMetaRow">
              <div class="left"><span class="swatch"></span><span>main list</span></div>
              <div class="right">
                <span class="count"><span id="hotlistCount">0</span> items</span>
                <span id="hotlistClear" class="clearBtn" title="Clear all">clear</span>
              </div>
            </div>
            <div class="hotlistAddRow">
              <input id="hotlistAddInput" class="input" type="text" spellcheck="false" placeholder="Add item… (Enter)" autocomplete="off">
              <button id="hotlistExactToggle" class="exactToggle" type="button" tabindex="0">exact</button>
              <button id="hotlistAddButton" type="button" tabindex="0"><i class="fas fa-plus"></i></button>
            </div>
            <div id="hotlistChips" class="hotlistChips"></div>
          </div>
          <div class="hotlistColumn">
            <div class="hotlistMetaRow">
              <div class="left"><span class="swatch red"></span><span>red list</span></div>
              <div class="right">
                <span class="count"><span id="redHotlistCount">0</span> items</span>
                <span id="redHotlistClear" class="clearBtn" title="Clear all">clear</span>
              </div>
            </div>
            <div class="hotlistAddRow">
              <input id="redHotlistAddInput" class="input" type="text" spellcheck="false" placeholder="Add item… (Enter)" autocomplete="off">
              <button id="redHotlistExactToggle" class="exactToggle" type="button" tabindex="0">exact</button>
              <button id="redHotlistAddButton" type="button" tabindex="0"><i class="fas fa-plus"></i></button>
            </div>
            <div id="redHotlistChips" class="hotlistChips"></div>
          </div>
        </div>
      </div>
    `;

    sections.prepend(container);

    const mainInput = document.getElementById('hotlistAddInput');
    const redInput = document.getElementById('redHotlistAddInput');
    const mainExactToggle = document.getElementById('hotlistExactToggle');
    const redExactToggle = document.getElementById('redHotlistExactToggle');

    mainExactToggle.onclick = () => mainExactToggle.classList.toggle('active');
    redExactToggle.onclick = () => redExactToggle.classList.toggle('active');

    document.getElementById('hotlistAddButton').onclick = () => addItem(mainInput, mainSet, mainExactToggle);
    document.getElementById('redHotlistAddButton').onclick = () => addItem(redInput, redSet, redExactToggle);
    document.getElementById('hotlistClear').onclick = () => clearList(mainSet);
    document.getElementById('redHotlistClear').onclick = () => clearList(redSet);
    document.getElementById('hotlistOffBtn').onclick = () => setEnabled(false);
    document.getElementById('hotlistOnBtn').onclick = () => setEnabled(true);

    document.getElementById('hotlistListSelect').onchange = (e) => switchList(e.target.value);
    document.getElementById('hotlistNewBtn').onclick = () => {
      const name = prompt('Name for new hotlist:', 'List ' + (Object.keys(store.lists).length + 1));
      if (name) createList(name.trim());
    };
    document.getElementById('hotlistRenameBtn').onclick = () => {
      const cur = store.lists[store.activeId]?.name || '';
      const name = prompt('Rename hotlist:', cur);
      if (name && name.trim()) renameActiveList(name.trim());
    };
    document.getElementById('hotlistDeleteBtn').onclick = () => deleteActiveList();
    document.getElementById('hotlistBindBtn').onclick = () => {
      const name = prompt(
        'Bind current hotlist to this preset name (exact name):',
        lastPresetName || ''
      );
      if (name && name.trim()) {
        bindPreset(name.trim());
        lastPresetName = name.trim();
      }
    };

    mainInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem(mainInput, mainSet, mainExactToggle);
      }
    });
    redInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem(redInput, redSet, redExactToggle);
      }
    });

    updateToggleButtons();
    renderAll();
  }

  let inSubmenu = false;

  function createCommandItem(id, icon, label) {
    const div = document.createElement('div');
    div.className = 'command';
    div.dataset.commandId = id;
    div.innerHTML = `<div class="icon"><i class="fas fa-fw ${icon}"></i></div><div>${label}</div>`;
    return div;
  }

  function setupHoverManagement(suggestions) {
    if (suggestions.dataset.hotlistBound) return;
    suggestions.dataset.hotlistBound = '1';
    suggestions.classList.add('hotlist-managed');

    suggestions.addEventListener('mouseover', (e) => {
      const cmd = e.target.closest('.command');
      if (!cmd) return;
      suggestions.querySelectorAll('.command').forEach((c) => c.classList.remove('active', 'hotlist-hover'));
      cmd.classList.add('hotlist-hover');
    });

    suggestions.addEventListener('mouseleave', () => {
      suggestions.querySelectorAll('.command').forEach((c) => c.classList.remove('active', 'hotlist-hover'));
    });
  }

  function clearNativeActive(suggestions) {
    suggestions.querySelectorAll('.command').forEach((c) => c.classList.remove('active'));
  }

  function injectCommandlineItem(suggestions) {
    const existing = suggestions.querySelector(`[data-command-id="${COMMAND_ID}"]`);
    if (existing) return;

    const commands = Array.from(suggestions.querySelectorAll('.command'));
    if (commands.length < 7) return;

    const item = createCommandItem(COMMAND_ID, 'fa-highlighter', 'Hotlist...');
    item.dataset.index = '7';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      showHotlistSubmenu(suggestions);
    });

    const refNode = commands[7] || null;
    suggestions.insertBefore(item, refNode);
    commands.slice(7).forEach((cmd, i) => {
      cmd.dataset.index = String(i + 8);
    });

    setupHoverManagement(suggestions);
    clearNativeActive(suggestions);
  }

  function updateSubmenuState(suggestions) {
    const offItem = suggestions.querySelector(`[data-command-id="${COMMAND_ID_OFF}"]`);
    const onItem = suggestions.querySelector(`[data-command-id="${COMMAND_ID_ON}"]`);
    if (offItem) offItem.querySelector('.icon i').className = `fas fa-fw ${enabled ? '' : 'fa-check'}`;
    if (onItem) onItem.querySelector('.icon i').className = `fas fa-fw ${enabled ? 'fa-check' : ''}`;
  }

  function showHotlistSubmenu(suggestions) {
    const modal = suggestions.closest('.modal');
    if (!modal) return;

    inSubmenu = true;

    const input = modal.querySelector('input.input');
    if (input) {
      input.placeholder = 'Hotlist...';
      input.value = '';
    }

    suggestions.textContent = '';
    delete suggestions.dataset.hotlistBound;
    setupHoverManagement(suggestions);

    const offItem = createCommandItem(COMMAND_ID_OFF, enabled ? '' : 'fa-check', 'off');
    const onItem = createCommandItem(COMMAND_ID_ON, enabled ? 'fa-check' : '', 'on');
    offItem.dataset.index = '0';
    onItem.dataset.index = '1';

    offItem.addEventListener('click', (e) => {
      e.stopPropagation();
      setEnabled(false);
      updateSubmenuState(suggestions);
    });
    onItem.addEventListener('click', (e) => {
      e.stopPropagation();
      setEnabled(true);
      updateSubmenuState(suggestions);
    });

    suggestions.appendChild(offItem);
    suggestions.appendChild(onItem);
  }

  function exitSubmenu() {
    inSubmenu = false;
    setTimeout(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      }));
    }, 0);
  }

  function handleCommandlineSearch() {
    const input = document.querySelector('#commandLine .input');
    const suggestions = document.querySelector('#commandLine .suggestions');
    if (!input || !suggestions) return;

    const query = input.value.toLowerCase().trim();
    if (!query) {
      injectCommandlineItem(suggestions);
      return;
    }
    if ('hotlist'.startsWith(query)) {
      let hotlistCmd = suggestions.querySelector(`[data-command-id="${COMMAND_ID}"]`);
      if (!hotlistCmd) {
        hotlistCmd = createCommandItem(COMMAND_ID, 'fa-highlighter', 'Hotlist...');
        hotlistCmd.addEventListener('click', (e) => {
          e.stopPropagation();
          showHotlistSubmenu(suggestions);
        });
      }
      suggestions.insertBefore(hotlistCmd, suggestions.firstChild);
      setupHoverManagement(suggestions);
      clearNativeActive(suggestions);
    }
  }

  // Detect preset apply from settings list or command line (bubble phase only)
  function isInsidePresetsSection(el) {
    let n = el;
    for (let i = 0; i < 12 && n; i++, n = n.parentElement) {
      const cls = (n.className && String(n.className)) || '';
      const id = n.id || '';
      const text = (n.getAttribute && n.getAttribute('aria-label')) || '';
      if (/preset/i.test(cls) || /preset/i.test(id) || /preset/i.test(text)) return true;
      // section heading nearby
      if (n.querySelector && n.querySelector('.title, .groupTitle, h1, h2')) {
        const heading = n.querySelector('.title, .groupTitle, h1, h2');
        if (heading && /preset/i.test(heading.textContent || '')) return true;
      }
    }
    // walk up looking for a sibling/parent that has "presets" label
    n = el;
    for (let i = 0; i < 15 && n; i++, n = n.parentElement) {
      if (/presets/i.test(n.textContent || '') && (n.textContent || '').length < 400) {
        // likely the presets group if short enough
        if (n.querySelector && n.querySelector('button')) return true;
      }
    }
    return false;
  }

  function extractPresetNameFromButton(btn) {
    if (!btn) return '';
    // Prefer data attributes
    const data =
      btn.getAttribute('data-preset-id') ||
      btn.getAttribute('data-id') ||
      btn.getAttribute('data-name') ||
      '';
    if (data && !/edit|delete|remove|save|update|add/i.test(data)) return data.trim();

    // Clone and strip icon-only children to get visible name
    const clone = btn.cloneNode(true);
    clone.querySelectorAll('i, svg, .icon, button').forEach((x) => x.remove());
    let name = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    // Ignore pure action buttons
    if (!name || /^(edit|delete|remove|save|update|add|add preset|\+|×|✕)$/i.test(name)) return '';
    return name;
  }

  document.addEventListener('click', (e) => {
    try {
      const t = e.target;
      if (!t || !t.closest) return;

      // Ignore pure icon action buttons (edit / delete)
      if (t.closest('button[aria-label*="edit" i], button[aria-label*="delete" i], .edit, .remove, .delete')) {
        // still allow if the main preset name was clicked via a parent — fall through carefully
        const aria = (t.closest('button')?.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('edit') || aria.includes('delete') || aria.includes('remove')) return;
      }

      // Command-line: applyPreset<id>
      const cmd = t.closest('.command[data-command-id]');
      if (cmd) {
        const cid = cmd.getAttribute('data-command-id') || '';
        if (cid.startsWith('applyPreset')) {
          const key = cid.replace(/^applyPreset/, '') || extractPresetNameFromButton(cmd);
          if (key) {
            lastPresetName = key;
            setTimeout(() => applyPresetBinding(key), 200);
          }
        }
        return;
      }

      const btn = t.closest('button, .button, [role="button"]');
      if (!btn) return;

      // Must look like a presets control
      if (!isInsidePresetsSection(btn) && !btn.closest('[data-preset-id], [class*="preset" i]')) {
        return;
      }

      // Skip trash/pencil-only buttons (no usable name)
      const name = extractPresetNameFromButton(btn);
      if (!name) return;

      lastPresetName = name;
      // Applying a preset = clicking its name row (not "add preset")
      if (/^add(\s+preset)?$/i.test(name)) return;

      setTimeout(() => applyPresetBinding(name), 200);
    } catch (err) {}
  });

  function handleMutation(m) {
    if (m.type === 'childList') {
      const target = m.target;

      if (target && target.nodeType === 1) {
        const wordEl = target.classList?.contains('word')
          ? target
          : target.closest?.('.word');

        if (wordEl) {
          lettersCache.delete(wordEl);
          markDirty(wordEl);
          return;
        }
      }

      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== 1) continue;

        // Toast: "Preset applied" → switch hotlist using last known preset name
        const nodeText = node.textContent || '';
        if (/preset applied/i.test(nodeText) && lastPresetName) {
          setTimeout(() => applyPresetBinding(lastPresetName), 50);
        }

        if (node.classList?.contains('word')) {
          markDirty(node);
          continue;
        }

        if (node.classList?.contains('pageSettings')) {
          createMenu();
          continue;
        }

        if (node.classList?.contains('modal')) {
          const suggestions = node.querySelector('.suggestions');
          if (suggestions) setTimeout(() => injectCommandlineItem(suggestions), 0);
          continue;
        }

        if (node.classList?.contains('suggestions')) {
          setTimeout(() => injectCommandlineItem(node), 0);
          continue;
        }

        const words = node.querySelectorAll?.('.word');
        if (words) {
          for (const word of words) markDirty(word);
        }

        const modal = node.querySelector?.('.modal');
        if (modal) {
          const suggestions = modal.querySelector('.suggestions');
          if (suggestions) setTimeout(() => injectCommandlineItem(suggestions), 0);
        }
      }
    }

    if (m.type === 'attributes' && m.attributeName === 'class') {
      const target = m.target;
      if (!target || target.nodeType !== 1) return;

      if (target.classList?.contains('word')) {
        markDirty(target);
      } else if (target.tagName === 'LETTER') {
        const word = target.closest?.('.word');
        if (word) markDirty(word);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) handleMutation(m);
    if (pending.size) scheduleFlush();
  });

  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('#commandLine .input')) {
      if (inSubmenu) return;
      setTimeout(handleCommandlineSearch, 50);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inSubmenu) {
      e.stopImmediatePropagation();
      e.preventDefault();
      exitSubmenu();
    }
  }, true);

  loadStore();
  loadPracticeWordsFromLS();
  reapplyAll();

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  if (document.getElementById('group_behavior')) createMenu();

  window.addEventListener('beforeunload', () => {
    try { observer.disconnect(); } catch (e) {}
  });

  } catch (err) {
    console.error('[Hotlist Multi] init error', err);
  }
})();


/* ========== 4. KOKORO DICTATION ========== */
(function() {
    'use strict';

    const KOKORO_API_URL = 'http://localhost:8880/v1/audio/speech';

    let state = {
        enabled: localStorage.getItem('mt_dict_enabled') === 'true',
        bufferDistance: parseInt(localStorage.getItem('mt_dict_buffer')) || 15,
        chunkSize: parseInt(localStorage.getItem('mt_dict_chunk')) || 3,
        volume: parseFloat(localStorage.getItem('mt_dict_volume')) || 0.8,
        voice: localStorage.getItem('mt_dict_voice') || 'af_sarah',
        hotkey: localStorage.getItem('mt_dict_hotkey') || 'f',
        // Must match KOKORO_API_KEY in docker run. Same default is fine for everyone (local only).
        apiKey: localStorage.getItem('mt_dict_api_key') || 'monkeytypeuser',

        audioQueue: [],
        isPlaying: false,
        currentAudio: null,
        nextChunkSeq: 0,
        nextPlaySeq: 0,
        pendingAudio: new Map()
    };

    const style = document.createElement('style');
    style.id = 'mt-dictation-styles';
    document.head.appendChild(style);

    function updateVisuals() {
        if (state.enabled) {
            style.innerHTML = `
                /* Pure CSS rule: Hide all letters inside active test word wrappers natively */
                #words .word letter {
                    opacity: 0 !important;
                    transition: opacity 0.05s ease !important;
                }
                /* Instantly unmask individual letters as you hit them on your keyboard */
                #words .word letter.correct,
                #words .word letter.incorrect,
                #words .word letter.extra {
                    opacity: 1 !important;
                    visibility: visible !important;
                }
                #words .word letter.incorrect {
                    color: var(--error-color, #da3333) !important;
                }
                #words .word.reveal-assist letter {
                    opacity: 0.4 !important;
                }
            `;
        } else {
            style.innerHTML = '';
        }
    }

    function fetchAndPlayAudio(textToSpeak, clearQueue = false) {
        if (clearQueue) stopAllAudio();
        const cleanText = textToSpeak.trim();
        if (!cleanText) return;

        const seq = state.nextChunkSeq++;
        console.log(`[Dictation Engine] Requesting chunk #${seq}: "${cleanText}"`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: KOKORO_API_URL,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (state.apiKey || 'monkeytypeuser')
            },
            data: JSON.stringify({
                model: 'kokoro',
                input: cleanText,
                voice: state.voice,
                speed: 1.0
            }),
            responseType: 'blob',
            onload: function(response) {
                if (response.status !== 200) return;
                const audio = new Audio(URL.createObjectURL(response.response));
                audio.volume = state.volume;
                state.pendingAudio.set(seq, audio);
                tryAdvanceAudioQueue();
            }
        });
    }
    function tryAdvanceAudioQueue() {
        while (state.pendingAudio.has(state.nextPlaySeq)) {
            state.audioQueue.push(state.pendingAudio.get(state.nextPlaySeq));
            state.pendingAudio.delete(state.nextPlaySeq);
            state.nextPlaySeq++;
        }
        if (!state.isPlaying) playNextInQueue();
    }

    function playNextInQueue() {
        if (state.audioQueue.length === 0) {
            state.isPlaying = false;
            return;
        }
        state.isPlaying = true;
        const audio = state.audioQueue.shift();
        state.currentAudio = audio;
        audio.onended = playNextInQueue;
        audio.volume = state.volume;
        audio.play().catch(() => {
            state.audioQueue.unshift(audio);
            state.currentAudio = null;
            state.isPlaying = false;
        });
    }

    function stopAllAudio() {
        if (state.currentAudio) {
            state.currentAudio.pause();
            state.currentAudio = null;
        }
        state.audioQueue = [];
        state.isPlaying = false;
        state.pendingAudio.clear();
        state.nextChunkSeq = 0;
        state.nextPlaySeq = 0;
    }

    function processTypingPacing() {
        if (!state.enabled) return;

        // CRITICAL FIX: Restrict elements purely to typing container to avoid trailing page cache additions
        const wordsEls = Array.from(document.querySelectorAll('#words .word'));
        if (wordsEls.length === 0) return;

        // RESULTS GUARD FIX: Safely halt processing if the test ends and active cursor disappears
        const activeWordEl = document.querySelector('#words .word.active');
        if (!activeWordEl) {
            stopAllAudio();
            return;
        }

        const activeIdx = wordsEls.indexOf(activeWordEl);
        if (activeIdx === -1) return;

        const typedLen = activeWordEl.querySelectorAll('letter.correct, letter.incorrect').length;
        let charsAhead = Math.max(0, activeWordEl.textContent.length - typedLen);
        let firstUnspokenIdx = -1;

        for (let i = activeIdx + 1; i < wordsEls.length; i++) {
            if (wordsEls[i].dataset.spoken === "true") {
                charsAhead += wordsEls[i].textContent.length + 1;
            } else {
                firstUnspokenIdx = i;
                break;
            }
        }

        if (activeIdx === 0 && !activeWordEl.dataset.spoken) {
            firstUnspokenIdx = 0;
            charsAhead = 0;
        }

        if (charsAhead <= state.bufferDistance && firstUnspokenIdx !== -1) {
            const endIdx = Math.min(firstUnspokenIdx + state.chunkSize, wordsEls.length);
            const chunkEls = wordsEls.slice(firstUnspokenIdx, endIdx);

            if (chunkEls.length > 0) {
                chunkEls.forEach(w => w.dataset.spoken = "true");
                fetchAndPlayAudio(chunkEls.map(w => w.textContent).join(' '));
            }
        }
    }

    let domWatcher = new MutationObserver((mutations) => {
        if (!state.enabled) return;
        for (let mutation of mutations) {
            if (mutation.type === 'childList' || (mutation.type === 'attributes' && mutation.attributeName === 'class')) {
                processTypingPacing();
                break;
            }
        }
    });
    function setupLiveInputListeners() {
        const wordsContainer = document.getElementById('words');
        if (wordsContainer) {
            domWatcher.observe(wordsContainer, { attributes: true, childList: true, subtree: true, attributeFilter: ['class'] });
        }
        const inputField = document.getElementById('wordsInput');
        if (inputField) {
            inputField.removeEventListener('input', processTypingPacing);
            inputField.addEventListener('input', processTypingPacing);
        }
    }

    window.addEventListener('keydown', function(e) {
        if (!state.enabled) return;

        if (e.key === 'Backspace') {
            const activeWordEl = document.querySelector('#words .word.active');
            if (activeWordEl) {
                activeWordEl.classList.add('reveal-assist');
                setTimeout(() => activeWordEl.classList.remove('reveal-assist'), 1200);
            }
        }

        if (e.ctrlKey && e.key.toLowerCase() === state.hotkey.toLowerCase()) {
            e.preventDefault();
            const wordsEls = Array.from(document.querySelectorAll('#words .word'));
            const activeWordEl = document.querySelector('#words .word.active');
            if (!activeWordEl) return;

            const activeIdx = wordsEls.indexOf(activeWordEl);
            if (activeIdx === -1) return;

            const endIdx = Math.min(activeIdx + state.chunkSize, wordsEls.length);
            const chunkEls = wordsEls.slice(activeIdx, endIdx);
            if (chunkEls.length > 0) {
                chunkEls.forEach(w => w.dataset.spoken = "true");
                fetchAndPlayAudio(chunkEls.map(w => w.textContent).join(' '), true);
            }
        }
    });

    function injectUIControls() {
        if (document.getElementById('mt-dictation-config-bar')) return;

        const textWrapper = document.getElementById('words') || document.getElementById('testContent');
        if (!textWrapper) return;

        const container = document.createElement('div');
        container.id = 'mt-dictation-config-bar';
        container.style = 'display:flex; align-items:center; justify-content:center; gap:14px; margin: 0 auto 12px auto; font-family:var(--font, sans-serif); font-size:0.82rem; color:var(--sub-color, #646669); width:100%; text-align:center; user-select:none;';

        container.addEventListener('mousedown', function(e) { e.stopPropagation(); }, true);
        container.addEventListener('click', function(e) { e.stopPropagation(); }, true);

        const checkboxLabel = document.createElement('label');
        checkboxLabel.style = 'display:flex; align-items:center; gap:4px; cursor:pointer; font-weight:bold; transition:0.2s;';
        checkboxLabel.innerHTML = `<input type="checkbox" id="mt-dict-toggle" ${state.enabled ? 'checked' : ''} style="accent-color:var(--main-color, #e2b714); cursor:pointer; width:13px; height:13px;"> 🎙️ Dictation`;

        const voiceLabel = document.createElement('label');
        voiceLabel.style = 'display:flex; align-items:center; gap:4px;';
        voiceLabel.innerHTML = `Voice: <select id="mt-dict-voice" style="background:var(--sub-alt-color, #2c2e31); color:var(--main-color, #e2b714); border:none; border-radius:4px; padding:3px 4px; font-weight:bold; outline:none; cursor:pointer; font-family:var(--font, sans-serif);">
            <option value="af_sarah" ${state.voice === 'af_sarah' ? 'selected' : ''}>🇺🇸 Sarah</option>
            <option value="af_bella" ${state.voice === 'af_bella' ? 'selected' : ''}>🇺🇸 Bella</option>
            <option value="af_sky" ${state.voice === 'af_sky' ? 'selected' : ''}>🇺🇸 Sky</option>
            <option value="am_adam" ${state.voice === 'am_adam' ? 'selected' : ''}>🇺🇸 Adam</option>
            <option value="am_michael" ${state.voice === 'am_michael' ? 'selected' : ''}>🇺🇸 Michael</option>
            <option value="bf_emma" ${state.voice === 'bf_emma' ? 'selected' : ''}>🇬🇧 Emma</option>
            <option value="bm_george" ${state.voice === 'bm_george' ? 'selected' : ''}>🇬🇧 George</option>
        </select>`;

        const dropdownLabel = document.createElement('label');
        dropdownLabel.style = 'display:flex; align-items:center; gap:4px;';
        let selectHtml = `Buffer (chars): <select id="mt-dict-buffer" style="background:var(--sub-alt-color, #2c2e31); color:var(--main-color, #e2b714); border:none; border-radius:4px; padding:3px 4px; font-weight:bold; outline:none; cursor:pointer; font-family:var(--font, sans-serif);">`;
        for (let i = 1; i <= 99; i++) { selectHtml += `<option value="${i}" ${state.bufferDistance === i ? 'selected' : ''}>${i}</option>`; }
        selectHtml += `</select>`;
        dropdownLabel.innerHTML = selectHtml;

        const chunkLabel = document.createElement('label');
        chunkLabel.style = 'display:flex; align-items:center; gap:4px;';
        let chunkHtml = `Chunk: <select id="mt-dict-chunk" style="background:var(--sub-alt-color, #2c2e31); color:var(--main-color, #e2b714); border:none; border-radius:4px; padding:3px 4px; font-weight:bold; outline:none; cursor:pointer; font-family:var(--font, sans-serif);">`;
        for (let i = 1; i <= 10; i++) { chunkHtml += `<option value="${i}" ${state.chunkSize === i ? 'selected' : ''}>${i} words</option>`; }
        chunkHtml += `</select>`;
        chunkLabel.innerHTML = chunkHtml;

        const keyLabel = document.createElement('label');
        keyLabel.style = 'display:flex; align-items:center; gap:4px;';
        keyLabel.innerHTML = `Repeat: Ctrl+<input type="text" id="mt-dict-hotkey" maxlength="1" value="${state.hotkey.toUpperCase()}" style="width:22px; text-align:center; text-transform:uppercase; background:var(--sub-alt-color, #2c2e31); color:var(--main-color, #e2b714); border:none; border-radius:4px; padding:3px 2px; font-weight:bold; outline:none; font-family:var(--font, sans-serif);">`;

        const volumeWrapper = document.createElement('div');
        volumeWrapper.id = 'mt-dict-volume-wrapper';
        volumeWrapper.style = `display:${state.enabled ? 'flex' : 'none'}; align-items:center; gap:4px; flex-wrap:wrap;`;
        volumeWrapper.innerHTML = `🔊 Vol: <input type="range" id="mt-dict-volume" min="0" max="1" step="0.05" value="${state.volume}" style="accent-color:var(--main-color, #e2b714); cursor:pointer; width:65px; height:4px; border-radius:2px;">` +
          ` API key: <input type="text" id="mt-dict-apikey" value="${String(state.apiKey || '').replace(/"/g, '&quot;')}" title="Must match KOKORO_API_KEY in docker run (local only — same default is fine for all users)" style="width:110px; background:var(--sub-alt-color, #2c2e31); color:var(--main-color, #e2b714); border:none; border-radius:4px; padding:3px 4px; font-weight:bold; outline:none; font-family:var(--font, sans-serif);">`;

        container.appendChild(checkboxLabel);
        container.appendChild(voiceLabel);
        container.appendChild(dropdownLabel);
        container.appendChild(chunkLabel);
        container.appendChild(keyLabel);
        container.appendChild(volumeWrapper);
        textWrapper.parentNode.insertBefore(container, textWrapper);

        document.getElementById('mt-dict-toggle').addEventListener('change', function(e) {
            state.enabled = e.target.checked;
            localStorage.setItem('mt_dict_enabled', state.enabled);
            checkboxLabel.style.color = state.enabled ? 'var(--main-color, #e2b714)' : 'var(--sub-color, #646669)';
            document.getElementById('mt-dict-volume-wrapper').style.display = state.enabled ? 'flex' : 'none';
            updateVisuals();
            if (!state.enabled) stopAllAudio();
        });

        document.getElementById('mt-dict-voice').addEventListener('change', function(e) {
            state.voice = e.target.value;
            localStorage.setItem('mt_dict_voice', state.voice);
        });

        setupControlsListeners();
    }

    function setupControlsListeners() {
        document.getElementById('mt-dict-buffer').addEventListener('change', function(e) {
            state.bufferDistance = parseInt(e.target.value);
            localStorage.setItem('mt_dict_buffer', state.bufferDistance);
        });

        document.getElementById('mt-dict-chunk').addEventListener('change', function(e) {
            state.chunkSize = parseInt(e.target.value);
            localStorage.setItem('mt_dict_chunk', state.chunkSize);
        });

        document.getElementById('mt-dict-hotkey').addEventListener('input', function(e) {
            const letter = e.target.value.replace(/[^a-zA-Z]/g, '').slice(-1);
            e.target.value = letter.toUpperCase();
            if (letter) {
                state.hotkey = letter.toLowerCase();
                localStorage.setItem('mt_dict_hotkey', state.hotkey);
            }
        });

        document.getElementById('mt-dict-volume').addEventListener('input', function(e) {
            state.volume = parseFloat(e.target.value);
            localStorage.setItem('mt_dict_volume', state.volume);
            if (state.currentAudio) state.currentAudio.volume = state.volume;
        });

        const apiKeyInput = document.getElementById('mt-dict-apikey');
        if (apiKeyInput) {
            apiKeyInput.addEventListener('change', function(e) {
                state.apiKey = (e.target.value || '').trim() || 'monkeytypeuser';
                localStorage.setItem('mt_dict_api_key', state.apiKey);
            });
            apiKeyInput.addEventListener('input', function(e) {
                state.apiKey = (e.target.value || '').trim();
            });
        }

        const cbLabel = document.querySelector('#mt-dictation-config-bar label');
        if (cbLabel) {
          cbLabel.style.color = state.enabled ? 'var(--main-color, #e2b714)' : 'var(--sub-color, #646669)';
        }
        updateVisuals();
    }

    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' || (e.key === 'Enter' && !document.activeElement.tagName.matches('INPUT|SELECT'))) {
            stopAllAudio();
            document.querySelectorAll('#words .word').forEach(w => w.removeAttribute('data-spoken'));
            setTimeout(processTypingPacing, 150);
        }
    });

    setInterval(() => {
        injectUIControls();
        setupLiveInputListeners();
    }, 250);
})();




/* ========== KEY CONFIDENCE + BEST WPM ========== */
(function () {
  'use strict';

  const STORAGE_CHARS = 'mt_keyconf_chars_v1';
  const STORAGE_INTERVALS = 'mt_keyconf_intervals_v1';
  const STORAGE_SETTINGS = 'mt_keyconf_settings_v1';
  const IDLE_MS = 10 * 60 * 1000; // 10 min — ignore only true AFK, not slow/correction typing
  const MIN_DIGRAPH_MS = 10;
  const MAX_DIGRAPH_MS = 800; // longer = pause, not a digraph for best/saved
  // Paste your Monkeytype ape key here to auto-save the "least confident" custom list:
  const APE_KEY = ''; // set via Archive panel only

  const BASE_CHARS =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + ' .,;:\'"!?-()[]{}@#$%^&*+=_/' + '\\|<>`~';

    const WORD_BANK_0 = "bouncy leftover zanily mendacity terrace provoked sicced justice ductile placement hor hoy easily hunky greegree lethal diactinic for sauteing aurum khamsin cracksmen hearten oppugn treadle gonorrhea rind strata grabbed adermin lithiases downrange hiphop prurient encage telic cosmism youthful baddest clop sincere schooling bellwether bacchius flatfoot polyphonic crowd overword hypogynous casuist pinpoint duodiode ruminator trustiness unreal fineable beefiness mesic ardor oogenesis saros audiometer mattress ruthful buttermilk buckeen inhabit crave graphemics premolar urea caudillo someway whosoever alienism jailer spinster arbalest acrogen dingy chime ganglia mutant cartoony coelentera sensate octameter anent pensioner finish temblor crayfish pear bolero amide soapy asserter whoopee ring etc crepitant educatee appellee thou horny performer drystone descant heatproof perilune spillage bricole accordance cinnabar foliolate legibly quiesce bumper chapping octachord deport eelgrass progenitor juridical anarchic endpaper overprice narial suppress nitric nutritious interj cardiac cowcatcher warlord outshone topicality isms blanch perishably satirist sorghum sensitives microbial bedeck littoral hereunto site molybdic immanence ethylate zoon neglectful flip alameda cash berkelium marshy alphosis navvy ayatollah matriarchs mews wholesaler culm scrouge orthoptic gastrotomy uniform hellbent pilewort epigenous dragger lamellar terapixel cinnamon limbo rapidness frenemy bletch volcano bankruptcy laterite slotted aphid filariases conchoid focused rhizopod sacristy autolysis startup livid setup scrubber workroom aeron excrement readership hajji dramatics forficate dogtrotted hangman scimitar festoon stringy thy starkness nitroso implosion swiz gatefold refutably glade apropos geophagy wallaroo apoptosis dactyl septime wad jocose expressway ostensible knockoff hastiness mallard slumlord trimmest hortatory consume arabesque plea moldiness metalize mitotic monocyclic tawdriness thrawn titter tufty soupy uropod shiatsu decrial carambola involution bobolink isatin dally quahog sprang stuffiness schismatic prefrontal schlepper naughty isopropyl fourteen telpher unitarily bracing sexless rototill hygrometer speciesist sleepover markka climb sin fiduciary vetchling convulsive shivahs crocodile layperson strategic abirritant hummable intestine capybara wont robotics subdeacon zygotene lawmaker splosh oquassa wherryman fatherland diocesan alveolus outputting spruceness filefish postwar celebrant switchgear loris visa glider sportsman noddy kipper groundsill nitpicker projectile uncial algarroba textbook boyhood woefullest benjamin fare backhouse textural chronology underwrote coneflower anaphora pinion caseworker impassable logger mailmen cumbrance assoil pager caduceus ergonomic amethyst framboise mini member nutriment calamine glycol poop recondite stolid secular woodcutter attendance termite matrilocal thirst dawn chetahs cactus monosome calculated gregarious lousily crab racist burry merganser jubbah jigsaw squad surd lumpfish powerboat putrefy cachou shmear obsecrate atomicity rapacity parsec skyward vivisector methinks subjacent mayo magma phys sneer fabricator fetidness aerometer idolum cum aftmost echelon deaf birdlime concoction furnace soph pogge seafood meathead bibelot polydipsic lamellate bayou buzz darksome blinder foresail joyance sect avidity elusion perusal saneness chasteness shortness koumis oblate trier garrison aphelian stasis diarrheic subjoinder divulge deniable spoilfive dope gardening formless amenity smugger copyedit sodomize catchfly sorb overheat diverge sexpot foresheet epanaphora leporine accordion coucal umlaut whooper cull foppery carpool simple garland dale chairwoman mikvot product roundheel dipetalous otiose inferior sapphism gallnut fiend circuit overlain measly intention histone stung entertain cyclopedia frabjous iterator bionically potmen mydriasis creepiness inbound novae introject hypotheses mettle drowning suspicion truthful shrinking soiled eyeshade cineraria interknit sporophyll asdic federalize bandy chalone patch trifurcate bestirring oodles seraphic overflow octet regarded staggering waffle kaiser add backside cantle muffin ogee modest turbid starveling solidary lexical whinchat dding radiation cricketeer horol tracer statutory chimpanzee abjuration equably bosom sodded rib gruesome sabulous labiovelar verbify rinse outbalance vow embus dopier kook turmeric capful comprise gloat wavy astrograph mountings feathery lopsided metalloid granadilla suffice dethrone jural starring afterdamp shamming master bullyrag gastronome ambroid graduator gigolo wellington rhubarb round foulness dices genetic papyrology underlinen hyetograph jugal citizen bracteate transitive cockshy revving thrilling divalent warhorse unifiable vermicide vermis coeternity heart paranoic homophony testaceous programmer flit breezeway impressure outride abbacy binnacle caper burlap digerati sepses school clubby skidway wickerwork definiens venery chiliarch pixillated polyamide hovel servitor ectogenous ascent brewery turbulent ovoidal amplitude ritardando scag matchmark rerunning simplism epigraphs hardcore blat mildewy caroler venal outboard reviler sialoid homilist blurb snowiness ingulf freebooter emcee filename panama turpentine steamboat aggro mammillae redbreast busily salutatory semantical wiglet burgle cecal ornithosis metrology cella hare splashdown locate somewhere successful sinusoidal betake bourbon creaseless villainous doubly sublimity threader cornstarch apparent wigged agronomy tel nothing prior epiboly detritus stinkweed pycnometer gaiety pit teller romanize wight winterkill abfarad terf phaeton abhorrence screen alfalfa yelp economize groggery thriller worm kummerbund noesis twigging gutsiness trebly transfix invaluable brutality plumose nose homesick immaculacy quadrantal taupe watchband raptor tachyon casuistry pentomic palikar ironical ninepin unusual ironhanded proslavery swankily wryness manner khedive tetanus ablation tyg scolecite fluoridate tensimeter sidereal rightness biramous hagiarchy egret hiking topog papism latke punishment ruthenious pyrogenic occupier origami rebel cycloid paraffinic damned orinasal betony detached bigwig recurvate crawly misadvize lately coquillage rosaniline eructate imagined shrink washtub lowercase junkie mylohyoid acidulent piquet enravish gauss classist trona geochemist recondense filature vendetta fen senatorial softa epileptoid specular segno treachery crass deuterium bloodied allomorphs origan rosaceous palliation agrapha alkaline neonate anoxemia egregious durance finitude nonsexual expansive valine crapshoot timberland caky cooee autotomize buoyage mammet omnivorous interpose goodwill overwrote cater corbicula nihility vegetation play drugged imminent trommel assessor stake forecaster abelmosk filmstrip perforated greenstone nudibranch flagship annoyance septum shanty fertilized electrode calypso kart polymerize dosh polysemy crinkle bifurcate motocross status iconically bot lowliness operculum tepefy adoration mothproof border hydatid taille demijohn bituminize interment clvii beef prune shutting prosit yahoo disulfiram colonic capreolate reparatory licensed tympani automat sickness chevre pref peripeteia sunlit maxilla wernerite lurid goatfish gallic bank prana catchpenny cavemen covey maddening steepen observing gibbet chenille empirical raffinate defective humiliate abigail gee bashing scabious multipart fuselage cochleae bumbler tribal motorist gyve courtship barbital harvester decentness diaphysis aerobatics bollix hand hospital bailment monotheism vehicle unseemly inviting blackout hurricane holocaust thrush overweigh snuffy nuclear tayra yarn rotund commend sabbaths axiomatic boracic principle dichloride cambrel tracheitis skive cymene fattiness rouleau troublous decompose strum beluga earthward gritty sightread buhrstone offended inventive specie singleton hone battement usher foreword curvetted redactor subteen goober duramen wavemeter elapse edibleness brill quag cheliform eidos trammed homogamy curule synthesize hubby zodiac logician ceasefire dais hunker complement indelibly scuff windtight abampere treetop monument memorable apparatus gamba amplify weeny exertion vexation operose broadax basque hallow but encaustic oryx glassless galaxy uranic rabidness shod binman configure bandwidth nailhead shabbily sublime saleswomen fusional thwack dissoluble villainy pedalo husbandmen banian primordium goo tammy thyroid wavelike autotype seismic rot turner cubical rickety fuggy woodsy among scroop malapert postcode oddball deathbed armlet vascular volute hydrastis reest blowgun hiding humor freehanded metalepsis deraign pointsman hysteroid broomcorn acetal officer comedienne logbook laughter noticeable ammonite empyema nearshore watchword corral passade vexatious horrid speculum pacific agnosia lurex blockage cruelty strabismus dimply harmless phage preconcert noontide broadside vantage raid calf purplish backward recency peninsular pondweed toughs captious sorority loosen rupture lipotropin blankbook overtook marchesa plainness chad sooty roundup uvea illiquid escapee mushroom billiards molybdous companion housing overclock atrophic shaft dysphagia odontology triathlon corrigenda eyecup redbud collective insnare mailbomb highborn arbitrator planchet chopped patronizer realize contagium sortieing oversweet marring wife christian arteriole relent rustily smalt gadwall toiler subsample fusible shophar healthily tights frigidity spodumene legislator tepee villus provable hep gunsmith gofer caracara bandleader deepness achene cutpurse couch eyrir bacillar navigate putrid mephitic baseboard franchiser octuple pyridine caterer selves tuba lutetium furbish roomful wateriness lectionary nasturtium versifier minimum hopper sickout gentleman orcinol dildoes quarantine parbuckle haricot pollinator chou bight submerse fallal lemures pyrolysis trinket rancher meerschaum singletree reimburse pya precook whirred anthotaxy albertype sural convergent pigged phasis inexorably confider coprolalia protonema mugger archimage slumming hieratic fuddle vespiary pushiness balalaika cringle blaubok warfarin faunistic autecology impiety dora canard reinflame matricidal keddah neritic bagel tutor autography assayer diversity carpark baldachin brevier epinasty hinny icecap werewolves portable unrobe gyral cordage lipoid tawny eyebolt tangram dormouse numinous fuzz converted liturgical overriding millwright blastula persuader skep inevitable uteri seawall rugged trichiasis loggia hank impart patella greeter oxidase optime dishware timestamp lase ferrous leukemia skidded miosis ventilator shyness fuchsia savings matricide bivouac artful gave kalsomine parody moiety joey wiriness hampered relucent funiculate ethnically xxxvi martini drumstick gypped glomming ruffianism pulpboard endodermis punitive jct shmooze reflective dangler necessary exsect afterword detoxicate cnemis substrate linoleum ascidian lowermost ostensory blazon sparkler creolized last supper scudded antrum candida bourse brickie contrast derma mercuric corporator karmic ministrant abstinence stockade offsetting mating pleura banlieue apostatize pliant passover paring escorted gonif epithelium shambles cataract parotitis essive lumberer keycard rule worship enlarger magnifier kishke parametric promodern publ quizzing navel hymnology trait radicand mac creepy erk vinasse nonferrous crapulent renovator found cortices tracheid naos andantino verbiage copolymer wily neoplastic pilch ridotto footsie caddis botanical costal peseta queenhood meal argot tumor trousseaux ataraxy held gusset replete tenesmus honeycomb phylloid unmoral staffing literal bioethical astrol opuntia airlike plutonium misspell robotic astigmia vagrom commodious unsling unlucky myrtaceous courteous tutorship microlight klutziness precancel expect glossitis bullfinch shinleaf quiddity dewy socman furosemide throbbed viburnum mantes jobber nastiness carbolize earnest antimasque fluviatile conundrum xylography aviarist pinafore cacography diazepam dastard ugliness scapegoat drupe cartel mayapple spiffily crucify floorboard gamelan diffract protanopia casing microcosm avowal purebred pliability buttonball amah coexistent sagebrush heavyish illation hookworm legatee numeric shred oxalate patina ultimo filament continence bromism septennial spandrel podagra gumption pluckless clodhopper lipidic caponize clachan simarouba murderer fanatic endways telophase simplicity misgovern patricidal waddle beware layette whup hying tunny literalize eulogize dilettante opahs easy ristra penmanship pictorial daub breadboard powder jealous overlarge longer nuke centralism bloomer auctioneer underpaid insanity subsidize examinant raffia nick titty unbent sovereign rotary fireless aversion mediacy tetrad panjandra yard penknife triptychs unrequited woodshed histoid clearness lancinate cutlet fleshpot viscoid activism beyond puppeteer narcoma sweatband rachitides gator hipster liveryman vagal dreggy unicameral bul antitype barterer sepia delaine shamefaced shredding unlovely lode handiwork siren medico clueless catalepsy jacinth meniscoid museology gluey piranha train aciniform tenno lutenist kokanee subduction objectify fleapit fruitcake toothpaste pwn hurtless whidah suppurate does exigence searching outta allocation curd detonation velour jactation patagium eulogist quine steadiness coffeecake rhinestone stud yule soakage monarchism dioecious wacky carolus blarney bogon fec quartern geometric ninon micron upstairs sanatory missy hoarseness balmy raggedness mapped aimless manage selfheal waft rampageous nipped monobasic polymer antivirus strop carouse dinghy mediated pokeberry cabby deathday hodmen seldom bottleful conjoint actress unorthodox baguio aphyllous upswing downer bridgehead calamondin scow gehlenite harness hulky grandmamma cannibal pastoral chinned axinomancy outwitting dissipator stopgap comfit sleety nobody lyrate ironclad dentition platyfish mudroom doper bevel howitzer plausive spiritism itch doubloon situation nettlesome tame empathetic windsurfer sororate amoebae turbojet extirpator torero creaminess stripe drat testcard kismet ribaldry voguish nepotistic dunnock clothespin literature shellback brazenness following disherison excipient bethought shrimp corpus mastodon moonfish associate repaint omissible echoes aga bipedal tufter consummate nephron legitimism derringer unspecific pulsator jug scandium gabbiness synonymity immerse yarmulke boracite keg muscleman expletive dustman nightmare skosh synthetic arbitral sacredness brass affliction umbilici daiquiri cingulum originate propagate certiorari hawsepiece feint abbreviate appoint hindbrain rondure sangfroid potentiate joke derriere write colorer kinkiness bestow mitt housetop buddhi connection windowless end oligoclase shrewmice horsecar fango covenantor kielbasa overbought lavishness worrywart drys betatron trivet lacuna helix lupulin worthwhile quintile jabber admin emblements alertness eyepiece slipper expressman regild procambium foyer hastily jigger payday tamis bypass enterprise fatigues centurial topiarist suberin fuzzy mincemeat dingoes subsoil governor niobic overslept overpass clangor lovegrass anaplasty seminarist vittles hoped millennium crick squill diwan woodpile outermost midlife forecourse sailmaker lightly algebra cresol brume chipmunk synoptic bestrode collimator widen exocrine whether resultant redistrict monographs vaulter swipple loaner messily vicegerent drumfire springe quickness garrulous peaceful misspoken foreshadow flux usance victualage tipple bargeman hermit gerund mediator ammonal univocal abnegate charily hysterics require bodega vase pentimento leach jigged autotroph carbamate otherness claret fetch lunular townswomen inundate needless formulator center coquina unemployed blog veniremen vaporizer messiahs bantam oligopoly feta nirvana stuntmen turnoff triad honeybee strangler peroneus firetrap headrace vivid extractor insularity corrosion thrive timberwork limpidness removable studhorse germicidal triolet supplejack snowboard thrumming massive lingo boxboard antecede jurist broider lamprey newsagent gar trapper rattle grimace withers apolitical barograph underdog purify osmometer aphasia airy babbitt faqir swipe hilarity tizz seeder cirri mangonel putty bidding tres hardcover playgoer vitriform suffocate mikvoth iffiness believe prisoner theosopher mortality cultic roadhouse nonscoring boatswain tical tusche ordinarily mistrial rowdily twp rent breadline sabot cordiality topless slain motorcycle vapid designator flippy thumbstall audit nuance literati winglet duckpin dispelled calaverite pinkie capably artsy molded nondrying stalky crib sanctify abaxial bldg switchman sprint thoron aerobics gatepost wiki expiratory reticle yappy premier jackleg obduracy teasing soymilk adjusted subheading priggish conglobate foal gap megaspore salubrity cagily pandit neuritis barbel cayenne verismo czarism kindle yardmaster hatemonger hominid pyrethrin ready meanness sonneteer nutwood lengthen corniness udder necrosis baksheesh lovesick shearer chop sextuple pilgrimage vizier conte earbud narcissist percuss slept risibly beautiful elegy washerman deterge myalgia aeroponics clearwing chalybite swagged loquat scrummage glitch pudgy depressing sizzle feeze polygamy betroth wholegrain easterly lumpy hennery postmodern politeness bootlace sermonize prissiness rogue enharmonic henge apologetic misogyny airglow brat spot quondam ralline aliunde clangorous wicket sixtieths reneger chickaree isochor testings lewdness chamois folkloric fantasy live homogenize cornflour firmware urogenous fiberboard upheave adoptive taphole bondmen hirundine trivia unobliging appreciate profuse ria resinate gladsome starred flambe petit putrescine torse cultivator sylphs detainment evillest topped grabby ahoy skyscraper repudiator enmeshment biotech readiness yuppify exocarp fauve pandowdy assuage snivel dormant boned caruncular cacodemon menarche gummed saguaro augite setback finely dulcify rich banknote darkle internment plainsmen purulent nummary bandsmen hodgepodge stedfast calamity klystron vaginate swing sortie rendition launcher epic nightfall ferriage blastocoel gazehound gag justle voodoo sandwich evildoing nubility anteroom humbly backspace humongous traducer largish tertial alder acrimony mastermind flashing plosive croakily orphan cadelle unhygienic fetiparous stetson urceolate boneblack flatfeet terpene monachal degeneracy scorbutic juggins seditious cymbiform connatural upcoming chinaware scoffer binary leverage muesli achieve diffident pyrolytic planarity stolidity onanism inveigle outspread iron huckster narration pasturage xviii timetable engaged kittycat sulfonate sunless overstrain gulfweed maggot keef fauteuil feather stratiform marked detrusion tholos sixteenths symphonia succulency coddle intensity audacious guereza adorn megohm workaday souter turntable telephony stargaze airplane tread bendy perigon concealed raspy jig illaudable rackety befuddle bailsman craze goldsmith erotic funeral ectoblast chlorous fructose fatuitous spree petrog magic hurried dicentra skit mobile biopic necklace ignoble piquant parabolic erg mushiness pithless headword icepack earthwork lathi prismoid leapfrog dunlin sci escheat escharotic entrepot inheritrix achromatic fabricate bag margarite dentin amoeba brierwood epicycloid ambrosia stablemate paleoliths logged shipowner jenny diminuendo sturdily vinculum prepayment zappy alkanet digging staleness colpotomy fusspot liberalize jabbing orthogonal leadership phyllome tingle scruff amok fanatical declared overshine bushily buss veto sputnik karakul intrepid soul smaragd cellblock phototype reline chinch highboy rebuttable tarsus cupful pull ascariasis niobous deepfroze schizont bazar fungistat sensorium pyromanic refix herbicidal epistle innermost nary dinned sucrase redeemer charlatan yeahs suncream jersey elaborate phonemic footbridge ethnologic subgenre nonlethal obligati banning orthoscope infrared divestment gynecic ineptness hydrastine enchorial dragonhead bally eliminate extrema grating ramose libel taiga flimsily impression blastomere covalent technical salvia outcropped weathering zestful tinsmith brunt carter hyaline memoir sonants erogenic overborne getter downtrend purloin hindrance boaster raven slumber devour hardhack disruptor multicolor hospodar lapillus brusquerie towhead pineta outlay bracer latter lyrist cartelize fall roadie teacloth statesman pungy piosity bugger kentledge smokiness towrope kenned knapsack amidase leafage progress alcazar cosigner newlywed infamous fibulae wonderment invasive engraver wordplay unbroken overseer caudate nasality recap gypsyish lymph prepositor mulligrubs tortious cytoplasm footprint katabolism speechless telemetry aphasiac xenolith suntrap facedown hazelnut nematic stridency rainstorm footrope palmette logarithm unshroud methadone tablespoon structural dispirit washer tympanites solace dexterous cosmogony incidence much allotter funereal anomalism wolver serial sidetrack stemmata burka dodgem fatigable trainman malingerer aposematic matelote sheetlike unify granola temperance sanative parting thiourea super subvent abdicator coleoptile catafalque vaticide rhodolite rapist reconduct pretrial ancestry ability semilunar engr leeway litigator groundwork passersby splendrous dismal pleasure settable calculable spurn rollway commutual pledgee finochio dibucaine joker grandiose hornbill ungainly multifold grinder clubhaul barbie hijacker mastic jetted indigoid poetry footing sharper pentaprism sulfatize outshoot staminate fermi brokerage tombolo unroot froe knot poll skiable heather atticism sheeny verdure bezel reopen pockmark eaglestone foliate stint superblock occas reportage unsociable monde cooperage nympha rile diclinous transfuse skepful payee bail pareira pepper endothelia shitted rennin alternator incensory stipe lampoonist permeation warsle timeworn around partly eloquent dogging slutty unwell gamp exsert ratite scarce flyleaf manganese afternoon tempering swansong correction nag crosshatch blearily triparted discophile valet pleader strip enswathe obloquious caput touch enabler acronym porosity indirect gobsmacked panjandrum monoclonal clavichord hypnotic childcare digitize cavalcade convalesce adenovirus outroar mortise deacon anerobic haul auscultate clupeid overshot tamp columbine intact wooer gabelle thankless palisade spheroidal wrought preach bueno waylaid draconian aureus baddie forced epitomist warmed likelihood dolorous primness cosign pathogen explant pili immodest waster stumbling planeload prattler finiteness enosis tumescent demur rimple scorch cinque chauffer soluble decoupage synoptical ogival woorali argon jetliner forty yellowness graphs fico intoxicate paddlefish morphing nephritis lacunal crassitude horologic impeccable scout haughty polyhedron hammertoe haphazard chg amphoteric basswood hadith octal ghost combine antipasti misorient hematology polyvinyl hag standfast overdid twelvefold unamused jangly dulcinea liable befogged believable rounce idolatress fashioner seadog snorer chetah posturing cloak podiatric fasciate baster organismic induce single signet sheaf inoculator frizette matcher parhelia weasel showoff meteor cellobiose bield continuous syngamy insalivate tic pinyin pseudy potoroo woolfell pustular attempted beseeching heparin outfoot follicular chevrette prosecutor unthread temporary seatbelt pfennig crop epsilon haunt cleft outbreak chert bargainer sulkiness analects germinate midi shorthorn savoy spake squireen colloquies critter octroi tagging misprint alveolate materiel fibroid whistler speleology rowdyish ideal noel vigilante twitch rondo cantonal slanginess ambrotype odea jurat wageworker toadfish exsiccate halfcocked vanward crossbred quinsy tugged millionth parton astrict greyhound pennon tolan ditherer hornbeam fullerene bonesetter outright barouche pitta excuse deceiving furcate similitude greybeard louver creakily semiotics paramount turgent rightful gentilesse pardner blitz indocile hypnotism perhaps lulu bias scarab cobble rebirth rutabaga undersexed meat telegenic rancidness demicanton whiffet perfective enclose excavator conclusion tautomer mass prepackage cytosine cabana divinatory lancelet candytuft coldish rescreen gabbed saltworks euclidean pasteboard coplanar bantling icepick donnee impinge currency wuss organicism bowel mingily noise precise buret cache anaphase ibis dairywomen palmate boosterism metricate dogmatist spadework edger lipography schnorkle caliper turbot succentor paw curacao wainwright prodrome volt ewer meliorism untrustful tyranny tabor exeat supine stunsail kerfuffle versicular robbing kidded parturient filose ankerite appetizing applauder dealing civics thresh marcelling infect crackup decadence plow cutch potation roundel breathless wiseacre strobotron folkmoot laceration flowerily ski supremacy flax plywood tripletail miser unanimity porkpie visibly vesicular acotyledon receiptor transputer civility logroll whitish womenkind commonness dotage eatable decedent screaming angulate retd supersonic emmetropia strobe splashily text femaleness baccarat chayote huff shovel edacious chlamys yah kernite belt prase pocketful drainage pentastich stockyard shortish brachiopod tillage frivol nebulose subhuman lunate goalless belch sideroses sign doe penetrant buddle tedious moonshot bonus optional unsound foxhole gid coachman unlash pallbearer bringer dice deafness smoker crossroad slushy suricate remote airflow farrow redolence terminus grovelling microphone hydromel chapati orthopter pinchpenny motioned machine governess vassal tracksuit clubhouse cocaine baserunner episcopal optimist prologize insured curtate diastasis ankh maharajah magneton turgescent disco anarch instate aphonic commercial approve pipeful prepuberty trouble swathe chattel bedridden jejune sunset theoretic globefish habituate tonetic wingspan kid stem peter ibex standalone duplicator jubilance pharyngeal brattice liberator militate sedge asquint steersman punch appeal naris eczema surrogacy benefic pair wendigo anesthesia pulmonary chasseur vendue sardonyx linear streetwise cell greenhead variegate biogas dowery frank colophony scaleni whizkid governance applicably grenade gym mutineer slang clock toaster earless gloxinia epithet aplenty street huzzahs haunter smolt wiener twig stabber adversary cline percale cirsoid tali speediness branchiae retrograde monotype coworker comeliness ruminal searchable disclosed formulary plunder classwork lipoma chubbily seminar semeiology diakinesis idler bushfire biomarker olive grumpy curious ziggurat crosswise cometary limpkin maundy teacart cilantro weekly hinter twinning neoplasm hack snottiness acronymous theomachy spinach pollard toil litigation tenderize bacteria gurgle nutrilite dogfight superaltar dreamless dependably greenfly admixture aneled wreathe dulled waiver selection asap prepotent anaplastic relieve pitsaw gunboat brevetted chirr nonsalable saxhorn misstep padnag tropine stigmata sutler fora ftp damp branny idolist maiden roadside rawinsonde acicula equable poi eld swastika lubricious clayiest starlet mol chronic westbound nonmedical preconize eide duodecimal outperform webby firebreak bicker jalopy grep whereof metaphor tunability platysma lungworm remodify louse misdefine wrestle myself sourball duress puli polyatomic nightlight bedouin tenderloin fingertip annual phellem fabric beardless hemachrome enchase liberal pantyhose forbid firkin peracid yulan psf euphoria magneto alcoholism bookie engraft switcher forbode coerce dwarfism ordained dowdily chow cadet cupping septuor footboard necrolatry firry macaw cloggy hairball emeritus carrycot newsletter injector narcissism signalman assistant zealot buprestid retrorse canceler firebox bedrabble gunmetal racket adenoidal commodity egression gradate cereus pessary clue guru petechia incurably meantime rectorate tackily tubal matchable boxwood sovietize cureless clapper audition planning unfussy versioned shame thence carnage adjectival slipping auth forecastle enforced ladder keynoter siglos pastis thinker venality egghead caplin slanderer escalator skipping defame perforce this exodontics shunt implied dollar orderer fashion pinchcock sanitarium clatter pretreat incognito gonzo nameable imperial ylem plump estrum planimeter caudal skaldic drear polemist rosinweed codpiece awaken shenanigan slopwork muchness columbic tertiary spareness plantlike fugacious automatic etiologic populace puree winker surly sett endolymph denigrate ansate coli integer cablet curvy seaquake hackneyed alkahest mezzanine musk catalyses strapper locket coed distingue gynecium straddle chunder tombac adactylous datatype gambier leastwise assessment doubter festinate folliculin pho bumbag neuralgia quiet roofless pedology polydipsia frize phobic larvicide bushido snore headmen scurrility impious tarmacked stagnation lysozyme protein cystine lwei greatness codon ttys brassie snath uprooted hauler bedroom suddenness spicate syllabary overthink gingivitis stork obscene copulation bijoux violinist doting tautonym risque luminous bayard melt hailstone colitis chromyl rhetor triune asymptote heal cleaning scut seemliness newscast polygynous thickleaf storehouse unseam birdtables delegate precede aristocrat abeam sootiness responsive linemen ephemeral eyewash hayrick klutz hayrack pickaninny palfrey disbudding benthic uvular marcelled diffluent eggbeater savoriness vinery battery ecdyses xxiii baronage meshuga iridotomy jillion baby insult shopaholic aspirant attic execrator prodder arguably tinkerer outfitted cyclopes coupe leeriness gamboge backbench peasantry tissue demolition quack netiquette diphosgene barter sanitarily cellmate oviposit spatted dovekie copalite beadroll annulment bully tole eryngo minibar repository awning workman jarred token nucleolus caulescent eagre seventeen caller sculptor diereses dimming archicarp abdication slipped claimed bugbear czardas curvature cisalpine physio fatness rhythmist headstrong quintain thicket robbed coomb touchiness autacoid helm cashew rearouse roguery minimal checkable hearken spoonfeed quotha psittacine lagomorphs keynote adjuratory frill estrade whizzbang grader anatropous meaning cruces aquaplane gooey scribe beleaguer bitchiness laymen proforma delict deferrable microhenry punctate aruspex succulent immune essence cleome faddy why libation function kidding ageratum jeer zinnia cockily ecesis youngling tiltyard staunch drifter platinize protozoal hearing sphinx cellphone tapster honor unrestful willet patrol mayflower swinish gormand pokelogan napalm tearful atomic placidness lyophobic sallet triazine capon summand singleness bumble caregiving continuate baronetage voicemail tong pock jackrabbit hogweed terabyte stupendous soubise pestilence bosomy zucchetto exacting dottle children dam golliwog undershrub sweat tenaculum unstick political recouple system eudiometer muskiness puny libelee globalism evacuate miracle rollaway anchoritic bratwurst hygienic player punctuate cambogia rudd stroller radiopaque contemn exobiology hyperbola tagmeme cratch glassware garderobe unstack blackthorn biyearly penis joss refutal burnoose phonetist tardily wishbone morbid protozoa serigraph miraculous shrugged gymnasial egoistical overturn saltily linseed viable dominance marinara elder diam litigant bhang tightrope moline nonhero affiliate panegyric busby alley urine sinner conclave wave jacinths devilment pneumonia stylus beanery triarchy laborer abruptness truckload spirilla epode ambulacrum thionate solidify portico orangery lederhosen sandbar loyalty bring puparium physicking sawbuck victim roughness liquidate enforce campaign arcane popliteal chive avionics synonymous puzzling acetamide gaucho galluses engulf carload longbow subeditor constitute greenhouse riverlike flint claddagh agleam statuesque centillion jangle dialing pirog metallic sanitary dalmatian dickens caff outnumber ecology necrology glommed crossbones thereat symploce crew monocarpic morphia shirker priesthood hideous dapperness outleap nettle insomniac starvation lasagna tunesmith camerawork topgallant manual sterilant methodical cerebellum cur exegetic skeptic adagietto swacked corkage bromoform tiptoeing delete dinothere odiousness minxish introduce premundane rapturous letdown windward fleecer rejuvenate millepore bream muscovado vespid helpline tessellate frump arroyo provably blenny levity undershot shmuck apelike crustily colonist moonseed coconut pangolin wallpaper liberalist etiology trivalency polyvalent thistle argentine profligacy allottee superrich arsenious implicit celloidin footpace rem cauterant spoiled mongoose partitive loincloths waken soothe genre photomap fardel fistful layer constr leishmania assuasive arrogance bedimmed alumroot cutaneous interwork reseau satiation enjoinment janitress overgrowth lithoid witticism sketcher abdomen oceanfront spur eringo aside mapmaker junctional ranee iatric chapeau wildflower lipread iodometry underplay bloodfin noma lapidate innovate palladium ambulacra blimey sickening tinfoil redline ochone born thumb mild czarist handclasp constipate pandemic deltaic damnation radiologic skinhead mayoralty wavelength millboard thuggery impair mongolism costmary being glamorize xiphoid hornpipe degauss twit eleoptene tinct precis anchored tolbooths hobnail cragsmen remittent carcajou birdbaths fellowman robalo intruder sherif specif genappe macabre dendrite injurious magnetic polemicist stratagem chortle smudge lavabo shagreen loganberry creme breadstuff grope sinus strive confidante cyan gadolinite roominess dado tartness farl semiology injection shallow alter airborne piety phenacetin somatology deserved suite swayback burrito apposition forereach favor filet bloodroot nonperson revertible cacciatore mortuary filmmaker toxic vulvae profundity cuspidate voltage sequin monoatomic zinger vinic satiable tweedily middleman induna emanation adjoin groove divisible stableboy ligure documented viscidity orgiastic cotter boarding lumberman brolly pirogue glyceride statewide saved shook preview funnel symphonize rip poacher spoiler coypu cud molarity monocular recut spittlebug bargepole fiesta grouser disentail reredos circuitous ceramist wherefrom corporeity nerve poundage intwine unthought asbestos gingiva lability sibilant coachwork align spearhead global everyman headstock aerophagia appositive nonmoral unpoetic fibril precedent errand cicatrize nubbin changeably natron bafflement presignify commissure propensity lugsail entellus shadbush ditsy jackfish myriameter coyness naphtha ensample amateurism eutherian gnash playlet beset baresark lungan crust swain dyslogia jitney blunder archaic palazzi ridding siddur woolgather sonde ergograph amiably legator swoosh dinar earthmover conflict roundelay adynamia peacemaker primrose raster cistaceous foolish analgesia designed indwell inflect trigeminal alienable chough herbal duckpins powerhouse hydrozoan deductive tensional aether minty urinal adept highbrow boyar enthrone laches splurge groveling chevalier arbitrager mullock buckra abutilon unsexual candent session coachwhip dysphasia photoaging peso doeskin diamante urologist torment scalade marginalia spadefish foretold arete saint anisole mutilator mat peckish zootoxin foregoes decalcify superphyla ramming chamaeleon harmonies suborn lawyer venture lackaday ionization algor mouthwash yegg onanist trifocals crackling bound tapeline castration greeny momism kali outwalk remoteness arnica zemstvo exclaim despotic deferrer kelp benny ingenuous saltarello soloist slagheap hypnoses evanish vatu squirmy bema herniate rubbishy closeout flocculent eunuchize fresnel batty folia globule analyzer shoddiness resolvable reputably microtome deadly beading eardrop work evangelist cogitate apocarp lucre clinquant telegram await churinga recidivism xxxv adhesion humoresque past brimful stepson maharishi basic iridosmine church paisano basophil weft eluviation crapper southbound mammogram society soniferous genitival deflator dandruff slimline trilateral lovey parasol tubule manrope gownsman tempter corroboree swarth hairpiece energize cercaria reclaimant xenophobic sulfuric bird stelliform abetment chuckle secretory brigade ladle multisense quenched rhyolite very barchan histrionic plumbed lack architrave hunk halation foreperson osprey goatsbeard supreme ostracod pinnatifid decency historian convention contortion rawhide subshrub abscess approver turning nightstick generosity aboral please falconer lightyear adroitness airline deadhead shipments gallows bondwomen creamily tedder reckless mizzensail outfielder futurity grow cytochrome cotangent regimental labyrinth mommy synergic contested occident tribunate speller sainthood unsavory against thurifer vena obsolesce brasserie ocher botnet hutch monkery analogize oarswoman wicked dosimetry approving tegmen cavalrymen hamal factory ceria factitive hotbox torridness cloudscape sincerity tourism aphrodisia toolmaking envoi squawk improbably acquitting hernial quizzed brisk coil bomber lowland dispense bogus suburbia razorback condiment avenue decadent frosty multitude moonrise lexicog pvt mycelial trompe earthlier silkiness perfection apprehend opulent lengths perception wart decisions byplay bucentaur horsepower robustness cru hiss nigger concordant ecclesia hectarage brachial viewfinder sagacious lucarne frittata annex poplar forefeet devilish concurring mistrust doddery anechoic pulsate guffaw diffusible swirly erythrism moreover selenodont cerecloths dumbo aliphatic outlying petulancy peccadillo theomancy dinosaur comp path hashish mast antre subbed ostensibly bellicose tumult jammy timocratic bookend triform redeemed dipolar skeg vesicle technique illus postmark worthies pieing sopping vulcanite priapean devoted mire dace velutinous apace fungal kronur smoothie scrum placebo herb cretinism signor funk tomograph masher chapmen curlew stipple ascus ratty proactive osmose discipline kami obstet juridic ageless taxonomist checkbook inshrine gentilism cornice sheepish surplussed rateable antinomy curiosity steersmen aggressor filial old gammon busybody cathartic demagogy ghostwrite tan senior admonish ghostly cone ursine pilaf gestaltism unrepair escarp dynamics mahatma sextuply bugeye sizable massasauga apocrypha calculus engraving ordo spumous appraisees tosh rusty contraflow skiagraph damper lixivium incline gushy embay snowbound limited afghan goddess clit monomaniac dragon samsara refection biotin granuloma acacia air matchstick alloy tribade scepter yes reside trigon relation taunt vying decidua statue dejecta crankpin tughrik fid earths clearway fat pretermit aureate defense olfactory taunting ferritin insulated plinth paint salpinx zincking horseplay provide groupware glaring scrotum countdown juvenility stepmom inhibitory humphs cheongsam skittish videotape inerrable farmhand bitewing glancing pilpul hydrops deistic defamer bluejacket lobotomy flattest clitorides cockleboat steak miniver ambivert voluntary punchbowl nonplussed ashamed mistook glory tastily tracheal grievous glossary celtuce annulling coxae alarming dartboard idiophone mouthiness coevality histiocyte guesser qualia ferryman doomsayer siriasis indene sourceless downcome reticule hungriness solubles napiform cession deviating tetchy woops coontie fortyish woodsmen popinjay electrical active lotion chardonnay unknightly mull sidekick quota reshow echinoid evite glucose nuncle bruise silent plummet cracker yeast bevatron altostrati reverie acquaint cyanosis mead spermatium peatbog brr buteo eligible flop trafficker underproof purview beeper duality downside carving overstep consistent commitment dibble home cynical poss taxon dump lawmen sponginess aflatoxin hugger agreement aperture summary trap taradiddle quaggy hindgut heliacal aluminum lxi soundalike trainee expendable tonometer flashcard bade airburst smoking charitably unfed orogenic negatory outfall whitewater plumage strawberry fugleman vergeboard nonbook junta dogie flipper bottler hoyden dickybird mastoid solstitial simpleton gynecoid tundra manna smalto wayleave footrest revved forklift tinsel ahimsa overview examine cohesive overarch campus italics sealskin query rely goer rhonchus apophyses strappado footstone shigella magistracy tetryl scallion princedom wildling deme overcheck miracidium apriorism hill syllogism homonymous discussant kidskin futuristic predawn bistort imaginal parlous nature guano condom vac slow pectoralis phenology sciuroid rauwolfia encl aphotic cantering sriracha englut paisley culver salvo rational teahouse sulcate euphuistic pargetted database inculpate cramoisy congruous hey coquille freewheel emetine backhanded dichromic gapeworm discretion liturgy analog diggings saddlebow lateness readily sargasso nogging leporid eyebright bowman reasoning goatee minke roundabout avenge dyeing bacilli mundane racer melanic defy diatropism sarmentose ratepayer feel troika cwm grimmer tipcat overexpand brainwork purport ulster sorceress parabola eternalize rod avow homebody keypuncher scagged geese resupply crimmer karyolymph eyelid unsocial wolfram fraternity catalog sextuplet clubwoman wheelwork spat bilker applecart nacre pillager frogmen washbasin schmear gnathion detention mangosteen rabbit incumbent unnerving saltish bricky sip isomeric lot jiggle singer rainbow borecole pleading pore dextro accept spiffy maroon newness gustily misdeem crocein flagrancy stylet fatted greengage overlaid tallymen archaize ruddock modem hallway juicily derv cordite proclaim testy fallible seraphical ilmenite expo porbeagle moisture kind psychical autopsist unfilial kilt ipecac diluent centavo burrstone marline diagenesis gobbet keep nudnick repletion twerk whimsical destroyer numeration grouchily ventricose beechnut accent unifilar tanto canst innerve brutalism lightning creeper superwoman hedgehog peacoat dieldrin fleurette lazybones penitent renegado drawshave creation preshrink fluor batik tailless deck spam comber vibe sprinter footpath gypsy kluge brights picket paperback colectomy additament booger metope flagrance hydranth hijacking druse fraudster astigmatic stepwise wardmote armaments positivity urtexte eau slob conflate decimal phonetics likability endomorph xxi elaterium burdensome impress steradian elate cardiogram epistases satanic maxilliped papyrus overbid honoree skylark adequacy ersh lactometer griffon abbot inducible chinchilla backdrop anabranch fulmar gasmen paramorph bah feria future roadstead whaleback lion rehabbed imprecator diastyle azobenzene politician emulation plicate eutectic guarantee info omentum crammed impetigo piquante graffito carom eradicable leeboard synthesis prewash artfulness astrakhan drogue apostate ombudsmen allege autoplasty cowlick mediocrity determine embryology firebrat universe cosplay tattersail wrongdoer academic sewer zibeline array ironed empyreal wildwood dieselize route cohost titlark antibody queue selector complicit liqueur spinifex dieter houseboat fishy spell alkalize cyanoses partlet nativistic overdress haptic firewood reinforce pandectist brine ophiology taillight subsellium doggery antilock canonicity desktop chinquapin pepping raindrop vicar womb draftee gamin silique vertical creator octahedron filiform logistics japan nexus incuse revoke verdancy rosarium caliber acrodrome luxate publican rocket ruble missilery remissness chip geological anvil tabanid parish residual gecko fifth chummily tiptop trounce lunarian mujahidin business veer mylonite awhirl mulishness expugnable brisling vignette ripper target irregular flatbed malamute babyhood depression satanical sextain cribbage scab saga bequeath tola amoebic bluesy hgwy entomol dressage awardee angina bellboy scirrhus illinium slouchy plunderer adit pigeonhole traitorous keffiyeh hypocaust chlorate albino graphical origin lampshade overleap herp coon airdropped seism tripody underlaid mawkin megalith recruiter wigwam somberness cribwork exudation vacillator ruralize niggerhead bullfight fordone albatross tragacanth slivovitz trehalose cramping monocoque weepie unideal sapless fuzzball fobbing mist apoplexy getaway queuing curia conduce disrate blushful duchess provider mizenmast actiniform widowhood swatting epistaxes herbalism redingote embodiment chlordane illiberal lira priciest holography dioxin stentor braininess advisement meg while cirque softball cobwebby punditry attendee nutpick suffragan telemeter integrate castigator carryon blindfold haruspex homeliness scramble elderberry chose dipso assort annuli tempting winking amylase driveway reducible serine disrelish cytolysis phototube souffle quitting counteract senna strained cottonwood chiastic balefire spacesuit percipient zool nonextinct moron metropolis partite tzatziki simulacra infra surpass jean impolicy walk dentalium polio inferrable geothermic anabasis receipt streetcar quaternary euthenics altigraph patiently cony ogler lithol aorta hick amass menorah mesotron bechance sciamachy redoubt prepped wader coda bugbane cerebrum toffee hie tiredness hurdler plagiarist jackal slotting irritable outwear pyromancy mesial prohibited shipman operand passel kiln peduncle subdued yaws unwrapping nubble prayerbook privation paronym celeriac childhood reflect whisper bawdy puerperal celibate nakedness stovepipe retina dash kanzu freestone chairwomen contiguous adulterous eggnog cashflow unicyclist oleoresin almemar bucolic attained convinced yak mezuza acquit moralistic bedpost bireme destiny convector sard boathouse kittenish blacktop adios format billfold mendicity highwayman coralloid preseason thong subsistent laky mistaken xanthate hidroses scouting treeline feeble cautery scrambler lordly stigmatize terry irate exhale exajoule kyphoses abaca salesroom cantilena eyot pachyderm jetty majestic unleaded slue embarkment perigee oilskin towards lymphoma simp whetter vagabond solicitous tailgater billing callant haircloth cuticular lex gymkhana agronomic copal crocket tenseness narcissus supplier tanned blear coronal pocky reformed courgette stuttering moratorium diplomacy caracal bylaw clavus hipped minimize halvah toolmaker demurred soldierly biforked xenocryst topple gladdest clearing femineity backbone firebrand epiglottal toxemia clank quartersaw emptily shibboleth marksmen hackle flubbed rabidity pavid released misemploy cryoscopy customary nonethical innkeeper brasier tetralogy springhalt keck unpretty thighbone textual organdy barmy bilingual trump honorific nonsupport oriole made infarct penile womanize lecythus mithridate humanist welly cembali flange vicenary pica droppings rhea psst stonefish brush milt teakwood assibilate nifedipine polymerase mortgagee lentic scleritis plushily fistfight pooch hyrax furfural factorize brad gosh valor invested thearchy picot badder jocko hump egomania longan apron exscind voile sensitize sades paramecium cognizance elan lib recoilless ninetieth delineate guise kanaka ultrasound flytrap luteous deepfreeze worried redye bop tuberosity gigahertz cloudiness jaggedness traveler cockspur outhaul syce stigma novel autostrada tenths pyrogenous overheard ejaculate purlin footboy mandorla banderole aspectual ginglymus pagurian treenware coatroom scapolite lam persimmon possessory empoverish peevish devoir nisus unpolite sweetbread deicide sifted dud morbidity denizen tussah tumescence proa bobbysocks shapely panicky chaqueta novobiocin intended blobbed naissant expelling trictrac niftily size koala feminacy vitaceous heptagonal unities quadrifid pokily suasion intercut preferment partridge merlon bettor windflower oscillator fulfilling mizzle pivot mend misdial claqueur biddy org gerbil nybble subside phalli delicate rhomb doggish agreeing pickerel tandoori taking tortile demiurgic fanon brushy clough overbuilt diplopod crosstown yogini roo hubristic persevere braunite deadbeat fulfilled shackle murther deathblow clotting benefactor leucite elitist melee ocrea emersed laical helicon clerkship archaist finis crusado hern progun autunite anchormen breathe dishwasher filoplume mischief ablepsia ropeway slake berlin interplay dummy undergone goodness stonewall maestro overlavish radiograph partaken commodify vesicate amoeboid mechanize paltry thickness plethoric deviancy cupola dredger fickle scalawag areca tackler breadnut insomuch glossy abode freeware bumblebee vinylidene pinta numbat meltwater phosphine jingle squamation amygdalin photogene cloddish fellmonger epidural forswore lutestring griper disk skull abidance crescents galop busk mannerly millage housewives motormen regalia snoop imposture coranto sanderling recliner mishear briefcase typify pressor mangetout voodooism buddleia skink obligation gusty pithead reverence trendiness breakup pointelle bellyful anthesis simian tasteful autochthon guiltiness estrus interphase stramonium relevance subfusc diktat defend lover wifehood flowering sleep toponym kor brashy oversell putsch volva registrant chiefdom tightwad almandine saiga gigameter fisher distinct remiss daisy perfuse nonarrival oof capsular bum cockswain crush cml snakily sarsenet reformat sec backflow stodgy besieger chloridic intermit scyphozoan reclaim loneliness humanity nullipore underset saying vitreous scenarist unswathe beanie propped catenane eyre watermill nearside hillbilly owl lye media proximo needleful quipping buoyancy candlelit encounter hamstrung bestial quell equisetum archivist kiloton twee salol billet deadlock overlay glucosuria guide evader curation convoy poon demantoid collect armpit politburo synchronic singultus forint asphodel boffin reveille taxpaying inverse coke nitrate botcher qto meadowland conniption patronymic chimere chichi sea cruciate frangible suppressor blotting tallboy liturgics scour cat snub cuticula encipher microcurie commandeer goldsmiths fritz envisage aventurine adenosine noseband legginess playbill there agenda peroxide kipped mammillary turps larrigan bact ensheathe americium chateaux geom dram diva kindly lowlander pixellate overplus nerdy syrup griever arsonist adulator poetaster cobwebbed roughshod inamorato antipope droplight torpedoman tare befell ceruse charcoal farseeing frit butted dynamical foamflower sacking telecaster jobsworth might attn faux servery clockwise goniometer restack cockup dollish candelabra trifler metabolize xerography bizarrerie aphis footlights twigged begorra anthelion outerwear amaranth compound strapped whap venter masseur escarole blessed tetherball typography choc descend pencel hectic nucleonic thermal endearing canoewood abreast thriftless baywood behoove geddit beater cystocarp oloroso aldose kingfisher limicolous apostle vermouth radiophone affirm archetypal eyeball hagride wreaths calcar platelet reticulum puncture whitethorn mitis endoplasm marquetery muscle printer ethereal voracity cruck tobogganer lane fervid fulgurate corporal pesty workpeople outsail thingy raddle roadsigns gang addict oxidic ideogram garrote underside laminator estival dup freightage imbecilic shitty bobstay midsummer cenobite disturbed eerie hew rodent mosh inferno cinereous mpg radiance slop diarist boskage payroll complexity decent supporter settee redivivus greenbrier knighthood phthisic zap chilies ratify bastille cocker epicardium backache inrush cordon growths culinary vesicant sacred caboose lube imperf squander nonsocial shout leukemic vervet mismanage disproof heavy dwt shamanist precipice stoppable thorny stagy accretion hell accented frontier cleaner fleetingly metonym outset erotically agnail alewives smoothen peerless apocarpous lightship subaltern actuate tetrode cookware defection bigamist quixotic manitou haggle aerobioses cosine shantytown callow trolleybus aviatrices diapason bookrest chinchy marina incurring parados boner ischium flakily sunshiny shriek stabbed shiva trephine frow impalpable paillette curb poteen marginal penologist yurt jammed polish autopsy husbandman lingulate nous barrel pleurisy acini tastiness hetero knurl lathery sagging threepence auspicious apatosaur dipteral inbox tingeing aright pushchair floaty airwave event prosiness boxhaul saltine fortifier snuffle nonaligned interferon marquetry physical pyrolyze scudding boiled senile monies inquiry tabular poet resume cop moose foilist bandicoot arachnoid firemen relist amalgam scudo sport tropology potshot scandic fossette helminths raucous fibrosis rape mither assessable partial kayaking yogh blag childbirth zippy racketeer escolar bestiary stimulus sentiency wield craziness stratify densimeter enthusiast twirly scrapheap potheen eruption maid lemniscus oenomel serosa imbue runic cornu laywomen biopsy airfield impearl shtick piratical cagier crabbing zealous picrite doz flagstaff penniless becoming watercraft hodman speciosity surv mannerism duckweed marsupial tug curassow pouch cornetist invigorate modding ill cupboard advocator dory combiner phalanx abruption leprose glaceing sadden scalar coverlet neutron sura tract friability acidify collator attorn satisfy piney wobbliness telegraphs strand phalange flurry piacular fogbow classily epergne manful tenebrous limpet numismatic remitted setsquare speculate flor polity occupancy ripply heptameter teetotaler tenacious harvested faith coherence abstergent rivalry llama larcenist drivel donne killjoy septenary madhouse kelson delay palp goon natheless rightism gutting indicator visionary polyp reach mudcat robbery pyridoxine hilliness heptastich pundit left gymnastic departee weariless foreknown verge techy thoughtful blurring ferreous convection convolute woe toxicosis rabbitfish greenroom futurology blastema camellia tutti barge installer herein underlip stamin mutt candor mod supergiant autoworker doorstep conclude trestle floristic passphrase applaud gripping caladium gland adjuster vacuous cit spaetzle superheat deflate tuque wiz tenanted houseroom indigent teniasis exostosis ascender exponible violet baseline piping undramatic mind brant wog exam mil krona wimp trichinize eolian elevenths modulate solan crocus immolate utopia bud bdellium overdo fetid braw subvocal incentive pivotal first embargoes subalpine piecework cpd dreamily careworn envelope rowel birdlike nabob gosling cord afterguard toplofty predictor conduit geoid damages revolution skunk postiche drench hood nurserymen assay feverroot masochism glandes cicatrix dissembler prosthesis skidding pantie flabellum layaway waveform sphericity callipash quiver comma lewd atlatl scorify flocculant handbarrow recess larrikin cursive autobus immanent triumphal rotter catechu pleural keratinous mystifying mange butternut chaetae ebullition overhand defogger listener overdue fussiness seigniory lowbred turndown revivalist oxheart hieing monolatry wasteful effete defecator crisis fanfare cicada ephemerid baryton prepense consolable confrere tibial edibility fastener bazaar peculiar stand pill cyanite bemock fancily cyanide stateless anecdotage fanjet blackdamp husky pectic spool preeminent bracketed crispiness mesarch tree guerrilla selfhood gaudiness poly loos skateboard militarism whiplash yon aforesaid inordinate perplex rabbinical drummed herald stool tortuosity westernize obnoxious toughness hominy empale rilievo rarefy propositi compar solemnize cassoulet theorem grid hippie lacunar zither schmuck sultanate beneficent foul tweeds quadrisect commorant beholder concussion glycogenic exosmosis butterfat flexor foxtrotted cowherb durra condemner foggily wailful tocology radicalism briefless introit volition mincing bisection life sow deerfly integrant trickster titmice altered spadix whydah jambalaya illuminist feedstock flambeed blatted hollowware linstock alikeness sailboard abjuratory cranage gerent snooker kinghood jounce airway sequence oldwives butene endotherm kinetics maxima activeness dude brookweed downmarket corpsman moreen hophead formulate ovariotomy pew induc vilipend stoniness ovenbird nepotism yuk verbality initialize nubilous loss crematory encryption chthonic stook overlapped vitta pitiless stet subclavius reachable caseworm nitid flora faldstool natty manse liking petrel midwinter millennial defrauder circulate coria masseuse mohair dynasty pate prescience probable panga ext cockatoo ruinous scalage roundness amain hexastich blotter overridden splore unintended relegate widths direct coff baronetcy humanhood draftsman fierceness checkbox jewfish compliment footle manumitter unconsumed con miss thirtieth headrail manipulate neologist ointment ethologist monotone griddle ringside comitia ligan demolish penuche lipocaic pushbike fauvist mash audient mullite law kangaroo ferric abhorred wraith monomer scotopia bereave luteal imploring moonraker strawworm dreidl insolate endorphin deductible abducent antechoir already entwine metadata malvasia gangue diorite northbound antevert disable meninx cloudless biserrate gunstock filler mesocratic enrich motherless extrusion bedlam barometric shipwreck skiing poisha fluoxetine biracial mawkish heraldist arena elev vamp brisance rediscount kinematics regretful rectory oarfish geologist prep absorbance enthrall billon dramatize sycosis assemble bicipital dunite bioecology animatism impatiens appetite bodycheck windswept grunge patrolman urushiol wonderwork dianoia holey struck etching tragic subtonic grosbeak illuminant div pyrology revealing imprest meager seek sandstone intitule shariah orator leucotomy micturate incisor outback primo poignancy middlemen dirtiness crumple anglesite dismay abyssal evaporable wrath sennet sliver gymnasiast sandhog ruttish papist orotund solicited analysis peculium baseness slash dairymen porker shrill osmic clamber psia gifted edamame jornada weald wildcard homocercal sitter flashily sponsor fife misthrow subgenera fishhook suffragist salsa clement crumhorn grittily forsaken ballpoint hooker radarman wormseed fair cyclorama via vote contented jutted fondue wryneck chancery isocracy egoless imprimis pumice akin jugged cockscomb stiffness formic assagai sclerous trademark suitably glittering corrodible beastly dom collegiate wealthy vamper depths bullhorn crapulence sexist retiree preappoint jinn galyak washroom esophageal heath hearse cultigen pablum aldermen sheer gobbed innocent canicular insensate fusee diphyllous bluefish tribune shapeless paparazzi webcast collyrium grange fussily lustrate redress algoid castle petrol bootstrap evidential arcanum numbness obstructed groomsmen popedom ampleness vitalism skepticism crackle hematocele griffin begone umbles mamey lineal earned footless obtuseness churner shown avatar pituitary signorino scrumpy vesical paintbrush vimineous nosy daimio habile unsuccess dobla hither miler homonymic anaerobic readable geode injure quill quarrymen preexpose zapped overladen brassy inveterate dynamism movably possible dread razzia gluttonize precisian orangewood predefine pothunter indict lakh cavalla redden gently glitz adjunct woof horoscope fetterlock extrusile overact stator subvention discuss logon exchequer armless charmeuse foreseer dag empire checklist submember tychism bobbed extremism visited bowlegged mournful cheetah nomadic chibouk shithead girasol aerophyte yogi taffrail adoption orderless pariah salesman langouste colcothar flowery lollygag bowmen spotting government assumpsit meristic employ unalike diallage microtone mugshot armet toehold prowler admitted embossment selective peeler hoeing harlequin journalize morbific zigzagged judicable aortic filthily flyswatter quicken gabbro soppy outguard husker pseudaxis speedway keratin chirpy gallop sandblast letterhead agonizing crine whisk reave gambado copyright ginning punchboard satang stope bathwater idolatry respell mattock hammy geomantic monarchy documental microcline paramour hatcheck jumpiness hawker solubility anarchy tetraploid luff bulbar netbook ophthalmic comitative hematozoon convect pantile flexion jerrycan adnate indelible messy lossless pigsty dentist gizmo starlike synths undercover cheerily petulant effigy clepe cyclamen extradite taxaceous scatty phylum shagbark cachinnate cablecast livraison chatoyancy bagwig superl gantline spp rag manhunt raise bazillion false demoniac cental drabbet dynastic corelative kilopascal aerator jota stewardess dimmest abloom dulia ethicist invaginate dressy fiberglass caviler synod beehive outbreed welsh dekameter turkey unsteel scabbard dolly afloat verrucae winnower woolsack aircraft lockup postboy cataclinal opsonize boong credit quavering intriguing maternal tubulure lyncean hilly episternum watt glorious hiemal sendoff jetsam wrangle unavailing blimp larcenous ridgeling preschool wretch windshield farrier emblaze ghoul goblin heard dessiatine habitancy clout bister somewise commentate mick singles copyread dissociate heliotype grant glyptodont crupper heliolatry epochs calicle snifter jellyroll solfatara coma scrapper aigret feck warrantee outwait priapitis chine collinsia connector wideness lugworm spang prostyle boxcar croquette beaut glossiness engender rout mech evilness maim microwave spall ovum hash slacker paralyses gastrology habitat eighteenmo thorax ignescent myosin genomic liturgist classroom execrably gillion trickish cyprinoid spirillum woodwind scoreboard protection gabionade biennial inveigh lord stridence karst vertu overlie paternal infinitive kinsman asleep entire fable carillon glaze trimester limy unhappy disdain angiology leavened chubby sort wrasse mucose ranger scend lopped atrophy flageolet pice booklover grounder crabbed abwatt mirage dahl allotted debilitate letterer burner collat solleret areole unvoice diploma salutarily heirship urban villein illusory consonant dogleg hance camper chlorite abatis epistolary actinism luminance tarpaulin harridan sleeveless regressor fleam nasal retiform venous cementite shoal sprog recumbent kiddo tumbleweed celomata collimate toleration zymolysis ohmmeter duckling seance genocidal property songful thumbprint corn crossway ecumenist pulvinate foldout dow motley venial factor public timbrel elf feminine isogon oddness scenically sixteenth ideographs guidebook sapphire longboat armful gallstone hypabyssal cartload sthenic wirra hob loyalties hon fortuity portulaca mythicize reassembly ides touchy japanning senega bathometer scroungy insipience dicta attract minor xerosere ingenerate elegancy mustang outfield anatomic postmen eudemonism piddle swigging oldish fetial dairymaid hail idioplasm variform ingesta shimmy affectless mammonist surplice educate insatiate berseem tother population bookstall curtness hairdryer winze backed misreport grassroots axilla devilkin eventual musty donna floruit cockfight heartbreak octonary rubellite demirelief maybe soreness flunky subfamily hate doyenne freephone mantis lettuce solute pyorrhea ectype careen repeating opprobrium esp binturong helianthus loser incurvate goalmouth relief intuit tachometer triennium colemanite pariahs caoutchouc lxiv variola nolo robe pathway illicit bivalve worshipful begetting millimeter proximate amiability sleight gelidity roundhouse reclinate wop melodion hitting insipidity deceive ink nickle barista rubrical ecphonesis enol nunciature viscount chasuble samarium leery induction exine excessive secularism manically smutch graveside brigantine spareribs fatality poem exhaust lubric outdoor amigo epiphytic moggy module trembly cumming cider standby affirmable vitrain obscure wheelman naif swampland header helmsmen vesting actinolite told insula quaint staid pronucleus salutary unguentum agaric chatline taboo ferocious cableway particular gressorial chatterer kenspeckle shimmery fremitus batsman corkwood bacillary perigynous tomatoes paravane cupidity camber knit bulge misspoke anandrous tachylyte glycogen thyroidal cistern veridical scurvy workable uphroe bellow linocut prohibitor lovesome foresee trackman sightly xylophone spew shadchan bosky subindex artistic prepacked narc ligulate lactose sample vapidness enamor entombment amulet nilgai gander tout graduate fagging invocate pneumonic koniology dumpster languor provoke paid cryology whupping malvoisie sloop halfback carryall eightieths fruity lychnis cultrate mashup monotheist mercenary ostrich geriatric optimize monochrome randy cosmology playgirl remeasure reference penstemon excavate monthlong stropping chicalote bran banish vocoid singspiele proximal dotterel swatted trinary meeting quietness sampan punnet seminarian repelled glumness hereditary gynandry abrupt catling whomp angel mildness entremets absinthism tankage wheel signorine serology brigandage vindicate sciatic fantail zipped adductor sunburst clastic foolscap roaster feature either pressroom loamy sorcerer astronaut despotism kahuna wunderkind petrous sogginess kidnapped coagulase corrasion dielectric nectarine fixate edit gov sunbathing ravage cottager fleshly kohl turnstone beetroot coalesce sweetmeat murderess fibrotic medicinal cabriole locomotive pursuit swabbed name localize transport bedding endosperm stealthy sapodilla affair spermaceti sensualist petrology farceur oxblood duplicate fraise personae geoponic palatably drudge lenis modifier sate mainsheet hangnail stiletto heartwood moderation allomorph thereunder tussocky penlight sunstone skedaddle amie ocherous digest syncarpous hatched foreshore roborant overboard oracle gazer smarminess duke elusory recountal butter node eterne kale sapele quilt streusel fimble constrain pomelo equitation bro cassowary apologete oldie painkiller ctenoid parietal mugging hoars forewarn tremolant encode supt pasquil scrub collar statehouse usquebaugh tossup golden boardgames perk smell raised qintar truistic boxlike groundmass dripstone startling perspire hexametric publicist luck trimestral subedit riverhead frazil foozle cordierite philology hydrosol unshorn lesbianism kaph tigon stang bagging flan superhero aerometry hopscotch unkempt carjacker maize mouthfeel waldgrave man aftermaths gestate sadist schnapps ache chewink bunny loquacious googly longevity mazy sophomore digestant activistic abhorring maun chooser ambit worrier whereon rampant tacker ecu parachute perceptual platy film bach publicized panicking scalable speciation cliffy compositor globoid hex hogwash snootful germane milium everyplace uphold footplate scarf clammily drafter claptrap surveil prissy cusk tempted sortilege rebook crayon milliary chanter ambulant egoist oblast wickiup sforzato labdanum betook geometrize bulrush summing southward attitude rower convincing hawse zarzuela smartwatch lazurite bear mechanic nightspot elevate topazolite fishwife twiddly loophole naturism outflatter vie downwind marigraph retention mealybug rachitis halve cravat marocain cornball determined churchgoer swig headbutt nautilus honorarily stagnancy subapical motorman crazy neuroses aligner acc hexone mutiny aciduria violone splenitis priceless notum scabby vitellus gale franc neutrophil slacken allogamy plantation pottle pastorship khan roulade through brewpub expend lama drillstock wow divergency boon dermoid cantoris fizzle ammoniacal violent tonga manta firewall pupping hermitage craw ytterbium outsize botanic anacolutha tenuis aspirate bharal streaky oceanog inch antichlor aridness budgetary trooper rille prau belated monoplane waxwing incl game vigorous bowlful jewel grooming manganite stinger rewaken lordling sham jay shopping spelldown dug euthanize prevailing rorqual eddy keto patency scoriae underbody carabineer mausoleum flummox bolivares funniness kachina headland holohedral cirrhotic geometrid dicier language breaths throwout melanosis supernal exodus zygosis shivah candler caird gobang octastyle emerita joiner noncoital breast asphaltum smelter tripedal burn leash piracy seismical dullness manly penance dimorphism oblatory woodcut usualness kneecapped relaxant cryonic repair alcove subacute occur fluency oilskins calvities glaucoma park helmet jackpot prank haecceity athanor pwt tipper happening scatted mordent verecund overfly frenum downriver sterility lineage galactose mounties unmeet minacious taraxacum flawless rosary brood flu demote dusky villainess subspace slightness avaricious merchant tubercular butting continuant expressed imp congou larva megapascal cicisbeo puffery occurred summertime nival kilobyte flintlock resent varix glandular pact glassy deriv lustily presser haemostat mesclun echt courtesan jacamar vacant leanness recompense nightlong misname melanoma reorg emprise gagger dower misdid shoptalk obsequent puppy antiunion precollege picnicker courante draftily retsina hyperploid planetoid iconicity hierarchal stingily telium necromancy fragment priory kraut conformal implement vertebral vernissage nineteenth cudgel attrit suppliance vituline dreaminess impunity dehiscent subadar saloop balls bur carburize thinnish rappelling interfluve hemmed preclusive mesmerizer barbican spleen complicacy uranometry exospheric vita vervain tee teachable genitor unthrone emboss saffron snobbery stylograph overextend cuneiform third desiccant comport girt findings mediant copalm duper jut esculent gutsy nice snakebite seashore rambutan chuckwalla appetence presidium expulsive smaze woald hagiology glycerite tirade lumberjack bagpiper construe complaint yarrow seel sear second hierophant teardrop slummed quint bonefish scrod unipod restaurant charismata gleaner ensemble foretop aeration blather hyla jeep tensor traversal formula open whetted stitchery usability kakemono petiolate custom spitting onlooking unharmful countably pistareen archt cornerback sidepiece subpar cortege acerate depositor dichasium adjective suffrage mayweed moviegoer finfish coziness hic getting maintop swanning esteem cycling syncopate prorogue harpist dust dapper redfish sibship detonator poleyn oversupply unforced federalism puissance odontoid phlogiston recent asphyxiate entrails carinate notate shoeless didst isodynamic interweave onside glisten acariasis welkin hostler forepeak swinge maya afghani wire crosier presbyopia mailing happy setiform obviate ovation galvanic coagulate veal enumerable chieftain ziti presage sukiyaki indicatory vhf stabbing archoplasm glissade cobra circumcise fifteen terrycloth softback puccoon aborticide nunhood implicate posthole coralline kingless pacemaking sixpenny gladder limonite breakout neptunium knap atheistic falciform crewelwork serried nympho pyrostat twofer cowpoke sprung nonsexist primmer obnubilate roust hemostat cooperator gymnosperm harvest awlwort difficulty aciculum pulvinus endophyte barricade waw instinct suicide ingle surfboat bromine distortion portiere fictive negligence tarnished chasse statocyst dull vehemency quieten root taproom keratosis deify breakaway didactic acinus pulverable lignin phonic poignance crenel bedizen gussy coupler estrange agony realizable motivation gulag tow moodiness budgerigar cariole wrest makefast adherence jobsworths flash fatuous afterimage ironmaster continent weasand stibnite megameter antiq warless achoo anthology archbishop hemolyses stealth cuckoldry piousness dialectal calomel luciferin rubiginous humdinger horseweed butadiene irk betroths regretter enamelware cylix incorrupt typecase allopathic warehouse swordbill archaism repellency hurst cause department denier husbandry manfulness urticate delubrum manager beginning possie isomer palimony chetrum ploughings inscriber fitted canakin dance quasi snapback brontosaur acierate marbling heartily involucrum forensic smalltime voyager verified worshiper triphammer hollowness surgeon flintily badman overcome vivacity sectarian carrack oecology britska nisei triumvir ejection prettiness arch asunder reduced misusage homozygote protrusion dilatorily tactic wand eventful reflection meniscus froghopper chameleon cheerer krummhorn incidental spacier passing anility outsoar disc oleander arsenical stash upsetting nostalgic afterward underpants translate canon maintain cookery provident chirp offshore masonic nutting loudhailer walkabout revolver pouffe glacier colorless exude grepped spiracle meningeal admissible transience hymn wahine overall antiphon sliced boxer render scabies ealdorman gittern measure goldeye indictor polyamory chaos depository inseam erasable groundsel multiphase abductor kriegspiel mesa worse railwayman twitted plasma ruthless brownstone decare decagon cardoon gambler symphyses amorphous heirdom grottoes backbitten pagination embolism acrid nonactive totter crocheter preppy antinovel resiliency fabulist birdshot denim scumming scholium playmate jumble unstylish produce undercool cyborg soilure intort pleopod laminar schmooze middlemost bushel guberniya proscribe buddy hobnobbing love nankeen dahs alluvion retort exorable diaconicon posed syncrisis pistoleer sapajou chilidog shelf windpipe landmass athletics druggie speedball excoriate lightish prudent wheelless molehill febrile ripcord regexp carnify squirrel robinia disbranch coign westerly airpower submariner distichs nozzle sinkhole salimeter periderm pancreatic collie fumbler crossword village basemen banality tantalous nominative decree buttress thereupon addenda grocery virtuoso shaved copasetic ascendance presidio unmissable manchineel colorful suture tractable radiancy brakemen nifty donee expatiate middy brilliant banneret spurious had shadowy sicko obelus rancorous invader mingle pony paulownia frighten specialism calcic unruly dialyze sandbagger hegemony impotency fatalism sampler therefor leptin murine surfbird eager danger tokenism pitying deracinate sapper triumviri bravo lyddite quiescent barbaric consonance gospel drag bedchamber pulsatory ova rhapsodize antithesis ironbound bluepoint archivolt artily labiate intricacy cardboard hesitant untoward roundsmen compleat sight awoken screamer phonometer orthoses maturate tripodic cluck forester placatory saltation flavorsome trichromat beautician gavelkind splendid flatter outcross menorahs nance weirdie unctuous varlet adust predicate barring heths druggy oxford slanderous vulnerary spammed uracil cutty delude bartizan dizygotic saddle matter placeman divider citrange reef yellowweed rising millennia impv albuminous charlock borneol lousy hexamerous prescribe grotty equality shreddable shelled mahlstick paraph cribble quicksand breezy sacra sprue slamming sweeping unwieldily dalasi steakhouse ascendancy fencible inerrant redcoat vireo subsurface cripple list afteryears stairway vine cragginess puttyroot floral sunbaked mildish abound hunchback filmdom actuarily chorus persist gluiness spikiness spinode magistrate positive observant locksmith bygone theme scotopic partner adj impureness alienation subtenancy rainproof foolery smoothbore inflection migration sulfite lidocaine shinned heterodoxy clover coarctate atm kwacha grackle sacraria exhibitor expand nondeadly toolkit tomographs bier plan datura vehicular hootenanny nymphlike wangler automation gaussmeter grandeur sweatshop drank impishness pigweed sonogram validness magenta hammerless braille hotel drooping megabyte witting bilabiate techs wooziness pratique wheelhouse rit cubitiere fee backslap kilderkin whicker ultimate causative orogeny radio slagging motor putted didymium antonymic par century obstetrics upland fricative lapboard afterlife judgment torporific crossbow nondriver dreidel sneaker fellowship stoneless racemose flabbiness abbe taipan collagen allotting diaphane wotcha infection sweetened licensee bestiality perennate poddy gun dew rollicking audile puncher worker unmannerly infusorian whore spun finagle snips mob pompano tableau inflected syrinx travelogue paganism upstart hamza folic autocratic acuity horrify scorecard catenary seraph bighearted caloric garlic scrump hematomata knockwurst wryest sphacelus brewage bacon cobaltic efficiency swayed salutation facility chloric clevis mint aphanite mucor cullet supernovae unwound ingenue brio myrmidon ayin mingy secondhand boneset cricketer heretofore purtenance kingbolt council honky perfecto tartarous altissimo genius famulus abb tolerant nasion dumpsite impugner fastening horsebox nyctalopia prang stressful woodbine bogging lesseeship jambeau swapped gaff hydrotaxis drunken platonic holdback salep ellipsoid bloomy outcaste elucidator housewares blustery gombroon leprosy gaseous bilberry imperium defroster gelatinize songwriter beeswing moorwort buxom mound enteric rocker precious dancing casualness victor threnodial xciv rebellion crucial dariole notably stockist breastpin enigma neuroglia blacklist teasel shortcake emu amp ditchwater entree lovely episcopate utile extralegal barbershop headcloth nauseating venule strobile hexosan corrie vineyard cembalist faddist giveaway gloss mightily tompion hydrology coly rate rotisserie rightmost alkyl nightshade amenably heritage earthily aquanaut parodist sclerosed enthymeme sulfurous antic ween backblocks still anthill hipbaths isopleth nonliving flyblow timeshare fifteenth dopiness illuminati walnut biting nobby razor barbule demotic grubber semivowel minimality kingcup tideless topknot springwood peremptory porphyria altruism borzoi immemorial loin dobra preempt coulter splint fratricide multimedia hooves resonator catamite allowed pkwy lunchroom acrostic preassign explainer boccie backlight pteryla purulence agape carriage repeat taser lumenal saddleback addiction cymograph bodywork nog disunion vague predacity shylock masurium typhus alkaloidal knead barytes leavings moujik oligarch interwove tamperer dobbed earplug revive paternity grass postseason periscope coccyges bistoury corrector gristle aberrance geisha hunger hawk rooster vii culprit jugulate stadium jerkwater semantics bandanna lowborn plessor faithless grits avulsion skinniness dynamic panegyrist dramaturge shitting carnet bugging pagoda liverwort uranium arrear hardness few primatial cleveite foramen pulsation flexure yashmak pray kinswoman tufa ecocide religious tenancy onboard etna ascend flyway escalade tortfeasor tectonics bedclothes preside rutaceous lung fancier lite pastorali mesenchyme tanh privilege trod empiricism pilferer tile blank odyl deco firehouse cumin dromedary recidivist singing resow costrel rheumatoid oyez pug taconite roadhog lazar adulterer legged mooncalf freesia squeak rareness dereism sentential drift feminism amazon gracious palestrae neighs granitic bearwood ammonify hemmer costly grouch tauromachy taxation moody duff tens brucite initialism ouabain zootsuiter imperious oohs socage cinerary hierarchy hiatus norther endplay purified aseity strikeout winglike given evertor convey jerky equitably dietetics complacent ell chin tarantella printed eulogizer reelable umbel surbase ingenuity mime uniseptate fortunate attractor sporran freehand elegant paranymph succinct horniness snagged papillae simulacrum distribute pedologist teammate cryptogram posterity carryout schiller deceit ignite entoil frag autonomist tuberose treated flavory possum carnivora tractile stopcock monster mislike convulse muddlehead ballute salami morocco itinerary dinning ostracism limn happily decryption towery funfair zebra feminist pose marbleize loath harden blini razz summit motto sure extension beguile wharfinger rad hoggish gradely bullet furry screechy forum tazza appeasable tangelo petrolic brochure outbidding avoidant steinbok pretzel kerosene renovate somnolency machinator bleakness marcescent tycoonery genista henna scaly recrudesce mood conation concrete canc osteopath turbary compile bifilar whelp patsy wodge markdown dieresis throbbing shirtless lingering lecturer referee niff ejaculator notorious stance gypping morphinism lucidity choral overmuch hexameter stratus patten wink japery pantywaist enwrapping bacteriol solarium myriagram murkily packthread epigraphic sash issei exonerator cirrus sexpartite twibill splayfoot ranunculus penates yapok perfidious falsify afield gomuti embryonic schematic nae aliyahs inherence reluctance married raffinose throstle dearth bazooka glossarial arguer daric unmoor unpleasing dithery backgammon surtax sportive prolamine repugn ruderal meritocrat belaud populist spirketing subdivide cliche celiotomy gratify geeky crude mile tropic capsaicin unbending label neuralgic cyberspace separate anastrophe eureka silty houseleek prickly pahoehoe erewhile asexual restless feat videodisc durian gainless preamp flatterer scapular cymatium thematic ambry fluctuant kitted kinship subbing zymoses gam torchlit sassily vitiation ficus anticipant latchkey fleecy boss monodrama wham ternate eighty protective airt refrain programmed subtextual pen reedbuck timeline unyielding hopped dye glimpse aigrette ratel vacillate mouton extreme brassica jokier whoa eviller willy wildcatter anemone laminate nib felsite bounciness webinar canvasback coati board ovary emphases heftily toughen commonage laughable neral ascensive folk colorado dobbing grotesque tenderness bleary sponger porousness workfare mimes therm whereas cathodic federalist choke intine uterine augur wive gingham warship plexiform zip judicator sinuous lustful grape remex zorch hematosis mad skyscape tympany fibroblast strode araceous bebeeru wheedler bailsmen above believed appraise snowberry marshaller chiropody pity laziness curlicue antitank loofah bullwhip steer mentorship visitation agrimony biosphere skinned synfuel instr microcopy cong pollen qindarka ethicize donnish cattleya fruition mooneye decision boring caddie tint runt surround sabadilla notebook boorish halfbreed stockroom tailwind triturate relentless illogic monarchs zymurgy algometer holytide pollster baseman habitation fave scruple phiz hemin melancholy auteur serialize smarten parodic yeanling flagged kiloliter slobbing menhir".split(/\s+/).filter(Boolean);
  const WORD_BANK_1 = "lager therefore limonene giddily preowned happiness airiness wealth dishwater reconvey anabiosis paludal loxodrome outtake cyanic pauldron spectral natl peavey devoutness pandora resinoid denari bedim preteen gestapo guilder bummalo dishy menology untimely available purvey ostium demean thorn tiliaceous ion births clothbound bilbo estafette veloce fructuous clink oppressor peak cornhusk spry stegodon penthouse summable escribe backslider woodnote vagus whatsoever donjon cymographs grenadine infuriate radium melanoid paraphilia disenthral viatica frequent barrow thrifty myelitis allodium fun choplogic trapdoor erubescent drabbest conferring streamer sinkable referrer graceless miff catholicon solenoid bagmen palliate fig calibrated ventose trueness tody somnolence epithelial affinity jerrybuilt drossy volunteer spectacles typist istle chartreuse dowsabel acarid practice hertz idolize aftercare subserve slough brainstorm cathode floppily couthie employee prickle exclusive dago tagmemic crake armor prepotency hurdle sump oldness wattage confounded pandect rooftop borsht souse pylon arm corrugate bruiser emanate dihydric spiteful officiate novene comity billionths kudzu despite nanoid stound howbeit lave glue prostate eructation cheesiness hod lackluster tumbledown pageant flump dunnite toluol dildo isometrics choline coble sandstorm mallei arrow dammed monotypic snug scourer covalence recycle doughy beaver astronomic misjoinder subfield mosey thebaine outbound paginate modded cookout supported palestra preputial elated refashion ectomorph cen subtopic quadruped alp fondness springtail infancy sforzandi poleward deception speedboat jump yellow ballonet omnibus navicert stroganoff prom woodiness calcimine claimable overslaugh chasseing actinia jobless countless probe abutting sem patrilocal demarche spelunker ratafia leviathan gormandism adjourn excellency clonal thirsty thinnest coronation teleost cluster finale homograph shutoff pebbly lorimer bighorn sot sick limnetic cubeb orchard earthen vendace antiquary cornpone acaroid outcrop napoleon inguinal printwheel steadfast bagged jerry foreplay acroter enrollment caution goldstone tardiness fracas fractious amylaceous memorize motorize radicel mandatory excellence edify poppycock ragpicker corset bucktooth analyst punkie deviance downshift trammel seizin broody creese pentane loge issuer racehorse pugilism march acetometer borate doorknob cheroot signore challenged aghast misgive couchette ornithine uncomic trow shelty ginseng mopper photodrama hackie virology phyla galere itself correlate rufous over amorist reflate emphatic ataxic foundling vitamin diacaustic lankily ane probity cabalism ditch bilk cationic busy garnish gulf vacuolar ugly jeremiad ecbolic mycoses barbell euphuist typescript swampy gainsayer chaplet hangdog classifier howdah overstuff dart disputant clergy fleetness goodly revenuer mudslinger stetted distrain metatheses auburn proviso peltast silesia seafloor uraeus skirt glycine organic pickings fenestra frostiness pessimal fogbound underwire prefigure unstinting cribbed tillable outpace jacket refund unpick migraine poseur pensive toyboy switch lupus skew pothead zoysia mechanism blase droid riderless cease enuresis cuneate peridotite freckle faff gentile mix chokebore accomplish inheritor uniaxial literality paralysis satisfying spyglass midden backslid jato kayak camcorder vegetal cadence termless siccing staffman paved thatcher seborrheic solon gallipot fasces stertorous pleasing beryllium sedative cigarette imaginable shanny bride overripen ropedancer visional springhead polypoid fabliaux misthrown negativity astatine wold brimless gyratory inject brose desiccate flocculus workspace waftage facade sheathbill steam aftertime caudad overlive hiccough incitement dreadful pavonine fourth wordbook homegirl reception volplane chunter reacquire groovy snippy simper burble relaxer apterygial rainless plumbago plurality garnierite tattooist cattlemen trabecula caving alibi sybaritic citify redneck humidistat maestoso forager photophore discovery terefah marasmus oospore corniche twofold dyspepsia lodestar sneaking zapping aspiring oxymoron artillery faction ultrafiche osteoclast shellproof arborvitae freshman rappen posturist prawn woman vasa mayhap obsequies chunkiness moroseness anomaly sunnily receptacle ruby locoweed wheezily inciter atom varnish moral forelimb lintel bedbug extrusive transl blissful weightless stature bicolor attenuant systemize danceable gulp harquebus wherein hutment paralyze trunnel inelastic parabolize provitamin brookite overpraise stepfather goosefoot multi determent repaper awfulness stingray misstate admiration siskin clogging writing brevet regret legislate caraway personably dishcloth diachronic scissel inhaul zero irritably antiknock pelham extolling squabble tincture weakling honeypot betwixt etch karyoplasm sedition stopping pontiff jasmine understory passionate animalcule bronchia torsion settler moist boodle viaticum eyespot geratology lifeforms scrawly pettitoes potter mitten endanger cite parasite ocelot dad scaphoid mene centra campesino weed corduroys afeard charactery ramentum hymnody trade herbicide fimbria rearguard blacking seraglio throwback ergosterol assign horseback poult bean dross shear registry eightpence aquacade negatron ranchman aura prepay yarmulka snog malleus rendering chocolate dynameter kieselguhr faineant thalamus trivium pushpin freemen spreader idea headwaiter antepenult tuber unprepared sim som monophonic saver mammal flog bleach pupillary inculcate mangrove fizzy amnesiac headmaster acuate fine seahorse hazard waviness ordinary woofer starless carsick nitride vitality rage bombardier ness explained spit assimilate louvar wheelsman molester gimmal colonizer almandite divergent hajj mim bitmap glut yenta oui glibbest sematic centriole airlock coition backslash toss gadroon katakana preplan cobnut bainite zipper sappiness bullyboy earnings sportscast paradisaic rabbi galumphs pathos punchy lockstep pluckiness parcenary trumpet latria flair aquilegia repelling wildfire slummer specs vargueno faradism misdate sud pitted pinkness infin naira peaceably enumerate headcase bewail maraca contempt varioloid tungstite speedup willowy firetruck coparcener canvas lockout aiguille imago dogmatic advertent safes hardily micrograph taffy damoiselle sheila motorcade ferula stale semiquaver stoplight speiss adipocere limey sphere wastepaper catalpa versify megafauna stodginess compander pomade entail lactase biconvex tinder excrescent unswerving pronounce catechin rowdyism crotch ear overdraw urial react legality survey infantile constant jolliness ballast savorless dragrope dropline scaler dermis enlighten taka codename diplomate farragoes crooked catchall ticklish effeteness dinky jealousy fitly sadness mirza brachylogy rebec damage chromate albite synonym longe bifacial concession panderer flammable billycan coniine mainstay waver justify sturdy built tapped cacogenics withstand writeup denounce slavey shipmate dharna gassy fluorine dryer parasitism enfleurage gelid beefsteak currents minuteman newsy spyware daphne meiotic jelly conveyance moneyless errantry ankhs tantivy washin para microprint stroppy niello adown litany overcool vestibular ancilla hoedown propman silica wingtip fluting aerialist gem shakoes lobotomize mundanity decretory greed tweezers cowage woodenware monohydric intromit quadrireme hosannah eave johannes dybbuk pompom precaution vermifuge elasticity helldiver hindermost swanky underneath epicrisis pectin artificer brainchild smeary retablo brackish propitiate cacao radii toneme bitt turbo doglegging umbrage basalt sporophore vibrant dynode electorate assertions bruising scofflaw rec approach nauseous derogate losel cramming whopping plumbism blogged cleverness disfeature ischemic flaky valid polychromy pelagic turnpike aftermost drone saturant yob initiatory dirndl fjeld bedmate celluloid nominee bungle tendency carfare tamer amalgamate loon jolty saddlebag typing coughs plasmatic vitrify kilometric politic bondholder splotchy cytolysin econ lakeside spliff antique corneous eupatorium glutamine flatted fenestella appertain apiary sibling newsreel decumbent intuitive disses license rudderpost vlf defraud guilt belly blivet eighteen beady thuggee dalliance encomium padauk calipash gerenuk begged irreverent oologic cabinet holdover sepsis fearnought yearly deathful iceman radial glottic epical greenlet beech babushka sylleptic impellent assailable death cheat sarangi enclave wazoo nascence intuition burbs sweven null bree chausses macho phylogenic lush fiberfill quixotry forge gauntness shirk splashy forgetting mezuzot fervor what tasimeter diaphyses cyst gean masterwork admit bromide descry sown joyless billycock brazier centurion quesadilla nerviness apricot eczematous pesto fittest nucleon jaunty chopping paynim woody harmonize poppy idle parkway estimably footstalk seeing brisket visibility wreckage infuser strow below quassia sisterly foreclose radix overbear ladylove outdrawn antalkali sprite branks inositol polymerous replenish tangy squame food saucy dido pallor stardust heuristic nominal jigaboo pork urinalysis zeolite tuatara chastise oarswomen satiety fabricant restage scalepan dialogue ingress pinnate grigri elementary awesome jock furlong interrex argentic gonfanon trifling underling maelstrom carbuncle borrow theta mishitting inflator changeful imitable semigloss quark attentive mucin dessert kink edited eminence planula acetous arsenal canalize badinage sib islet commode sherry babysat rangy lisente mudslide exploiter meld plena highwaymen tide fortified nonpublic galingale quibbler lunitidal snootiness itchy bury enthetic eunuchs astuteness glandulous fisheye horoscopy pertinency hoarhound speech misogamy see swat primer trained chromosome hamadryad originator haiku confocal modernist cleat postscript kukri uncinus muskrat hackery seer accustomed racialist academism jaywalker siege photoflood soup wanner footage scolding fund copulate dubber burgess sparid myology fecund convivial breakage hardiness morbilli councilman cursorial silo mixer malodorous sebum doberman propeller cosher uninsured toeclip dogvane acanthous mucoid forebode prophesier redd overstride prov vocative oocyte yataghan tempest questing friction glimmering storyboard canoeist obeahs schappe tempered booster unction horah epilimnion precess paperbark testiness lapidify tenacity meteorite anthropic expectant compulsion villainage concubine hardened camass attainment monism entoblast crenelate dandelion basinful slowworm zodiacal dragonnade fingerling pauperism campanula christie breastwork ardency artistry yaw adverbial ranting plenteous sled broadsword boxthorn inveigler chalkboard babe rank tampon cablegram hypothesis stonecrop logwood mutagen ingraft informal furze latitude expertise directer quittance quantify cockamamie fluorite involucre great loden soundstage levelness sinecurism thin pennoncel ordered cicala chainman goodwife turnbuckle flowed slinky adonizes salute telemark menage theropod axillae bxs casebound scanned flitting jumper sporocarp resample latte anther calabash goalpost scrannel gunning assonance exegesis inhumane variable badmouth rated dimple mephitical xeric contiguity lyric scaffold seedtime eternize houstonia splutter groupthink conformism avuncular tartrate kyphosis ribosomal mestizo lindy enqueue lumina pigment bowse cushat curry heroine tensioned orderings batting rcpt meatmen peanut kludge kaon skirmish virus formerly theologian resin locality enemy dichroism byte pleat lender applicable pheasant comeback nonjuror potiche landlubber bottom giraffe glaciology hobnobbed brander superuser tried marbly ascetic barbecue irreligion jew ligation helpless bombsite shrewdness spookily leakiness xxiv blunge wagonette readmitted junker schooner sex incandesce icicle accroach compensate outpoint chuckhole recharge gigot borrower hippo workhorse bannerol big discovert eremitical ceilidh branle launderer normalize helotism recusant hummus simulation nodded immobile mus meddlesome rowdy theft stingaree twopenny marish slovenly polar beseecher sighs microbrew nonsmoker datary signboard sneak wamble studier mortician aspersion penury squamosal funnest detruncate helical sedentary staysail gelled overleaf hybridity housemen meta ledger clarion euphonious senator quant solely gadder canniness trepanning trustful lattermost disclimax plowmen ectophyte bluebill schematism prosocial curtail bailiwick echoism lallation cutout learner roast brassiere cultivate froths newton sunbow homeowner plushy lingcod rummer corvee deferral bustee ism gasser bogtrotter petroglyph reverent waxiness uredo recurrence maraschino each tyrocidine sedan peruke cupric flashbulb subtrahend blesbok eulogistic abundant avast decathlete cropland simulate icing blister jogging henbane benefice erroneous prosperity bask shocking revere highflier taluk removed rectum surra subject adjacent aweigh app herbivore immolator blizzard delusion showmen alabaster workaholic extolled bridleway uprise underflow merman segment metal swigged shalt bourdon tetrabasic doleful myriad majuscular completist sleuths talcum palmitate moschatel judicature warring isostatic retiary ganof flesh vocalism peekaboo sacculi oolitic aleurone pseudo godparent paronymy opinicus spiritless editorship abatement washday ormolu hereinto kauri tilths discussion wrongness ministry levogyrate rhapsodist muscadel rearward ravager flouter hackberry haloid rumpus chromatin hamster brachiate myrobalan hushaby cupel earwax blazer inkle enplane tactful tiepin quest spherulite enmity discommode accountant woadwaxen typologist lingual eversion backpacker highish confession twill gabbing symbolical tidewaiter sapped runtime factoid flocky btry fogeyism virologist charter soma rosemary plasticine painter zecchino casebook teratism stipule correct librettist commence wolffish tent entrap yep foreshow tramp peng shot imbalance ectopic negation woodwaxen epicanthus meseems threnode management rhymester naff homemaker playschool xanthous brocket charwoman clyster shamanism folly jumpy laddish imam nasty scintilla iconoclast cinerarium hydrograph citadel oogeneses conformity digestif pothole rundle fleabite loran infanta stably bregma barium pyrogallol hottie pelecypod amaretto headwater dine infirm nigritude artesian catnapped tatting mutagenic nomad entered hazy wimpish backdoor xebec groupie coupon quiz perpetual synovial fibbed aquatic ladybug playlist such watch election passive expansile oilcloths practical torso sparoid esse cyanotype kolinsky callback upgrowth photogram construct german develop bouncer xxxvii buyback chickpea judoist aldol redistill impresa somerset ricercar acoustical chessboard placer scupper scandal forebear plectron gnosticism buzzer piedmont neurology blood flexibly alcheringa homologize microfiche hydrosome hidden tracery baht vamoose whop caprifig delphinium interwoven chessman turquoise scullion lustrous fag interments hen awake error saraband homily saddletree colicroot chemmy heliostat lire rarefiable advection median rhetorical fire salinize poultry sapota hipbath along pushcart defrayal handful ironwork afterbrain fallacious irascibly hemihedral bandsaw cnidoblast freshmen antisocial analcite lysine uremia actin hotcake vestryman cleric catch gumtree spouse bandoleer disposal reknit hectogram pic nonmember owner cymose sketchy clunky swapper scratch grain emptor whensoever archlute eider palmtop helot supra hexastyle kris ectropion rim tippler poisonous labret waterman maravedi fumatorium seagull autogiro biggie chugged fixedness mysticism seven vestigial firmness saturate stylish diacid fatten vocable vagrancy gestation demark kilonewton polliwog stimulant reversible hydroplane mimicker calvary hemicrania dragoon trumpeter distinguee wikiup mellophone standee bestraddle actinozoan strategist occultist vaccine payback playroom jiva monkfish ethylene sequacious sudorific scarabaeid nocturne elicitor necrologic platelayer synopsize chaplaincy dianoetic permeable gamb gastronomy classiness tawdrily calender paperboy gradatim garish incur triclinic josh trash empathic gilgai hairless oceanarium heroic crocoite haggadist gadded venae audience windscreen sateless fairyland cheapo mantrap numis hemlock vicinity assassin pedicular tray enlarge pinery iterate photolysis kalpak fantom duelist serranid pedophilic zabaglione orthoepy peccant paracasein caw bogosity comminute marquee cavie zonate graveyard fusilier homotaxis thwart cosmical overweight chatroom cyanotic ripieno indef fatback hypnotize graphitize twinkle mayhem leather dysuria reverb maltreat nipple hydrologic dietitian spurt codger opine supplement bleeder consular rhomboidal kindness litigate scrubwoman kinematic khaddar chit ploy baptist smaragdite beeswax prehensile directrix arpeggio index phelloderm botryoidal coop siderite fwy paperclip mkt compactor senility pileate fustian stylolite spumy saintly magmatic oversexed cowpat touchwood bassarisk searing squidgy utility chrome stinker watercolor soke reffing chartist sequencing sheep beriberi away caravan smoko tyrosinase piso unload sozzled glitzily asymptotic balance patriarchy expanded belemnite modernism scorn milled earflap nostalgia succubus appliance meson tautog tenon explicably scorcher duvetyn vintner policy baldpate hydrophone scopula asphaltite hydroid beheld osteopathy shagged pizzicato cloy bridge playreader greenheart griffe entrance okapi antral val outwit remissible innumerate jostle versus gearing counselor maneuver damson actinic artiste unrepeated harangue blocker frowzily soother ally naughtily unique auspicate consumed clientele purser bronchial foreland prosciutto dependent compatriot courtier greenish serfage phyllo compere painting settle noisome precedence fatso bassist petticoat cosmologic prenuptial bulky indign rarebit scooter prandial jawline amphimacer hydraulics briery baron pleuron whispery zonal shadeless kinswomen futhark cornily crypt tater byway punter hairspring withheld sarnie fabulous crescendo clingfilm poorhouse spaceship fryer lues basenji abandoned woolly patroon emperor bulimic margay durable mentality spotter expert topic dragline weep girths surcease cradlesong maiger bodily pibrochs perjury nondairy coachload optimal valuable rummest cutey anemia scabbing olibanum cordwood causality tubeless lank euphroe ozonic mantel calcite fustic sewellel listel megadose pancratium quake polyanthus marchpane macle unisexual borne entomb lint ass slog equipping framework smelliness fattest obligator nicotinism corncob rigorism presence marketing transition answerable repertoire percaline dillydally centimo diligence devisal ruse sibyl condone nonvoting pragmatic xyloid deathlike oilcup catamnesis sweetheart protesting fibroin strickle tribasic margent ocotillo dissidence confessed eddo housebreak putamen centenary thyrse squatting confused unloving kept smirkily drumfish nest befitting shaddock dribble greenness dedicatory ropy nipping dumpling tine torridity alforja philol crotchet fingermark zamia tepid redeemable sway cermet liquidness vegetate muon malcontent headphone recreance downpipe actinium taxonomize cultch humanize hessian overmatch nagging crowfoot velites nauseate condylar melodrama did spurring guestbook wedge interwar mycosis manhood myrtle exceed autocue vermeil dish carnauba cattalo tinhorn fraternal magnet actg noncausal knawel hubbub shoring caldera simpatico sidelong cartwheel yest isosceles zygodactyl patois treeless bistable planer hotting gasbag okra coital gaby spirituous corporeal mannish sourness tolar pastille payt societal lowdown doctoral chancy centralize forerunner embosser afar avoir ducky carven haywire unilingual dormeuse kindnesses soundbar risk seesaw turgidity weenie nombles syncretist bunkmate feedback carline telly catechol tabulation assoc volcanism cabbage dysplastic geodesy phlogopite goody vina backrest side traveling hasten rhodium shanghai downstroke anima trapezius chrysalid whine tramway fumigator venerator hypha dyslexia clonidine rooftree demirep landform insist idiolect paparazzo solenoidal loudmouth aeronautic parol buttercup morbidezza chinning surliness talus coracoid ting poetical auspice unlikely flamage paste isoline summed tenfold tenderfoot loathe safranine ovenware incinerate cycad villain canner plesiosaur curbing abiotic place dealer terracotta pontine tamale licit agger stifle sericeous justness catted admittance diddle blessing bedmaker takeoff slotter unseasonal popeyed convert cake taste valvulitis frigate plane solitarily sorry petasus olein inosculate underwrite patty ontologism albacore cork ambitious dorky dissonance steerage throttle baba dribbler neglect doorway cellulitis perfervid fro maximize heterosis frightful potholder khanate phonologic surmount mocker moire foxhound gesture granary crummy unilobed folacin rebutter samisen fluid airsick demit ethic groundling greyback jackstay uncourtly juniper azo kegler remold interrog exordium coffeepot feudist beanstalk consign friskiness uncanny hokey perforator seiner cigarillo staffer hoosegow vaporish ellipse loafer packer decorating synovitis sandlotter bongo tangerine pillowcase roadrunner palsgrave relique dogsbody topi chenopod clos epitaxial macron reaper serigraphy liveried uniformity lacunary plush creamcups overbold malt pita deflation hazel rarity actuary misread aftershaft ogreish indigo boatmen affect button curt nullify hamburg surfaced burden muckrake dominion dizen gladness wobbly trainband faena principate looseness spathe woolgrower capitalize grokked pemphigus craps boil yam dilute barm marron feeding senary sappy conjunct altruistic tuxedo mysterious eagerness paycheck amorous internist conidium diptychs summa grille enfeoff corollary tessitura incident syllabub tern exr manganous acroterion planktonic tabla plushness buckish goffer victimless frolic aecia odeon allergist epigeous gourde lithograph snowcap progeny embower aegrotat watchcase bogle underfoot abusive pizzeria dabbing grue ileostomy convoluted cameral biggin falafel cured optometric neoterism precondemn mihrab dune backfill goddammit nookie esophagus corgi endnote threefold kowtow rode oddment monas unsellable intrigante heritable cryolite vaunt inexpert sylphic aim urethane fax humbleness satiate holly outscore tapas insurgency gorge goshawk swoop authorial nosology scandent honorer quavery sheerlegs cervelat anchorite cardholder squeezer canthus monger phrenology vivifier atropin dandy saddler treatise coursing offish turmoil felonious wise anabolite livre salverform sluice eolotropic beanfeast tressure violator eustatic puncheon simitar prosodical amid commonalty squaw sucre hieroglyph atria landaulet yid idempotent locomotion kip chron gorblimey overshoe anon transcend inviolacy guimpe everglade botch outgeneral signer goldbrick dauntless evangelic blushing exaggerate preslavery monomial deckhand relume sedulity ileac modular olecranon inmost merriness negritude cystectomy mimicry faithful matronage hexad fifths schema some blur pyorrheal bijouterie hexaemeron animosity feaster balmily nonfat dub briefer mice skysweeper hover poleax zoography flattery beneficial sipper sensibly interlace popcorn towhee antipodal integrable abseil doohickey snakelike irrigate nonracial bellarmine coiffeuse bawl unblessed pye grave telesales revert dotard toxicity pantheist vaccinate wally hacker pudendum bacteroid geodesist triangular gangrenous sepulchral fornicator whalebone whenas hypocorism exogamy credenza irrigable bemuse resigned incurrent acrolith lardaceous ditz peripheral renounce assembly circular rehab neat friable scutter bedrock cathexes dominie isologous heroin preclusion superadd trackway substrata noblemen meadowlark laborious leaver maudlin ambergris upsilon recuse chicanery impresario cuddy played embank desalinize nephew wheedling downtick bespatter temperate stimulator couturier rugby mappable rainfall punning governable bluebonnet silvery dissonancy burned hourglass veliger sister ritard tyrannous amicably neoclassic canoe catnap tarry glutinous wore bookkeeper seborrhea radiometer crosstalk metacarpal cower platen hoplite juncaceous overbuy lacy retentive ninths flatus eleventh sombrous leptosome subscriber aphasic traumatic shameful sargassum edaphic ragman lifeline repro coccygeal monistic captivity pitiable idiot whiz assert terce genes cumuli hypostases blamably zebrawood nylons punished sequential sexily fulminator horsier garfish sugariness daglock straighten formalize trinketry isogloss retain sable hippodrome botanize gothic adroit result topmost skinny remedy snowdrift olla exposure amusement pester sexism chaparajos lemme turgor bronchitic monadnock rude homoerotic animato newline amentia fart astrologer refine heterogamy japonica turret flashiness monzonite politicize malicious inhalator grimness severe dyne alb propylene athletic gagged durative neuroma flank coterie lur tellurium uptempo ductless leading manganate lithia aloe capsule classical nutcase opal cheerless surrogate piton amine groundsman ecumenical tarmacking pectoral jus careerist viridian mollescent storiette sturdiness hyraces assemblage facula stated allomerism dialogism bookshop tyrosine causalgia exigible subsystem sente execrable gamy ana sopranino sequacity posture aragonite ageism cathead abortion antiar pollack zincked musketeer headily induline uropygium plover maze diptych monsoonal too camphene roamer embosom diplomata tipsy pictogram spinal kheda pulmonic gunter variant gagman downgrade spiderwort novation natal smite champion detestably gunyah laburnum jibbing pellitory allocated artiness stunner clxix gladiolus cough troll toilet pediform cupulate adventure neology treelike lithotomy depressive legal guidepost viscera rachis mopped flaunt defeatist votarist inurn caudle gibbous monkey overlong ankle cobber nowadays piggery catatonia edgeless swordsman miso jarful brutify attache considered att trialed noontime upped sri nephology mirador rheum elapid squeal lead flowing determiner voluble amice columella sneakily snugging classicize balsam hanker nascent scurfy fishmeal diabase whamming misshapen anchoveta frumenty horotelic soc blade covenant rasorial birder supertonic torpedo defamatory rump photolytic poachy tattler unmeaning remitting fantastic halocarbon blackmail guideboard viscosity offprint categorize marchland isochroous wince fragile fauces mischance perdurably seaworthy dilemma pectize uraninite omphaloi meagerness revoice molter punchball arrack adder festoonery gong periapt chumming chambray minx hypoplasia dracena limerick gymnast notarial dep antimonial malleable tuck morsel affettuoso edelweiss poppyhead danseur insatiable oculomotor feudatory magmata rottweiler filling glauconite morganatic melody horsewhip dissogeny sordidness cabbalas chauvinist lyonnaise thrice opportune lackey firearm communion preshrunk glasshouse yardstick stamp hexapod impassably postulancy nugatory tire craftily somatist episcopacy coverall sundries florilegia saporous crescentic ululant windowpane bullheaded charkha puttee handspring gear realty epicycle apatite demand douche wanigan whinge kruller erasure ixia passerby sporting girdle straggle fyke farina gotcha heave rapacious parade flight spiritual lumen merino dipping gummosis inmesh bedabble nonverbal helpful vengeful capuchin cantingly cottonade gimcrack embouchure ironstone checked biphenyl chiccory causal arroba dustmen rya parricidal nuzzler luxuriant fastness superload ricochet polder satinet boycott entente epigraph synergy crisscross fledgling pluton bipinnate boarfish bobsledder snowy employable effulgence diphtheria spiritoso flatulence study webfoot verism scagliola pistillate digit myrrh ogre taco hematuria lounge sunward toxicant non swizzle shirtmaker scribble dunghill psephology fustigate meetup loti grimalkin unknowable motorway senorita pome toupee lorn laminose palpitant lit bowyer crook sunwise touraco scribal moderate gendarme cytoplast ampliate obtuse mastiff featurette despumate growl altimeter saltern sorptions sunflower stagecraft lapsus approvals scotch shadoof workbook expellant fugitive fang berate acridity nephrite impalement kiblah blotch widescreen shipborne lactary scatter integrity crookback outridden gyration seaward suntanned handcar cornbread gasiform breezeless glucoside caravelle rentier veneration unstep maleficent clique bogbean copier shirr towel hetaera dementia shedding clammed zitherist imprinter didgeridoo vogue azote meningitis overthrown sensor cannonry bellbottom lagoonal eradicant talker fibrinous licentiate christen savior vitalizer positron asked skill herbaceous plutocrat precatory tesseral musteline empty narcotize unwonted portal cheese procreator loathly perdure clear housework sphenoid heftiness admonition credence ayahs literalist saxifrage phyle ergonomist vernier enceinte velvety revetment escape limitedly amphora improbable aperient homophone clubbing journey conquest slimmed cuspid optimism gutta divisor adeptness fowl dirt reparable ulcer hygiene pleasant jackstraw clinker ala genii conical froggy within venomous leek eighth askance muzz fitfulness shovelful insertions prototype bespangle impeded univalent dupondius glamorous snowshoe overhead glomerate nodule cachalot ceder mildew euphemize rialto prefer wholly autosome alicyclic widow aquarelle cheapish cuttlefish splendent genet anointment viol sclerotomy bedwetting assumption endomorphy sateen vernalize unhandsome cattail realistic aphorist ephedrine stomodeum storeroom balladist carragheen posset astonish drafting swill kebab lysosomes outstretch carnassial inure wrench spoondrift dispersoid curly resentful capote polygraphs mounted upload serrulate goes duumvir fightback admonitory nonedible aleatoric inconstant deva xterm dogger hunch whereunto saddlery unsubtle copped subarctic triclinium brownish jamb bakeshop glasnost stitching prismatoid dedicator slitter fantasm sedation urochrome oomphs flavoring bagginess goosy wiper sufflate dreamboat mobocracy smartness debutant parameter deicer calvaria wimpy breeziness kopje ariel avalanche ctenidium paralleled endemic dentiform floribunda nanny secund reeky ballerina knop roadkill lecherous seaport matzohs fluidize naker legman nob severity bleeper darken bodice armillary bellhop multifid chinkapin inkwell bullfrog criterial sharpie kinsfolk silk annexation legitimize dystopi atrocious mitoses astounding fagged litchi largeness scratchy pythoness bopped fishworm injured accessible offside lankness washing ethane desuetude goa sigma monovalent pallid incommode pro postbag unathletic purveyor fermented amnio outfought consortium echinus philistine bedel neurogram bosh catharsis flatting beaker heirloom locker roe deployment serval mallet digitalis sarcasm bivalent balminess carmine paddock shelving fanning sunproof quotient isotonic gobioid surfperch grunion forsook cosmetic regardful store biophysics protected insane duty oxcart ribber pyrimidine polychrome orangy transpolar exert mangy pupil lad veges overissue sparseness fidget citron kine rewarding antagonize solidus kuvasz lacquey shredder impelled surrender waifish outsource demo commutable aneroid heathen ocker protohuman intellect febrility lenient luster druthers pettish pianette chicory vasectomy regimented body preludial plausibly sheath ambiance additivity anear skillet ozonize batsmen celom pillock larghetto dithionite tingling equatorial shh daubery nonslip swabber permeate morgue look clementine frolicsome phantasmal mineral inadequacy rockling faunal biretta packsaddle invigilate dank hologram polygamist bespoke candescent hazan ascesis glib crouch niggling firebomb sorted baldfaced prestige vaivode trough bitumen landowning ultralight tiny breadstick polytheism subzero stroppily bologna thresher arquebus solidarity urethra skoal hade autumnal waxplant oxymoronic reradiate mitigable noose tinstone nontaxable newshound coliseum rcd underline judiciary handspike clemency overprint panada palmistry tapis tomahawk triton berk inference chyron otocyst drove slumberous theist rheology knocker joyousness swamp baudekin adenoma aecium volcanic xanthin generator vane jipijapa burgeon unclean awareness gomphosis bisque shmeer immediacy space sennit sciatica veil website mensural clapped satirical pyosis yuppie hogtie unbuild peppercorn stolidness mealtime acerbity shrub shipload consol teen bacchanal justified patriate manubrium crispate cursed cloison unserious endmost noxious bagger batt weka nostology guacharo streamlet iii command quasar mudskipper ventage projector lilangeni odium soundboard militiamen colicweed creamery lamblike rootstock animist strainer riddance blanket fleecily sternmost brownness combined barogram arpeggiate fellatio remanence drumming subclavian fragrant vitiate bouquet crim intaglio cenotaph tutorial towpath bisexual isoprene pinguid garter homophile buxomness mgr outweigh disruption grab savagery gaugeable cretinous kalends kafir frumpish wingless unexciting top funicular sectary lynch plash chivaree pirogi laic sewage eyebrow nonnuclear vinegarish contently inventory gahnite oidium birdying prate inimitably thermos footwork leathery lighten leaden equinox gorcock pret emporium lowery aerie quod diner falcate almonry jellylike beefwood ligroin phosphorus sundew holographs piecemeal enclitic teosinte inodorous wraithlike turtle fibster shop stridulant abasement indolent avdp flimsiness airdrop whitetail abiding ratifier autogamy mouthpart wheelchair quivering perversion kidnap sfumato gregarine chancre abnegation affinitive biogenesis sodalite indention oxtail dacha clinician imidazole cloaca immaterial reek gulden panoptic ablaze ferrite coastal gearstick lemon arrowwood outgoes bashful spital bename cussedness composer bavardage septuple tamed loftiness presort briquette matriarch niddering isogamy preglacial dampener fluvial kaphs chloroses pedagogy depurate trollop elevation exoplanet croupous foxglove heathberry greenfinch gelding homeroom baize armada bearable suboptimal netsuke exclosure cobaltite limelight bursitis ascites troughs deliver footworn tricostate teddy morse misally vixen flatwise plague devastate adorably vicious avoidance crepuscule affluent workingmen hayfork halm mainstream bijou cornmeal rhizotomy sidewall fruitless sinkage memoirist oologist assistance exotic intinction jugging algolagnia questioned guvnor referendum septic padre bowerbird imposition proxemic drawstring residence meet overplay demonize abettor labial blokish malignity cryostat marinate pathic mendacious preemptive joviality jive obcordate folktale mainland strap heartworm bebop sasin halter iciness weedless bouffant dysprosium cankerworm locknut cortical baroque chitter journalist nurseryman denigrator groan portray carbs burglary swallow patchily bookseller summarily humidity mandarin probably magistery sundial evaluate graft choroid cesural flattop effluvia chetopod wavering whin centreing gangrene socialize mimicked restrained enriched warthog incisure bonehead karyosome edema cants linkboy liken mobbing balk trip location plenitude aryl throttler allium ravishing frangipani eternity swimming footrace placed railwaymen value holily gunny hotfoot sinuate lithology swotting increment foreyard thready collegian cheekily stockiness egress payphone biradial dead follicle breakneck fathomable acetate slaying tumulus aloof globulin goods immoderate gemsbok craniotomy shuddering mopboard encrinite bushland dominate noumena moment dugout smiley confine spicule kief sorta robbin sienna petal seafront multimeter melamed dreadlocks plaudit isobath calk dentelle viscus lower covenantal mutation vehement latten caliginous int emanator hooter electron setscrew pilchard whirring zoological broiler trichome skyway disaffirm totemism depravity scanty pharos mineralize tearaway charlotte convene shinguard volost ostmark tache spearfish sphery pawnbroker widthwise say backspin massicot alvine avirulent biparietal alpenglow despise gulosity bioreactor midyear sacristan ungula cabstand prostomium uretic marrowbone disquiet helve welfarism caveator celesta destructor citrus pulsatile delate dairyman beneath bookstore detach botany plowshare rockfish semidome harp daemonic pentode dol cabriolet valve slackness bespeak feudalism curtsy ornithol coastline ambulation cubiform cystitis onsite cholecyst umbilicus stokehold car abrogate costliness vegeburger teeming plonk bargemen fidelity ultravirus diathermy agraphia termor waterage coalface homicidal phocomelia muenster ashy flory formatter prohibit roister alleluia extinguish haven ridership rob foremast cad verso adsorb gauze hypostyle fetor overdrew terrorist dissolve unmindful scrumhalf phatic safe earthmen weariness multivocal gin slammed nomarchy lout fink philatelic deviate algorithm towboat videotex dome wright peptide illusional regional solemness freq epizootic rune drachma shaley preclude nurture garbology pax lagger grammarian chili spatial hombre sunny woolen dooryard mudra straw dustily vittle auramine journeyer pupped embezzler pith pyknic carpeted manicure excusable doolally wholesome cardiology threonine cohune falchion stumpage turban composure raunchy trematode subversion passivism laureate yield gull meronym elide couple pressie proposal maquis piddly suspected monolayer melanistic sudden whydahs wigging togs unicuspid override merit occasion gyrose trench one jughead bronzy windbound skellum humankind tanager hilltop claustral notion tbsp dict jingly reindeer cornetcy precarious officious cirrose marcher patrimony emulator sandbox ambient drivetrain pula gelatinoid brainwave care sissy cambist skating merle misbecome mesoblast amyl salacity gook whidahs biochemist tallage keno diameter drubbing deplorably vanilla seitan suzerain ankus pillowy cannoli epiphytal image immorality toddle ketose veniality logography spindrift vermin dysphonia cumulate suggest rewrite deadlight pickax sunglass outreason reimport cute hem cornaceous cafe patriliny handless fistic rescore bregmata jigging easing corbie moonshine walleye squawker hickey exposed cohabit ragwort acrophobic amazed nascency stutter lovelorn ency subsolar amazonian countering vouchsafe lobworm confidant tench udometer quenelle reliably seat torchier fireback theurgical folio typical pawnshop modify pentastyle extrinsic thing tentage setter mugwumpery sluttish favorite prothallus canonist definite virulence orality riff alexin topfull mike lucubrate immunize inductor mercurial cesspool wolves targe panhandler boatel missal vegging rajah execute interbrain antipodean circuital clarino solemnness footpaths permute wheeziness pretor scrapped intercity baptize bogymen identity leucoma gingivae poetize crossfire desiccator cartoon cowpuncher locomobile heelpost woodenness deferring lucency estovers retractor unchaste tiebreak packager funkily unwieldy trypsin parkour waggly wilds boundary sirenic learn slinkily obumbrate shack jack overlord trine show waterfall transeunt firstling rotunda incubator improbity corsair carousel lii meme skald barographs dithyramb recordist interview estray dashboard diablerie pail whatever propane crutch antinausea caroche hilt hinder coverings bronchus snatcher exceeding ordainment wheen cast tantrum catabolic stabile dyadic septuplet arid scrota slattern yeoman yawning auricula cataplasm plainsong neurogenic burdock lucubrator sophrosyne bize paywall browser hegumen ahchoo octahedral sat submarine virescent apothem rockoon thickener fanzine subjection clxvi pugging quirky almanac druggist bitcoin snuggery turpitude amyotonia tactility mutational unwomanly horseless jotted recorder goosestep aloud shape oculus willed gyro ridge puristic confiture stocking gyron nostoc katydid osseous terrorism definition mustard colt hook palazzo mourned baffle dermatosis bandbox futurism glume farnesol kilojoule modulatory diandrous calcium poncy modiste curved chrismal magistral tease tourmaline leptonic prelatical demigod cementer mescal yucca requiem diopter dorty emmet huddle retrofire ragi kinda adamant oldster sauce italicize cuprous brakeless homemade emigrant heaths jarvey fathom mail outdraw pleurae wove sooth systematic reedy whereinto pretension gawky lachrymal grouping success bosquet hock matzoh valerian mineraloid fanfaron conjugacy filibeg omphalos cucurbit midrash rabbet birthrate butyl taken froward nosewheel roundtrip washrag chimney fado rufescent gemma resumptive thiamine exciseman isooctane raunchily sapor dip stomatitis hydraulic motion footwall zizith catalo wade chaff tenantless villous shortening placental dungaree severable notornis slabbing aero furn congest fermion eikon aerosphere enjoyable traumatize coaly lacteal synodical kernel amberoid lenticular loft phanotron murder diaconicum entrain goose eugenics biasses signal crappy toilette drip pongee colza stray blowzy overran bureau ravioli prolix aquarist diplomatic shoemaker gradualism broadband solidi redshank expel priced saltbox poussette recreant magus casemate rosebay inflatable deist stylist miscount lay pistachio barkeep alary circumfuse calash find subdual stillage downpour apian bough gumwood fascism lamination sloe mordancy fabliau adhesive deduce wandering neoliberal shipping boyla quipper accordant spotty emblem litharge tergal hydrobomb conchiolin throne queenship advisory grimacing outpull rhymer pooka satire gelcap crimson concave dopa tensile adventitia spirula bather nonissue buckaroo whirlybird damageable wheezy flak sapient boudoir footnote heathenize shoat certain zeitgeist eolithic fiction communize sike domestic offending chipboard rhinal maffick pederastic trinal mara spiv barrier hemoid jurywoman behemoth miniature stinky spoilsport subsidizer generatrix establish surgery vociferant sottish salmi inhume perishable sixths loach jowl barony ilea funky pawpaw bimanous bull wriggler inviscid flashcube hypnagogic lonesome permafrost most coaxer hepatica purine clerk shoreward sessile barrio rajahs patienter masterful poaceous scutiform flipped sweetcorn lansquenet trihedron grassy nephrolith rifling deadpan toilworn sledding droshky tripoli tram doorstop consent doornail runesmith acceptor saccharose printout carbineer cricket cowhand volumetric abutted dropout jampacked curculio interlude elitism venerable reckoning sarky baked polythene occiput bladder plank galloot woodland mythical and subtropics blonde halftone scammer oversold lighted rowdiness backcloth royal commune timbre stimulated curtain sphalerite ravisher retaliate gawd grabble holiness ponderosa cathectic flogging rigidity minim puzzlement replicator digressive noplace cioppino cracksman polygonal sweep pyromaniac platina debugger bearably sleazily metritis when dependency spondaic manumit churchman broadcloth osmically rubella forlorn saltant manor fighting entrapment lemming strongbox mistype langrage questioner twopence tripe firth guff euphonium anilin sore highland kobold former chanson often amygdaline eyetooth shitfaced flippancy undulant well backpack obstructor plopping tarpan rootlike reciprocal trajectory all brashness outmatch sociopath handy bugleweed rale hoarding dripper foretell rationale keyway ripple dustheap gala recessive avidness stria television kilocycle ritualist charterer burnable senescence lamppost different convict sire immobility asafetida futtock anywise exemptible foemen broaden moonless effuse ventriculi gunpowder joyridden cosponsor caulk rupiahs viperine radiator branched academia danish pyrrhic cockpit eidolon decrement bushmen taught collate microvolt talliths boric ream hyperbaton pram benumb vital suss excurvate vizcacha pinniped bruised rye decollate dimmed bandsman googolplex untruth fum corkscrew trenchant limpidity atomically oncology rectorship midtown iminourea lavatory proper housel wishful agnostic haggish asthenia fallow pliable miner handicraft lipstick earthly linty bloatware polyphone corpse glassman ancestor worth scarp pruritus rammed kiwifruit fascistic cognac cordillera lorikeet real superhuman skittle confabbing chill syllabism jackeroo democratic molality syllable feudality bimah necropsy compulsory kneader chador woodruff homey crusader goiter disserve grogshop tarweed triumphs rigged conchie remember geomancy comfort sundae skyjacker jetport pansy lev actuality warbonnet dysenteric anus fetus windfall subdean authorize systole masthead buried mastaba alveolar amoretto zoonosis prosector spelter thuja elflock wakeful havoc resurgence statvolt negotiant holeproof sop filicide worthless tightener ferry rugosity centipede sciomancy patrolled exoenzyme bulk multitask tumuli touchhole haste tormentor chronon cervical horology tabernacle showman postnatal culvert tablet lory tellurian waterlily foofaraw until chabazite wiggly partaker motorbus orthopedic convulsant obeyer stillborn embedding sunniness hull blurred firedamp overtire ephor grume orometer amidship cementum immutable perky yogic updraft locatable sheepskin bandmaster plangency sensuous lumbricoid fraxinella anodyne keek checkoff gigagram cheder pipage endometria vanillic backless serotine hoofbeat suitor wrinkle bdl penguin wareroom henpeck facecloths chrysolite capsize purpose spread dippy willpower ammoniate leftmost loose qibla botchily octamerous innoxious discussed slipstream nativist dubiety doxology fallacy poaching sinecure privacy ululate moonlit flexuosity digraph cockiness automotive etesian affright gauntry subjective mural rented concuss mammalian gossipy headlock complainer chair ableism permalloy residue upsweep scope numerate mortal muscid zillion folie limousine scutch antilog northern freedwomen grumpily dock anthracite sinning frigidness acidotic followup pedicure batmen suede plutocracy giro offeror lushy mordant calcine charmer lido gall broadbrim dinginess mot dyeline enallage seaboard wellness rapt zone bisulfate six registrar finespun cyclostome inferred falloff lengthy introvert resiny cresset cleanse peltate speckle monastic motorcar abundance holmium revanche serologist stenotic slaty saury scumble crabwise bowdlerize whinny excursus trivial wreckful swabbing beermat playtime cutesy recontract mending matched songster accepted respondent bestridden throe hedonism reboant crimple windproof sculptural ripped roustabout mycelium felicitate hypodermis unpen paranoid faultily isomerism snot defeasance ptomaine ride calzone overpower heterodyne strangle liger lovechild chattiness gyronny trunk stochastic sage congregant graded geyser aggress pipping conveyor deluded aplomb petiole outlet wreckfish cowskin shagging tryst standing dyke bucket recoin estrin fontanel stellular speciesism analysand flinch tabescent reversibly longsome godspeed niacin proem bestir desert ricebird ruthenic eclectic biestings chapman coaptation barrack famish postbox distracted apartment twixt toadstool epanodos jalapeno nibbler alleyway casting methylal averring pixel septal anarchist cultism kulak crippling maulstick comfy timbal eyelash mph ravages venom patronage vulnerable exempt megaflops bibcock segregable phlebotomy jogger flipping aisle ergo failure unsettling tenet technetium unthankful cellarage laundromat neurosis exclude kingpin bawdry cheesewood crepey kidnapper aptitude provincial equine churlish quadrivium sumptuous seriality floodgate virion autoroute wettest gaudery herbalist difficult boxberry mainbrace ambulatory cutwork somatotype entropy reparative glaikit avertible facture pandour disarming faradize addressee alba subdeb aphesis presswork tarp radioscope bezonian percentage pkt cedar yttrium guildhall coinage diabolism chemism digitiform plug madrasahs sketchpad dimorphic shooting expedite impalpably mainsail deodorize groszy heathenism pinata darter terahertz menopausal mediately redlining eland entozoon shoran carol basipetal nit runoff tour envision ironsmith misthrew troy cornet monodic bleed casualty snappiness syndicate codling shortwave patronize bitch croissant bowdlerism crane hortative anastigmat splat voter sickish transship elliptic min methodic watertight amphorae monomerous guanaco galbanum amused lever phrensy abattoir misgave gammer smock nonmotile mayst saucepan effortless maturation spikelet dolphin erbium choragus boogeyman dyspnea solitary hypoploid stoss daube basketball hypoblast tubercle unalloyed tat monomania shy prettify cystic naught cerulean tambour bice vetted elision dugong sclerite gondola flying lionize dustcloth glair quadriga deportee clopped thereto groundage humic canvasser webworm ambulator feigned plumy histogram isobaric backfield bodiless granter overpay inflictor demilune detumesce animality rocketry fret toothache propagable lithesome gentrify codify secrecy pallet countryman teenage labor outmarch pedigree halloo crankcase shadow remarkably spacey dismast marka viewership surg siltation abhorrent penuchle mystagogy genic perspex tirewoman epiphanic pecan mel height staggard eulachon hacienda ideomotor parallax gunner diatom streetlamp germicide curiosa kingdom eucalyptol quercetin dig snapshot horselaugh tricksy undercroft concinnous seriatim outskirt bilection technic therapy trove staminody skeptical hipbone exemplify poison toile sociopathy humph califate absorption yellowish cuckoopint scabbed glyceryl inflexible purpura eirenic buffaloes beauteous rockweed possessor semiformal obstetric residuary linguine thereof resounding highs astroid hamlet kaddish firedrake ominous relay salver trick mikveh lettering fogy posticous squire francium bombast causeuse traceless wildcat overhang iridium personify toboggan officiary mouthy copyist carnallite jemmy explicit nonwhite sayyid scoliosis drab arsenite ton soiree armored barelegged abated spoor competitor metagalaxy elm moil augmenter datcha hegemonic diastema lunk uttered pixelate gimmickry allantoid outpost hookah fairy yoke cellulous zinc obtrusion narwhal requite nephridium captivator relativize faggot shut languet wittiness retinol newbie gastrin antrorse stonemason cacti accoucheur squadron promptbook stoneware glycerin lidded surmullet flamingo subpoena cheddite nightgown whipsaw smithery woolpack leakage gigabyte mermen subletting wineglass glister subsist dazzling adoring penurious barbarism misguide auriferous torturous gangsta vigor breccia lazily sirocco existence edible aye playpen moraine hircine garnishee mulct godship slurry dihybrid burgh confirm tub signora pet windy sobersided count blaze blackbody advertise antetype cockatiel apparition duodenary bilateral apotheosis cruise antipole charity execrate outsert bagpipe fluke everybody detachment balneology credulity busload heptarchy hebdomadal tactical manikin dendriform are safelight carport unitize stead mangily manservant ballocks deceiver ferryboat polonaise git paxwax amanuenses lambaste censorial antenatal crownwork soldiery pubis soft soignee curate mailbag plaice wherever heptathlon ternion blitzkrieg dourine instar brag curfew hanger backhander sometime zinkenite deletion marksman runty syncopal feeder tome causey exurb omelet enchanter supplicant parson spanned tmesis efficient explain egoism bedrail haustorium knitter tempt octofoil explore steeple rear effort alanine basaltware dibbuk gallous cardinal hygroscope holotype snugged aught preset caregiver skydiver guillemot eclogue blackbird fixer centiare intestacy gliadin apsis mobster humeral unless recording overripe sauciness reseda xanthein loincloth virelay sinewy publisher million karma supposal muntjac sapphirine commender techie arbutus matronize squatted manometry chintz hematoma recognizee radicle partway calve chiasmus fortitude underwhelm quiff spinel disturber brew driller hydroxy poodle vile speos ornery shamanize cutback causticity chick glasswort rung uniformize mag exorcise vorticella stripping kazoo grappa tefillin quay remarked raspberry concessive phonotypy porky seagirt actionable azotize shantung steelmaker trotyl ware bucksaw snuffer destroy scansorial narrow floatage firebug synagogue bible peke frogmouth stun unifoliate pindling esker phoneyed flexible league alleviator nickname pubescence sympathize cardialgia codfish hellbox tantamount sealant shopworn subprogram pretty huskiness bouzouki crabby sill brooklet unkindly bowhead briony muzak cassock leveler apart abraxas although gimmick pizzazz juryman overtop northward overblown metastable computer bursary drug dorsal alkali farinose enginery digenesis birdbath righteous kerbstone nescient whitehead saccharase delta sextet surreality mixed discus kin ouzo adze quisling horsehide cowmen mudflow prehominid monetarist benighted treponema oenology blab vomit oriental diplococci entitative haustellum decathlon anecdotic anyhow ardent hoydenish scute forename neurilemma neoliths chump buhr rainmaker arson outearn assisted drowsiness villanelle dolomite undeceive torrential nor eavesdrop lovage snatchy adjuvant cycle cabalistic alephs illusion spider heckle carmaker gyre sociologic nastily corrida eldercare hardy slid mussily spank sickbed flatling inertial pay eddoes airfare wholistic beliefs portage crapulous galliwasp galeiform canikin accustom synergism scrummed according impeach nympheum lethality winner homophobe hexose doggone pullover severalty purity sparing bimetal living rebuke unwish megawatt horrendous admissions attrib spirant volatile roundworm remapping periodic tonicity childbed upkeep smokeproof issuable emersion rance more exergue hide agential claymore economy murk linsang separatrix millrace granulate warily flatware petty from nonrural antitrust kalimba whipstitch muskie hdqrs callosity writhe vaginismus busyness jewelry wonderful sphagnum corsage swum melting bale bedazzle dewclaw wheat sordine piceous zebrass strangury pekoe rehears ankylotic drippy swizz taskforce seamy plumule rehung reticular minify protease raffle dovish eristic nauplius sacculate depicture finery sanserif amimia rapping talkfest dost ammeter ideography tatami schmo jackass octennial imbiber journal manlike dollarbird cellist offcuts fulgor epididymis pliers campsite clasp envying aswarm prismatic tanka enact protasis entry brimmer apopemptic fetishist kit shawm adumbrate blagging ctr hearthrug lobscouse choleraic whistle crusher yellowwood enshroud dusk soy veteran downright werewolf lethargy antinoise panhandle obstruent cult possibly empyrean behindhand twattle brassily atonalist hymeneal unclear applicator aubergine jesting apery forsake perimeter clavate mecca irascible downthrow subcortex english appanage bluing jargon report diorama pct wagging papaverine awestruck duckboard finfoot catalectic ambush lowboy autonomy paduasoy liana emissivity limitable placename poinsettia stalker gate miscarry peacock blameless tideland beadledom lar minutiae trapezium odometer multilane lowlife slithery rote choice ebonize burnt begetter springy bloom predinner semi realist hussy electrum vivify fileable vicinage striae dimissory booths chew petrosal shagginess segfault accedence woodsman flapdoodle dobsonfly strong windbreak seguidilla assess textuary tannic dorsad abrogator crosstree strick turnaround silver missive overtake appalling preface trochal goosefish adaptive forgot hundredths dubitable enclasp underplot ethos martyrize pentangle misaligned unsaturate acari ecumenism belabor approx parquetry plaint lingua slipup houseboy lisper lynx outgrow sempstress handset vinosity stacte shareware bowstring bathrobe shimming homologous hosier commensal soldo killing kamikaze amauroses responsory indurate hike tokay lob finned artemisia endotoxin mesmeric sync puck smiths covin circa gist codicil puritan tractate bibliogony acrospire tadpole bonding lymphatic piths thermistor dysphasic wildcatted broch demode agamic privy reincur rondeaux ambidexter meltage bulbul jamming preceptor pentalpha gravamen fewness pistol spoken sonny cedi fineness mtge aphelia stunk helping kickstand undies outdoorsy dictum monarchial deform textile talkative cantillate stickler harmony scalenus charade phosgene maple quatre homology lintelled wail frogspawn paddy cadaver salaam fillip exult redemptive drain sadhu predecease sulfate attachment avaunt chloramine cogon install embrue prothesis overgraze thankful interurban foothold epizoon poultryman hryvnia volubly neophyte betide cornute spangly globalize gestaltist plumpness pyroxenite troth extremity lie mopiest livery khoum dated alacritous lobber palace reforge grith firelight nescience desolation educable contrive belladonna afire bong overtrade preverbal credent propylaeum onshore obscurant xylidine cruddy canola errancy rewound arsing darkroom euxenite wet diadromous father curve copydesk imaret conatus doubting dictate sleepyhead paratroops breakfront shellac bug proneness lamasery matrix floodlight monogyny geminate guinea gibing workhouse pyx tweediness wickedness wigeon segueing beatitude goutweed stroud velvet junket perkily salted innards aubade rottenness crux hyperplane defrayment exospore anil bunker psi pessimist genetics deterred briefly venosity teacake toecap cacoethes galipot reappraise raiser wentletrap popularity digestive cannot rehi presenter allopath assurgent smitten limeade basidia seniority wisher undergo sauropod effeminacy incipience shorten eurhythmic berm slapdash woodcock ecologist kinky millwork hight truant meioses buckskin garden unjam brogue skycap moss unroll gunky fretting intracity tasteless tramming hamartia sanatorium bookplate thesaural magnified tradesmen jink graininess detrital twist benefit himself abl omniscient croon secretor unmet subvisible opposite underpart kame observe hype individual sulcus lacunate stepdame mandalic unpunctual overlook suffix choosiness torte brucine oversize pavis telepathic fetter rive torture nudicaul jihadist avenged creakiness monanthous sling tetrachord dyscrasia abstainer versed hurtle overman rodeo spa cabernet bronze gastrolith sequester cattleman hotblooded trotted shofar cushy telecast pep bonhomie forkful evident bruin utterance papillon tangency centigram gasolier infringe gherkin ensign skeleton benne glycerol post glissando drongo chilly herniation seashell menarcheal railcard proreform clabber standard trisect nursery insertion atmosphere wast milit incoherent neuropath lefty memorial octangular nude foundation hepcat stormy framed ninetieths dairy aileron plasmid injunctive piffle cumber repudiate landward choanocyte aerospace diddler puddle corner scarlet dalmatic detente doyen iamb wabbit overabound girlish myocardia winery leu silkworm precursory barrenness tutelar cecum cosmorama poulterer semantic tinworks defeat schoolmarm hostess zamindar ransomware shindig revisal asexuality guggle helicoid seizure ozonide tacky idiom hylozoism camp robot ale wingnut pocketbook canso lade settlings phenytoin fixed greenhorn misconduct obelize shire whipstock arrowhead stubbly nutation pileup taxonomic lain contraband treas nuclei hug emission four tuberculin catapult color eluvium abbey grace college koel reddish abuser mossback coauthor conflux muskeg drizzly misspeak rawboned courageous villi elegit llano enigmatic goofiness roofer caldarium state polestar hydropic misplay leprechaun detector tourer classicist vapor chirpily polyploid shuteye shend claver virtuality screening tsarevitch xylol scrapbook endbrain gravid eclipse travail throughput jouncy cultish spotlit seawater wagon mythify pursuer pluralism voiceprint reproach forestall changed pieta tutelary sudatory bigamous pressing afflatus missile thesis spotlight cystocele barren reshipping disyllable blowhard periphery gumboil doodahs congelable bant arrearage stormily detergency functor gushily gooier gemination variolite pennyroyal moorfowl completed heathland goy baseburner peptonize fathomless mashie limpness evaporite stein quadriceps cassia pocket henotheism mismatch stainless deciare triplane longspur orris perimorph audible warty occupation subminimal densify expellable switchover seraphs spiroid seedbed tenantry wigwagged aficionado applique scantling raincoat canty apparel ferocity shay acclimate clinger gas humming oxidate enthalpy mantelet gutty nightclub wort yessing gain aureole earthiness smoodge decolorant fenugreek corvine monoclinal chandelier ngultrum croton sevenths royalties undertaken peony ramekin decliner mastitis amorality necrotic trig gratifying dorm lactescent bullate celebrity occult gassed partan bandoline pudginess pullet except busmen diacritic gallium channelize click decahedron afebrile fretter stroy tippex graffitist rah funkiness carboy mandible aux nuzzle fender pharisaic masterly menopause soulmate toilful hexapody weighted plummy campo squinty pappus waterborne thebe embracery endogamous rabbinate waldo whole fritillary helium graptolite archdeacon pard upspring minibike allseed marvel palliasse echopraxia lifelong saleratus padding airmobile bodge stoicism indulgent ciabatta detinue proceeding gaur affordable engin rebatoes barney taxmen nonlinear prezzie harshness moo dregs bistro homely jailbreak remontant peccancy tetragonal varmint huntress brain pleased docent ert tootsy sulkily snooper sieve baggie indole lisp colorblind threadfin dulosis whoop deckhouse campy shockable tin mage piaffe native hydrolysis austerity entomology amiable addendum facet whapped horde viscountcy imine northerly diphthong pageantry argentous loci betaine parole licitness riyal spaceless antitheses helicopter ambuscade corneal megaton wary asthenopia rigsdaler cafeteria readoption waistline slap masochist winch credulous surreal parmigiana filer nephogram lect bode accurate fistula tenor lipase deprive countered biorhythm hernia avowed soundproof lignify frazzle eurhythmy unguinous oleum carriole tale infected coatimundi flee intonate kino runner ceil mixture astern eggplant massacre drizzle obstinate sanctimony mid matrices apical maw nominalist ceratoid dreamworld posology indicate snack kiwi prepping beano immerge epagoge flanker quarterage estivate outproduce bamboozle sandalwood nutria ceramicist motivity horsily seventh loony scabietic halfwit strident rheumatism fungi rumrunner wiretap agoraphobe bless underpay financing landau hoer pantaloon acme obliterate flavorless hoagie fellahs placenta pillion basso civically rectify pendragon abscond doable angwantibo microsome oriel furmenty drawplate corrigible quinquefid team elodea triceps intima help morning coalescent leopard dpi cougar altercate azimuth knack sandman contuse covariant mince cadmium nappy squab spongy chronaxie postie slut gladiator declarant witling gloriole oldwife passage crosshair excide grizzly diphtheric heater antagonist statampere lineate usurp metronymic misdoubt pishogue expellee televisual wanton geocentric promisee mestee madman compute quixotism nosebag outputted crisp volant ductility ducktail movingly peridot untenable fruitily grumbler inaudible tatty irreg concinnate cladding avoidable ironlike amphibrach satin rosy charge evolution deaves glabrate sinfulness musquash cheloid razee curette retrusion kappa stealage receptive cocotte whitewing filmily postpaid heifer unofficial floriated derris ladylike insulate scabble bluegrass speeding berretta lavender ephod occurrence erupt foolhardy wizard riddle deity meddle hurt trey sandglass ornis adapted ferret outdid collins armadillo underclay prioress scilicet platypus duo enl serai shield fanny silurid gonadic regrate pentathlon machree gray childless mastership bailie bovver meh germinable acridine obsolete sweltering rerelease ratal nucleotide madrone overburden throatily lungi prelatic cos docudrama anticlinal ladyship rhymed corralling scrabble coherency fld regeneracy heelless stevedore jawless backlash fail fatuity rubstone bilander endoblast poppa polyhedral troglodyte hyaloid noiseless hardball epistaxis gamester keel atonality ligneous mincer laddie allowably faint peninsula pignus befit saprolite cruiser subkingdom quinine brief hibernate allusive thievish visage bleb motel chondrite aerology bozo armchair ridgepole binomial inline hoist clitoral amygdala neut placate proximity totem tootle guardhouse achiever congruent sprigged holder access headhunter bidden semibreve lippy changeling dropper hassle nerd mayoral conman concinnity tutting revenant abiosis drowsy potherb prehuman clary retraction easeful granulose tamarisk refreshing exemption rivet upstroke foremen irrupt dustcover hesitancy tuft cost shul tither callable swart aka shock stickiness toughie chestnut idol nymphalid woodborer tendinitis lyceum curbstone regressive buy religieuse marmalade scathe mujaheddin endurance gerah phyletic exocentric bola rabies own cocoon retrochoir monotonic sternum hear portrait clumpy statfarad antiseptic pud mystify nonprofit aggression encumber epee gloppy grump triteness paranoia uncross blotto nostomania phonically vela delightful grinding showing buildup squiggle perihelion biter catfall alveoli lettered canyon hemangioma hyssop flashboard clunk insisting rating legion titchy shroud refutation optometer sima hitherto muscat petrify bumptious xcvi bailor fury gigantism anchor lightless lairdship tromp mate vary colonial natter alkene ersatz amphiaster forgave vastitude frizzy censor windrow begonia quin alienage priestess drapery ornate vol liverish sycophant ultra dampish dixie singe terzetto runabout underused thoria sandbag pelvis striking swatch logrolling normalcy nutty avunculate encircle subglacial lampoonery misspent threshold alert calliopsis incr airship lammed misspend agateware skite troop earner asteriated monatomic tipped majordomo intriguer activity enzyme entresol nautch pyramid antivenom fug soever mailbox fingering nightstand thymosin fond sloughs erase mudpack lagging knapping ppr calumet custumal planimetry retrieval canoodle furnished innate palatial assignor forbade papoose crewmate headless rotting foudroyant gasp telfer manned maidenhair meths chazan judgmental outplace atingle valorize canoness manteau acting vestibule infinite scentless reemphasis vidicon bidet paddler foreman loughs swage fireboard revegetate solidness jet maund ruffled algorism fellowmen ragtag sierran migratory theodicy banishment mulligan buyout sizably dwarfish pretest lepidolite broths stalemate plume thudded brigandine aneurysm cloche shammed tontine nave paeony blackface foaminess fain propelled cleavage mauvish crabstick jivey achy cow keyring genital eyeful boggy spreeing outgrowth cassava copaiba rachitic shipper nonsuccess neon bedder thank stellar thunder sextan sunder hector atiptoe scabbiness wearproof uric refresher nancy hacek aeronaut heiress angelology zibet hatchway gargoyle tank fossilize mullein cyclamate halal lotto houseline gonophore holler feculent shah arbitress trainable discrown postrider bawcock ganoid rankness shoebill sodding ownership mariner jetting creosol photometry snowshed agnomen embowel aldehyde balm radar azotic imprison donate rhombic gout peepbo silkscreen ragtop unblock membranous fit negus sympathin inoculum canine hundredth centric microscope conventual fluidics fascicle bitstock admass whupped eonism neither derision triffid merciful caducity scald piassava blackjack lute cauda segue rabid locular niblick extract abrade ovenproof dutiful theroid rheumatic grunt hilum hurley candy maledict pelt quizzical navicular misnomer beezer lungfish poultrymen belike neural stubby verrucose wantage resist oligopsony pollinize catechist bigener heartburn xci lonely laager parky antiphony accession touristic downspout prolific netty pushball subset blende stay lamming volitant pigskin soon postman clomb tuneful livebearer metier organzine kill saltire vedette arsenic mantilla broker arbiter fromenty cagey pase snootily stilly parley stipend brimming lxvi massless fruitage launce oboe antennule pianola tutu geologize hatred inflict army striation durmast waterside odalisque overrode pinnace suppletory dragging semaphore mistiness irritate amount osmotic duct birdbrain glowing tabret backsight campestral used reliever sulfurize clumsy spinney alchemical nursling quango borough cylindroid enlist denazify sleepwear cuprite hydrometer runagate nationwide saw cadger mountable addition dweller sublingual festal risky modernize brasilein fane ancona brace touchpaper checksum literator ectomere port trull crudeness birch snag grubstake overstay reticulate wallet yup normative speeder adduction boulder buccaneer evensong spy bubonic bedimming fastback internat category pantomimic enow almond dialect brininess sculpture sacrilege clayier immaturity conference urbane abortive protect underlain blotchy sarmentum gradus indictment coonhound ionium cajoling teredo rest rubious urgency panelboard parenthood ten mutualist submitting organize thieve fever aspirator outrange netter woodmen brassware furor insider algae spectrum bilharzia bibl conjecture cabal iodine brave kitting tabouleh anabioses unwed jubilant autotomy escapism telex bolshie flatulency eastern ration tailspin barbitone breathy high incunabula anisette anthracoid tonsure thighs crackhead cervix crunch leniency producer oncologic attach kibbutz lection tiler chamber askew bratty trachytic carpet tonsillar amity stymieing appointor garb typicality deputy jade kitchen tantra recitative roger bad spurred rhinitis varietal wale impartial tribunary donor outstand trailer entity conidia highbred orography antithetic heddle perianth muckraker behalf yoni clench fordo insatiably dunnest toenail bruit sororal fastigiate brokenness laetrile globose laudanum baccate prologuize detest zaniness iguanodon muliebrity rehearsed yeti drowsily flatlet maria yogurt extent imperator quadrat fisticuff hypoderm assuaged scarper leaning postdoc muscly bighead impeacher abscind snatch umbellate rutile prison quinate driblet botulism linden elongation pertussis negativism ode treasonous capitular compelling immix octagon candlenut topsail enunciate attendant turnery diploid tap prelect boating oversharp prelature oblige hidalgo incurve contrasty electuary natch suchlike junk seeress pelican leer sporangium lemongrass rewind binmen presoak vorticular sheepfold anatomical volitive fold enervator guider chatterbox sebaceous narghile emaciate symbolic bellflower ninepence who semblable mung turdine you hedonic muss acrobat copping ordines sangria rattoon filariae gainsay metathesis flourish nonuniform cherub ign sculp fluidity estipulate demonology petter unmistaken argonaut novena grogram glossal adoptable roasting titanium opacity haugh dampness entreating defray multure loricae eponym blindstory legwarmer incretion colossal begin kabbalism astute spiky diathesis presuppose allocate myoglobin giddiness denial extinct muggins swordtail fol contrition futon glamour dyarchy escalate eel visible euripus ramshackle trauma toweling windowsill supervise fetoscope lancewood ether formulae stricture squeeze servile tuff kumquat disendow enough runaway ferrule skipjack bailee piazza wholefood shnorrer quotation mailer contagious edgewise sufferance variance bony passport genteelism hemisphere papeterie tool trefoil whipt anion exarate allopathy inveighs uremic periodical unbox oread sclerosis undertint basal kindling periotic sewan preventive undogmatic treasurer jauntiness examinable pollinoses wobble contention presbytery merbromin describer gran workwoman guacamole ungrudging torr boneyard wellie gangland ichorous weaponless exercise rubescent colonize facetiae craunch argal annalistic troubadour chappie girly dipnoan afterheat theologize tab engineer dewiness welter dampproof dreamy longshore manga kenaf conductive verbosity insole theogony permitter drafty falseness dreamer cassis cosmonaut pasta turbidness boreal diversion lustihood cruciform chug macruran hexagon poor homespun conchoidal spoilsman riskily transp clergymen bio gyroscope paraplegia wordily arethusa hayward hireling unobvious editorial kieserite epiglottis fully dauphine conquered surficial poulard makeshift plica arise toddy monophony tympanum probate prophesy mouths acreage medicare sender conure anklebone oxidizable sostenuto haar lingerer aphorism killick amoralist poncho possessive chophouse scrap annulled thruway farmyard fluxion samekhs overfull nimbleness basil breastfeed pinite vape robber funnyman homo trichology transact bluntness onto symphonist hark paramedic noncom optician monologue gamecock galimatias pinchbeck outdone assiduous smuggest stele burletta indic fateful excusably osteopaths seedy dogface outpatient imputation agha wrapping gallery crying bewitch parvis betting gastight ogle moths amboceptor huh exarch windhover squeezebox kinkily whir headship deny thrower perchance epicedium obesity literalism inurbane viniferous obolus sparteine pussyfoot foggy cleanser vendee crony nightwear glutenous inside challenger overmodify coiffed delft monstrous tribesman antidrug scrivener extra prompting backhand interlay piscary outrun hort fructify premarital epilepsy azotemia patron jocosity farcical frogmouths inter legionary greenfield platting trillium alk palstave botfly battalion vesta coburg anglicism hackney starwort crookneck fenced drupelet bottomry smote drearily fanaticize pileum stannum coxa jest crochet mute fuck infant selfie equerry pashalik concurred coryza siliqua milreis nape kvetch encamp unornament sector oddity endgame formation eagle marking hyperspace glaceed entopic conic laccolith nelly upthrow touristy vuvuzela frailness scam hepatitis sequela speck arguable grimmest conquerer sycamore pension ejector wadded orchestral mortar quipu residuum wurst medicament lipreading taunter dihedral balaclava lin sleepless world oat abecedary physiology doorjamb bedsheets tenpins mountain assonantal absorbable redwood befool domaine melange plugboard checkmate expedition labionasal beeves truncation must limestone pentameter wild subentry threesome curer plentiful comatulid pirana shaded fluent toponymic untrue panelist silicone lilt franchisee hurtful sestertium interested personnel guillotine heritably churchly ribbing decrepit misfield tight arrester interphone bis penstock floorage ladino slimmish ripe phenoxide cashback analogy veinule cine clavi sinapism selenious bel knoblike downhaul horsemen farthest vacuum tatter effusion deferent infuse moony narcosis ostler ringtone tussock ferrate champignon pricier chondroma tertian blazonry coadunate monitory reciter bitartrate wind frustum yapper polecat myopic achromat ofttimes lateen coleus ketogenic anime starburst kina vesture sheikh intervene doorplate nowhither shrilly retral kibitzer goodman husband metaphrase want perineum headstand nonjoiner mindblower embark beefburger buzzard bewigged gillie comply salmonella shes lanolin phlebitic elaborator tenpenny scrutable sorrowful ileum prefabbing randomness aliform oldfangled untired pileous mythicism polonium spindle murrhine drywall narcotism nebulosity onscreen reckon magicked pyuria sociality sag terminated restore faiths waxwork scenting meekness stinkbug mtg autism fibrilla duello deil blowtorch diaspore implode antigorite scyphus coal liquidizer steeve impudent haystack polyglot anal boscage celandine amend tideway chernozem reflector mongol forborne tactual brent honored phantasmic saltigrade kasha subsidence sub thrift knotweed deictic spar sparsity overdose batfowl rotational ulna urological deplore reprise precipitin affray collector mousebird dragonroot armure apsidal schlepping knowhow lushness wrinkled irradiator decretive puckery fricassee chamomile casein meliorable centesimo acoustic agitato qualifier intertwist tying antiaging slenderize populism oogenetic mercurate mallemuck comaker depone minefield repatriate monocline floweret jingoistic splitting curiae autarchy shin neuron aspect bluey annuity envelop spae areola torpor niggaz platform surpassing ultimacy euchology pulp elopement baton bardic hijack intel sit tincal lupine streamway metabolic jussive syndrome durst strew cheviot blagged charqui tummy iwis meanie insight cerussite sworn stony economic bub date vulvitis shelduck rancidity bairn litho benedict ingrowth collogue phrasebook diabetic answered febrifugal overcrowd shambolic verb melisma vortex aloin codex repeople comrade seedless fourths pigling hough glomerule scythe didynamous seismicity unapt seringa tocsin onset outing hottest gunned deduction birdcage cybersex wagonage malleably impetus stannary thump flirty parsimony eyelet lota gelignite turfman metallist fief paradisiac document lordship equitable diplosis unpin waif annals ronde bipartite bondswomen wayworn booth isotope original clod ergodic paronymous peaceable saprogenic fiber weigh extol quinary ballista theurgic boulevard brassbound supertax allopatric fash bushranger venue defacement sannyasi tunnage phosphor thereafter daunting yank zookeeper fatalist macaroon apteral angelic hangar able adviser soave underfund twice calfskin armings turbine otoscope antidote unmuzzle any bluffer perilous eater prexy zoolatry peepul threepenny genuine ecocidal arista threw cloakroom sideway urinate matronly valvular clxvii mimicking hotted percolate sabayon handmaid divinize anglicize lithic ultraism monomeric predate cleruchy hobbler paginal blue eugenist dialectic titivation armistice fridge acyclovir toothily apercu houri stomatal innateness jinrikisha sputum corallite yummy forget mamma scarily paganish mottle cajuput subtotal rampart dogtooth bromic segmented stalwart diddums closure aching uproot jazzman hardware trendy musing gourmet shiv excaudate cabaret gummite stenos lituus wok astir cocainism carve clubland hosepipe crematoria purposeful luciferase nonnative quagga wispy costa lichenin hogan osteotome escapist angora porism choric wizen think knotted cancelous ovate wraparound chant edgebone thesaurus knitwear nubby fuller garage truster stammer zoa rat serenata exiguous chinstrap humble tripinnate gowk cismontane latrine stemwinder smutchy triumph largo peeled postdate sirrahs beryl theorbo moduli hitcher ringhals notifiable axletree apemen mirth alarmist subarid hazily meshugga leftism whatsit domination outlaw handily cataplexy subtorrid bossily overinsure skimmed bothy emulate pursy char mansion sheriff philibeg pentad loquitur coherent expurgate melatonin rounded sally hafnium hun receiver chickweed harmattan ampule inward gauche poolside puerility zayin ulnar coronach culch twerp malfeasant euphoric committing gearbox fieriness sharpness runless detriment pteranodon discharged toke inquiline nimiety laminitis unready bhaji unriddle exultant pleasanter carnation matchmaker elasticize amnesty scapula townswoman loggy gulch thrum pillory doodlebug flyblown cold liquidity stridden kph protostele asp headachy kelt spokesman timothy control dispelling proline sorosis xanthene catena habitue langlauf dipstick spirochete jokiest halogenate ribwort stitcher transferal benzoyl terrier resurrect maidenhood hagberry passably fireguard venison indevout firebase ineludible fireboat tsunami cronk nullity bookmaker traction winkle anemograph favus backstroke petersham protean metis cousin spellcheck tannest embalm readably admix cleanly panoply cleanup keyboard succubi geographic glance mark operative contrecoup begird parry misadvised dispersant warmer spin langsyne batter gutted discern grist plughole cetology noncombat barnstorm romp bequest newfangled anamnesis insurgent court apophthegm sculpsit hesitation dogcatcher groin anthem prostatic posterior cruzado oration wormhole garishness smacker sniper vibratile turpeth plectra retinal specify mittimus engram misdoing endoscope knar symposium faithfuls marcasite vetting tininess revanchist limitation nontypical gammy seicento kirsch civvies lanate prolusion isallobar relict termagant provost tutty piper alienee synop aerobatic byzantine costard scrooge fisherman seamanship playsuit deadliness milkwort curriery claypan overshoot gemmae rootlet plunge sloppiness chalk tech vim alee confirmed standbys patented carbonize remanent cutting chairman chapfallen cheerio scansion sorn metalepses piperidine blobbing goalkeeper lurch logoff yucky serrate ovine erythritol chlamydia cormophyte ransom sweepback tooter ambler unknit hockshop broomrape tarot aha hospice gabion panicked ethene statistic corbeil dasher sparge net falsity bloke xvii doter smirch chge couture mechanized decreeing timing farandole quietus carangid kaput roll foliose notchback rubric halidom moocher neckcloths saudade piperine dialog aflutter aggrieved adequate sunbath apheresis eccl thyristor impervious annulose folderol ironmonger faintheart freeborn mariachi kinsmen afoot theism brewer goulash daman mindless paths teething jill triphthong snazzily gangplow weepy wussy alongshore chainsaw sauna incus yawp metastases stertor paucity gunnel goal again racetrack ozonolysis slurred oppression tasty muffler rhinarium shadowless imposer pitiably millipede bolo sandhi criterion crispness bifocal thief strongish hypophyge soricine aerify doublet syzygy".split(/\s+/).filter(Boolean);
  const WORD_BANK_2 = "plashy exploded meperidine incise attribute virtu paladin durably overage maladroit regnant epideictic saggy bulldogged upstage fichu pavilion bullpen doc pourboire cotillion emendation kalif eelpout matchplay cloudburst gobbler footfall ionogen simplex blowtube hosteler stoic misprision frontality hectically writeable syphilis downstage classicism sideshow artisanal moot applause advowson stane ligniform macadamia debenture gill indigence sprain chore juju mousiness fasten choriamb incurrence remorseful xerophyte capping depredator aglow asternal preemptor displant soothsayer seedling haggler crown washcloth baste midterm seducer halftime inaugurate sudsy sobriety bottomland marvelous lasso centering moniliform semester tattoo detrition intens grind hapless preheat defiant adult feuar unmannered phenformin spanner bandwagon boneshaker wailer frigged chyme megaliths authoress resident earmuff graticule censorship morality ufology bioscope afraid crump patchable physique carrel payment antlia sawfly queerness celerity smithy budgie cod oysterman filled vallecula beefcake cephalopod blueish mirk dilate nonunion kibe zydeco musicality dial boliviano perfidy cagoule pikeperch rewarm plumb manure mothball actomyosin triste gunrunner buttonhole tropics generalist metisses bubble dreariness anemoscope cryogenic sild ferrymen meatus bedight totemist frontward quaternity iodic activities exulting coat octan sectorial trysail incurred stowaway pycnidium escutcheon overate rail landsman temple frisket velarium heteronomy leisure beau edh clarkia silicosis puke hornless executor inductive uncaring nuisance roaming loanword emphasis dysthymia noncitizen thermostat veronica mettlesome sellout underlet geek range trinity skidproof ditto affiche insurable final monogenic minister reexhibit referred markkaa escapade sinciput anodize wordy subtend stereo colligate burlesque yammer riser crawlspace waltzer stirrer scheme polyhistor multiyear lying stinkstone surer begotten somber dirtily emitted tonnage cubism pogo verapamil clump stepmother nonjoinder thudding lepidote lamellae gentlefolk capias oxygenous burnish anything mopish mizzen wrack ionizer misinform anaerobe negligibly queasiness ceric cheery exile hackamore robotize mneme trawl gargantuan evince beguiler maxim imbibition romaine joust congrats jungly were aptness thinning pinnule initiation samsaric therme dermatogen lysimeter lard viperish physics valuation recalesce peck conviction desolate subsocial chemotaxes comicality crafty observance humorist blitheful roundlet spamming dyspeptic gossamer locus ratfink wag welsher hake wardroom footlocker einkorn evenhanded preen scriptural sexy petted sneck pawl perturbing pellicle codswallop fogging cateran comestible sciurine til rosiny fab uproar humbugging bombard suspend backstory atrium search funded preserver occupied host question overhasty wallboard chariot longhand gift whity taxicab ballgame eucaine sawdust rotate check fount indophenol orthoclase negativist weirdo hebetate snooze grew greaseless gettable antihelix transplant adjuration quiescence recompile cladophyll rapid bard bobbysoxer segmental ingression pinkish guesswork pyrone trainmen bummer lambkin spear fluoric traveled unfeeling ontic quaff erectness compose singalong pyromania medulla aqualung semipostal cranial wrestler splinter engobe role shirring servings lune significs teacher stubbing straggler chevrotain coloreds laundry natant barratry steel frenetic posthumous fear hecatomb trapes chromogen tawniness nominate principal titlist gurglet ranter denar rang rigger propel immoral topflight politico upwell chivalric skiagraphs howdahs steelwork armature widespread sludgy gink channel upbringing preshrank coercer trillion bijugate handler debut dustpan bitchily desist punish saliva contribute osteophyte rabbitry morula hydrolytic instructor incest qophs understand frilly reproved frown flare overdrawn portentous mythicist day saltwort scrabbler hemp gynophore ingroup nosiness ironweed herm flummery dysphoria forefront nightjar spittle phenyl microgram longitude cocklebur plangent caster genning holdall latices obituary costless vaulty makings emblazonry dateless plunk minatory baluster bookcraft permissive thousandth putting monopode shootout allegorist kneehole stuffy flowerless terrarium decresc diluvium misbrand samey autolysin downtempo mascara refractory strati nudist dairywoman miscast corruption gorilla phenolic plasmon rubidium ethnic clares tackle ogham aerodontia white jaborandi lambskin die loaf reimprison billabong swingle almost various cover electric soapwort accompany provision aitch affinal grillroom welt blowjob tunicle bosk tankful synergist follow pendant monkhood cystoscope yellowlegs hoodie booklet gravitas shakeable discarnate vivace behavior rifleman military piccalilli resilient pecten flam discant mediatize antlion tuple teakettle homicide secrete auklet perplexity cruet equivocate dhurrie caisson arras servo usably forgery hatchling inorganic spheroid magnitude bleep curse belling copter rocaille operon alliterate xxx veranda fulcrum nonviolent homework budded manslayer luckless laboratory cilia funding lacrosse shinning refry partition resurge biliary spoofery newsgroup pseud rocky outward vedic demurral scat emotion goldthread penna matronhood associated apiculate jellaba scrappy quamash glassiness abridgment ponderer serigraphs hallah guardroom levator mastectomy ardeb cissoid lassitude discrete snowblink stypsis seaside megabit jarl endangered refitting amputee freshwater albuminate colorfast creche cerebrate emunctory despiteful announce sermon baggy armiger bombastic agitation tidemark arboreal humpy mojo faugh antenna cyclostyle maritime greedily summitry labroid hoverboard unbosom pellucid imbecility parenting sequent benchmark midwife greave obsidian petting advised skiascope precept coca point cockatrice lionfish cochineal illogical goosebumps leucomaine enamel vacancy hydrocele substitute euglena exalt dirgeful payer birdhouse foliation appraisal holiday meadowy volleyball mfr citronella aberration fetal stearin fearsome wampum folkway bevy vertebrae prelacy cabmen wert stoppage amphibian treatable ritzily braid cacology taxiplane zugzwang misery aspirin alegar bitty cuesta poesy aweather marzipan sunlight sugarplum turbit remindful spirelet envoy tore french dormitory backstage catboat dubious oceangoing ornithic prebuilt roach punk legalist firecrest whipcord budlike cittern unabridged steatite herbage smallish issuant oilseed obfuscate pinewood extenuator conquer bass clxii guessable orogenesis desiderate balanced lemur arboretum photon abalone moralizing muck tenorite latch agar nonvisual stability hooch crossruff stithy warned trigram cranium exactor excitably planting sextillion cambial troat whereto radicalize whitecap buran annulus quaver sweepings outvote revelation seaware foxfire clapboard neath revolve sld teetotal ballflower ridden pheromone cesar coitus dextrorse finial gemot geomancer bastinado novaculite forest debauchery yap endogamy ionic lockage vulgarizer hammerer upbraid candlewick doctor turnstile coulee milkweed ampulla innit postfix ruggedness quartz cannula hipping spermary bumming fairway pteropod borscht lesion pokeweed spirograph pelletal clam workings starfish fishbolt fledgy angrily dagger blackfish reseaux virilism forwent ridgy metalhead clarify brazer devotional roam bocage purge scree disposable cotquean tactile notepaper diastolic debris offbeat steelworks gloam photog brail besmear strapless caryopsis blague figure fondle swiftness iotacism diametral carioca killdeer isotropy confluence sporocyte pentagrid cobalt pucka misfile quenchable moxie airwaves auditorium underscore cephalic hellhole playwright feathercut grepping wormy endive colliery swearword equitant gig wedding operable inquirer elicit shakeout rescind cloud forworn cataloged priority roorback nonsecular varus orangeade slink predella voiceful grisly folder overstate judo decaliters leech propping advt upfront explorer resold germinal unclench buckyball year gallivant skimmia bondswoman boart almoner shekel antiquate espagnole uppercut acetone bustard apograph hydra piccoloist uniflorous recognized chanciness epact caddish carrefour pine seriema aortal quincunx taverna khat scratched pause puma flimflam imagoes gigajoule reflow phonolite assn fumigation intersex obsess selenate enunciator potpourri zigzag sym distraint archival anymore grip immanency favoritism sloths volar meatless ruddle stark bawdyhouse cooked debauch tonneau fascine empress ejecta sticky flaunch amenorrhea razorbill forspent tron dak fairlead bacciform doggy pillow rendezvous hemitrope catarrhal ichor pastime nonempty galleria bedplate rubeola lobbyer hawthorn iconoscope jargonize invent nonfatal maenadic ectotherm septillion herbaria chincapin namesake angst mongoes banderilla misfeature regulate hemoglobin stunt solubilize woven tranche roommate carmagnole gaberdine multipara sleepy sylvite epigeneses pectinate epidermal concert anemochore blaspheme bagworm ungraceful semiannual ichneumon horntail prelaunch virga buzzsaw comedietta erumpent patriotic uprear grommet turnspit calcaneus zymogen arrogate somebody queasy succinate reimpress hedonist falconry eisegeses roller thegn kingcraft croupier cajolement urogenital mesomorphs avg bris eyra hachure turd murex fussbudget carthorse trivialize fireplug splicer churchyard assiduity clingy comprador gunshot arthropod canorous boga precool rockfall paletot bunt thalweg tonsorial need decoy diesel intrusive summon bragging coffee gamesmen outburst xvi kinfolks oka electret corrade wardrobe homeotherm debus guided refuseniks neocon thirty rockbound swell joking kist solatium juratory peril swede felinity flightless crazyweed condominia eek pelisse myxoma majority jingoism confabbed shoddy fiorin onion luminosity termini hoopoe abbrev scholarly ptisan rubble darling chemise annihilate lati repeater hair woods tut sagged rustler reflected spectate indusia invasion nomism madden sorption draftiness daddy rookie copious rennet banal squid nidifugous swami prospect mythologer heriot flashback suggestive blogging amphimixes roughhewn owe droughty enface hallmark fluorosis orgeat aikido minion tacnode nearish laicize heppest tailplane age melodize retract attended treasury metallurgy dapple biblicists gimble kyanite bemoan burgrave interdict studding tinner multilayer syphilitic bonny simony mouser vanish limpid librarian sanctuary panlogism lvii infract postilion jag nucleoli festive series glebe cement arranger chock bingo gateaux unship ribbonfish petition adduceable grandioso bulginess naturalism row daintily movie gentes aurora rechannel arcade peep soursop hesperidin chuddar guy aging lebkuchen vulcanize enlistee ratchet piling coastland coetaneous spryness phenacaine agron bouillon fib downsizing bisk complicity keratinize nosegay tenia liftoff amateurish decury toy henry chinless daleths enteral xerarch aurelia miller ingoing trundler plasmodium actionless zymosis masturbate hacking pageful spillway headwind vulva resolved coulomb manageress virility somewhat aliquot nitrometer trampoline frt actuation grinned squint hemistich fatheaded iodide orca bulbil baroness whippet retailer verdant eschalot obligato drugget trans conceive usherette chukka roofie sissified harslet returned betrayal cantilever rickettsia chronopher horsemint opposition perquisite urologic bashaw webisode emery stow quenchless sloth surfer reluctant oblational scoopful tuneup unijugate wonder snobbish aioli attentions beechwood opioid causer eucalyptus drugging guerdon repute lochia ambary thieving usurious parking hexane mothy batman morello nagger quayside pervert spoonerism virgulate litmus antihero pronate consuetude chatting informant men phobia scleroses absorbent connective uppish outgrown unconfused beatnik changing knobkerrie archfiend affected eglantine manifold wheatear vicarious elbowroom excruciate lysin recount princely shebang husk koine locomotor trireme hedger roadwork experience aground wagoner optimistic souterrain dialogize curatorial jollity extern nuptial weedy patriotism ictus orison anoxia patinated decahedral bracket chape arrant tomorrow macaque laminable magicking restive filings sixteen pleasance neap longcloth challot impatient idiotropic even petunia breeze quaky proclaimed large numeral pailful insignia dichogamy lempira sheqalim aromatize idem thickening senhorita enwind corrupted nonworker underdone fission bicep seminary common combust pollinate harmful nonsmoking bulldoze triptych hindward stare twaddle hogging proscenium spacial bouse dhyana bigmouth chivy prat bosket clew courlan obduce lactation monstrance illegal azan cadi brawn idleness clumsiness wireman laity tapestry operation myasthenic polyester tact symbolist endomorphs epizoa sybaritism hypozeuxis routeing barbarous emblematic okay condense muzhik forceful snowsuit vividness entozoic known diaconate lameness crankshaft clubfeet massage topside ascospore osteoma excrete uvarovite encampment ceramic auricle wedder powertrain crwth hornstone objection whichever ukulele queen equability lewis anabas illegality cancel interstice repeatably accentual harpoon encephala rigadoon slabber logout launch whiskery stoma excelled tetanize pupiparous lengthwise plasmin swab haircut repeated pyrrhotite demanding dropping rudbeckia flower truce keloid trickily idolism forespent tipsily raincloud tie warpath burrower gustation mudguard washwoman gingili helminth doorframe grungy lamplight soigne oblong glam gingerly packet seppuku copycatted ballpark pertinence chiral uintathere promote tubular orthosis hub timezone agog measles secession binaural recovery jotter prideful schnook ootid whitefly syncretize preacher saturnalia peptone tantric notwork punkah canella albedo overthrust greywacke line monody tarantula bush danio uranous votary aqueduct jawbone discord kvetcher gramicidin unbid spongin butcher anybody davit accumulate symphony issued fogged airletters chandler gimmicky depositary extensity eatery marc mallee accusative esotropia schmaltz jerboa cloths enter fieldsmen slippage pegboard feeler meow fecundity positioned lexicon leno burgoo inspired caretaker sukkah talon almshouse escritoire sniveler culminant faintness cullis compel divide funnelform pinup introrse waders clergyman livelong schedule huarache der jutting sonobuoy antistatic manhandle syllogize blowzed hydrangea restrict magi sod taffeta prisage room filtrate quit rental whiskys gamine inoculant python scheelite swale binge redfin percussion isomorph champac slushily expansible globular refinery nonparous witchery myna builder envy nom kudu nonfascist waylay sighting renewal anatomize woodsiness area arginine shoelace grouper gaze bravissimo gorget wintertime clingstone jacquard coven dowse numerator sonar refight guarder recusancy bibliofilm grandson occlusion outturn stiffen ponceau hunting wedgie briefing aerophobia avail sinistrous shipped lather psalteria poolroom vaccinator literacy don truncheon resonate scrunch bleakish engird leapt borer immense dimorph beloved shed intercede orderly archive boron otherworld lithium embow jugular mujik wreck ford indigenous comradery kike bearing brachia tallier pussycat phalangeal gush albumen rootless regulus downstairs temp appear hallahs fatter heaven beg sedum stuck placoid cossack shrive swearer manducate revaluate wagerer overstrict baobab gentle limberness decorum voe dexterity courtesy furriness palpitate aquavit ranket haw tucket sanious timocracy cognize harmotome niggler anklet separatist patted littleness bigamy peepshow fungo fobbed plenary indiction overwind taxing pacifism gimel abysmal recusance alpine fumy spearwort retrad bossy handmade friarbird make superdense springlike scot booby retrocede birthright warder song nidus pacificism analytic giblet ninety cockneyism freedwoman rightward prejudice mere castoff lump babul clayish theosophy fucus venose disjointed perlite mono bedraggle diazotize contrapose tendril crapy whaling juxtapose pavan armband homogeny magpie septarium dextrality spireme tenace insulting indraft cipher canebrake bemean gluier captive headrest sundry dulciana oratorical toreutic decalogue edulcorate halide luckily slaphappy imagine crosscut snugness king dvandva managerial erector kaolin preachy ergophobia caricature grandsire oeillade acidulous ophidian pampa whapping midinette depressor hemorrhoid cannabis ludicrous exogamous rivage preadjust ventilate greenling trouper palpation cliquey critical intersect muzzy pfennige teatime federal station marcel likker fireball badland instant poorboy porphyrin hackman linearize millesimal xerophagy jess cuckoo sericin minuend bissextile antiheroic flitted fadeout pasture deterrence schlepped songfest busboy outbox swift cairn shallop halogen caecilian gearwheel promontory tymbal cowboy heron affiance noncaloric calibrator sorcery snorkel uptown foulard apathetic tartan churchy whittler shippable pipkin aftertaste lifer prink inhalant str divisive invite arioso unideaed grisette fraught mocking ringdove decastyle conoid muezzin obscenity talisman clot spiculate naiveness bond pinsetter dampen stamper encystment angling vibrio sealane speed abstinent jehu atonement outrage clamant alcoholic oversight splayfeet debating hereby mandragora luminal ham sportswear lurk complot snowfall defacer delirious azygous trihedral igloo sheathe stiffening scherzo paradrop exquisite turnon octavo ulceration meant adapt deep isotron quadrivia goths avenger handmaiden glengarry zaire ait rhizome heavenly cartogram nosedive nuclide efflux spinous intimacy mignon brushoff chaussure lambert newsmonger hypocrisy aboriginal kepi whirligig scrag dudeen fired curvet ostensive citral miscible vesperal magazine congeries assonate xcvii acidic rap dionysian bedspring hirsutism hairdo truffle mealworm misdemean ringmaster mare costar errata harsh englutting wake underbelly mangoes recipe schoolroom wanderer eugenic nucleoside cymoid varnished scanning professed quantity triturable villosity waters islander placket nautical beguiling habergeon travel caribou clothing nonelected foeman tractional sitting luculent feverwort erigeron epicarp hoodlumism murderous bargeboard fluorene juicy transonic antivenin overflight capitalism slingshot vetiver aerobiosis drifty aerial solanum potsherd laudably sander herdic fecula stemmatics stall gluten rubricator tafia oatmeal fledged sheqel flimsy vex excel sexology broken coriaceous burnout aeciospore misled insistent meridional cobia shirt dime tagged tui portably cyclic rack trecento buffer hotter archness chateau cyanate limbate extrabold chiding recon azimuthal surprint axillary crackdown shutter chairborne exit nudnik unmovable lunchbox showbiz graviton toxicology burgher caseate influx shamrock rick superspy punctilio trifle stomatic stoutness twang dimorphous motiveless orphanhood sizzling patine ortolan jivy mobilize gristmill polymathy cogitator truculency wastage soundscape neutrality debility phonograph hmm febricity fling listing digitalin failing purist grilse chronogram prudish stodge beforehand pitiful scop discobolus cryst abhor fibromata saccharin ole staccato headspring gurdwara bromeliad landman furnisher botchy filth leva attenuator cooption clunker assignable withdrew soba shrine dander fortuitism bracken peloria farouche infiltrate inclusive bluegill shyer narrate cuke lacunose ark peperoni bump auric gazebo eclosion enneastyle sleepwalk abolition bypath brougham geeing unific devastator capuche tmeses rejection hong splotch labialize salmonoid biomass registered remembered shinleaves clickbait titanic wildlife petawatt aperitif goggles ichthyol anchovy midgut upping superpose pupate leathern arachnid biparty moving pkg paunchy prose sirdar membership investor bubonocele whom accidence gonococci scrounger inhumation anemic naan mystique alphameric dishcloths oscillate garbageman choose pilei surrey yessed haleness collard legroom fulfill epaulet alpestrine cubist stream neoterize heptane indicative bespread damascene banksia gossamery taproot arrowy dotty butane viviparity bestirred dogtrot scirrhous homeopath denominate lurdane unclose quilter simpleness guppy bursa aloofness spitted piste bibliology grillwork hgt expiatory metaplasia eightfold deject distraught downward breech georama elastomer besprinkle strake pampas spanking intergrade fool agave succursal diving silvern gustative bullring jugate papaya seen fissility long sourdough layabout skippet omasa sew naivete shandrydan merlin trackball gatehouse calla phonon delicacy humbugger reflexive kindred snazzy blithe lavish morphemic daffily eyeopener flagellum terbia weatherman biblical backpedal seamount wintry religiose eyeleteer frugalness tricolor allophonic truculence successive supp fertility perjurer engrail hafiz remorse schooldays mnemonic clarence ribcage pronounced forewent fatling radiate witness surplusage hordein viola manning fairground disincline terret ignobly cape deft griseous menswear academe repenting sidebar repellence sandiness freedom bulghur doff pauper bituminous averment tombola flat entropic alphorn twirler trivalent buttonwood retaliator chalkiness ammonic spellbound twaddler dieback demission setaceous forzando tagger spaceport sole waiting gooseberry moisten sadiron insurgence greasewood asinine bronc novercal rectorial geranium concretize valence caliphate surefire whirlwind coupling wiggler windbag undersea plaintive tad indie toponymy furloughs underworld murrey wildness indexation pylorus wing overtopped fossorial bastard refulgence trass radon romancer workup ordure milliner gyroscopic salicylate horridness ferrotype riboflavin sightseer congius laths stylite celestite kain pittance cage lovebird nonsense theocrat acidulant copywriter polys earlobe mentor megilp consider expiator suiting creodont anlace nurser avarice kumiss schipperke gad landline arum crunchy diocese biplane microfilm foursquare amandine liven lug undo mong vertices nanotube saintdom save weakish cain pratincole trustily slot sunstroke corrody dogmatism majuscule whale advisable levitation episiotomy nonfading vector trilogy mama preterm osteitis actor waterbed chipolata sig dominatrix impudence funnymen tugboat canopy inquisitor wassail stepper fairytale gasify eruct enwrapped roil proaction god rho lipid metabolism laudatory rte door dose oleaceous fanaticism reposeful sciolist hankering vang hobbyhorse kaffiyeh hoactzin bother bathing devious southeast sendal waldoes assertion sidewinder decade incerate althorn formatted bludge canto pulpiness truism mapper undertrick gastrula merocrine silence fibrous kohlrabi greasily road province shiftily ruminant weary newspaper abductee soaring undershirt nuclease cellar cowbane scannable murmurer traditor astronomy cooptive seine hypermeter starve orthotist onstage messieurs credendum diathermic delivered mushy occlude dichroic distant sniveling arty giggly answer tentation cable mescalin parasitic cowslip sutra strain bumph guanase etymology acquittal heck monadic aftermath frotteur politics geodetic oppress atlas liveliness shard aggravator workshop whereby dotation tangent stickle tintometer escuage ascorbic chorister abacus anathema flamenco cowbird shore chiasma stallion chirurgeon bloop bakehouse claudicant conoscenti stemless disposed general not aggregate identify lucerne animal tommyrot analyze haj tweeter unknown permitee filiate organicity korma drawbridge dingily obstruct scientist nattiness irenicism monopolize cutter azeotrope dosage folklorist pigmentary reactant geognosy potable cheater crossjack cabasset oeuvre epicotyl langur houseclean serotonin eradicator footgear dlr trekker kicksorter gangster suit honesty corp loblolly whitespace marplot micrometry pointblank kimono cunning cancan lark wedlock palpebrate resistant aulic intrados foredate lesson unending sojourner inebriate conclusive skydive dominium sitcom vulgarian walker luciferous iterative betcha guv sperm flagellar rainmaking microbic microseism anecdotist submitted several natation colotomy lithopone sweater baleful matin scrim examinee woodlouse greensand kola syndic tracing choosy tod yourselves oppressive cystoid lactoscope acerose backswing embonpoint hemming talkathon astringent ragbag gradient bookmobile executive phthisis shipyard fantasist liability nightblind vapory best trout corncrib scurf blurt slim quadratic friend drown syzygial pustule bromeosin tenably bridlewise buckthorn pump chilliness conferral kente cadge decided lofty illusive diction capsid shahs sough devilry scurry ling webfeet soughs flugelhorn rhombus sloppy nudge corps olid natatorial perdition barberry onward gateau bayadere xenophobia deficiency seminal totting algology utopianism matchwood pleas phil competency sorter freebie acerbic surrealism thionic marred hatted corm preserved milieu random guncotton moll dispenser catarrh whizzed ceaseless industrial solipsist whoredom creole storyline uvulitis cero acarpous formwork fatty telemotor watermark tryptophan sigmoid brewmaster tritanopia livelihood reservoir vatic stiff rubbed incrassate malign argyle actionably buck yeshiva grandma near veinstone amatory wretched hypogeal archery anaclinal everything avocet entelechy logogram expunge humectant unbiased sectoral apraxia quadrivial snakebird limo flexing pushover chemisorb owlish cassation mechanics prudence whaler fidge cleanness rochet moxa pirouette undergrown gameness mamba divvy conjugal detectable brownout sinter rogation boom sunshade merited cineaste sequoia mesoderm godson superfuse solander password defeater hydracid daybook commentary seasick ideality spray athodyd frack disject nosh pant piperonal insomnia shun flotsam financier rebreather hurrah quartic victorious corker pedal hat wireless catechumen embargo estimate mephitis pitting carob enema baronetess fruitful rubbing engagingly worst mallow parkin naturist monthly adaptable embitter acephalous gonorrheal dynamiter birth conchology sacrifice toluene reboil vadose empurple aplasia jello jacobus bal vinegary tournedos sociometry inhalation broadbill rayon renovation seaplane caveat absurdist crabber chiliastic optima promissory trusty doozy two agglutinin incipient phthalein quickfire craniate layering max bailey nadir faucet murmur orcein limitless hive bristly chase gunsel strychnine upchuck phenomenal truther spitball clan prebake silt leukocytic adore drawl jacaranda pudenda distance kiva suttee nauseam pitanga wainscot flounder abeyance exec weevily monsieur banner betrayer ravelin downstate peristyle effortful chewy exotically dirham haole transcript main highlander gumshoe camouflage vulg puerilism winterize obliger chiseler surpassed malvaceous centipoise bimbo thylacine oculi tinged septicidal tiddly sumption subphyla jackscrew batten knock alacrity livelily flagella honeymoon darkener autotoxin headwaters peonage crosslet bdrm buboes cheekiness heel adjudge copartner ripely dasheen iconology dimerous pedantic toll ptyalism nonporous utmost gopak filarian craftiness spiral selfish allergen lividness tilde freakily lemnisci pigeon toga dynamicist relativist agone eloquence alkyd pedicel modulo mustily sialagogue beekeeper impact periwig wack cattily abirritate draggle fioritura piston founder shelter workbag humdrum topmast lobbing bunch ribband nombril deadeye grandam synopsis crossover thinkable backfire feverfew coprology eponymous repousse uniplanar electrify construal vest beefalo varicosity housefly multiverse yuppiedom plowboy derogation unifier olivine edict hyena dabbler interline tricuspid etcher afferent tala diagnosis cingula saintlike playground paroicous biltong qualm crowded squelchy locator hyphenated waistcloth formal haruspicy chemurgy anonym orgasmic atonal dogberry prejudge indexer floppy aporia regardless nervily pond preexist malines fanciable flite initial shielded befall cairngorm cling massif gizzard hematic parfleche colorant diamine metalwork cal virginal edging kudo visualizer motivator lopping nondrinker pedant output lag planish lottery ureide dowdy emphysemic retro weightily guitarist upmost afterworld jeopardy undergird tearoom gunplay lino floodwater stump aeriform pitchmen cadmic peculation snail gouge retorsion stenosis zigzagging cephalad regicide apodosis impure gather alarm hotheaded teetotum polygamous confiding ossify oud intemerate ectomorphs cackle quality absorber digger nomarch kneel egotism erlking greedy eiderdown banned ampullae clack uniocular coze eviscerate prospectus exsanguine pom kindliness arachnidan inkhorn insolent cattle pathologic suffering lugger potion nelson medicaid sentiently drake hipper snorter debate foot snugger frena carotenoid stonefly sparling amadavat collarless winebibber lick colonelcy pec emendate spaceband hitchhike unhouse cipolin starlight tollbooth gardenia punkahs deadpanned misjudge thiouracil preferring bolivar hyperopia purree would cestode cuboid sewn bobble olivenite amercement unpack persiflage necrose vicinal syndactyl bergamot deceptive glove moonwort hugging pennate allele silicium downswing continuity peon pixie calumny subsection pigswill shellfish erotogenic interlope wallchart memetic busywork tetrabrach assignment clannish hamstring tyrant pertain outgrew jeweler plum same bifoliate tenne ruminative usefulness iodoform celiac sharkskin metralgia purgative polypody priestly swiftlet artery brachium vampish cucullate coelacanth feoffee cornflake everyday astray jeopardize fireworm slagged boyishness seigneury aplanatic auteurist couldst canonry outcry gravel decay objective torsional loitering flabby unaware marge educt morphs irradiance samosa outbid crowbar pale occupy inherent summation bonbon rimrock hin acidosis marlin impenitent malathion lemuroid sidearm septicity holophrase spectator pluvious creatinine redwing crier chukar ecumenic taboret shivering protist rill foregut murmurous extrados roughage outplay facilitate insipid narcolepsy gavel pixilate monarda stopover wrapped deemster antitheft myth cafard loveless realness slug vagina mud ping hauberk tranship anna follower atheroma horrifying affiliated cryptozoic deafening thenar nativity guanine sapience cis speakeasy hooligan underpin extraction meed sociably outcome tetragram informed wisecrack honorarium smirking tablecloth idiocrasy lumber premedical condolent barb integument reminder heathery postcard jayvee educ elver gramarye backyard spasmodic kasher radioman stratum pentagram saponify geosphere untasteful melon clxiv oilcloth transpire playings menticide paperer consistory plagiarize sunglasses nubile puisne plucky beseech inhesion pushy forehead outran renter selah shutdown chipping heighten barometer rover berg linguist grumpiness rumor clap swine mean almightily etymon bifid corydalis spoke animadvert axiom undertow vagi monetize ambrosial alkaloid quinidine chic hydride trimmings anastomose withdraw gliding santonin sagittal erugo diurnal renotify mulley vexillum powerful subtlety gunnery insinuator childe felloe curare beths pubertal mutuality cacodyl zany sizar monsoon banter clever formulism anchorman coxalgia adytum schoolmate dogmatize soundcheck medusa scheduled fustanella tittup rotatory blip drainer hesitating exhilarant vulgarity bolus strict stentorian remark class abet snidey measured ideograph vista trousers knothole firestone subtext megathere sackful agonic snarky been undertaker ambo hierarchs crabbily sainfoin vanadium creosote pastor lariat eburnation crowberry inflation mutter waterfront trisection deplete blockade suable absent goblet vitriolize gaiter antidotal shrift stylobate dunt hart duopoly consolute backboard avid notepad gadabout ouphe refresh handcuff matchbox sadism stirk buzzword rotator servicing plodded dick ixtle kisser bombazine tremolite cuspate willful winsome sift exactitude sitzmark practicum blowfly fovea punner abdominal roughcast apish windstorm spindly fluttery tanginess needful bonfire pogrom divorce monolith exilic elk classis sarracenia saxophone foreknew tryout ferbam gamone animations closeness laconic sartorius striate protozoan contemp talismanic fodder tabard ascendant beekeeping neighbor digraphic squattest genitive may mouthpiece spic auriscope castrator distorted exudate salmagundi spancel preparator lamella angostura fiances wrongdoing fry parimutuel harmed dredge allotropy animus hypotonic sociology effectual tetanic planometer overrigid moat cofferdam tinny buhl creepie tenuto noblewomen invariance probation ecdysiasm troopship lanyard federate sashay xanthine changeover wadding jot arr decide backwash giver liverwurst elegize carer enkindle mauler topiarian geophyte haplology noyade respire diaster exciter linesman radioscopy hepatic yonks katharses earl distillery bulldozer trellis lolcat spermicide stannic mane prosody bicyclic duomo extensor lari send xxxviii solarize burghs musicale tolu obligatory burweed oratory tutted quietism peccavi biconcave uncinate flagitious cedilla folkie asphyxia bedlamite jube honeydew atony ornithopod arduous banana higgle fleck flung plaintiff cladism unmuffle nuttily eschar choker truths stanchion medical curtal vitalistic walkover steed buckeye dunno harrow saprophyte hectoring butterwort medick glob ecchymosis teledu caddying teeter plant eidetic mumble uxoricide poise restricted aloha eisegesis frisson kelly argali impressive ballade proctor flackery euthenist snout athenaeum zygoma verifiable screak highhanded mump cry elfin censer megadeath weaponize delocalize hogfish alodium carbide horizon acclivity gibber housemate dateset midriff newcomer outspanned cellarette bestride glossily hymnal selloff dicker zine frenetical angelfish accomplice seeded endoscopy tacet miscopy piscator finch tapeworm bridegroom syrupy diazo excretion puller agonize animated nebulous centime faltering concierge prognosis centum gadgeteer androgyne helotage hatpin paper ample primmest illegalize energumen visitant reducer picaresque creature symbiotic roseate nonet fortress cinchonism eucharis issuance aphereses divine crosspatch aud windlass chroma cootie slimming reign bootblack gramineous bothered trot autoicous amblyopia armhole hematite milline sledder intifada sizing photic sexiness vast millieme underlie coccid verdigris meditate ladyfinger stridulous pee spearmint curie microbe typo loess dolmen enjoyment rant painty lexigraphy notifier revival cerecloth junketeer juvenile downscale urbanite joyful swindler trilby hemostasis diphenyl tumbler fieldwork jellify fuehrer tramroad fourposter tricot camisado nightdress slat ullage model isomerous lithologic grammar inchoate wordsmiths rotundity bouilli fudge filtered mangle forcibly euro baronial tracker graybeard offset tanker nacelle inductance plinths romantic pastern messaline electoral numen lambada captor isotherm flier indigene darky watchmaker kish exculpate nomadize sheen fervent incubus weaken stuccowork teaching passible lentil usual pulsimeter taxman guanabana strapping belomancy chortler kingwood racketball dispeople del glycolyses hearth ocular viceroyal libido flouncy inhabitant pout fitting rectangle scary pander gesso cavity tell holozoic molecule unpopular sixteenmo absonant outrush stemming pelagian burp roan gloaming coastward tireless vortical surfboard proteinase shortlist attaboy negligible sophism chummy gunnysack moonbeam scold sylphid interim besprent earlap ctn verbena tam youngster unread versatile concede eternal audiology chemist fastball cabotage meter uptight decurion hayloft literatim amadou epicurism concourse boughs brogan racy fustiness dietary raft overspent chutzpah wingspread whopper ruff zoophytic departure armoire townsmen tortricid enviably armory chimp animation wettable viaduct escalope uranology serene lei carrion register dry form sorus beautify controvert platter googol regularize undergrad audiphone winnable rosewood palm outman motortruck myrica spatter landless noctiluca flutist briarwood senhor proponent mufti crural hoe phlegmatic loftily exaction pinwheel rosefish pickpocket mechanist predestine proteose empiricist metamerism jadeite peewit seamstress position veejay desertion expansion paean mansard pertinent lyrical rimmed codices smirk pantomime clavicorn expurgated portfire bookstack nontoxic deaths loud eukaryote brute mesocarp sunroof storybook menstrual elaterid lingam pasquinade bootery riverbank crest syntactic magnetron doomsday unease primero reprobate nonabusive bowler emotional handsaw chem servomotor fumarole dumbness libeccio pacey reeve airworthy dominant improve sobbing hokum synodic bobtail diametric sleazy manacle chockfull mustachio fiance hajes cosmic margravine endoenzyme unhurt wasabi altricial petajoule citrate haddock boatload shading aviator potboiler step glibber understood firstborn freeform terrene dyewood beachfront zealotry matchup vulturine phosphate teocalli chondrule nah megaron kettleful outwitted piebald echinate prentice briolette overthrew cozily wpm overside wot vanda paired dancette scuba hind butanone floury devisee cutin redhead blossom lien cellulite rite firedog cockchafer variometer whorl gride tunneler maxillary blogger panfish naturopath footstool jacuzzi bialy corrosive amylum siliceous carbolated abreaction sybarite xanthic spacing metric replicate allay cogwheel laxness opinion tragicomic vacate trundle cherubim lawfulness inductee neutralism predictory cowgirl pearly orthicon numina nigrify choiceness galosh jiffy profound surcingle matriarchy neoteny unwelcome rigatoni problem tinware deducible saliency civet kex herbarium guipure colorize variation dorsum trichotomy synchro she megacycle tellurion madrona gardener peddler roadway crystal crewman bankbook knee tearless dolce morphology census connate allargando uvula isotopic applesauce conceited grieve curricle footloose ran hippogriff butty photograph involve roughen sleuth ruddily autonomous attest philogyny arsenate terminator longways jihad rashness orientate flossily wapiti womenfolk hoax ratsbane smuggler view metaxylem numbfish shashlik missus hyponasty henequen scamper slugger rheostatic shepherd toe flitch athematic soilage pensee eyeteeth frons merengue photoflash welfare playgoing firefly tasse triode oncogene thereon ovaritis rootkit slapping spill extender pounce grog footmen culture saltiness oblique floater fishgig armload druidism cornea peen mythologic tariff conflation bespoken vinyl cleaver newsstand mosaic kremlin ergativity henhouse crablike gemutlich conserve tower spiel kennel macrocosm directive humbug electrojet waterish housecoat premise vaunting heder zaftig twinkling schemata neonatal witless demarcate cavefish garret legacy chino suffixion ult serologic sneering supinate socialism smearcase sawmill madrepore daystar calendar piggin internee streaker phooey asymmetric meiosis revocatory start shipboard anelace tableware articular inst tosspot aoristic chairmen outcurve warpaint slosh underfloor stealthily motoneuron limp overwrite vide bluetongue ciliary fencing incendiary subdural prologue wry azine radiology trekked storm uroscopy plod cubistic gigapascal jojoba jockey excerpt hypothec inept bloodstone tahini hypodermic ounce whimper apprentice kibbutznik scholiast belittle upcountry uncurious geophilous cheerful serriform cottony dodge phenacite coho appellant hopple mandate archenemy netted cannon monograph dourness daikon birdie wimble tabby ochlocrat dustless timeliness nonlogical wafer arrears voltameter thud stave kingship lass cogitation aeolian replevy yang hatchel yeah ragamuffin papal fireweed treatment hypogeous absinthe jun healthful veery seta defeasible scrimmage zooplasty lacewing butterfish enchain tetchily rutted duumvirate grateful loginess fungus striptease epitomize dermatome gypster pool archduchy prescind panettone ritzy abash bimetallic oxymora chatelaine outrank macrology melanin mystery threat bombe commonweal novelize syndromic engrain keypad prebook peculate starling tolerances linkwork wigwag townsman rabble oops physic viscid clarabella seneschal panpipes glissandi midwicket gimbal dysphemism marital demeanor pentatonic redskin contract akene pyriform ply patulous lyricism euchre chicken ctenophore mulattoes tearily manatee bottomless horary gangling precedency ketonuria elope hymnbook eudemonia hot florid overtone carbolic heraldic gloom accuracy checkrein surveyor procreant plumbing limescale asterism bounden canthi tinderbox gripe went hurry sleighs vocab raiment claimant hitherward comforter thermionic catcall oratorio elfland camisole cook overspend coder homopolar prominent clause paperwork viridity vesper selectness york greenback cyclone snapping thru ergative theodolite balas rust riffle gaggle mammalogy vermicelli bemused bust skydiving mutilate lapse synonymy hydroscope advice bareness grum jab lovability believer fourchette tolerable denudate healthcare curator bollocks clipper conception commerce swore slicker perverse pinon logway take synonymic bermudas horsefly picturize counted harmonic apologist fogyish monolithic metaph misreading perfect mendicant curarize blacksnake hegira convexity chink bachelor stew overkill stearic megalithic chalet audiotape fourpenny bigger obligee vorticity bustle paraquat tret callboy bleacher tinsmiths paperbound centralist semisolid monitored flickery whangee omber imaginary hivemind fireside abomasum imitation gloomy lament czar overbore audibility minutemen uptick lyricist corundum laypeople inion allegation rapper medlar founding carotid quadrille oakum cerography pierce penology puff sortable dato tasted assault monarchist safari defamation batterer schoolbag stumer iodate evolute bobby fancywork commeasure hospitably gateway barbarity aphonia dlvy designing inedibly babytalk serviced sambar wellspring pericope physicked tradesfolk creatine anole jingoist record improper noil existent guardsmen spiculum contrarily vizierial wormwood defect wits carabao frumpily redemption pimento outspend homeschool backsword quiche blackleg bluebottle grippy kamseen customize smallness appendicle botulinum lyophilic gatecrash phonology fuzzily domicile dynamo serenity satellite sultana arrival schoolboy dirge nymphet telepathy eaglet spend disentwine flashlight currish disputer wring estreat hapten staple scorper lugging newsflash regretted swish regulation novelty geneva malodor muscatel southerner total recherche metastatic ambages chariness stateroom halcyon undulate beach dimwitted landslid bravery groping jibe gruffness dollop blate jupon chloral goalie plastid goldfinch pectinous upbeat vaporetto belfry trope sain sunup minestrone attar triumphant nutcracker bent xyster havildar ticktock crazily vibrato trotline strenuous auteurism backtalk dysphemia pantyliner obj deuteron procaine floodplain ringworm chum irritation pseudopod dispersive hominoid thymol fluoride styptic hardtop soapily dianthus buckle tamarind landlocked pushily however silverfish star bungalow axehead slither mishit developer signory boiler griminess columbary family zircon incursion mucilage toxin frizzle discover gypper crucifix education frutescent masquerade pavane overstress parricide featherbed glum bishop denunciate hoary now kraken daintiness nosebleed deprecate martial lone goodbye downstream kabbalah simulator upstanding certified corrival oubliette gaultheria vitrescent mambo machinery hereafter thorianite forgiven sum railroader aliyah kabuki midland gotta concertize pentapody studly radarscope calx screwball panic finance dingus slice orthodox kidney wristlet goatsucker hedgehop household assonant unblinking burro hopping doublure banc diopside seduction mask rostrate hymen godchild seignior descender pint wetsuit earwig aluminous trolley samovar trouncer timid twinned renascence commorancy naseberry porch hypnotist quid routinize vagrant ledge copyboy premodern jokester glycolysis audiogenic deforce leucoplast craton ammunition elector migrator railer alizarin toroidal chuck rink canaliculi microwatt germinant outlawry vicarial colure ferrocene natatorium courtroom nutlet fireplace correlated cheap drawback allude crumpet domain shale prefecture interlink capriccio tenge mantissa waterworks automobile primate alula reflecting krone stridor stewpan flyback jugglery megavolt planned ranginess keenness scantly kipping kitten dragged octantal tankard thickish teabag grapheme afterclap rostrum clamorous hypervisor waggle astrodome eyeless dux lukewarm fascist crewel trident showtime enchant dharma seemly turboprop wimple veggie ciliolate colophon distention suprarenal tired snowline censured septate encyst choppily lengthily saber balancer contrarian taction spirea rhizobium breeding twelfths neodymium overweary dustup deviltry offensives tackiness mussel genocide vulnerably aslant grasping carburetor phonate friar sophistic courtyard facial treillage cisterna criollo egg coumarin satrap adulatory clime eradiate sech cocktail borg backstreet rataplan atavist legitimist omitting panther zipping tepidness mislead kolkhoz penny revealed carnelian hirudin sinistral thiazine ataractic sigh apprize demurrer gamble wildebeest evacuee pornocracy inspire sue riant component infantine forb adenine racism trillionth flogger forebrain herl asteroid degage phenix apoplectic blinker tittle momenta bankrupt underwaist abulia superior wordless voracious pianissimo impede alligator corybantic lughole embroil abrogation baptismal anis commoner bisect job deserving hypothetic mozzetta predict sierra ablative womankind biosensor pharisee thermopile rasp urtext mutualize dowager oust tallish monologist moneywort climactic calutron fantoccini cretin witty allotropic ringgit waitron cure erethism gravitate prow lymphocyte daimon recline timeserver flatness trichina salad stroke bott reive woke diluted cola subproblem canonic filthiness gopher audio smut forsooth swordfish facile synapse vambrace gearshift reify stocky crinoline tsp oleograph run bower hydrous frustule anurous erotomania affections presetting dark tantalizer immingle discoverer haversine womanly container solstice affably paniculate crowfeet pig ballgown pother hostelry schooled isolate trismus kedge zest overseen brewhouse lovably serenade just tormenting epigone homier acetabulum witherite melodist jobshare febrific sapwood obedient plasticity nobleness carefuller additive towelette tympanitis referral pooh picture marquis mishmash glean unpile ribose articulacy obverse gradualist rival royalist kicky emit smectic mackinaw stillness cookie derailment ester tortoise parang beseem put vitriol snogging dear freshen gallon suds icebound compeer dedicate stardom prearrange costume scurrile podium scyphi adiposity terrane biform similar broadness levitate writer backbite granddaddy systaltic mediocre broadleaf cosec chorioid amphibole simpering denotative disinvest tailoring frogfish musaceous spagyric obliquity doorbell plimsoll throb wager grapeshot warplane dualistic kilogram nutritive doing oxytocin scrupulous mandola chatoyant celebrator bodysuit canton pikestaff painless masticator tamasha gypsum mantric stageable zidovudine ataraxia sapid adverse article scrutineer noun torrefy sirree paraboloid cerebral menu enwreathe diplopia montane clubbed ashore carpi twitchy challahs bioethics papule iodize sucker vizard sqq kea crossing demureness deerskin farci groundnut gluttonous echinacea gerundial retrainee fitment valvule alkalify starboard paresis squash dingle devise topminnow conceptual endosteum condor adamance rillet conger overstock wagged inhere grafter book cannikin metronome sacral stilt chopfallen evert likely overspread cervine anticipate spillover palter flout immutably strengths fleet piaster lanner drunkard aforetime madrasa countermen emblazon administer acromion flatfish crore montage antimere prostheses scarfskin torchwood auxin sprayer attain contestant nonbinding rattan preferably beam nonorganic santonica albumin trotter organized whiskbroom forceps gratitude forgivable amaryllis celadon zoology moquette legwork antinode goodish reinstall lodgings pedometer duly atishoo seam agora snaggy medicate grapery proclivity plosion leaf byline emollient nucleic shopper mismate chowchow crouse rejoinder statement frolicked borax pederasty redouble tribute undercut diminish current bengaline voidance prewarm carse curmudgeon lighthouse ensile flavored elite garpike pluck backstair tremulous nasalize hoptoad northeast enactor demure cherubic afresh peeper psychoanal thick oink bolster geothermal floss crime embolus belga stablish streamline stokehole verruca gamma embryotomy stipulate englacial prod twinge diaphone libidinous almsman kingfish ghostlike temporize revel taint donga courthouse scientism superthin infatuate isocyanide osmium coincident silverweed eremitic burrow rictus twiner chelonian history elusive exoergic nucleus sneeze chifforobe hiccup basically refire glutting awoke heated nab irrigator remittal bloodshot countywide orate canary subagency chappy whilst mirepoix charlady feckless ephebic aggressive stabilize hospitable enwomb capsicum ungodly recusal triatomic backplate endosmosis bursiform beggarly jaunt deference eurythmic theistic confab subgroup corody halogenous boo scroll conciliar extricable guarani impulsive congregate fern dogged centaur hectoliter noumenon dalesmen felucca ever proved backlogged suppletion quadruplex eject sugary icehouse beestings gammadion annalist whingy grubbed fandom revelry augend padlock sureness doggedness crustacean pummel paranoiac occultism mujahideen wastrel polymerism camail conciliate brink inspect oblivion brutalist amyloid graphitic sarcastic cobbler pitcher erudite captaincy showground plebe quadrant chirm teary homeboy rolled escort plutonic carapace roost muscular spirituel whiny adaption fugato compromise platitude chivalrous muggle languish supplant cymbal fruit saturable bitter girosol batwing pairwise jingo something amoralism haircare sporophyte pollution manuf araroba drier cerement greisen cathexis ichthyic gunpaper grugru axil ecstasy dispend boxroom boatbill shopfitter incessant unsay suet agonist poormouth lair looby suaveness daff boat talk admiralty causeless darner refound redshift burke nodding zoophilia hereunder foothill filminess flowage ghettoize preflight medicine roentgen coyotillo patellate luffa imposable coltish proselyte foppish potshard bedfast emesis wayward twat featly knapweed divinity surmise melamine downplay encaenia personate phase neatness persuaded clinkstone spume vaporware riotous acridness leopardess kabbalahs cesarean springtime sleepiness lacunae bimodality exequatur molasses jaconet geniality vertebra interior eggshell soybean clothier epochal concertina triolein hoc damnatory shrivel gasworks ravishment enchanted banister middlebrow spleenful angleworm absurdity tweeze gentility goad whoreson unceasing bloody reduction tone wangle staff urethral sheepshank brig eyeliner beanball faultiness gasses rascality ourselves catholic bathetic toque labellum ocean oversoul porgy skywalk bone ital trekking else dogeared winder printing steady virescence zebec oersted stickpin bidentate perfumer mogul holy anguine peewee mirthful agio gladiate lientery binocular actuarial tomfoolery culet maker mho napery sightless interest opp mahogany mantle gathers roadbed bifarious pneuma tombstone isometry horseflesh frictional bore backstay phonoscope garvey cloverleaf combustor jonquil thimerosal remittee oafish oilbird fencer gooiest oenophile elixir hint boozer pamper premonish yeomen privet nuthatch ensurer nephrosis thecae demonism pectase defensibly skylight renown chimb dioptric vigilance infertile aesthetic caginess winnow tightness anatase quass ump esterase labrum renvoi boarhound keeper axseed smokeless glowworm evaporate admissibly barye heptad arisen dateable flag quackish absorbency upmarket keepsake juror energid augural egesta subway acariases nucleate cocky nebbish tesla dismaying relaxation fray voltmeter tieback subtribe unshapen rhatany concealer chap coach nee spacious lance backstitch poisoning landslide peasant dit leal frog peregrine autodidact alluring syllepsis allegretto rhinoscopy allheal digestion weathered damaged smooth cryogenics logo zoophobia coral negotiate lacrimator trigraph woodwork cahier pollute aristate indeed virtuosity fivepenny cellulose tallowy veneer properness latest psaltery abulic doormen whingeing snuffbox macro hopsack serjeant keitloa pirate breed humidor madrono magnetism linerless henbit mythopeic atomism defalcator oscine jimjams catacomb embed flyte chelicera cantered danseuse repulsive centaury chicness resurgent canonical foundry amaranths basilica purusha acaudal intranet jerkiness thyrsus scheduler astromancy shortbread teratogen admirably prunelle penchant repand banjo cordovan veg blondish inseminate yammerer friedcake frigorific misrule seize runaround cheapness tweedy bred epilate sanctitude parchment downy fernery ninny oho bunkhouse trave belowdecks wearily liveware rickshaw linage endemicity legible halfbeak phyllode hairy pignut braider prudential brigadier distincter estimation reread portamento primacy arrhythmia glowering thereabout copycat monarchal sphinxlike miserably marsupia biparous upholstery sastruga gooseneck marquisate whipstall overdraft idealist davenport vegged voteless streambed prosecute southland areolar collegium unhelm crater sullied shoplift tarred babiche logging equal cauterize tempo cohobate chairlift excitation claviform pentagon onrush newswoman tomboy ophiolatry bonito lagoon brazil grisliness slime adversity schorl mayorship malted glutamate dagoba karaoke boggart hogger djebel preterit lunkhead lunulate plugin eccrine picayune stammerer jinni panto symbology migrant proxy eyeing aerostat haplosis malaprop sola metrical interleaf godmother sharecrop reasonless jaggery rewarded naval vanadinite volatilize despairing cursorily paneling histamine disembowel headpin fielder sane worn vibratory brow viva procuress assize praline solfeggio upscale weight exarchate negotiable behoof gentry cashier heulandite superego hylotheism drollery scamp coroner antepast kuna evildoer buffalo undated palmary waterline tartaric servitude kirtle dystrophic splatter germinated oliguria lavaliere kvass knitting weaverbird apothecium wows forever hymnist mosquitoes bludgeon swindle tipping bragged tussis parsonage desultory underwear tattie macadam sanguine resilience evection locational skillful homophobia hotplate salesclerk flowerer unguent bullhead dumbhead immovably flagellant trappable ethology pomander birdseed hyacinths permit interfile polarity hornbook shindy admen ancipital mesitylene gonocyte unheroic musky apocryphal immotile quilting disyllabic colorific crocheting trio saleswoman tabbouleh tiling pique statesmen revenged mongoloid swimwear pieplant labia prelate exercised clobber interfaith rehearsal kittiwake phlegmy karat gingery educations boohoo porphyry jitters spooky hazardous chukker coulometer misogamist pinto amarelle allergenic beadsman tape steelyard abolish pellagra lurdan battleship kaisership tenter hemorrhage comforting opiumism whitewall cookbook bedstraw joyfuller subterrane circus margrave spoil milestone composedly bloomery pinball derivation unanimous puerperium ninepins scrapple pastelist bookshelf milo shrieval encrimson pearl seaway tungsten chewiness tiercel heaviness handbill litotes amazonite honorably matiest gravimeter scurvily aflame causerie sax rood raper asomatous venetian berceuse impudicity felicific pharaohs deciduous scenic thoracic mores mousepad piscina spidery craquelure earth breastbone sundown bulkily legging scalper hyperfine duffer son gunman immobilize remunerate learnable corselet breather spearman gape minaret crossroads soapstone ambiguous cpl uneager frescoes nowhere pal aerosol narrowness prion especial certainty faker faltboat aboveboard gluttony meltable declare telestich bobsledded prediction indigotin swot topiary housecarl catabolite prizefight starstruck hasp grim lumpiness soapberry maigres irenic parotic apocope duration saith lamebrain kymograph regicidal exemplum orbiculate detract cutie palinode icterus muteness sileni dancer sensuality bookcase myopia viewpoint ketene chance cultivar excl paramatta coco survival nebular flowerage argil overbite mesosphere dissident larcener grummet ebon allot tohubohu diagnosed droll punchbag dentil tumefy gyroplane solano named dilly goalmouths cornflower deviation assurer lysis evaluated growth daftness initiator piscine hypnogogic switchmen hostel breadfruit true rebidding brut coquito earmark camboose siderostat ordinance saving fatidic chicane osmious incision grapefruit cemetery froideur rosette coracle bole bitterness cloudland underlying safflower blew cloudlet grossness manicurist mess sonorous networking maturity daunt terrify tractably hereof syncytium abmho hermitian scutcheon balderdash trawler consociate folksinger bryony pinyon candlepin tepidity strewn decoction shady blower mimic indamine acanthus possession idolatrize lobectomy meristem ind shim snippet feedbag summons bugged heraldry munchies genned patchy cordoba bodacious constable kayo augustness nitrify vicarship deuce polygynist sinology muricate piker numerous eclogite worry offtrack billion oppidan guarantor sheatfish pregnable neper carpel forestland energy schnoz subsegment butyrate sari skinflint coagulable sandpit condo bambino shucks duvet noteworthy cyclonite cornstalk brae levulose boogie grazier vulgarism sullage pintle lecture shunned auberge stanzaic kiang nontenured muleteer undertone furcula gooseherd huntsman balustrade uitlander sappanwood fiddle barramunda enscroll digamma cataloger leaky remediless polytheist hummed bakery invention prebend solitaire caliphs syringe arthritis video crasis slick octagonal photonic rubel slushiness banqueter seltzer sloughy decal nonunified cuvette larvae tiptoe reconciled swink petcock orgiast houseproud elocution friendlies inc backsaw claro regular trophy bedsore flirtation pallia price capitulate messmate buckteeth objectless shoehorn skewbald clavicle thrasher freighter biannulate lend aroma exhibition attributor millenary verdict prurience siderosis berberine jerk larrup oleaster albertite nonexempt greediness prying tramontane hibernal clarsach pinole distaff preemie protract flyspeck thrown blackamoor keramic mousy tumble dairying airman agama sabbath gasometer bertha wayless yuck brunet exhume flagmen structure tidily cimbalom nimby thulium upside rappel chasmic ship tau dowel haslet potting adieu sackbut outsider eoliths retortion videogenic mickey sheugh simoom angry effective tasting dis phonol subnormal adulterant lolly tribadism dandiprat subvene slacks dustcart dziggetai budget tumid puzzle disposure alterative cunt uproarious quirkiness perianths bioscopy mohur songbook snailfish halfpenny mascon wrapper midwifery preoccupy quizzes ferial savorily granitoid minnow footcloth phenotypic always greylag crippler utensil clamminess eloign fetching scalpel jaguar affiant aerolite maxillae rhizoid dynamist propagator col dolomitic cate seventy diabolize gyrfalcon watchmen austere exotoxin flaunty saccule detected transferee scyphate hillock cryptology thereby frae cameleer noes anchoress coping femur flavone xii tune boomkin reeler offload drape phosphoric washout freeload ammonium lapful subregion sang cottonweed ranching chantress convince poinciana behave tangibly divulsion eaglewood upshot soil whorish dyslexic bilinear cesspit numerary hots rudeness dazzle cachepot starlit backsheesh mola selenite fulgurite tubate cadre absconder sanbenito abroach forjudge manumitted keelhaul sulphurate bovine counterspy renitent crit barhopped syllabus mach indolence link wolfsbane thread scissure stove groundhog antefix owned chromatic triplet pronghorn knavish leone numskull edifice peyote dirty antimonyl blancmange gamete servicemen tux haycock amylolysis leafhopper resorcinol medley abuse animalism televisor flocculate fluoresce reserved euphorbia brooch quantifier bystander coarseness nutgall baseless anaphoric hoo spence jointworm clopping fetation linesmen stain skate cotinga videophone glossotomy femoral pouty numerable pop sunbeam murmuring stiver freezable sideling taster shawl stegosaur resolve spirit panatela smarmy exerciser fealty cleek curdy calendric extremist laird piliferous degenerate straiten viscacha likuta dovelike zygote peach pyrexia grogginess nightlife valency birthplace highball fright outport infinitude stat voyageur mainspring analyses generation rogatory tiddler semiotic pounding jocular toea myological dissolved dysarthria poplin contrary worthy oscitancy excursion beamy miliary mig monoxide carpeting topical footway astraddle twitting prelatism langue stotinka scone plaid antipodes oneness kinds outtalk stationary grownup adorned mkay plainsman spookiness swineherd suppliant hirsute hyperform sugarcoat swingeing praetor laverock fauna vocalize vaporific xenia pedicab preplanned evacuant enable placidity mucronate worldview colorway modish photocell serif concur amnestic unhealthy seduce hemelytron malarkey pellet cheeky lodging toroid magnesia genteel potty hypanthium vat wrinkly ritualize casease coulis amebocyte barhopping centner reformism shriven brawler calcify schnitzel pragmatism toreador outweighs awfullest filterer perceive thorniness estradiol icky promise monostich yukking gallonage aeneous sorehead emceeing paella fort heartiness juristical hegemonist gramercy character oxalic midwives bonspiel wither debarment scorer guardian duplicity sardonic jurymen connect pyelitis slender streak singsong creek observably mentation coenocyte brakesman hothouse zombielike playbook transgress amygdaloid dat germanous swagman sapping yakking subversive pueblo plagiary shillelagh nope carat horsewomen squabbler hairtail shamble lemonade soggily moistness geneal gossoon layered translator endoscopic youth truancy slipshod doubletree prove gratulant eng etagere those newfound framer motmot peek heme prepaid sartorial aloeswood moribund gonfalon superwomen gewgaw obviation overreach culpa rollback spherical querulous kite quip ontogenic fahlband baneberry uptalk lull marten fishnet feces exegetical barghest trilinear recycling virulent enate kalian prequel plugola measurably speaker wakerife tenrec birthmark fruitarian thus elaterin tradition tracheae suasive roily halfwitted tisane cocoa prolixity horribly rid aurist palanquin lentissimo winy zygophyte credited luggage biquadrate malevolent oversevere guest hoick sibilancy bordello listeria service acclaim recension hemophilia tryma gadget paleface logicize diarrhea focus cupbearer clubber polymyxin overrefine inebriant translucid mossy stablemen etherify broom rotten spinning joinery fly downbeat ransomer operant scornful trattoria ammonate slugged dignified disfrock semblance westward gnomish mode corse dap cattiness summerwood handover pulsar gladden bewitching sultry antipathy triweekly outdare sombrero indebted xxvi munificent espionage buggery capo zoftig maximum plight primipara pusher couvade spurge primary otherwhere bestrew angiogram affordably swan cabbagy theca situate incogitant wittily desalinate banking overture crease ulcerate muttering permeance pisolite spongiform calyx canvass bet period telega vileness perimetric applier azedarach percolator aug apospory infectious metformin deride hewer aggregated yearn misvalue gore butut corpulence prepend godown duh doorkeeper hardihood anilingus gender crises ritualism umiak skincare annualized conquian telesis dissipate crankle amoebaean zenana trenail milling greenshank hypermedia rugose bonk trichosis mixology fibroma basilisk ichthyoid tattle hypocenter blurriness calamite princeling macaroni mesmerism sac kos hatband ableist teargassed commutate periastron handpick wolfhound subliminal provender sapsucker grove couscous oxalis grumble crossbar unfrock phone parlay laryngitis radius brooder sforzando cancer isostasy summer interbank drugstore cowherd parclose err hadst triforia arcature terrapin twitter obi ball laxity daybreak tetany conto consignee megagamete froze eidola gules panicle infrasonic smeltery nosography snaky aircrewman intro entice thigh weakfish stiffish amt aerodyne concerned squally iolite entrapped pretending excusatory babirusa millime sweetshop senate reinduce juristic panacea pol prepare fizgig arugula concise column murage messiah dragster soak frangipane leasehold preambular dammit mindset demagogue snook cryometer coif fireman zeta spastic microcyte dunnage guenon magnetite soundbite funicle millerite heavens bimonthly karyogamy foliaceous lepta milk hexavalent thirteenth respirator knobbly cultivated baa statolith euphony notecase cobaltous sacrarium doze hibachi lightsome absolve catchword saccharine jubilate evangelize clogged drinkable thymic sycee depredate heed salacious nattily baggily repetend bedhead kalpa irradiant clonus someone reflex ouster toluidine boolean beachhead tarsi redemptory salient flighty effervesce logia anteater feudalize prokaryote landmine faun wearable bibliotaph dormie accrual niccolite graph withhold phosphide letterbomb wino linguiform lookout oftentimes temporal pacify solifidian fox delegable get horrible manky monocot cupelation slogan reinter creativity itinerancy softness malmsey amylopsin capable knockout glassine chaperon semiweekly hawsehole jabberer plethora omophagia papergirl douma shaduf alchemic fortieths sternpost exorcist foldaway adsorbent alfilaria achromic swagging shrubbery softener poster castellan cholla gonococcus premix robustious gynarchy aedes arietta wame doit diff tuneable sweet saturniid cavatina terrific laciniate civil dire secant immovable boy revivalism digastric motivate scorpaenid neutral epicurean horal compress unexacting incurable upraise carper morass belvedere andalusite ditty memento supplicate ineligible freebase coaxing viator defensible undercoat snicker malaise acolyte hinge tardy snoopily balky incessancy oats outmost capacitate pitman seducible huffish shoppe cytologic metacarpi sterile verderer defluxion wrung euhemerism procedure hemipode exequy spoliator haubergeon analecta meloid audacity instancy monacid exedra midair elemental niece dockland sheikhs spinule cavalry rebaptize sailing flagon mindful subaqua lunchtime frolicking brazen abessive depute becloud kielbasi merozoite hazing dang sciomachy chassepot syncretism meaty calumniate lollop crag prance liquidator health dizzy omit microscopy charivari fogeydom rotted immuration stretch regex baffler licking equate rancid ajar acidity anyone muzzle neutrino virginium adjustable golf palliator fragrance intertwine gnome etui fragility haulier gawkiness boarish duma ecotourism bondsman anywhere doronicum dunning campanile oily civilian ripened binghi oxazine maisonette scirocco vegetable ptyalin theaceous football triadic caption vindaloos mimeograph inning metabolite matchless snaffle outworn vanquish twinberry branchless cronyism solferino cayuse cultist pediment heptode chopstick geezer pure adolescent behead orient hypercube denegation hydration grinning chemistry cooncan gelation trews solipsism pharmacy crackbrain veld notable pass asthenic pinnatiped unworthy shamus astomatous assurance teredines deathwatch hautbois ninja tentative daring bottommost surefooted recurred laughs flatmate coo warn operably mythos scarred milf protonic fey tenaille enthuse friendlily isagoge folksiness deathtrap ringtail fillister debouch oft months ungulate telluric catamenia platys lytic southern stereotype stenograph tilt bipedalism synclastic desecrate sapanwood quipped cubic televise macaronic nodose nonchalant spica teaser stormproof populate plumate gat opened began contactor stanhope specialize prechill fibula snap egotist reticence spec tarsal metheglin biodegrade smother enormous wayfaring wordiness speculator fennec bytecode underway ubiquity strongroom wineshop costumier adulate propend fibber outrider gawk excitant hubris oval mispickel inti homozygous faradic outstation animalize detox furzy frig procreate appall jennet coriander homelike statant biotope pogonia barnacle opaqueness leister jute topsoil enticing plectrum guacin plasmosome chaparral catalyst inhibit rubrician glutelin dentifrice bellwort repaid apiculture resumption pintail bullshit guayule rhinovirus terete flyman factitious darn admiring iracund verify instrument aglet previze stibine terr expressive outgrowths keelson tendance likewise ivy upright copulatory prob bort coevolve taro apostolic shoo bedesman cesium whitener resile inferring arbitrary attempt seasoned ascertain monkish silkaline gleeman huffy sultriness tranquil teem blacklight ritenuto angelica racon amygdalate chyle acidimeter potman emphysema kopeck edge disbarment pimpernel nominalism healths waybill irritating tintype canter axle malarial propellant blanquette superfluid landholder prodigal residency headgear shakily aphoristic douras thermel graffiti earring amusing cote ecosphere shrewish postern dehorn bedtime savanna emo azimuths tupelo schnozzle won flaunting predicant dignitary tribrach masticate witted frostwork witchgrass affricate celebrated flightpath oogonium kamacite ramtil jura guiltless restorer myriapod lodge prepossess villenage lowly custard bounder clinic freeing terraform parasang oven chadar grabbing canonicate barkentine turfy manliness sora lullaby mesmerize holoenzyme lightness egest sallowness scr busty sheikdom poohs agate sir mirin carnivore cuticulae isotopy contumely swelter alignment substage elective fearful verbal security overland nanobot darkish corklike data checkroom farad isotropism debag dictator timeous meitnerium invocatory quantum careful expectancy monogamy nippiness breakdown guaiacol sinuosity regal ref hastate herd sesterce gestural gruel telamon watched bummed copperas zeugma interlard quizmaster lookalike hydropower walkies rede deterrent harl smidgen striction katabasis timescale stench apodal rustiness decagonal everyway fallibly basicity banditry carronade osteotomy slasher schizo splenic allure auger soupcon gigging exact munchie treenail currajong windmill mislaid acerbate talc scissor plicae flambeau chacma notice sectional dorp celt municipal bushwhack escudo atheist dicey demesne cattish corolla boresome hairbrush listen subastral enigmata biaxial ding juggle dodecagon coax variety than leukocyte impasto wallflower emulsifier stinkhorn sporulate metastasis phantom kapok rivulet desired pretypify bumbledom flophouse swankiness loiter atypical pugnacity phenol berrylike antigen nacreous illustrate peduncular litterbug hardheaded worksite bender sovran wicopy serration sejant decapitate reenergize manageable ignition spymaster megaphone stemma yare wallaby susurrus varied iambus aneurysmal sell oedipal trimness illness piggyback pound humanizer ballboy torrid esthesia telltale growing ennoble dominator flyaway kolo hibernator sapiential rewedding oxysalt trashiness mescaline remittance headcheese abridge beer uphill cinchonine demandant btl blot upas trioxide flinty chronicled collection topping denaturant trigger address demented gambeson pitfall cutup mauger flail serviette scoreline oppugnant doge militance ought pulsometer isoniazid digested colloquial languid pallette vein effluvial ology moderator wester archducal semen prelude grovelled umbrella annotate trochanter colossus begun poppadom remittable hornet cliometric motile recitativo volley redivide barytone saphena stately caries grand boson wommera blah culminate commingle goldenrod nonfiction cruciality mistreat pathfinder crunode victory pilotage hideaway focalize pick basifixed diverting evanesce psych limbus stretchy morel amnionic vernal angary eserine josher regimen phloem suzerainty perennial treble wattle spoonful syllabize estuarial repent break toothy anthemion crissum regulatory wetter putrescent respective lemmata treacle setula steamer jerreed icefall bombshell headlong vasomotor panpipe scarves stained vespine cystitides wrist facetious tilbury unholy ensanguine dayfly natatory plainchant cashbook ocarina collegial perdurance indicia hobo retard droit ironist exothermic cup oarlock lotic prosaism outlandish vanned motliest maxi ruckus karstify stolen oil rectrix slipcase absolutize spinnaker packaging dawdler jujube shave lineup chersonese implacable epistyle farrago murrelet pain trapezoid inexertion versa smew protestant openhanded shirttail sledded gaping denature fuguist toluate iconoclasm divert formicary workload executant suckerfish adjustment pedimental saliferous gibberish wholesale winter vaginitis tularemia medial algin fleeringly vociferous mora shinbone cangue deprave analgesic edgily denom riskiness optometry satori voiceover rubberize pubic basinet guan puppet recluse monarch baldy importer largess humorless biped aluminate abominate turnabout makeup sawyer trapan ameliorate tuition dean autotrophs bluff baldhead calque zeroes source testicular uranalysis whelk neurotomy firework amplifier carcinoma checkrow overstudy anorectic strabismal bohunk pertness rammish promulgate ire subminimum berth antimonic shiner breezily emoji sunspot shorty casern pewee podiatrist litheness mitigation biomedical bioreserve epicentral hip jaundiced spark pot lek lierne moonstruck legalize heritor auxiliary suborbital bleariness underclass grisaille swanherd disgusting unfree furbelow eerily recidivate nonstop testament ridicule thorp snafu likeliness yttria plexor letting alluvium loved beefy endorse foodie linen yukky horseshoe computable apeman epidemic landlord cade idyllist ratlike bikini succuss tremendous fierily cataphyll greenmail cathedral adjt omasum shr remainder preapply torose catoptrics terror lift ineffably drowse reasonably mythmaking waterboard mulish unexpected spambot trigonous areal overprize antilepton spicebush roboticist dirigible miterwort hematin dike comedo impel crinkly slimmest insure nevermore colonel pricey educatory laconicism prosy expiation menhaden stipulator skyjack bromal slothful rice phisher fiscal parve climax zoril plasticize canny withstood enroll tameless insightful physician tantalum theosophic scad converter ballgirl parboil friendly paradise imperil adage surculose dadaism billiard molest bicapsular amputator scamming squeamish neutretto divan absorbing markup resupinate mooch bold lapel caveman adjunction landscape milch peartrees stuntman hardliner bunk aesthetics juster append avens gemologist graveness holt blowy abject cart craniology finical optics tacmahack submittal daresay dehisce jolly farther haustoria accidental furuncle skipper rearmost sene basinal preachment shadowland breathed till hyaloplasm socialite nomology equipment vino allodial nationhood councilmen press scruffy nocturnal dole monoacid oceanic effleurage pilous yeld special qua opt fou trehala vodka aplite truelove corr adenitis scolex addressed decrypt cursory cruse collision windup metanoia crescent sofa perfumery pam postage matchbook retaste cimex instructed portly nativism pulley modiolus patellar deb weekday stere omnivore allegeable spinner liripipe bloodsport hogtying swath necroscopy furthest overproud tipsiness crawler dully raciness handiness pliably transiency quarreler pleiad boll recurring bonce andiron blacken finalist disastrous staghound choughs likeness incitation achondrite plural backbeat alleged desecrator pressmen wardress palliative gaucherie chewer eccentric sitarist symbiosis unpolitic dweeb rectocele offscreen morose brakeman heliotaxis haku jejunal gassing datum pung winepress twentieth cartomancy smokestack basin teston lobelia tart ytterbite stateside turtleneck algophobia dedal tussahs lithiasis pipeline incessance poser polemic crud prevalent asyllabic strep worriment predigest pastorate retronym avocado furculum blow fubsy calcareous corvette overset cricoid headsman begrudging adamsite oasis imbricate whomsoever ghee topnotch piet saurel wept agrestic anhedral liver geum postwomen mountebank delve landside tercet whimsy principium lattice lazuli interred wharf guardsman lumpily clinometer low engager salvation luxury condemn chronicle feedlot cavern dornick slowdown eraser aeromancy worldlier girth sacrament headlamp adminicle chlamydate noctule vibraculum riflemen statecraft lehr gringo trophic fuscous bout trabeated classmate sideman sudatorium sexuality incense uxorious tremulant seafaring wiliness psoriasis chancel stacc derisory black paperless yipping snakeskin priv cytolyses gargle renewed moorage herpetic djellaba clef ternary breakable impeccably valentine aware skein dumpcart smriti psalm mutterer hall obviator fibrinogen clausal botel purlieux kick concerted braveness untidy chintzy theurgy overcrop toff copybook capriole metaplasm thrashing matinee corky exampled bacchant crossbreed bestead enrichment fluffy collop sgraffito illiterate shadiness powwow rumbly idiopathic velamen pointsmen connive brevetting senores stab monotonous glomerulus resistible yell nerveless trotting fishmonger tollhouse overseeing cardamon mature coexist intervenor meterage pyre exasperate duce prodigious sodden haggis ataman bate leghorn statute meddler anyway sanguinary feed clamp sass hosiery coating giggle raggedy crinum melaphyre tyrannize tethered blond inkberry eviction petronel filmmaking puffball cajole phosphene cuber isochronal joannes theurgist duplet acetylene unmown extricate collapse redpoll erectile guzzle journalese joint bookstand mezuzah jaw struggle ayatollahs moon aquatint further harass psychism ruling biog cathodal tephra coffer keyhole capacious genealogy greenery invert soap azalea antheses founded bequeathal calipee syndicator exuberate billfish dynamotor randiness sprocket climber larkspur uppishness lobbyism blandish tass protrude abate dissing politesse astronomer forwarder ingestion spermatid musclemen proteiform slapstick hydrostat horsiest lictor chalcocite makeweight polynomial performed carrier element linens upthrust apache prescreen hectare decemvir thurible regelate prefab servant unflagging rollover disproval squiredom thievery hiphuggers scrimshaw skiffle handball cadent cadetship blindworm oleaginous tiresome gamic viragoes deferred unexplicit opera hectometer futurist bughouse fetishism daemon yip scantiness adverb debonair dropped clamor mistral odds thrash gird dullish auspex wane stomachs dill biographic estaminet charnel bontebok saltatory kloof glass byword flutter anorak vowel quintan baroscope marinade smuggle transaxle booty thalassic surprizal monk dimension frith estimator omega bellyache pushbutton pedophile vicuna amaze ceresin levy blain propaganda magnesite valueless smug skimpily diatheses etherize spatting wartime apheses precinct dozy malformed yapon tana flounce bind parquet cordate quaintness neotype stich withdrawn calamander negotiator transmit chiton jurel lymphoid bowed preemption verve caravel shallot prompt essential alar yow chimerical diphyodont tarpaper vagueness xref catty gilthead frogmarch gibe cathouse accuse fogeyish pugilistic sic publishing epiphany snowfield polo lampion stubble reputed sunrise sliceable pod sideboard woozily firths jeroboam mirthless hhd prosodist ethics bushmaster devolution supergrass enhance lavatorial pathognomy fordable pistole printmaker calycle neuritic astrology crepitate hysterical caporal whetstone innersole fir afterlives stammel dotter forthright pontifex cropper anthozoan maul strontium amphiboly finicky strove stillbirth hydrophyte leaseback debutante beta jefe micro bleat friendship dictionary capricious kidnapping racegoer aroid legist pulque apotheoses singspiel capsful ethnarch nigrosine gangway hangup talentless minuscular sol rev nappe pintsize hyperopic flex voluted roturier environs mouthful skewness limb facsimile monocyte dreary flavorous zapateado sarcoid ergotism expositor mediumism loosely citizenry monandry foretoken pone literary pecuniary frankness crape selectee restfuller packetboat flue mooring presto nystatin blemish hartebeest cretaceous yardage lookup fourpence ascomycete avidin fulminant lenticel ossein catgut factotum reptilian pussy dialysis disguise logistical timepiece kirmess groat yakka punned catalytic nonoily camelopard behavioral genera floatstone battlement heroism rps impairment plumbery womble prowl muff edematous fedayeen anim argol gasoline hardstand garboard meshugah cicatrices attested diatomic sully cagiest scanner fawner overshadow elastin sleazeball typhoid necking shipentine skewback gnathic loyalist bomb packhorse timidity agrarian siding samadhi gemmule forbidden nonurban dobby blimpish recognize castrato goosegog fictional monopoly shoulder brock comparison mandamus cassimere nigga heap roughhouse aborigine settlor awfuller durum aulos seascape accursed yellowtail degrease hols cernuous polis part latency driftage ecotone columbaria tetrapod tennis cardsharp vision advocacy emergence segregator riffraff stogie eardrum mustardy thyratron preceptory wolverine gracioso omicron dogbane inviolate jokily sky clown tarantass annotation handheld camize kiss ascot parochial freeman misdeal kaif envious wingding going infarction moorhen demimonde sheepcote lobby padded escalation enviable buckram handsome periosteum gentlemen perfoliate dungeon initio summery idocrase helluva cottontail alopecia network uplift blacksmith".split(/\s+/).filter(Boolean);
  const WORD_BANK_3 = "typhous exodontist abominably fermenting cruelness freaky steward fixation ilium persuade manic sheltered test stepparent biz bursae paintball average airfoil histology potluck palette pleb perceptive wayside nervous liny unreported pepsin grivet ovoid bewilder cutler ebullient negative hast parse acropetal vasculum pshaw pedophilia hypertonic verminous mercurous repairmen masker heliotrope salade charwomen whaleboat seatmate haft gungy bondsmen washwomen espadrille mosque sahib lope striven tiller ruminate acct nomothetic phreaking acnode deodand myeloid sexual paralegal showiness provolone snowflake desolator figurer persecute prism toadflax norm nictitate foible bluster ovipositor modulus freight shareable atop orle misheard windigo frost embryo sandal nongaseous clinch palmy outclass harebell yardmen micropyle reverend duologue handfast pour anorthic cist greaseball gilding headdress psid glint respond whiten figwort sinful pathol whatnot realm watermen cartulary comely strepitous ague anamorphic forgat stationer rhodamine operator lapidary triable nipa bastardy subculture compass ceremonial penmen tumpline endearment dratted advertiser unary shipment aminoplast spiry rotundness arbitrate prolabor gunfire tambourin far projection cellule morceau glomeruli janitorial dormancy octopus oilily aide fan chi appraiser politick literate coset outwash notional bund rioter chunky tributary select synecology diagnostic mobbed mythomania arytenoid crap donation cockboat prescient syncopator grillage club verditer joist sharp fideism blabber hider ennead godly specified preferred colicky vandalize boarder slobbery peeing ort hemic gyrator caus focal snit clem aberrant xylotomy cesta benevolent plunger word xxxi womenfolks lewisite paving compatible pentstemon humbuggery banausic bedded paleness homeward suspect gley science hamming hardship rota ted overtrain uranyl calvados demitasse concordat entasis jasper bumf credible stole refugee caruncle snowbank folksong shiksa critique quern commuter entrapping schism secede download spottiness startle genderless bridal tho pavement rhapsody ionone conceit maniacal heckler huffily polygon ingratiate yokefellow cadaverine bravado sal junglegym cubbyhole mitigatory cribber directly bipetalous touching unstable drum taxeme heuristics irksome whitebeam groundsmen invitation daughter rattrap cultural isotone least loom hotness phonics briber roadster tornadoes committal hog swishy portcullis supermodel propellor remit irrational revers kabbalist brooklime steamtight hypotenuse blob overgrew nuthouse cladoceran wavelet amnion rheumy requisite bareheaded snapdragon kummel hosanna depiction gurgling archetypic bench acumen titivate empower glyceric galantine pibroch boniness glycosuria embrasure antagonism detect local biogeneses tantalize bipod versicolor apotropaic prancer sloppily ecthyma wampumpeag shatter flexed purblind mentalist manger amerce peafowl camshaft gite wit fend monopolist airstream tractor fist gonadal male muggy endospore isomerize antigenic sternness backwoods effeminize barbette pyralid rustproof expressage castaway lavation taskmaster author endameba sphene farmland bluet attractant automatism bacterium burley coachmen bifocals karyotype hypoderma outhitting downtown butterbur sediment lepton migrainous soupspoon shade mistitle archine refilm altocumuli loathsome fishplate sumpter pterosaur seclude saloon flacon schuss committer arteriolar dockage poetess substratum desperate avoidably hagioscope dachshund gobo sideburns monsignor dustproof spiff cray encephalic hermetic smirky blowhole handgrip finder beefaloes benzofuran madwort jejunum catchpole sacellum suck twentieths bacterial duiker conspiracy samarskite endowment brei stationery propjet angle eupepsia underfur outpour soapbox starer citrine playoff valise sniff lacework shake paganize chevet ordonnance orthogenic update strutting diaper elem bewray droopily paddle papyri enthusiasm lure salivation triskelion aerography carhop enneagon creamy townscape damnify esperance birthday exon kadi vasty antecedent blouson slowcoach outdrew dele uncool vanadous reported discourage kab mapping quad rapeseed vassalage rebaptism woodlot baptism gyniatrics egocentric blastoff hydantoin hornwort bimestrial moper ruefulness medallion stammering equity moralities figment gondolier strait whosever muscarine horseleech seamanlike blackcap excite tamandua lee cheddar hierogram rototiller loner sweetening antonym anew schoolwork sparse playboy parlormaid biweekly rakish surtout itinerant hang hopeful novitiate cardioid sake turned gallant bloodshed unhallow workbench parrot diode cattery chevy quadrupole mesquite helices chesty chorea apodeictic mediate obliging bedlinen benign homunculus lebensraum cytology titch digicam dianetics crackpot nebbich privatize microcode borage pipestone tarsia depend groggily vallation valorous though dabber overnice sheerness bonanza alkalinize terbium dupability studio haughtily hotshot coward lissome warrant sixpence abscissa chignon moderne quatrain gash famous gilt fascinator overcharge nervine blastoderm pentagonal intendant endorsor chalaza prithee transfer indulgence redroot field scantily overcook languorous sadistic vendor rata spunky paction bradytelic tolyl misreckon spoliation breakfast enisle sunlamp sturgeon kerseymere tutored written fishily complain baker themselves kermes lustra toyshop bluenose rustle decadency scant igneous soulful survive cutinize naphthous westerner venturous canonize paperboard milliard avouch erelong antelope ratted overmodest outpouring tilefish populistic gyrus lichen rushy globin caryopses mutualism moneybox fetish skyhook invitee typewrite picnicking silencer demonical whence boater eohippus pliancy dockworker suckle nubbly retake jequirity knew jampan excited goglet roofgarden cyanogen angiosperm archit emancipate ordnance caseharden gasket longship riverfront lash refl secretion offertory moke deliverer strigil vacuole mush scathed nucleation earthbound bowshot controller lipolysis chaconne glede ingate reproval cool maternity trug rime confuse shush pencil backup wanna signings doldrums aphides farceuse bogie teth meany upturn tuyere tenterhook nonacid psalmist venational scientific chaffer remediable descendant kiddie deration histolysis sphenic sparerib changeless alcoholize temper mainmast teat redigest simonize chronicler prehension stifling dubbing meteoroid antinomian distrait wrestling tantalite cameramen workpiece protamine impatience seacoast castrate menfolks overthrow plotter soccer dadaist remissibly cherish calpac gabardine bourgeon dumpily treacly island conjurer strafe secularity isocline chaotic gemology enteritis didoes nosecone androgyny paleontol spacemen laden comose inulin discreeter cark homage pharynges awe expatriate gelling neckpiece shortfall commissar rein branded ivory asperse teethe incipit coxswain tervalent comparator naked kreplach confer brand stupefy twin playable viewy pinspotter antsy longueur shyest tramline foreground onlooker septet divergence chromatism doggo diamagnet polled oak atrial popping achromatin emulsify blackball typhoon ceratodus champagne youngish paraglider escargot penninite fumbling agronomist immediate solemnify docile meshwork biker prelusive coir pancake trenchancy composite serialism archeol rivaled sever sunburn blowout incondite knotty rhet defector stonewort sand snotty fellow risen sati hyphen rosewater callous repression poised encomiast lungwort approximal whipper chorizo carpophore gadding sushi publicize metameric whizzing skirl recorded mofette wholeness typ battler zapper undecagon caliph spadeful skirret washhouse steely hobgoblin tetragon tumorous respect hartshorn trembling sellotape amoral gardant placation furnish stomp nimbi teleplay csch karyotin beside amphibolic hermitic heliograph lifework grumbly dhoti praenomen endogenous lemma mikvos gorgoneion workforce palpably diaspora undersign jointless ablaut chartulary beaverette pottery elute mango marquess carp choli climbed emissary thrill patchiness sypher buffoonery squibber fogginess miry passivize topcoat tigerish argentum pheromonal furtive manzanita vomitory lux kaboom mesothelia jaundice seep watchable decennary animate jingoes serpigo carte crustal febrifuge yesterday runny raki com fibrin overground lech fossa guiltily aldrin cheapskate archerfish spice strut forfeit declassee chitarrone chipped aquatics mimesis lazulite prototypic sysadmin evzone oviparous catarrhine torsk itchiness whiting retrogress soporific intern microbus brioche titania bidder filariasis steamship kaoliang penumbrae boob towline textualism boride divorcee marigold impeller unwon eisteddfod bunyip agonistic frailty scrapping onanistic grapevine seem brownfield odor periostea gridded sago counterman taxonomy gazump circulator legmen phosphatic hanaper entrechat directory rasher heartsome genipap leucine obtrusive disseize infractor parka fishcake rhodonite waterbird biostatics almuce outstare guildsman gnomon compost fortissimo skintight absolute pompous wacke monodist myeloma norite niffy desmid impoundage pardonably darkness tace extortion anosmia vizierate perithecia snowslide fuse cowl argentite dividend empennage duffel rheometer wrathful insert inboard decisive halfpence exothermal dempster portamenti frequency hankie glitzy rundown alkalinity stringendo compatibly penal official trafficked serve giggler lordliness amniotic abstract truckage anxious workday humbugged sgraffiti osteitides eyedropper fulminous phylactery mavis floatplane mimetic angularity sonata garniture corrosible foliar dor dizziness barleycorn shortcut frowning parch tarriance google pendular embrace awakened union aspen cunctation embraceor dignity candidness inkling seafarer hawkshaw foreignism gie angriness correspond bodied plenty shifty anticked phon milliliter kana vesicae epitaphs excreta violin skimpy klepht subseries dresser monadism headset mixologist atrocity congruence dona bijection cockle wear seal brouhaha phrasing chamfron pood outboast south birthstone pastry sunscreen trite perforate ohmage ywis ergot squeaky snarling peptic initiate skywriting solarism epirogeny billy distressed rutilant slummy kef endocrine rosin urchin belong plebiscite naive gasholder paramagnet cottar meditative taintless slurp valley agalloch zenithal acervate worrisome hawsepipe warfare harborage nodal battledore cooperate selfsame scrape suboceanic suntanning oscitant mediumship pilothouse microchip fribble passer zing townhouse music kanji tarring eschew coss homegrown samite trombonist reactance harelip anat liberalism retene mozzarella skipped oneiric terpineol pajamas timorous frowst evenness creed itineracy cicely pathogenic rasbora flatland hellcat bunchy alight corymb acaleph schlieren machinist snare bootee bombproof telephoto adduct gummoses capital lagniappe homeyness metalline daylights vowelize unlink nurselings avadavat gabfest treater strabismic troche stink username process waggery tucker lapser gazillion diuretic brake repentance futility secure maniple scholar mica quart forme hypergolic matier jittery spiceberry rough firsthand goldfield aquifer phonogram cliquish metatarsus papistry filch ringleader dell cuisine forfeiture tendon destitute emitter sparrow reparation rapport pyoid artichoke spare iconoduly dragonet terrain typal transform variole abetted apparently thyme cotidal landgrave finality escarpment hillside plugged qadi weighs inotropic ingredient varistor vociferate motlier reecho curl calaboose garner squashy candidate malice makeover labarum shortcrust auxesis naut catmint chassis additional shpt armilla clientage censored sunbelt octave patrolmen profligate card fakir younker hyoscyamus shortage ovotestis cuss isolation spawn illume mammon jackanapes rickrack atmolysis unglue salve antler pulse cnidarian maculate blindfish arrange whisperer ancillary epicure calicoes pluralize manifest halyard ellipsis proteanism cognitive headhunt vocabulary orang memorably logicality digitoxin apology fumitory buoyant steno afreet sundeck sufferer cove myotome accentuate oversew immortal hindered pace superable piratic surjection semination assumptive acetylide dormer nepotist peaky idealism major lawmaking nim overline mon seaweed gelatinate wildfowl discovered roguish crammer trucking millihenry coprolite dyslectic manana rhapsodic dishtowel multiplex nebulae mullah casa terawatt teashop slickness rare skyline nap tubby chrism gromwell madame relevant yawn fullness decussate bivouacked mignonette collecting crampon airdrome marketer sylphlike augury lobo suspensory gro craftsman overmanned annuitant innuendo scutum maceration ulnae desirous anemometry taw gladiola alpenhorn bogeyman weekend vixenish outfitting sublet larynges scourge rapporteur pineapple pah felon justiciary geog enterotomy scammed topology citreous bizarre campstool energetic capitate doll obtect kirkman lacrymal turtleback sleaziness hugeness greasiness assail galliot allusion factious exfoliate kobo bedwarmer vigil eta faceless impelling shoestring railroad exterior pigheaded cockalorum dumbwaiter entrancing motorboat pressurize estate cinch stirred missioner sleave bus lynching winemaker pietism becket challah waiter wireworm geophysics osmosis noisiness hurds dopey astrionics derailleur appendant bodyboard paralyzing antitoxin annul glee emboli strengthen cyclometer forestage holism pantaloons ebracteate cranberry dangerous accuser cyton holdout copulative roughrider gantlet meronymy polychaete gourmand saccular washery ufologist puffin trunnion cumbersome tamari epitome abuttal baggage niggle gavotte tinkle sweatsuit dibs drudgery crumby cockroach gaselier carpal procedural outflank cormorant slew mucro gnosis untread branchlike clamworm sucrose kail hairspray starflower ethical dextrad recur besom zig commute melodeon magnate juke flitter eastward stripling tote flotation pasty revoked dunk sunbather allegorize elongate compline due uptake benthos damped impotent cuddly pronto decaf stroll sound bubaline refinement nystagmic ponder tenuous fatherless heaume tercel commix alumnus arsenide cytotoxic dolman eliminator warmth uglify analogous protrusive lancer ideational propositus corpuscle crinoid cornel trachea compact debit hyperon syllabic chrysalis gayness yowl vanadate mezereon explosion crenulate admirer enlistment sipping liard insistency prewar ouguiya proficient pack writ promising umpteen decor alpenstock cynic picrotoxin bankcard cislunar qoph monad peroxidize scratchpad weir chubbiness plateau thermic pesky middle queasily shelve dist anti lugeing millstone redbird depilatory freeboard battle attrition musicology martingale crista rafting sloshy lawrencium afterbirth jarosite plotting reject ectoplasm obedience candlefish zeppelin mantra silhouette ingot unilocular peerage telemetric cutlery schistose colocynth capitation banquet oceanaria choleric podesta princess ppd windsurf chlorine leadsman carman odious empanada mir eudemon highroad paribus evaluator malison anabolism thitherto quatrefoil stunning colorfield rebuild authorized farriery aphelion stutterer clapping hornlike seethe stamina carious creamer asylum celibacy podded waterhole patristic slyness stereogram teeing blare sad homographs denture blintz sordid parget nostril authorship payware hickory campfire hora adware atmometer biometry tergum filigree degassing harvestmen allethrin droop granny crevice lame gaffe pointed tellurite allocution wreath flub eightieth prehistory tag cede planarian slipover federated kagu overbuild rosebud faubourg icon colpitis ampelopsis catenate heredity saccharide whitebait reprisal verboten grubby congress redaction souvenir mycology clammy fellation map cudbear sodamide contemnor purdah felicitous obtrude urology career showy enfold earpiece precursor dewan marshal furred wearying pardoner piniest chatty condolence kazachok cartelism priapic apocopate bascinet venenose subclass nethermost ovulate dislimn excisemen steering stone glow ephemera selectable adjoint tofu boletus earthshine pogy ailment striker footy landmen abjectness tetrameter additory chalky stripper dimity eminent wienie bailout extraneous healer quittor airwoman mullahs sent reserve headwork ambassador racemic geomorphic asset ending deformity answerably quadric acyclic lose sika atheism rejoicing bombsight invest conative aboard obturate undersold meatman bestrewn clarinet semifinal drumbeat mollify brassard truckle retrousse nonego crestless baronet driftwood cooler phallism cottonseed alterable telegony ontologist localism albinism gneiss journo loudish temerity footslog flense amylene submissive handlebar transvalue aligned signaler casefy corposant rigor sphincter amylolyses choirboy backbiter friary anapestic sensation attaint ram czarina carjack snarl octodecimo ecstatic cribbing ileus backset phyllotaxy tailbone smilax hypoxia palais balloon cully henchmen bushcraft stob bray afford leftist bedcover key epigram mentalism transitory semicircle sledge disparage letup catenoid bathroom hooknose corban drosophila expiration core cristate aborning knobby switchback abreact funner canula reversal filtration fortalice azure tapetum diminuendi prostitute smurf lore alky succotash anthrax numerology bounty thesauri cladistic behest copyeditor dasyure hurler paramnesia dodo akimbo mosquito pule stranger flume contingent manciple tinniness galah lust booze judge domineer cantus examined intent casket karmically brierroot postlaunch revolting hebdomad hogback dabster tramper type tuppence shudder selenium tarball synonymize aspartame gaslight castellany jakes brassiness silage teliospore submitter brilliance colleague cymophane catting markswoman helper sludge bee bushman curtilage explicable bill praefect sickly rigid moved hellfire pastrami colony ascarid oozy rigorist vivisect civilize gavage trochaic seedpod litterer totaquine burbot hoop vapidity quarter jangler revision swatter pilferage requiter lioness cottage nonallied barbarian holystone nagana triunity blink harrier kickboxing acuteness deific foment pettifog honewort secundine easel rose turbidity quash pennant filmy quotidian vesuvian legumin peccary romper chitosan stapedes ipomea immoralist roof fraudulent extoller mockery tumblebug lox camphor stenotype nuttiness jowly dubbin zaratite snowplow dazed cymbalist villiform warbler queenly combo ketone daylight scrutiny topper ammoniac pinprick vaquero forestry rotifer damming succinic indium raccoon frontbench bullbat inherency surf ibuprofen dogma myocardial aria fishery enormity oviduct gadoid daily asepsis rumbling alms improviser excelling nostrum ironbark wieldy bonobo semipro hearer autoerotic dot blusher cancelate melodic uredium exhalation cartage discerning appease spermine intestinal bismuthic irriguous cooking libratory liquefy stupidity idolatrous pier gelsemium junction ermine intercross crumb syntonic lozengy span aviculture hydric siderolite inapposite juncture broil imprimatur decanal drool tun pomace irradiate diazine improved district kraft verst daffodil lorry dada diplomat shiny uhf areolate almsgiver sweetbrier sulfa expose equipage licente cyma retrofit coreopsis pekingese meditator secretive tick casque dopiest tinnitus adaptation peba orthotic plait ruffle liniment clayey congeal sawfish rigging brachyuran convertite knur acorn task snark histidine minority escallop foregone indoxyl stonily miscreance case nucellus ongoing gestalt portion coextend idyllic obeah amatol hullabaloo selenology loiterer mutism pentosan act cadency flatworm titfer pasticcio morn flysheet timpani rabbin zymogenic hodden direction uneven dryish anlage hydrometry tarragon armorer amperage pareu lieu combe maccaboy velure weaned chummed drawknives bugaboo cellular glacial foray oversaw yardarm resound gynandrous foo kyanize pyrethrum soggy floorshow flinders whys setae cigar millinery rheotaxis qualify blush minimus superfix radish hoarder dispensary topspin liquescent pedicurist corer sonant hacksaw someplace aleatory premature dipterous shimmering bine charger reluct humility airstrip flagman upbear identic foursome twittery haplite urbanist mistily arenaceous popup soberness maunder jabiru trainer rpt reiterate brainsick sharer spasticity telpherage beautifier macadamize carnality tandem unacademic stipel cyclops terrifying percent eurypterid rectal sobbed passerine gnocchi gaming ticking crowdfund phylogeny cascade whiteboard rupee hurdling raceway anonymous torus together squealer haggard eighteenth inasmuch backroom gigaflops lambda loudmouths quai cherimoya almswoman songbird scent beeline surface douceur desiderata ecclesial exhaustive zaibatsu homologate allophone cumulative theremin chilopod unicycle abide nodi barrator hoof moaner pothouse testes peephole jibbed insulation voucher bushbuck asseverate rattlebox ramie foresight suavity dukedom shirting shakable patentee neological gribble monogamist valiancy uneasy becalm digression bastardize suave ceteris dateline allee macrame shared inert mustee inly calorific grokking loyalism gradin shuttle ravel saltcellar omnipotent footballer puddling freedman homeless polluted serpentine viperous valiance formidable patisserie eff fistulous ideate luxe liquate fortis adjudgment potage diabolic pyroses macerator vel efferent separator adamancy alpha jaybird slogging ceruminous francolin finished altruist cion guck dwell hop posada lilo canal renegade profitable umpire recitalist prophetess heterism garlicky vulgate stubborn stress etiologist approved overawe coordinate epileptic photopia newt cochleate sunblock paleo factorial vatting ripoff erysipelas illiteracy stringhalt anaglyphs tope kamala oilman north crosswalk tortoni hole scoliotic orgasm bestseller causeway barde cock landowner moderato redcap casuistic manipular dollhouse agamete liege forejudge close nonkosher billionth megagram claw myasthenia scotchs townsfolk contender sprinkling borrowing canticle hyperdulia flavor frogging pulmotor highpoint dilation furlough biologist watchstrap newsweekly hysteria hadron fiendish penetrable madwomen openness caryatid cask cromorne alarmism melted deaconship legitimate expedience alongside veterinary patroness marabout megaparsec transsonic shaken hyperemia goriness misbelief banket extenuate schoolmen pounder sternway repel spondee greynesses wraps pledge sitar icebreaker garcon factorage balladeer antipasto nominator kittle biologic insatiety pilgarlic came sundress pruner boneless awkward limulus antidromic tortilla mdse bursarial envenom wallah nonstarter megastar night anglophile thumbtack denticle phosgenite forgoer glummer tolerance wallop peg lamia tutelage workmen aviary apathy demivolt ordination pendulum grounding killifish pish holloed chuff latent utilized cageling azoic alternant underusing solicit seediness forging softbound bigot denouement overrate polka warmness iniquity sereneness tack gamut alumna macedoine quarry toothless gracile misfeasor cowbind altiplano brigand beery viced mesdames tachometry praxis dog ascidium tugging astride weevil iterable clomp swellfish perdu censure arrogation extant paranormal hodometer rhachis civ boor capsulate glutei tetanal madrasah cornelian britches loo rove hypallage intonation corpulency rishi anopheles wide vitae carrageen silkily staph entrammel fretted seq lustiness seductive witter lxii docility typeface dogteeth tyro ghat polypary blackness ruggedize patchouli shadowbox corpsmen offer kinfolk humanness transposal tangle oboli flameout immersible detoxify shakeup alliance coeval ichnology frenzy martian legalism hagbut maypole drysalter cuisse humanoid balbriggan trepang psalter impuissant oarsmen broodily shrank bloodiness perv mammilla precision boost heavyset sporadic eulogium chaudfroid tyke ironic petabyte ureter diciest impute wheatworm have imagery sputter martensite nutrition epineurium venge sold nohow swarm ionizable emolument drama evict chaste forsterite cossetted eustasy ornamental alack director malinger match drabness voiceless shift urus mutably exciting addend luce war bowleg stimuli corny medullar coaction fade effaceable elkhound speechify rockiness profiteer ember versioning var settlement heatstroke overbook invalidism refreshed subscript grassland prince westernism skua ppm chaffy prurigo nephograph hedonistic hence outbrave vain repressed frostbite aniconic dybbukim autarchic corf moistener luxuriance kindless internal misty cringe ramrodding nestle golly splatting larum drolly assignee appealable laundryman architect warpaths sharpish figurate mathematic woodworker hippocampi panda tentacular nonage derivative benzoin smear circumflex pitchfork saskatoon expurgator favorably tussle shogun bowl unfelt halberd lungful whitelist bidarka timely doping sniggle bagatelle tripodal dixieland newsworthy lampblack sopor cavalier ape tinkly rumple noviciate prevalence deadfall limber liar palate footstep majolica reveler stepladder charged laser matchlock balata harmonium fizz alpinist indiscrete sticktight touzle clingfish activation smallsword lease sleekness floridity reliant loan premiere surlily horse criticize oregano insulator mold foretooth jointure galloon gouty vicereine recreate lethe anise vivarium lankiness highway blackberry dekko chiao logorrhea denarius overhaul flamboyant pallidness capt foreshank hardwood fajitas lanugo ratio tabloid canaster diffidence vaginae huskily shearwater solutes hyetology strophic these madrigal ulterior criminal boxfish unlade yellowbird vandal liverymen broadloom covert ken abjure posh drive mink skimmer bibliopole cicerone inharmonic reclothe assigner chasm ewe freeway euonymus washstand cracknel convenance dree crusty crustiness mayfly craggy unite murrain equivocal photogenic trachoma meliorist spaniel town dacoit snitch firebrick strummed melinite adrenergic styli freckly protege defalcate county beckon amber belletrism flopper jacksmelt mission riverine clerestory manakin trucker takeout urnfield imperfect belled unipolar catwalk gumminess custody should glia appeaser suitable cortisone triage riverside exchange pyrene ironsides sept detent foreboding crowboot drubber manuscript sarcenet phony ribbonwood tweak petroleum perse benzocaine fairing alt coldness chief turgite diazole acidimetry driveline foxiness univalence satyagraha fossick chyack never cartilage muticous intrastate krypton energizer texting jackhammer crenate example beslobber headcount catchment hairstreak reminisce athlete tinamou collude boxful willies deliquesce fascicule estop handedness feasible pestle luminesce wheatmeal notify harlotry groper cybernaut apocalypse libelous centennial guardant epexegesis apprise lath pupae caprine whirlabout lax glim reliquary aby amazing widower baguette sorrily abhenry ganef fascia snuggest bract defaulter canaille cinder gutless zeugmatic altar tablature mellowness chalkstone conducive entailment acrodont effable hyetal ascogonium semisoft innocence hyperbole unworkably rapparee interplead timidness jagged cloddy peppy gagmen bath sterilize cense genial kithara benignancy sylph hellbender opening stoker topaz diffuse kantar gild berylline parvenu sonically imprudence theol regulable steapsin ampicillin assignat favonian cicero tagline flaw wrote lifeblood salmon uniqueness kitsch perineal memory handbrake newsgirl formulated zounds signify bwana oblivious anticking ashram paries froufrou head loveliness sweatshirt loquacity countrymen whereabout liliaceous holp cortex plastic gully svelte brainless foreseeing haulage bridle doorstone paragraph atomy papain gremial heroics abduct foam declarer mom complexion scarcity footpad himation fem colloq foredoom hendiadys marauder complice repairer sapphic monopole skid essay peskiness scale skean predator classified kiosk emitting touchback devotee exposition wan novelistic umbilical diaphony trochee merger turducken tain letterbox headward pithiness loq heavenward euphemist faille irrelevant antifreeze smasher conduction nursing flagrant chemotaxis sociopaths riot nabbed sickie prelim yapping unionism tahr halt potability slaggy shunning bracelet pangenesis submit irritant rollick dded vibrissae sans pratfall butte tori officinal committed kraal unwitting ancestral tatted mesnalty fell cabman calciferol grovel momentous bonne mensal impassible jerkily vent riposte floccus eringoes dewily adagio potbelly potatoes insphere gleet saucer varia masc tornado dopily lightener awl pip inchmeal stor subrogate rehydrate papillose garbanzo ashtray boffo fragmental procumbent laughably dauphin bullnose supersize preadamite meandrous parapodium babel pontoon boozy firestorm servility coalfish fingernail colubrid gilbert airbrush autocross dissert anthropol waxy stoical redisplay humoral froth flatboat sternson lily cyberpunk lean rebellious gene oleate swank disgusted bagnio preprogram besmirch lassie duskiness gravestone traumatism admission ritual shorebird dilution clinical thymus leak systolic buckjump signed bated waterspout sponson sadder ketchup fuming buskin heelpiece jackfruit virgin discommon ecotourist bannock green cir charming aviation pacy solvable kith protoxylem simulcast mishap biome sciolistic tellurate rapped trabecule galea papillote limen quantified narceine bipartisan taxpayer spahi software sextant stucco stretcher bowfin accessor postulate mulatto tremolo druidical sustain shellfire gazelle conspire skinless warrior alchemy bulletin unripe latish kingbird drastic devotion sealer calamus neoplasty knapped sevenpence elucidate ducal stargazer chon womanlike house prenotion absurd flakiness ordain underwent policlinic ammo feebleness amphimixis viscous epidermic pethidine frowzy qualmish myosotis upswell roughish sloven jacal them disorder giant ripstop vegetarian snowbird surprise imposing sleigh mart glossator jaguarundi cantrip lexeme gnathonic spire scalp overlearn doggerel alum coalmine brimstone decapod chunk evenfall monachism hyoid joyous aoudad flt canzonet malady lemony embryol beast lessee seigneur sayonara nitrogen alerion cap resonance resect piccaninny shimmer rescuer illusorily drummer chauvinism anabatic hobbyist nonevent guttural emerald olfaction mesh duckbill inoculate item iodism strutter rondelle beatific parsnip unbend faitor comedown apothegm lucid expiate mucky payoff annunciate congruency directed ephebe hemostatic symbolize bandeaux antisemite judicatory donnybrook celery alembic refutative suppleness larynx overnight grosgrain tumidity ideologue reservist cynosure zoster ghostwrote frame housebroke pandanus kylix lace compony agronomics sixshooter blabbed participle gey popery tradesman represent ley exonerate rutty antennae every initiated offspring noisily paregmenon friseur rondel decimator superliner heir tesselate zooid zoochore teacupful scrammed regrind stoner bleached beefeater multiple equanimous dharana kava arthralgia firewater aspire background nutbrown fagaceous hatchery planar orographic pictograph timework sink purpure knelt sulphuryl clearstory molluscoid madding homebred casemaker invt warred navy outlaid emerge evacuation pedicle sisterhood neomycin bestialize salable nowt chapped unpeg presumably pretonic president quester alunite misuse hoodlum gourami catabasis cytologist smokey asthma planking euhemerize phew roup fard comminate embezzle dramaturgy glitter convent parenteral sculler barite sippet commando entangle twiddle persuasion astound tarnish bionics toiletry adsorbate madmen minuscule bayonet whiffle diabetes warmonger cascarilla ward jackboot mahout nuggar glossa cahoot supportive humane overglaze firmament option regretting dazzler cytaster nowise impletion halite phlegm inarch sepaloid unfeminine dichroite gummy peruse byssus weld daze birr bullace polemicize calculate basketful dagoes minivan focaccia capitulary blandness clumsily ultrared heartsease rehandle naturalize mesothorax wolf sideband tyrannic russet nimbus valval fluorinate rotation howsoever baldachino procurance conformist heteronym cussed muley arrestment quinze gormless fitness carditis wynd benzoic osculate galatea sou mouse clove eceses groom ataghan vibrator spue laundress resistless lagomorph exciton enchanting slopped outshout verist unlike soundless humpback harassment milord horehound fearing fandango rebato showgirl catcher ecotype sun postulant perjure polyptych zincate seqq serous signatory bootlegger meander evade foison rapine heft falsie coagulator hindmost frothy promoter catlike fullstops maxwell glochidium downfall matelot evolve echovirus erepsin supercargo lapwing indaba pyroxene sphygmic fieldstone spewer chimeric embryonal fishiness hiccoughs hayride gremlin seedily whorehouse chordal pekineses truss primarily overdoes prairie voila humbler rhythmical doxy obvolute export sheepdog sandarac minter duck fino fletch cabbing iambi epistasis bowknot foreigner humanistic alkalosis deluge tend natural stultify herniotomy audibly applet bearlike occipital polisher pardon gallopade dehiscence weaved deg tautness milkman optimality impoverish bigness whenever scatologic lieutenant truck peroxidase unicorn boisterous bridesmaid abri internship lagena subjoin straddler fringy cerium penetrate agorae cyclist oxidation lusterware bloodhound oxbow fix cadenza pianism miscue outrageous undertrump cheetahs hosta copper tiff beggarweed ammonia cream tarpon miasma motorbike minium antimonous scrog doughboy actinoid calmative parsley ultrahigh grief penetrance cockateel heterodox shouter kif phytology handsel brit jaggy unhair fountain swapping peal zee wonderland latex lorgnon roofing sporocyst cowbell dabble bemusement lapping shelly garganey lanthanum slur abaft altitude wrap beget erosional denitrate taximeter chalybeate zygoses erenow adventurer viewing arability goofball thyroxine fenny morrow headbanger veganism gormandize nymph sisal prenatal aerostatic epidote muse ihram cuttle loam eaten symphonic aesthete riflery sorgo annoy photom bogged eyeglass mandolin babysitter afterdeck captivate sequelae acetify wound navigable colleen advisor mandrill whitesmith testate thewless controlled juiciness chintzily xylotomous sunhat pungency makuta oilmen rescript macarena natality prytaneum ischia beep bootlegged epifocal voyeur restraint metatarsal snakeroot sconce recreancy amputate impi thalamic testifier synecious honer unconcern stupe bollworm nonzero permanency beige playback masseter signpost stampede logjam caltrop diphase clipped checky damask galloglass gunk veracity spitz shaker profitably overeager spelunking fastigium rug antiheroes muscadine catspaw widener poo fatalistic effacement lipophilic beggar pesthouse grison belying glare singlet hae smashup rancheria fiancee sweeper vestige bristle xiii haik ruthenium wheal mackintosh premium goggle eyehole clung chloroform judicative cellulosic barf connubial feedstuff diglot riparian conifer baldness pentyl populated repurchase staginess jellybean adumbral decimalize bopper alfresco aery sidesaddle stringed fantast workmate functional enactment quinol palmetto lactate sinister naphthol culotte shag goldfish crossly nix subaquatic basilican waxbill tnpk averred coercible tripartite kaolinite finesse fadge ribald diabolical churl overfed iambic dreamed alto salary biography downwash bake algicide sudarium glaucous epicritic musette ionize suckling metroplex magnetize elves competent imprecise bungee pope archiplasm galliard hauteur octuplet skitter monodical amen chautauqua epiphyte lentigo iniquitous outface silva aftershave rudiment predikant stripey desmoid astrogate quitclaim fusion quibble embalmment dinner quale weskit ingleside anticrime coincide webbing nearby kaiserism tony formed bisectrix discommend defiled taligrade slobbed moviedom catatonic wooliness earn gullible trifid sweptback raconteuse invoke panoramic prey earthworm dwelling carbonic metaphysic resistor allocator frisky sultan bobbing icemen sprout setose ibidem heartless abscission tog ramrodded fezzes tahsildar organza capillary seismology anabolic hammerlock suffusion merge leafstalk vaginal their penult splash instead terabit annular otitis bipack photomural quantic steeliness fictile grosz bronco continue cutlass credibly groundless lbw ourself jiggly catalyze loxodromic multiply matzot primitive sanity shank refract peri tephrite unseen etamine lasting smooch unworkable corpulent abort flawy guarded wriggle flyby caustic copyhold skip swinger clubfoot halon relative eulogia imparadise violaceous grad trowel goner lipotropic fylfot fronton kamaaina gossiper serviceman noway surety harmonicon numberless shiver negligent frug refectory purple cozen marriage metrify crossarm adsorption sensible meaningful fulgurous tallyho then scummy megadeaths voice laud daytime fuckhead stirps spherics vesica unwisdom avert depletion weakener farsighted blowpipe dandle cay anytime meatiness lubber reversion stickily jouster regear totemistic fremd revelatory subjugator pianistic autopilot neurologic chary overdone proprietor nameless sweatpants penitence gyrostat talkie digitalize trapeze scurrilous inpour cholent fleshiness yum mental dopester horseshit crotchety favorable orlop ponytail rawness clincher confined folklore nonpareil candyfloss cannonball innovator vice snarf modularity agrology supercity kimchi plage proven muddily homeopathy exanimate elaterite forcible ubiety toccata freeholder synchrony vespertine offshoot smarmily regroup funiculus ostomy encrust fore bentwood pipsissewa biometric xeroderma garibaldi nylon temporizer bismuthous pregnancy woodworm homogony justiciar embassy chaser rhythmless frenulum potful nummulite deanery japanned navigator zedoary gatherer admeasure insouciant frambesia enquirer accipiter tarn diagram trimmer lifesaving donuts apetalous alible cityscape sly craft jazzily educe medieval siriases grocer surgical virtuous linefeed counter touchline declension presbyopic bobbinet spinescent cockade billowy endogamic pulpiteer enologist tuberous stereotypy radices navelwort misogynous tonsil generative translunar draftsmen fume provisory galleass dongle aniline mutilation dialytic skirr phial calces unfit gymslip confiscate devil voyage hyson vulgarize uncomely marquise herpes ceca beanbag styrene patchwork mended vibrancy quo ageneses solicitor teaspoon chagrin tripping legless evasion noblesse declinate symphysis alkyne birdsong symptom disciple croup scatting erosion corbel centare stout wisp tricycle exuviae nutrient emptiness incept swimmer keystone swaths revue solecism adjutant theocrasy serape undermost fireproof phrenic marathoner brushwork victual oaths untune chiffon prognostic briny clothe seise hangover hexangular gumbotil futile pyrosis authority overmatter dishevel influenza resnatron climbing mizzenmast objet legibility cabrilla secy slype postmaster vandalism fixable yen loll pimp sacerdotal bogeymen ganja deal grievance slush swagsman group wolfish takeaway sword loment piercing unitary eelworm spicily landfill partible roomette noria hobble circulated ikebana exfoliant washy mongrelize flaggy wordage rumal lumbering planner mimosa suborder fraud poriferous norland fila burr antiquity sanitation tor dame endurant tear quote biological slipknot yearling bipolar grapnel summertree saccharate punt modeling farmstead imagist finny whither curch spineless admiral modified derby spotless movable lumbermen pix bearer gunflint eggcup shuffle patriarchs sacculus sheet libertine duckpond linkman bookish slavish nihilistic finicking bloodworm subtract faquir malar recursion republic sonic patio omnirange venire globalist resupine primula benzidine palindrome restharrow cardamom historical cornrow puniness sparkling ace manila voluptuous showboat softy trousseau overeat undue restful outstrip julienne reasoner abduction supinator doubtless roaring aberrancy undercast grayling secured ceilidhs disannul pylori become tiramisu blusterer aeroscope underwing orifice hurrahs bridgework trepanned goldmine karate smuggling dupe budding watchman cantatrice druidic tunic lanky chilblain dulcimer humidify harelipped dosimeter putridness mineable ranking validate whetting kerf biggish atavism basket pietistic bridgeable dink betoken panacean cushion millrun delimitate consomme maximin shilling dimidiate zymolyses menagerie detrude intimation superpower knowing jog yuletide serin conceal lousiness cultured commandant unsafe vanishing mitral underquote emend kinkajou smutty catbird turtledove daw thrombosis chamade brutalize hawfinch wholemeal labile elevon brewis otter orig actinology chlorosis swelling cankerous kissoff versicle silicate pile sailfish musician exorcism traject slander breadths flicker arsis retinue ruination skat dendrology pertussal baritone impolite aquamarine minuet rainy shrievalty udo unwise obelisk evictee dropsonde passe momentum collegia lexicology squarish diabolo shako accessory decimeter layout waylayer afflict abut illocution mannerless cam solid benzene swordplay lisle restuff rumble dowitcher vocal strike cohabitant void tinned taxidermy assumably indusium kettle dissect bedsit bribery heehaw machinate bornite missed rockery daltonism style coxcombry ectoenzyme quintal commotion pudding sizer finalize odorless kurrajong slapper schnauzer terminal impartible web mutual cub guard student blueness piquancy refined hassock childproof misfortune plat viz beak splanchnic chiliast doubtful cornucopia rehang weensy muslin log overarm poorness caffeine velarize homonymy colatitude volume knout premaxilla merrymaker inoculable nankin pyxidium headliner ostiole gnarl pappose dalesman essayist avian precocious sabbatical pursuant microphyte fritter doughs calm lanceolate hussar fame cropped evangelism patting evaginate vertex continua hoodwink apophysis unshakably yautia quadruply cyprinid monazite pontes primine hyp pithily rococo taxer keyboarder harvestman amberjack prajna lubricator inhabited minima jodhpurs replevin laryngitic quaternion knavery headache moonwalk waterwheel leper urethritis hierodule cacophony jape necrotomy timpanist satanism matrass feculae misadvises officiator spoonbill appressed quietude figural gyrate excretory hellish homer lxix hammed mutability thralldom variorum sumac brothel miffy sestina abscise dibasic moralism clash epenthesis donator push goliard hoke bookrack concluded traverse arcuate junkman emplane campaigner branch manzanilla wadmal fiddly remarque marine fungible inspissate tinctorial epeirogeny placable baptizer newsboy misgiving gunfight ribbon substance sgd coste necktie chat wearisome dripping emigrate ecospecies boggle tectrix transude huzzah goaltender moidore pabulum paraphrase blvd avionic paragon anaptyxis insular loco bugloss privily overexert grueling charmless ravine clarity pillbox tocopherol pyrazole grandniece engrave dong gesundheit colorable weanling sprightly shampoo clay infante fusillade ironing nursemaid bramble grazer exhibit whiteness fob company wiggle cube debt plafond flocking godlike scripture sequel incomplete trichoid intercom doglegged leonine blockchain citric refusal equites monoplegia ptoses posy huppah sumo snort tardigrade cleromancy gelatinous gravure pyxie duplex tourniquet innovatory hexahedron woodchuck acedia dragnet retriever pipe cumulus metamer resat speedily smallpox foxy tweet broodmare birthroot asininity bobsleigh misdone enjoyably anthracene bathtub megabuck dress ileitis pacer genotype gaily evangel rimy headmost metacarpus abase bargain contagion tailor candle revenge belie deary whitewash wig bookbinder ancestress bye fingerless becharm announcer relativism cutoff elliptical heliometer surrealist bathe clotted radiant scoundrel milkmen pathless retrospect vegetative thromboses ogdoad washboard cavil rusticity curvetting bondman xerox preinsert reticent sestet agouti genus jollify abutment dropsy cubage wen currycomb gluon psychotic sulfur order gutbucket asyndeton scorner pericarp fatsoes nicety weedkiller colloid grandaunt kob harrumph rightist sociable apyretic landwaiter occidental molested frap pretend haymow frogman ruffian dictation gallinule deffest defended titmouse baseball opalesce acrylamide tolly ibid transmute simile infer selectman pointless grantee transient dabbed minelayer lambency appearance osteology loader phagocytic sacrum euphemism epitaxy oik production user amino thew vestrymen mirror sunbonnet creative carbonades calculi augment perplexed boogieman burglar shoeblack accentor hithermost share willow gurney underslung lawnmower heartbeat antedate prude sine hydrogen esparto firewarden twenty poignant dumbfound barranca nutmeat vestiary lixiviate eugenol galore seagoing variscite hayfield acquainted placings execution prayer ciceroni stern milker caloyer tarlatan jackknives machete pulpy cognomen dyslalia vilayet queendom culinarily inventor octad colorcast acropolis retuse bulla overhappy flyweight thallus medullary ensoul flowchart laudation enzymic snide thyself modifiable cysteine fattish cramp sloganeer ramble intenerate surah gypsophila dailiness bronchitis weaver probosces kedgeree olestra randomize month burst tableaux multiped pithy handymen alderman koa bedaub suboxide strophe cabinetry sunbreak slugabed sweptwing pileus triacid uveitis marmot immolation unsporting execration schist rubbery paroxysmal plowman coloring notochord waterscape draff chord viosterol schematize ogress itinerate purr recrement annularity hartal overblouse tinning ventilated sour spritz heptagon studded entourage salicylic jadedness heroical ensphere pitch impanation campily fusionism siemens militarist drawing clanswoman curling conversant blockhead identified snowmen mesoglea oyster maidenhead fugue orchardman jumbo browse hackbut nimrod certitude assure xerosis jewelfish sunbed meatloaf massy blusterous reason redbrick subagent chlorinate rueful miscall try adulteress shoebox noncurrent cranny prosaic leukorrhea hairline sower toast unchurch cognition wharfage kickball autogenous speak paltriness buttonhook allegoric perturbed anchusin suburb overcast vulture exoticism thriftily betterment coolish handle alien lineolate godliness factuality certify trochilus hitchhiker provided moonshiner bawdily zymotic starch schmeer methought rattly trodden erodible anserine strychnic moldboard courier royalty centiliter boyish footmark inmate dulcet estrogenic bedfellow orneriness pappy timberhead scaleless coffle telethon embellish hollow outguess bleeding caner psychos pseudonym uncap stabilizer bitterling overdub sup damsel chiffonier huge whist apogamy untuck chromomere acetylate megillah stepdad crassness flakey hotlink catkin shadberry odd likenesses exanthema binal velocipede amphictyon blistering pugilist doorsill larder important squat billbug pianist deftness tiebreaker signorina squeteague goldenseal waitstaff spoony gluteal execratory lang gal longhorn heartthrob crankily minded nongraded assailant fact oneself arvo ultrapure orpine primordial chirk canker signalmen mousse marjoram brightwork tonus tulle spore delectably polite tetracaine urticaria rash mitosis opium inkstand tomography flick pricker mulberry rooter offensive amateur epoch pervasion analogue manioc fought cavernous deniably spender copilot apivorous epitasis ngwee rebate nutted axiology imitate repine minyan sedate endodontic semifluid recuperate stanch watermelon cymogene dizzily felt soda knish busing casual luetic rheo neckwear erne oleo hydratable wannest kookiness nigh mega greet avoid apertural auditory squamose earphone freshness decorous archil declivity clearcole flagstone hummock inanition populous pleuritic epsomite otoplasty cons milady listee message congener endless miniskirt burier juvenilia fishbowl torpedoes echidna warm slammer sweatbox operate drawn samurai subclimax continuer rockabilly steppe caterwaul calculator fluorspar phonecard bebeerine isthmus tridactyl nightshirt ontogeny calends teleport octangle gel pyrite domesday misteach intermarry psychology grainfield avocation archangel slope glyoxaline palmist horseman screech testee multistory arciform policemen fjord hospitium boogeymen hydrate bung seaborne rath wedded lumberyard totemic gluiest warranted beforetime cercus simplify thirlage torque arak reremouse flush narcose opalescent abohm university wiring divisional impediment withe wolframite truthiness seamless untiring bicorn nephoscope scapegrace nacho headstone divot lawbreaker dovecot colloquy tusk pimply sausage legit fatigue battue smoldering gladioli groschen nymphaea water ampere chrysotile diverse pinch subcouncil bicycle possess subbranch persistent ascocarp payola slather hush transeptal hydroxide martinet verbalize kero multiform juniority wetware stenotypy leviable feminize quickie outgunned nagual anneal hidrotic stegosauri wingover aegis toneless mutate rhythm anorthite peccable realities bedspread coarsen gan cookstove adjudicate layman generous conch tabaret airlift abetting self hagiolatry bowery dejection relativity mewl frottage bareback triplicate rathe puissant sruti threnodic menstruate douce alphabetic that snapper fagot dentate washbowl amianthus spallation onyx stopple estriol interstate noetic despair ceramal dolor whoso gimlet bloodless barroom steamily dour pyroxylin cloth cabdriver trierarch walking less tarmacadam brecciate convolve plop southpaw preengage oaf koto inverter him franklin misshape signage manometric windjammer mastitides adjure foretime snood desman overwhelm theorize outbargain finalism comet criteria myths airbus stolon highchair caseinogen shall cisco golem cig sandcastle philately hostage fruitiness mover split layover curacy gannet unionist sherbet parer smugness gosport emissive airbase irrelative carroty beauty pasteurize contumacy gut selfless unassuming consumer ordinand hierolatry scrounge flay fawning tetter domino vidette bookworm cessation nausea serge figurine octopod limacine tambac galiot granule nearness spellbind shiftless brawny cirrhosis aliped gauffer pituri mill matey mamelon rafter defined eyeopening kissed rubiaceous dispeller anatto minstrelsy embody permission axolotl bkcy scandalous harpooner thought blintze waveguide inspection squiggly lime utricle luxuriate phratry sulphonate ghoulish fez cinquefoil teths atoll testable arboreous duro stdio tibia midbrain awry marshland empery noncredit bargello dilapidate innervate stinginess copy calumnious kaiak screw putridity genuflect thicko nonuser deportment conferred tropical tippet bordereau quintuple germ whf grail charabanc acosmism otitides listless salientian locked alpaca paramecia frequented gossipry passim cram shakiness toady ankylosis outwith pentose revulsion inebriety patrology experiment cello spacetime drabber anoint critic manille outstay kneecap steal ploce spoilage pressed clientship with caducous gobbing garroter crispy proceeds tellurize scented foilsman snowman unkennel taphouse hadrosaur whew subarea ichthyosis armorial abroad taxed meridian crosshead pimple dipteran blankness riptide elegiac published reignite bandwidths membranal irateness wannabe fence squareness technology menial other enounce disturbing popover ariose bayberry agitprop remain vale jointed angelical tripod viviparous bleak gharry pacifistic exist blubber mycelia chilling syconium copse calotte navar shutterbug trickery medic maidan hangmen rugrat glaciation protoplast apostolate bricklayer breach whiner instance rattler perversity myall nonmetal badlands interflow tournament needle skewer albata repeatable admissive solved laurel factual prong corves hierarch yearbook pennyworth acuminate fervency isopiestic bragger mudstone mistakable annatto pledget strudel filo workplace devest pitchstone sung tormentil threnody capacitive pejoration carrot occlusive sparred opsonin provoking valiant circumvent censurer protozoic penman dishpan dorser rostellum nod messroom serena agma preharden valuate clamming palomino manmade compiler cowrie outspeak lodger cachet zoophyte stagily biscuit jugful erection scallop laminae maleness jiff halterneck thither reground planet strategics lyssa aquarium goldeneye decretal mediation risotto floorman playacting deafen tizzy limiting flagellate wilily antisepsis fourscore discursion pronominal rappelled filarial lambrequin methodize overcloud rete unlikeable thane steamroll cardie prem rookery chasten noon ichnite endostosis flown rater snarler inwardness soothing fivefold underhung boombox incumbency damaging thrave cervicitis cheek paintbox aid nonillion malapropos delusional caring cabezon effector munition tangible wayzgoose firefight soar baric oke cichlid wheedle shrunk chatelain dipped wend puca jabbed slopping stiffener thingummy piecrust lordoses greenwood auntie disentomb paralogist pantalets manteltree soundtrack pataca sibylline stinko drew sebiferous pedate crept pus interval psychic betel taut party dense sterigma nickelic attenuate outmoded expelled aural fancy subvert perplexing thiazole arrestor theatrical pesticide rename riv fusibility finding quintet subfloor coonskin octillion amputation helmsman trumpery penetralia fiddlehead jogged syn turncoat potash dextran congeneric papacy tiddlywink truly barfly evanescent separation modality meatball drop limnology marble fielding scoot trying rend cerise ebullience thereinto unreliable mopier hyacinth xor winning strumming angioma ingenious scariness bhakti unresigned chinaberry vanguard rapture juicer teniafuge syringa aquamanile shockwave carafe patrolling riverboat megachurch datolite derrick biolysis sockeye sagamore workbasket valgus thaler mystagogue silicle madrassa arriviste rue pursue napless accolade prenup machzor donkey flour academical phoneme linn aitchbone adherent elvish coccyx taciturn jalap neutralize prerecord sputa worldly tanbark passivity behold grouse balsa evincible reprove abstain glt indistinct spermatic impromptu jocund veristic present apostil blunderer dray comic subatomic aglimmer fetcher deterring gob sandpaper tilapia patination phoenix tip genotypic market skibob highline cookhouse teleran retroflex import eremite foreskin unilateral mannerist inanity acerb postcoital chartered effluence waspish underhand hiatal epicalyx salesgirl manhole bibulous glaive hoarily thickhead tautology befriend affront nooky multiplier flareup spitfire chloride fur fibriform conferee readjourn molal upstream affaire homestead dammar windchill churchlike vibes oxide stop duodenal gree mudfish fortnight neocortex encephalon ringster trocar flathead repetitive bused medal pulpwood playgroup badness reality yin grandness rescue reverify thinner logistic battleaxe godroon arpent mudlark approbate trustless cirrhoses summarize colobus oligarchs freshet virtue affine girder chart moonset marry protegee mailwoman crewmen cutworm snubbed ferny jovial palatal martin mouflon hypophyses levant coact plumbum tungstate stockpile roar recaption grippe unliterary harbor oscular dimetric ripeness antimony clipboard birdman dissonant paschal dent jilt unrelieved dataset wersh puffer papilla margarine symmetrize punctual apterous rial tension gutter silliness collotype layup cannabin chapiter thrombin peasecod dualist trim horsey sighted shalloon jailhouse pancreatin alderwomen sonority editress upbuild collinear ciscoes gabber zenned handhold waterloo elect affixation provoker befoul etiquette sexennial soubrette xylem madder fallback magnifico subofficer lucent understate enshrine morgen lingerie gritting manque mako sarcoma positioner capstan suffer betaken spathose ere contrabass automate porcine oscitation rotor cretonne whitefish spinless ebony aviate estrogen relic militant monetarily telefilm rectitude slowness curricula comatose niter ataraxic grindery whack anger gynecology ubiquitous prebendary commander harmonica buttock ensue forecast unclinch salty occurring polymath fanciness euplastic serum protoxide sullen misesteem reverse dough gunpoint macule malignancy rufiyaa positivist block enameler sty pollinosis whizzes concision slumdog lumpish devoice weirdness cystoliths alteration stagnant peristome magnum superbomb yachting cha octoroon clubroom misgiven confidence pyrometer midnight mendicancy blatant inherit heretic eatage barbellate minimalism sensory brominate expounder plateful superman milkmaid bicuspid cerumen trainload intercept altazimuth violable paged gait roomer unrig batrachian slippery seamark avo dewdrop wintertide howdy ilk blinding budgeted kerplunk cashbox welder geometry metrist decahedra decl feculence pall operetta tapping calathus limicoline pinfish load boule mongo berry legalese surprised shopwindow octant jalousie bogey hungry spleeny brandy humanities doss diamond decimation feal mazard lyrism counsel matchboard pannier billboard hope doodler lamented unchancy gripper csc klaxon emetic forgotten pandurate hogshead feeling ignobility misleading multistage brook minus watchdog alkylation paroxysm stonking strife once footsore remitter sext cultivable pickup enstatite sublease gadolinium marrow masculine rummage squirt stitch gnomonic drumhead landlady barman terminable ballyrag lxvii centistere thrips nerval immersion subito tousle shtg nonmoving fourteenth virtual saporific tomcat plodder poundal parader sawhorse courtly prerelease liq coequality laundrymen priest shuffler dustsheet headshrink irrigation touchstone snipe playa smash concretion boastful riding roundish socle combatant phallicism lurgy lambdoid vulpine hearsay sulk spritsail councilor cybernetic anatomy radiogram tripterous flyleaves spectacle visit totterer decane shellacked gunsmiths marsh immigrant cherry allantois deadline wannabee fault tsarists porpoise memorandum sorbitol expertism teapot earreach peplum typewriter tricyclic testatrix pithos butt pidgin ophthalmia perpetuity halothane curagh stumbler tuppenny cerebritis jambeaux communal little cryptonym otto preamble zoomorphic lividity excelsior nainsook cosmopolis dynatron broccoli carpospore adorer monkeypot burnsides superclass shitload watcher exosphere gorgon stumble scopoline craven cento scrubbed hist underarm cubature pelage fadeless ordeal lyophilize plastique capitulum bauble circle grebe fatherhood fester funerary crapped practiced farming dunned interlock mopey moonlight costumer jurisp backtrack roc asceticism lunacy tartlet nates sycophancy croquet prolocutor herdsmen tinea redupl autoclave tricorn holophytic hybridism prepuce emulsoid swim cellophane barracuda bloodstain englutted scaleboard urbanity iconolatry supposed songstress umber without hotspur stylize sepal extrorse buoy investment trek freeboot stalag sevenfold germanic about magical vitelline hue badmouths yearning ghazi aromatic dive laniary flunk communism ragout consecrate tenement eyestrain cyclograph methanol useless chemisette bulkhead hematoid dogwatch hostile scion apter furious coseismal labeler shrieve eparchy gemmy carnal vetch isocheim livestock riviera speedwell orchestra ethanol allied broadtail nocturn blossomy overstaff semolina deepfrozen popularize abbatial warden fuliginous planchette zoom conferrer derisive let zombie spottily aport whipped ramiform picaroon reconcile weigela ravish lvi porthole babyish fugal neckline thymine frontline mestiza novelette cozenage sprawl downcast cliff routeman thorough anomie pretax subdue turgidness cloudy ribbed byre blastopore matador coryphaeus bulldog costarred glorify shote lifespan thousand melanous diagraph epigynous towage acetyl expository cubby perry plumcot stipitate coastwise evonymus building checkup aerogram gadgetry cataplasia hockey struma bald feudalist cutthroat hesitate idiomatic frostbit dimmer repress repugnant before xxv basidium inquiring thumbnail peeling decompound sunk epilogue flambeaux moraceous seacock pettily consultant kidder getup beccafico leftward nonreader summoner scaled stopwatch resonant abyss sidestep carpetbag subcompact colporteur evocation nomography bikeway client monarchic tinker saponin bugle webbed archaistic panne wee monastery workweek blk insincere brightener adulterate partiality frantic condyloma promethium reparably exuberance stringency smartphone ballistic seaborgium was therewith terra dashing sunfish swaddle wristband emergency outlast quot sporozoite knockdown trice krait emulsion encompass boast prompter nitty psychosis pinny briskness tensity patience cremate unfailing decelerate lithophyte exempla tartrazine marseilles torch alcalde physicist zoo blemished overexcite cloven desorb lollipop nard outsold byroad validation downturn forgoes chestily bamboo typesetter dpt dispersal cowshed molybdate appetency expediency lycopodium affidavit essayistic hobby adopter intricate abdicate barrage refractor plaything croak tactless guttle waterproof artifact venereal poltroon tarty goodnight lavaboes commutator extempore float hid ultrashort interloper bigshot maloti leprous doorman spermous kaiserdom flabbily downfield pretense aleph enrolled stripped shaving jobholder limit pugnacious benignity hazer wigwagging effeminate stalking proof aliquant lour xxxiv cycleway hazmat kinglet smelt agita alumina slugging flavescent whish brawl bookman moldy sewerage docket orch dietetic midfield rider solve nitro spraddle vinaceous steroid chattily newswomen tolbooth bumpy carryover birthwort potto dearest caducei crouton amylose spatula septa preaddress polytypic lophophore frontage buccal theocracy nutmeg dustiness chuppah surveilled numbing knockabout cargoes phallic guyot formyl exhumation hearty whitening mummer enlace droopiness fighter enjoin gulper fieldpiece dorado gradation login diffusion lighterman gnu notoriety tubful slimness midsection easygoing shad subcranial corduroy cabochon familiar ahead ommatidium bobcat brought pinnacle antiproton vegges pottage auxeses hydroponic letter coloratura footlight fickly destrier formalist erst natator nunatak nondrug rimester tropeolin wipe dogwood manstopper wanderings clintonia between chafe scram perpend emphasize supple nevi harm russety damnably aqua seriocomic adornment drawtube seriate spaciness fetlock buccinator plantain purchaser premunire swanned nav vassalize testudo plausible blackheart bulkiness teratoid modillion mistake dekaliter secularize malty frieze anecdote uniparous diagnose vehemence cachexia offered cystotomy opiate resole bicyclist glom sixty delver swung redressal calcanei prog hatter cheesy amiss handbag appointee lobate pruinose bane longhair deckle prolate feebly therapist gunship carjacking revile amrita prevail implant mfd squib avowedly drub baldric blackpoll bitters septicemia abominable menacing radiomen blindness none drainboard clamshell gds mollusk zwieback modernizer apologize midmost koodoo anemometer yipe extensile sachet draconic dove gynoecium timber atomize brickyard flattering dervish diarchy apse glyphic trickle hitch jongleur idolater repairman hustings argue carbonyl marginate hakim poach biographer publicity snip glower partook prowess drumlin scaramouch stomata hotchpot nudity brainy outgun factional pagandom kroon spiccato vitriolic fecit nounal infantry weariful grangerize prettily sketchbook move vaporous shit sarcous talaria earshot tragedian cadastral ciborium contexture tether buster tenuity traffic atomistic parotid wavellite dawdle peroration adducible crudity unfair agapanthus webcam unmusical octavalent cardigan gamekeeper divulgence jolter emulsive yippie coatrack opener fitful cosh orpiment scraggy mandrel lithe tartar perform lemniscate athanasia scrofula ottoman weighty faradmeter grotto alevin floozy needlework bourne birther interact pommel bindweed rouge nail duarchy tier phenotype clansman bossiness pedagogic undergoes matting fac asbestosis solar anorexic encyclical dearths bryology smattering bugler thewy grainy fissure asterisk wank vocational pajama ruddy thorium vernacular usurpation palsy exacerbate yukked smart decorated hemolysis succulence northerner oblateness ques nymphal backdate stuffily disdainful underwood distal affection entrapper piggish concord culinarian fatal shammer plumbic clii cholera credo covet refill slack woebegone vainglory mummify fraction skol pzazz nisi motivated introspect hamulus drinker holding lunisolar beanpole imparity exorbitant hotpot fascinate naiad polemics immaculate lake replant mitzvoth equalizer misbehave hale sluff tropopause infare pointer redound phi attack straight despond oxyacid eldritch shipshape apophases spirometer titrate metonymic undersized purse waverer sonatina depth biospheric gabby subtangent arrowworm cravenness dryness private conspectus ambivalent inflater brick responsum histologic refereeing nipper botulin cotyledon sacrosanct supervene plaza aliment hurl brunch cudweed oological megahertz psoas pacha evasive overinvest studied lining awash abysm patness chook raider metalware gnostic fairish champ rhythmic testbed bloodbaths visor prole cavalryman kerne leadwort blockhouse sciolism shirtwaist breath toggle depreciate disepalous central maltase stilliform obscurity radical uncut mensch deed aculei verdin amative greensward goethite regrow shill jellyfish paintwork upswept hame plebeian thimble slag jemadar gopherwood krooni clampdown caparison nightie strutted turnkey softwood insurer ovule nicotine cheapen artless buffo tortuous snorkeling pogey dystopian apatetic amanita sportsmen pewter huntsmen lowbrow nodular whoosh culex respectful suicidal shockproof fellah abr saturation synereses stannite traprock petrolatum locale oversimple georgic bevvy dashiki lambdacism bookmark hypnosis footie mulla knickknack underspend darbies alienator roisterer subsidized gusher ransack blindage herby cyme tang becquerel porcelain jackknife foremost orbit affable coeternal haunch telegraphy precast hydroxyl tannin agent retting maltha parafoil phalarope spathic cockcrow pyramidal gaillardia totalizing metage disclose germander captain aureolin camelhair holmic kohlrabies verjuice eupatrid acne myalgic kailyard reata dermal exigent gravidity flapped firn aerodrome slogged burnisher pluperfect geminately branchia grivation ossicle clypeus crucifer engineman recept isothere jaywalk obey abhorrer returnable boltonia caritas fluctuate good systemic extirpate vaccinia pochard jockstrap tealeaves prosodic estragon ballsy comb synd julep squirm burin flooring submerge staircase cuprum rasterize nebulize racial facecloth terrazzo acceptant droopy anterior pukka sterling vibrissa glutted olio daybed swordcraft bowling ideatum cabin audial coronary scrotal mammonism lipreader impurity worktop perpetuate guesthouse phocine hiker cavort zesty aniseed savor miscreant stirring deerhound obeli crownpiece xxxiii unfading absorb enclosure deposit insectile fellaheen backswept alkalies admitting gorp terajoule posthaste lappet manpower mercury rugger plot cooper stoush bacterin gigabit esophagi laggard leaper freehold minutia wombat militiaman soundness tulip judder foxhunt milligram cispadane semitonic definitive trifoliate urease craftwork viscometer bandit unlock bandstand attached duodena dislodge knell feretory schizoid tabbed withy underage gangplank enzymology twinset forelock ruin flickering ratline virgule capped nation bagman decibel pardonable joyriding adaptivity heterogony dutiable coz hassium iridaceous quidnunc hydrant quitter prosciutti preexamine measurable festival sixfold bishopric mammoth izzard irisation barometry yawl squiffy interfuse lacerate portend headline floppiness ascription sharia ectopia misguided boatsman nonswimmer serow dispel skullcap separably eyesight ratifiable revilement aurify tuchun pun dubiosity lectern goatish essayer hoecake myologist boxy echolocate pipit smoochy inshore teacup corridor urinalyses clitoris imit falsehood ovolo baud earful iris imbecile plodding popped headlight fosse fad sailplane incestuous knife malleolus aciculate gigue tropism def reprieve figurative allotrope hypogenous quested floccose buckshee mentioned suntan lovemaking nonprotein confection subsidiary glucagon shaw vaticinal obligor homograft gaudy hent samizdat mog quoin stowage anesthetic hose redesign immesh brawniness benedicite challis waveband neoprene kenning ovulatory decameters twosome lab proclitic interblend luckiness ginned lilac midget rall acidulate loaves levitator nosher varitype nymphean finagler temptress paradigm gunge racecourse silenus printhead android caracole pinned deejay locution mensurable minyanim alae petuntse plantar offing hierology connivance outrigger yakked howler allyl agley rainout demography epigenesis parliament tailrace marimba insinuate bid potence rundlet dingbat permatron discomfit friendless teak deliberate tach nonelastic footwear jezebel bluffness squilgee crappie effluvium deionize person ninth procession sunderance supervisor lava bedroll minoxidil pie complete vanity roughneck costarring yoga supernova hoar soffit dewlap cutwater samekh chigoe boughpot reputation floccule boatman totalizer herring pestilent doomster ragged coolant metaphoric nervy petitioner pouting ballon ondometer sounding right oilcan peag tar hypsometry urbanism pares bluesman atomist faultless gleanings rector clearcut palpate ineloquent misfitting inspector roadworthy stomacher rudderhead glibness effloresce invade crikey linkmen confetti bullion empathize seeker territory saunter undulation ducat foredeck volvox burnet centrum piteous swanskin cappuccino financial actinide thundery organelle knacker interlunar varicella estoppel ectomorphy mafiosi hippest balletic cuddle oct tappet diviner twilit egomaniac width pelf payout rocklike faze underrate semidivine necrophile wanderlust charioteer biannual exurbanite crapping ohs bladdernut ashcan collocutor cajeput hereupon cattaloes murkiness regiment headnote silicic handgun phoebe lumisterol foretaste potato western lobster impeditive glop recidivous lychgate vastness splitter dextral orbicular enjoy illegible worsen gametic tumular slicer butacaine fortune thumping grubbily sentence anchorage misfit nickel literarily chaplain lunette standstill collation gymnasium paralogism dispart taxa specific longish platinic barit retarder concertino staurolite reglet favorer xxii sneakiness kettledrum biogenetic hairpin complicate deaconess habitual satyriasis epiphora symbioses coneys eleven kibble stilted lactam subclauses cacomistle catamount colewort ligand synergetic subduct secret xiv obloquy crimpy privileged pendulous autolyzes perfume sweeny revise contain broach afoul erythrite hemline encrypt wryer airguns aculeate vacuity toxemic lapdog farewell hairstyle firescreen spunk frustrate volatility precentor vouge polygraph offsite veracious regard gumming triathlete anxiety bloc squamulose raff condyle fipple multilevel sanctity woo obit disputably trilobite thatching outline hedge slowpoke melic fellahin constraint issue teach entophyte brocatel braise stodgily asphaltic covenantee colic hideout allographs spectra sclaff pauperize gloominess lazaretto linkup deiform plenum pilsner duodenitis logic cruel proboscis shell clammer capita whimpering bubal waterfowl verdurous obese middling newsdealer vetoes globe swash civilized beatable porridge posit dream cynicism athwart daffy ago wist explosive foolproof atilt antiphonal dryasdust pancreas jaded ora glazed midway vampire autarch skijoring ochrea echoic scatology yapped monetarism terebene jocularity thickset healed stank tit spasm whose jitterbug glary feasibly linin opaline bile ignorance tinge brilliancy level diaphanous thaw equator barn glacis forbear atlantes myotonia ravin comfrey vas felly laudable swotted sori rattletrap primetime tallow anarthrous struthious touched cleave uhlan soapbark ringent astrometry arouse fathead stressed splatted godhead bungler cased widget bra braiding dominical biol furfur woozy fork gyp epiphyses polished fwd lardy minstrel overscale hypozeugma almighty footling raconteur stinkpot mikvah olivaceous banns tambura pellagrous calculous ligament ferment rowing popgun quinacrine aridity fungicidal loonie espousal torpid purl abstracted trance knighthead bangtail transferor loup niceness illuminism airfreight coattail cooktop deodorant autocracy lubricate genitalia pagan hardener regality fishwives hymenium airstrike unswear elation ideologist chanteuse bookwork scuta vulval tailgate outcast shoetree encoder alumni liner ironware goyim tetra negligee bobbin microdot gelatin painted nobelium breve sanctioned pompadour sweetish hormone blotted van youths tweed postmortem valse meek anthophore notarize internode musical knotgrass tesserae medius flowerpot whitepine awakening ananthous nimble morganite cupreous bereft skilled mercantile stull hookahs flap potted zoologic outyell degust longhouse luminary cereal intrude ratting accouter projective lathe subhead which ganister knotting cavitation spousal hipness keystroke bicameral power homeopaths khaki crabbiness isonomy motet curdle methylene mukluk mussiness handwork mic motormouth deathless windburn fella orange sidesmen sassafras hymenal snow raffish salinity bellmen perorate forelady chemurgic ssh mandala gtd sinistrad aggrandize frothily defilement riveter headfirst camel kneepad fruitfully stagnate touchily skimming spite obloquial chillness looter diaereses streamy unploughed expense earthquake horme winding laughing whoever effrontery didactical saveloy catharses divaricate coxcomb aerobe exemplar imitator topography vaticinate shipmaster angular noble community airwomen longicorn acanthoid everyone dubbed munch cont byproduct alimony looting homeland disrepute visualize relink unsighted orb salina spacewomen porringer modernity whiskey indignant onslaught variate hailstorm allonge received monostome pismire stride lyse boogieing bluecoat lamina outspoken cargo lagan coruscate onomastic chugalug woeful uralite ceiba pedestal dayspring contest acre loppy vellicate butler auto passbook patent sixtieth lexis underglaze zit windage entryphone roadblock idiotism nonreceipt molar heretical offline guild vendible cespitose osteoblast swam unerring serialist graven hipparch astragal stomach bentonite scantness glottology phaseout punishing nonpaying poundcake late comm landfall sexologist tunnel cyclotron smegma stonechat breadbox dropkick monopteros doddle caballero cyclosis avn archespore kermis centrist tenant cosmogonic weeper brightness hemstitch overrun emalangeni jazz tea dystonia photocopy propylite crepe susceptive intimist verbalist glabella besotting alimentary gunrunning hexagonal falsetto scraggly frumpy porcupine handrail manometer diagrammed scaliness mineralogy isoclinal parterre hypsometer fog irade mopping tannery telson phenetole shebeen sail hard absolutist gory homophonic deltoid pinier mouth babysit propelling submission whereat zoophilous traduce noonday anhydride vil sclera dissent abjurer boschvark mumps worldwide volvulus brooding tinpot ytterbia camarilla cathepsin defunct savory calibrate willing whelm gangrel emirate acyl pairing quadrature goatskin glide package national mayday triphylite egotize epiphysis glairy piscatory barbacoa like seabed win thimbleful savate calamitous galangal turnip nostalgist harem siloxane synovia laywoman behemoths ludo scraper bookmaking onager amendment viceregal misology prenotify barre indictee recce harpy circlet bat recyclable treasure budge bribe physiotype creditor refer unpeople foldboat typhogenic reg marsupium rock noisemaker animator andante dromond autarky exogenous talent fleabane created ephemeris sultrily teal courser bowsprit alginate ahem granddad ukase executrix succession dismantle fissile manege devoid linnet segregate permitted voicedness advocate lucky ignorant obvert lechery protector reconceive softcover interface flew windily heartfelt turbinal dilatation unthrifty ofay nougat journalism pourpoint molt rhenium poetic chronicity swivet dayflower isogamete touchdown smocking secateurs cannulae statuary gorgerin lessen buckshot delusive supersede smoky spinneret footstall spiny switcheroo pucker cembalo nakfa nonhuman vicariate yabber inearth enervation havelock confident facepalm iteration overstrung placekick bike gorily fantasia gunfighter capsulize overshare mobility faculty impotence dusty feral traipse muddiness foster numeracy scum trace adamantine feet sinh locoism pantograph bock greyhen casino sheaths prolongate ineptitude dote methane disparate linkage salon incult sissyish crushing adrenal boatyard residua pizz accusing grouchy embrocate katabatic propulsive camphorate monocycle inundation imposingly bountiful soprano anaglyph charlie uncreative pluralist beagle naumachia catechize police coiner foghorn quench jauntily hawser skerrick tokoloshe content drainpipe raga cenobitic attractive calcitic virtueless transudate sentry integral cenacle fumigate ordn godhood tushy response shakedown carpus trammeled severance galenical menadione satay sterilizer sacrist hanging moreish dineric reverso ambulance polenta krill rheostat mottoes zloty homemaking membrane threaten inedible sirrah thetic anthropoid catabolism rappee colonnade dipl tambourine tenability allergy bursar muttony oafishness saccharoid understudy opah evocable boomerang wool wineskin forthwith garbage vacation jarring haaf orchardist craving melodia teletype henceforth hemolysin subsense cataclysm gaminess barbarize lintwhite magnesium term erinaceous bulbous hiya organology disputed obtainable tox soothsay agility sortition spumescent dumbbell joyrider refulgent spent semisweet anarchical advisably alidade yodle psychs succeed steric gibbsite dilatory lix biff fibular belletrist stretto sudd tacit endogen saleslady turnout talented duple sheave geriatrics chs gradual supercool basis gone eryngoes scandalize bathos cinchonize heady motherwort beansprout hyphenate telescopy gab cloister garboil linebacker caulicle arris wirehair flock tabes anguish farce tidewater actuator conscious dactylic piddock enjoinder anticlimax comate leeward dekagram dismissive bison snagging epiclesis slate psyche cowling subdomain pickle yonder repass equestrian bourgeois string greenbelt confessor demurrage rhetoric blabbing bora terrible routine honeybunch argumentum doctrine strathspey eudemonics spurtle anorexia steadily maieutic employer outflow objurgate restroom godawful blucher sniggerer oxycephaly bicarb dioptase intendancy despondent fuhrer radome lawman sociol gorgeous misquote fate castigate scruffily trilingual antifungal spermic shrew caulis picoline unreserve amu technocrat bunghole educator stumpy cookshop manageably bogyman patinous naphthyl zymometer embedded strath chromonema boondoggle expended gymnastics wackily consortia meticulous nyala expunction veep espial unsteady bisector whee trickiness immiscible phrase splenius barracoon draper calamari erratum neigh clerihew relish portent aggrieve ignoramus honester inchworm expat irony emote desirably endorsed nardoo visual coleorhiza bedsitter cacique myxomycete stemson hay acronymic mascle wavefront sweats dental crossness isle erstwhile environ shouldst pantsuit nova pong robust thirteen carotene condyloid gnomically sicklebill departed nobleman boutique outshine vend wonk allergic codding imamate automaker hammerhead coaming empathy sourdoughs pureeing camlet sneakbox mop imprint arrestable baptistery fertilize turn terrine gritted clad bagasse methylic alloplasm scene plate women solaria urge antilabor scummed migrate powerless corsetry divination furl apophasis coremaker pragmatist savageness constancy anodic oncologist exaltation groomsman enticement grubbing coverage expired peneplain calamanco prosper rewash pathology outre secularist coleslaw kinetic lat longtime fracture loading veiny scherzando accrescent ligature recourse hoover dangle unbeloved araucaria polyhydric interfere binate thinness townie light forswear toot sidesman heathendom wonky gigapixel peppery voyeurism astatic ornament antilogy graphite creatural divest apoenzyme brim phlebitis tawdry amour declasse excise divalence project quillon gramps coinsure tum obtund plasterer pacifier copacetic astrolabe tequila operatic pilliwinks gasman squall mackerel permanence infrequent bandore geol dermatitis confide sensualism risibility carpology commission deanship pigpen slabbed cafetiere upriver affecting sublunar tavern pannikin regulator jazzy authentic swag bandage euphoriant smolder transept piglet antarctic deviant klong filagree aglitter sigmatism cwt bunco decennial interrupt legend craftsmen libriform sophistry sense nonfactual pudency aloft begot cincture durability dramshop erose mercerize terminate promptness shivery sassaby phonetic mayonnaise huller anthrop bawd falbala merciless thumbscrew exploited nub phr racing apodictic binding nonfood copay successor alg poilu inkiness pemmican caged lovelock nide hayseed furrier truculent dinette ballet adopt shmo lodicule chopine weather quorate orbiter colorist sundog quinte doorpost ricercare underpass scorpion recipience bobsleighs backlog coniology backseat starfruit wayfarer pneumatic frippery lutist economism subspecies pentatomic vomitous beachwear forbidding scribbler flashy pharaoh emigration ecphoneses fusty give slaw strongmen draghound snowmobile pyrites porn rudder easement permitting crone yardman adrenaline chiliasm driveler bingle protrusile bonze jiggermast javelin glutton phenomenon messenger snowstorm consumable cithara medusae riel wax carbine reproving woodprint accessibly impost guitarfish negate storminess carnival tailpipe".split(/\s+/).filter(Boolean);
  const WORD_BANK_4 = "spacewoman humaneness locule dealt frigging zed pademelon daredevil casserole bibliopegy satisfied tristich budder allanite brigandry puzzler railhead sacring hogged consenting mourn trouveur adversaria bilge drawknife psycho handoff spelean papery occasional during roseola leukoderma jurywomen myelomata shimmed braggart muriate predispose attributed sackcloth numb hairnet scrutinize faddish lozenge oxidative dudgeon misdirect secretary musjid inner plenish effluent stack alcohol exch quartzite impetuous weever netting laminal intestate specialty levee colugo begat stubbed cornflakes separatism biogenic uppercase router fickleness slalom cowpea clipping mazzard enroot combed pitcherful eustacy burse licentious cervices chigetai crate pelvic vertebrate duotone mafioso kalong pox hobbit rudderless caboodle anarthria tripped outfight disvalue airboat hummocky mycorrhiza distichous molding clouded many compo notary snappy tricrotic clownery cossetting yobbo winded nematode silverside habiliment aback organist auditor presidency canape lockjaw cretinoid boar prototypal vigilant desquamate yawner dashpot importune seismism cantata booked crosse aided dentoid postlude clockwork prevision opponent tetrastich cisternae threadbare hovercraft collected longing tiki freak collocate porphyroid xenophobe macerate dermatoid stonework silly poverty demulsify ossiferous percept sailcloth watery heptachord pureness illust scape sensoria kendo gospodin vibraphone thunderer coquettish worldling uncouth screed syllabify demoniacal wall guardrail fretful fractional sickle gimp heinous altimetry bahuvrihi dispermous fiascoes lyncher noggin thatch emboly pilot tramcar totted rowan pebble hellebore insurance habitude scuzzy veinlet fixative mystic impend reader militarize gainly corrective scenery williwaw dialectics tantalic diversify golfer qwerty suspense allspice relax decline rosiness cilice exc succorless pyemia furrow tautologic meteoritic advocaat shamanic cowberry bovid heaver scrubby convoke wherewith aphorize syndetic grampus gaud shool carton reap news cut ceremony travertine crumble seniti goatherd canna goosander thrummed militancy antibaryon stuffing melanoses orangutan yearlong nanometer racialism hyperacid congii jook polycyclic upper out dab ballcock lineman keratoid withering synopses curricular undertake grindstone curability coagulum wholism skeletal translated crack rumba grot way prefabbed auctorial lactic slavery serious headsmen disembogue penumbra jammer frosting icebox floreated tough sedulous jardiniere smoothness plenarily agenesis hoopla modernness tomato suretyship rollmop ope linalool undying ate script scilla heavily slatted join cetacean lightface serfdom abnormity colloquium bark normal peptize account superb boardwalk margin minicam hallelujah quadrate orchid dichotomy beshrew debtor shameless scattering xylograph obtest catalase maremma boroughs eyewitness zygotic dob muntin caret gauzily taxi teeny granitite waitperson sepoy brevity satem fixity bright hygrostat humblebee sleek riband whirl analogical extend statism binning gleam epidermoid lardon negroid rascal outsmart chiffchaff halftrack guilty thrombus welcome hematinic bondage couloir therapsid garrulity marionette compliance theatrics inhibition metaphrast nextdoor spartan macaco squarrose macrophage underskirt dinnerware buffoon outfox vindicable peppermint mole gauziness noodlehead leavening amphioxus apartheid downtime washed hexapla time demoiselle megass medalist silicon rain slider corkboard kilobit stingo twisty gunlock homocyclic geocache blueberry wherry congestion pelerine stander wadi drunk ultimatum neolith dight egestion demiurge rucksack claimer stereotomy brambly wood chokeberry adjust geographer parasitize dispatcher regalement colander vedalia outdoes tuner fanned revulsive arteritis deprecator chapel annelid volumeter thimblerig dollarfish yourself fallout narrative regatta lifeguard lentamente hotkey hardhat ptg beebread movability blackguard quarrel coercion hybris hierarchic goldarn annulet remise kilometer trader scowling encincture repealed prophet emotivity bureaucrat canescent harshen solidago oligarchic discoid coom stalactite phenocryst chowder nourish penumbral glans malemute cheekpiece cerebellar reshape stickweed shone poisoner sansei popish censorious leafless nephralgia init coup bushelman galvanism krimmer drawbar parathion amitosis shalom caesura blithesome bateau darnel parulis optimum awful stressor histaminic pipework toothbrush triaxial paraplegic ptarmigan ionopause serf tritheism cherty tectonic warble cassareep bauxite acetum libelant muddy foreordain forehand entirety where bearskin obligate megajoule midshipman greasy epizoic isentropic cannily pitapat elbow burghal nobble edifying richness carbon lunar trilemma involucel niche megapixel rubber noisy fluster feudal chipper stigmatism heralded auk west shipfitter mayor chest picklock new simmer generic clean auroral venin phlox pommy unruliness begrudge traversed zucchini toothwort luminaria fajita grayback immensity newsroom planted chantey decagrams preordain floor pinworm endear burliness twain listserver bog stagehand modeler combustion carabin cog stakeout neckband nippy angiogenic erythema trabecular padrone adiabatic rotl equiv sferics ouch thornily crock tyrannical tragedy paramo burglarize ginger natterjack epigene pyrogen epiblast nystagmus vermicular neuritides fifty edentate mobcap fierce satyric guileless grumous crimp telephoner cent tungstic mineshaft curet grandpa mounts pricket showdown bathymetry autarkic thug build manurial tubing belonging chocoholic sweetie flywheel rusher suitcase libelist euphuism sectioned baiza tomogram sphenogram patrician deem bionic aparejo floridness action swarthily miasmic short snuff syntheses pursuivant tickle pantheism yippee cultus consist polarize scenario bulimia plead filaria ulema code ambsace besought bodyguard perjurious toothpick vorticose bartender spumoni roundsman multifoil graphology sniffy mummy leafy auricular hostility piragua institute kymographs paratroop suspicious wean succory bigotry tress schlep hero entreat euphrasy firebird endow pyretic halting whirlpool cents chamfer superstore resolute unciform elephant gibbon arcana earthborn enmesh lav fictionist lobbed frijol sequitur nosepiece peat voluptuary pediatrics coot bastinade fearless archegonia coaxial valvate sinusitis upon nebula force markhor dobro metro flatiron corpora lunule jackshaft detainee schoolkid your christened lubra detergent biotite flycatcher quirt patin polling battology oxidize biocellate tendinous hatting tantalate dignify tegular antibiosis quipster isobar cassette glioma reprimand hyphae reliance nonary funnily pigtail coated set unrest walrus pence cerous levigate exultation smooths gleesome snorkeler chirrupy scream deontology prevenient abrasive matronymic humeri twine sunbaths molder sinless levin bryozoan pinochle posturize sportiness bedstead abrasion coyote dentistry eclair pesewa guddle plowed zymase foll page fop sodality hila carver hoofbound back candela biceps purism positivism gladstone glitchy sanitize deceitful bromate breadroot flypast dodder albuminoid privity blameful bunion microloan subgenus petite columbous brimmed wisdom wringer dullard latino evaporator teriyaki lighterage fifer overmaster sopped dowry goofy bilabial chm thrombi division evergreen kelvin hydrofoil rhonchi forward toeing erraticism messuage fluffily gaga backchat hoarfrost harry similarity pegmatite pilgrim saboteur holistic uncrown verily charpoy shoe fillagree hello mow chuffy minuteness cress sank airport roadshow milkiness cockneyfy valeric mall slipslop picante timbale blowfish mana chandelle naysayer deadness catnip skyrocket legatine backbend blockader speargun bathyal mezzotint fleuron hawkish baryon semiyearly dogcart atropine communique vivacious witnessed scapulae nonce backcross barbet ballata subaqueous plasmagel lumbago commendam titan sarcophagi crockery enrollee hypogene trochlear metopic anele somatic fescue abandon nonentity decreasing hothead oversteer compelled lapstrake oar whopped acpt whit traceable include alumnae sapidity mun staidness motive susurrant reed filthy oversee predial cantor campground misprize saturnine izard balladry whey objurgator digress retirement clubman brickbat droplet centimeter bandog paratactic isosteric cotta savant hexyl artisan shoplifter doormat proctology cavesson casement upcast huckaback amble dimeter acrolein flirt hendecagon goddamn washcloths album malefic dunderhead maverick ruddiness nephritic vitrine meshugaas cess talky oxygen ombudsman lubricity puss glittery jejuna implosive trihydric sawtooth rifler ain saltwater windgall dissertate forsythia personage montero mustache safeness druid fiasco apoptotic dispread cither quantize cantina scoria reviser fixings obsessive cogitable milkshake dual isoleucine matureness wain personalty nawab retted beguine studiedly morbidness pincushion soot hangbird noticeably mythology scuffle milia highbinder whomever wetback allotment psalmbook slab parr midst pat tenotomy festivity flippest minute urethrae martyry pupillage jabot misdealt tureen tympanist coy tannage cogent uncrowded dotcom hoiden rancho secern cyathus bobbery togged tush rapier perish productive aplacental dovetail centuple mucus lifeboat sought foehn obstinacy curative skivvy ligule retch horsehair perique zigzagger lifelike exuviate meteorol lawn pert succor onerous germinator floc murices sharpener crossbeam benzine bequeaths choppy loyaler pyrope postaxial whisker accusation rockaway thill miniseries paradiddle millet knitted remonetize smile classify excitement jane dovishness licorice colchicum aeromarine axis acrophobia gyrostatic freeze balmacaan specula offense tektite croft musketry filum schoolbook pedagogue encasement credential sycamine chromic sumptuary nonflying witchcraft tourist riverbed copula bromidic custos piliform klatch typebar caviar benzyl nonvocal sneaky decigram transgenic bliss blondness micrometer sinew choir lenitive prefatory unroof gimbals glazier generate stopper cetaceous sterol grease kinescope pargetting firer governed analytical liquor urinary galumph timekeeper pelota iridescent talesman chinwag dropwort bulgy foreleg outrunning dint elegist modularize saxtuba bodysurf penicillin morphine fill sampling albeit offstage gathering provenance trainings narrator cypress hatch giantism diarrheal ilex wastewater roughhew sorrow broadcast free imide blundering topee standoff overfeed orphrey gavial oncogenic mannequin murre potassium dwarf capability styrofoam ebonite formalism backbit ungual telicity jar cuttlebone sagittate subreption eeriness alewife doghouse glacialist woodblock scrip hokku famine outspan anabaena antitragus overgrown thuggish oxime verbid earthlight nether mailshot shooter fricandeau duet adularia nock caseous titanate coley hansom satinwood difference hungrily pitchy knoll bridoon disrupt expertness deodorizer armament osteal workout anthodium forewoman cue indulge asperity dogsled cryptic wait leap jailbird ponce repechage exiguity weaponeer impugn spiciness chosen numerical nurturer pettiness hoatzin uprate patient oleic headstream tailstock thunk continuo ail neoteric ascension trebuchet joystick brocade diaphragm unchastity reformist methylated pistil hypogeum teleg sharpen parlor cert hawkweed entozoa tidiness yean confute sodium reposit annoying wasteland vacationer moralist hula asparagus arose quillet finite prier debater cystolith kaka ska sanitarian govern five larboard appel rictal miscellany holm vernation magnon teamwork mucosa arctic scrutator wivern silicify butlery excision abuzz europium charitable dewberry careerism splendor soaking cortisol scleral coming symposiac bigfoot cartoonish outsell handcraft salvage proffer quince antimatter deer popple diminution superglue receptor offkey canfield growler sober intrigant pad sartorii monochord contravene doily ambagious haze floe diuresis stockily frozen clambake vermiform sparry cor biomorph buggy medevac patriarch tillandsia ageist stockman crufty bitterweed spherule semiliquid percentile sitology putative gullibly wergild unisex pensionary rafflesia diastase subacid abbr geotropism childlike typology afforest custodian franchise batholiths septically distillate foreshown triforium bland baculiform lauraceous statical stair nook denseness angler sniffer title patriot sweetener stickybeak forceless obsoletism asocial stringer tomb chromium sinusoid batfish nephrotomy outside personal subphylum forgetful adenoid domainial foamy wheatgerm pregnant parhelion parapet judoka grower mower yew exception fuss digitate paregoric fucoid pekan falcon beret decillion breadth muniment creel placid patricide proglottis yclept amesace coadjutant jacklight heroes contrib begging hexarchy capper ground parcel tetraspore ridiculous hardwired homosexual worthily ritornello banker midday abeyant mitigate impassive saltshaker magician conqueror pulverize styliform freestyle tambala embrangle exequies averral andesite turaco dim fakery recruit camera orienteer parentage sofar sere fiche monastical arbitrage ballot violist centerfold bow pediatric ecological purlieu cataleptic eight blame prostrate lawsuit obovate moussaka appealing xxxix umbilicate transpose quicklime anamneses hyperlink triplex pika flack neaten foredo pensile newspeak shewn pres fundament strobila impulsion prophecy lamb fussy sward allelic centroid halutz minatorial flaccidity elude hollyhock boondocks threescore artist empiric kickstart ruche backing redcurrant chocolaty confirmand afflux phlyctena arthromere cannonade frowziness hagiocracy depressant mechanical nereid sanguinity aramid double urgent chaperoned titular palimpsest pizza kinesics itemize feline porterage dressiness hidrosis surgy impaired sheepshead hut specious peeve subsequent hwan nitpick anuria eyestalk tortellini gainful enzymatic benzoate forte overcoat butyrin footman incorrect housewife cyl pilgrimize ensnare stock senseless alphabet luxurious mugwump historic phat yellowy jeopardous gonad menfolk gazpacho astral pigeonwing adv sensuosity hippiedom payslip note coolie glimmer hatchet vara beltway brachiator bilirubin cobweb unfamiliar aspidistra headboard pontifical chico vomer autocade criticism became polyphony palmaceous arrhythmic clearance enfilade quencher squama fretwork lustral rebuking opossum iritis marasca foresaw reserpine chancellor nonviable mother mining gumma logan phototaxis potency ataxia snowblower revalidate decollete blooper sunbathe brainwash penalize burstone implacably entreaty adman screenshot mealy pacesetter canzona crumbly arc rustic molybdenum hatchback gib prussic mace empoison condensate antibiotic bisulcate equipped cusec prize bougie dhobi pastel disulfide celestial shotten flattish undulatory foil tetrapody eft ant gnomic peace eutrophic bondmaid midge wulfenite terribly bolection brown blatting tollway differ offering salability overly suspension colone phototonus blistery topotype dun bathmat interpret met engorge depside polemical inky sideline militarily allover wiredraw limitary equation aggregator egad thar icosahedra inflame trifocal basement eximious unfriendly penne polyphagia smith dandruffy bilious peskily monocle slip drabble godfather whittle spicula demonic overdrive esprit slapped innocency loather fleece kent mortmain pinkeye interjoin superclean amaurosis flunkyism acute orzo joggle heatedly cowardice breastfed toad paraselene disburse smelly selsyn tamarin vampirism somite windiness thorite dinge sexivalent hairgrip sabotage obsession crumminess mine duppy grater leet enzootic bismuth twohanded champerty tom burl criticizer leaser hunter anemology gasohol skiff flake wording rhotacism essonite staticky parlance infirmary decongest deckchair laterality oosperm reiterant pervade economist holster chelicere zoologist akee rhinology swoon extinction comedic cotenant steenbok pos cuppa toft mammary smog indican gimme airily barilla errorless dosshouse museum lifesaver abacist beat notation acromegaly protium galley varices extort kurtosis pipette pikeman citywide runtish spangle muralist glossology antilogism beacon upgrade postural reductive ratified gruff diluvial smoke escrow scriptoria botulinus schlemiel stemmed intensify certes liberate lined blindside yachtsmen gnaw firepower gastric denied feud underdress barton scleroma yokel unseeing spline agree dissemble ferule supermom brittle exporter habit ophicleide comparably convenient glace importance sis koruna groceryman young kingmaker lindane bedside prissily marketeer unthinking ethmoid elfish slippy cerotype braless orchitis kestrel fortieth shoot mien abvolt encroach advent transit fungicide unmarried mislabel stickseed putterer declivous rpm colubrine early gentian tantara soapsuds sniffle shrike spikenard wash spoon abnormal aurous syncope jetton immature petulance passenger paunch douzepers taper comdg clubbable geneticist stairhead selvage brushwood sinker liminal diag alyssum transom cordless iliac overalls irruption singeing tauten rockrose blackcock feldspar overrule prosperous misfitted waffler acrobatic quirk chatted socket torii gangboard palladic fertile pedestrian frontlet noumenal oriflamme tholepin prof cinerator angstrom graduand kuchen fiddler clix ectosarc aviatrix flowerlike extrovert copyleft florist outhit runlet withdrawal lap hybridize they compete judicious clupeoid chomp quickstep guaranty siphon caramelize jam venation multiuse throaty ganglionic preselect moonscape attune ethnol vitiligo soulless typecast penknives niobium mugful clerical arthritic gambit brandless airplay confect nitramine carburet myeline hamate titillate pacifist underact smuttiness incipiency simplistic celebrate parity dendroid sentience intumesce greige billhook carry wile mocha stepsister thereunto rerecord stockmen betimes valued bypaths walkaway eosin moonstone earthstar stairwell earldom attenuated sacroiliac monitorial intrigue scan idiotic berley chirrup litigious mighty antonymy placet aftershock ordinate maquette cheekbone carefree pinwork trisomic obeisance locksmiths basketry curvaceous sovietism bioplasm forcemeat foe purgatory rumina zooglea yestreen impish fasciculus sticker barnyard ottar landloper priorship premed anagoge cardio viii chide newsmen deaden snooty mistime zoosperm bicycler velveteen juba freakish faucal briarroot legate lingoes fettle erminois tophus theine parfait hairband disruptive fundus estancia calendula pileless cupcake koph flyover lough baptized circinate monticule nibble hardtack rabbinism dabchick stilbite yore pouf interject airscrew brethren sabra demarcator defecation androgenic imbrue grizzle bead inertness clypeate haver bar goby forefather telephone how skiwear castanet rope wiseguy alcahest volitional polyzoic downdraft heathy mercer mortgagor tapioca insistence hardback indemnity gadfly jolt sensillum ditheism immure fawn slouch salivary flaccid radian damselfly office kickshaw stir orc stickup catalysis coiffeur lovelily backhoe larch monotony monoliths isotropic alone upholster ephah seedcase abdominous embolic sordini mankind cackler sandbank bowllike chaise pessimism fazed hefty disulphide calceiform ghyll malachite aspic deflector womanizer stoa therefrom scarlatina vituperate blastocyst suctorial buckler pampero duende jerid hanuman increasing bilobate damn pericycle slung disturb shiftiness quire land peashooter relational scud echolalia apollo purposed artel misbelieve ricotta gridlock kilohertz flame recto elected frugal hyalite easiness soapiness flameproof people crannog emmer comical barcarole shadily befog sequinned piece shotgun trogon shine tuitionary teratology sassy exponent canceled opposed skatole faience saccharify slide suety scauper stg tender nut ireful sack woodpecker knives gluteus madwoman explode venerate bagful dipody culverin meditation countess joy tidbit animism ban cetane fleeciness dolt notelet openwork draggy pelorus toothlike implore dimness azide apophyge carina solus tameness unground regime arsed gratis gula agiotage semirigid polymathic susurrate shrubby purslane airtime human atavistic invertible chalice legume forespeak stage attacker oogonia exurbia bor verger flogged opcode prothalmia sleepily giantess tailing barong spadiceous eyas alias loutish excurved nark material landing grandchild nylghau reediness developed bulgur afterpiece condition multigrain structured subscribe coadjutor bickerer proustite forger bumbailiff maxiskirt dropsical ocreate susurrous replicable antonymous suppressed lodestone kookaburra soldier hippy heresy flypaper burthen biggest xxix copperhead venerably tricotine trichroism gnat entrant albumenize pineal liberty shippen wander smack boink sanies secco stupa weapon fin lief goyish sectioning stagger running chiller apnea farmhouse falter emplace mullet razzmatazz ordinal greeting elecampane inocula stapler exabyte drawee toxoid oiliness nocuous cannelloni revanchism sagacity thallic gambrel statehood dogfish hemocyte epidermis immoderacy jewelweed stingy iguana excursive fuzziness deceleron assembler lancet airshow costate bangle ratbag dioxide tigress divagate endure babbler morale because crosscheck collide readout swellhead intramural conferva valuer brash cupped stableman ecdysiast borehole jumpily suint vectorized discreet monteith compare elemi osculation backstop suppertime commodore savagism wite algesia slingback labium cautionary oyer wizardry tensility forbore pointy bodkin bondwoman croaky sepulcher carvery habitably archon actives bubbly smarty slops juvenilize kevel scablike twelfth profession bloodbath memo jazzmen regularity yet redundancy weird reliquiae destine lichenous rotenone webmaster sone stent rowboat annal coronet thallium huffiness eke enervate impound navigation bigmouths semicolon tax endpoint groggy symbolism twelve debauchee pericline impregnate tanning viper depict tempeh beaten hydria dextrose grandee perfecta pseudocarp ohm instituter evictor tumbrel kneepan workshy arithmetic warison brochette handled braze anthurium barbicel predicted acrylyl armrest bracero pustulate entitle creepily skywriter hysteric fast fulgent chigger icily explored progestin renege mem box deficient sorriness misaddress also elastance magnific meadow continuum bullish extrude cob treeing horsiness humanism evocator maddest heedless telephonic fucker doloroso ophite buttery passkey rupiah synapsis railway xxviii nigrescent cumulous lifter mordacity allegiance scission embattle professor flippant jimsonweed skulker cambric external menses deaminate theory redelivery reveal pissoir edgy acutance monogamous tumbling libero totality kat vail ravenous oversea muttonhead curettage zirconia pane nonplus binned miseducate fanlight addlepated chaw peltry bullseye coumarone carbarn fiftieth kickback hydrolyte eparch upset arsine onetime mugginess moppet trill hedgerow chare eyeshadow corelation pediculous monetary slay sexagenary flossy agitator bash rifle jester river compagnie cochlea sweatily base circadian laniferous qty pap appaloosa eighths relater tailback soppily devolve undecided small gumbo enuretic basketwork tidy marg pinko regain guidon female humidifier epoxy landmark yodeler atone speedy poky apposite ebb adsorptive kitty prolepses grindelia coquette toucan alchemist forewomen argent driver melodious megrim thwacker upward ramrod amendatory metic altogether cheep willowware vitric hellion odyssey wrongful nobility sororicide sidecar maguey overgrow headsail organizer wreak impossible insidious goop signalize wilderness disgustful egoistic tonight rickey medication sporule epitaph dialer pillar flagging lampoon snobby frivolous mummery lac steamy cranky mutton cutcherry slipcover lashing theomania allowance curial excogitate rhigolene art meiny conga renal moth maximal tugrik slimsy unhandy moor cinquain echo verbalism dishabille lifestyle unvaried memorized ghetto rethink sprinkle dystrophy called discrepant marabou prompted cygnet randan leucopenia tripper flabellate stockpot vocalic monumental hawkbill tonne solubly hightail bushhammer lickerish halitosis handclap aggrade sennight scavenger icy vengeance parable patellae boa hindsight blennioid tussore fulminate motte heliport agist overload unlit delftware emollience rut victimize launder vertigo injurer tamper rowlock sinfonia luthern wondrous bacitracin galilee dulse plasm ileal observed chorale compendium gazetteer perceived carvel jocoseness colostomy rissole wellborn forensics rampancy treehopper milepost lazy trespasser cannery sepulture attorney tabbing traitor travesty eyesore bib subsidy fam rutting meliorate mazurka squinch morphosis fleabag agile doglike fornix cole consoling zaffer regolith ciboria slant machismo lambent anatomist precession redact fermium tally burgundy method serpent realgar civism sympathy coquet lucidness gutsily publish support lotus fungoid genu condign railing bumboat suffragism adhere calliope lanthorn tealight version girlfriend exemplary thespian gobble swound schlock sluggardly wheelhorse gainsaid thrust auxochrome endocarp koan ashlar megabucks grime rabato chandlery fluently cowman discordant pullulate interleave therein biathlon listed eightball purgation otolith stereobate expiable halfway resend soredium monogram loathing coacervate scrumming spile cusp piano acescent newsman enology wheeze bonsai biffin vitals matte outdate bap vibrate frolicker honorary caused girl attemper stopoff nonself workflow immortelle foliole tritium hydropathy lithomarge algebraist irremeable pean canteen nonpolar runway boldness aurochs twelvemo hajjes positional laconism primus dickey recopy howlet prospector spinet anuran skidpan insolence togging delighted gambol stunned closeup velate monorail diastole everywhere levirate chlamydiae blacktail coronachs kingly strictness doodad mesne assegai impasse trachyte sweetness bubblegum prater pergola nodical gratulate delaminate snipping challoth scalene conk bemire alienist criminate tapper mullion gauzy anonymity foreside nagged ovarian lordosis libretto overtrick showpiece modal bell lanai liegemen tainted jointress mutule deciliter distort competence mikado archetype spammer effectuate sirloin playact flong vesicatory gudgeon sculpt gullet degression osier naturals red detection satiny despicable wheelbase neck hydrazine curlpaper rake sunfast lessor leitmotif felony sapling newish pioneer manyfold emarginate headpiece length agraffe farm birl lucrative washily brickle imagistic hygrograph ademption gent three derelict pretext blowup burgee gaffer reannex dysgraphia clownish brickwork geod valance lobeline sentiment obtain accelerate scarabaeus podiatry naivety rhodic holdfast stimulate leave atty unromantic actual rencounter mantic frostily effusive botanist vigesimal fayalite doughty pincer complect timberline moue picnic marmoset agueweed phrasal tickler dwelt plumber quackery glassily gigantean dung candidacy hoard veratrine eventuate fentanyl miticide woodcraft truncate ornateness begrime tierce bitterroot guilloche mount collet exurban returnee goggly condenser mew dejected gibbosity reptant std down bubo rocambole allurement applejack syne easterner embroidery suppose impanel armipotent potassic damning storage virgate syncretic finger schilling healthy psychopath etiolate humerus brainpower heckling guestroom colored esquire ergonomics usurper wilt loop putto britzka penname meataxe solder cloture incurs compulsive equalize lighter workaround digestible panache vessel thistly polygyny bimodal madcap edition hypophysis farcy xenon fledge will cruller fresh veritably triliteral hooky waged expertize antitumor retrovirus jumbuck invitatory chokedamp circusy benempt homonym wriggly face slitting queenlike sotted extensive magnolia beetle endeavor ultima bethink cocksure particle utter midsize grill adipose subtenant anchylose needy chitin afflictive gilder storefront otology bufflehead grayish argosy demulcent baths emaciation yaupon ore combings nummular airmen aerograph cancerous connivery edginess jibber warning sophomoric eutectoid cremation gabble deodar fourfold connivent trimerous vestal feu impersonal karstic petiolule supermen snogged rooky champaign soliloquy objector rand tweeny menace lenity kcal handwoven binational treadmill trackless underfeed absentee suffuse sprag saurian vole bit panzer toxically basset kakapo cuirass snowball berths arcograph pilosity rectifier furlana jackdaw nanosecond fess uprising pollutant chlordan violate invidious vellum flotage granophyre pupa child deputation texture requital advantage cirrate stronghold womera drayage dihedron mastered sensitive isinglass swap desk embroider snob desire protoplasm ablution handyman contradict outgo ragging ingest pinhole cornett mainline hispid charm tailboard prevention shrug enwrap daft dumpiness scarceness episode toothsome univalve fixture abomasa ragweed tanner besiege blunt jeans pygmean rusticate indite stippling overtax checkout diapause arrowroot subtropic optical barhop mortgage edifier brabble skinner volubility screwworm wish leaflet obsequy housemaid needlefish dwindle thalami careless suction impulse hortation diaeresis mossbunker prestress gauge arterial ooze legateship peritoneum noticed quarto attainture rube gold refortify acoustics overlap resentment autophyte gable pansophy invective shikari blaeberry release jocundity shopkeeper xxxii pourparler trouvaille ceilometer embankment prominence apomixis cosset confusing waist triumviral boltrope purger anhydrous hypostasis activist schoolman mealie tapering rubato constantan influence mudflat eulogy dovecote selected prolepsis alate paronychia bindery matrimony wheelie polypus pothook oxidizer dumbstruck baryta secondment hocus kainite airspace lumpectomy ululation wiretapper munchkin cavicorn calcifuge pressmark funny vial malacology lading guacharoes print sufficient subroutine took rammer xcii arabinose chaldron spending impetrate lampas stagecoach locative proctorial unsterile mandibular compressor scissile seismogram tipster inn foreworn handcart wellhead influenced blender pinning bolter planter maltose crybaby isopod rook nonrandom tonearm outfit ltd strategy internet perkiness ticktack cave molluscan unfitting greatcoat commie attraction aspiration plasmasol ancient eastbound daylong persona automaton quadruplet affability deponent ribosome tansy yikes cestus scampi wether pelmet optic aquiver sunshine goldcrest digamy anodal roulette trail balboa coastguard fest lamp katharsis newsreader sonorant wistful infuscate leering villager corrupt chinfest absolution marque antiwar dumpy staffroom climbdown genesis blueweed reassuring luge reglaze belay periodate waterway embolden tulipwood region wackiness friskily barathea alike ramp denudation dowie gum douse fluff gravity stigmatic ticker paymaster pretender pocosin warlock meronymous seasonably mar flowerbed exeunt mascot quail tabletop compaction expulsion midweek seed teletext adulthood barley penalty hearthside oases hoariness ohmic purpleness brindle checker rubberneck writhen peignoir frenzied mermaid zareba subpart verite churn conductor anabantid highlight spicy drubbed tensible superorder claytonia sapsago papillary engross email thole engulfment fiat thirstily selectmen cambium java aunt scoff rehabbing podcast rubicund colchicine disjoint triviality mania fielded butylene stropped promo crow rescissory dyer promenade elutriate bushwa ceraceous rufescence dockhand causation persecutor ketosis monaural hippocras lawless pave rotgut pepsinate galvanize coalition polydactyl earwitness complotted facies nine hemialgia infliction contort fluidness spruik episodic requiescat diplegia portliness neg anethole abashed markedly salience academy baler blowlamp doltish parapodia downhill anadromous familial headiness soutane minivet preform whitey temptation parkland modulation skimpiness frankfurt pons hacktivist nihilism sparky chervil oosphere agnatic aquiline pasteurism deploy pontonier cartouche overtaken snoot calamint brazilein pere pullout voiture osteoid coursebook apomict everliving astylar esterify epiphragm flow autograft parent matzo salamander caulker devout stupid snottily quizzer mosaicist mete bin netball appulse plankton parakeet bucketful podding mock revocable genitalic whipping leaven doughnut mulch reassume unkind beet intrusion lorgnette woundwort dimwit novice spate nuclidic supply tachograph insufflate cabob aqueous regisseur nefarious millivolt astilbe quinonoid limewater freemartin vibration roster wrecker repeal roque shingle bradawl square miter evening smokehouse pinhead tomboyish thiol scrawl logotype escapement melilot mort och stases flatten erudition minibus bolshevism aseptic yachtsman occipita award narky dreg kinin gushing satirize trapping regards lipped whsle nihilist spittoon alehouse pallium strawboard scarring grit dauber bottleneck bowline bay bearish identikit propitious epicenter ninebark lakefront renin freedmen springlet undine prednisone moodily modishness sheeting chalcedony logical today accelerant balcony shrinkage isomorphic nosologist panorama beatify warpage feoff rebid subbase azole ringing accredit shivaree gaudily deflagrate nighttime betta subtitle frail gigawatt bunting dendritic aluminize oversleep viewer pharmacist bloat pantheon scoreless keeping journeymen titled dumpish sped befitted recomb sulfide exenterate feticide palaver afrit dyed rimless swimsuit buckboard valonia desinence shyster esurient nestling agreeably czardom libeler trike appellate sulci telling postal dankness sergeant ragtime genro smudgy accusal thunderous intimate thinned profascist erect parabasis futz zirconium spokesmen ebulliency carpenter mercaptide titi coursework yipped archer slideshow shipworm boyfriend courage intermezzo dobbin durbar collage whitlow testicle clone yesteryear scablands crawdad prim hammock autotruck planospore crosstie exoteric springbok agentival errhine cere retune testis lawgiver flatulent ann monte scare textualist loricate gaslit cachucha ethnogeny dipper chrisom seconder turbinate echogram stomachic hermetical lapped noddle somniloquy notability underbrush manicotti enforcer fornicate girandole fuel producible metricize mainframe intentness woomera guanidine nonrigid homiletic appose snowdrop unstopping workingman gleamy bod camerlengo congruity befogging flapping underprop fluty variolous cottier object peritoneal superfine atween capitalist definably fitch dramatic dripped diver breakwater mote overscore forgo eroticism lice unwearying recital picky prescript sidewalk shrewmouse buyer viscounty gasconade adenectomy acid mug barret apiarian foreseen raceme arbovirus adobe digital raze saddest applicant tsetse dyad tomfool holloes inexplicit persuasive inaugural narthex piroshki coalfield glosseme blaster swarthy solecistic cyclical propriety acentric generable jejuneness stirrup radiosonde dative sluiceway synectics mouthorgan bloodstock keister ethyne cozy lactone geologic habanera trad upheaval hallux mention subvariety platinous convener fusiform defensive siltstone bigeye photostat fringe piggy ontology erotica obvious submiss federation weeder frock spoof subplot anhydrite canasta syst scincoid corncrake dragoman advise linearity cursor amphipod soothfast oilfield balloonist correl attestor gratin reinscribe warlike wordsmith exhaustion mealiness stanza styrax plating vestry suspire abradant adaxial waitress arillode spout eolith camping aslope overreact womanish sleaze engage lifebelt ignitron piccolo triter manhattan holograph profitless quodlibet carwash cerebra misericord carder dystopia gasteropod swagger tenpin lobe lobar legitimacy carbonous decastere sterilized peridium slipsheet priggery harmonist idiocy alienate ballad pelite jokey strung shorthand testimony plugging rigmarole grate codeine viscose biddable dainty knottiness cryoscope figurehead horologium ask takin impendent smarts wmk sounder superheavy retinite cyberbully rect ripplet clamberer hatstand consulate knobbed throughout shogunate innovation seeming cyanine whiff caftan carcinogen grenadier volutes fervidness pantry litter walkout rocketeer ennui sideslip catchy amphibious solitude tolerably jubilation guidance prudery liquid sandmen synecdoche houseless shaven epos animalist pygidium boonies papistical untempting anionic kern errant catfish lens unquiet accident searcher convenable nitrite sulky villeinage owlet shroff deign scup berserk phanerogam cab inexact designate borderline legato martlet antiserum trappings apolune ousel triplicity trespass editor dysentery plexus peel schmoes fortuitous samiel flagger pathetic postwoman cindery uptrend slum romance tentacle ensiform headroom atomizer apeak diesis leaderless wearer abashment leveret scripted wardship lusterless bellbird frugality raptness costotomy impostor seclusive couplet autoimmune flambeing buckwheat pegging waterlog waterless peacetime elevator rattlehead flubbing niggard goof sourpuss diazonium skyjacking cymar sweetsop overcame philos enumerator calyptra rajes litigable deaconate potamic facing amitoses duteous heatwave kharif fluxmeter cotton obtusity jumpsuit prophase potpie anarchism horst vicing orgy tetroxide nameplate cheeriness doubleton sarong galactic earache proleptic ruths dossier checkers polysemous trashcan ramify misdo hum feuilleton fulvous sting nicotiana gatekeeper kilter bassoon wapentake hypo alow cox haploid dicrotic convex quagmire caseload affirmer fretsaw homecoming wantonness slump collateral luridness kicker soviet narcotic chinook urn heeltap tremor bodgie attrahent rigidify decidable kwanza tsarevna yacht chiliad cham micromho celeb spaciest maduro ecru exploit thanedom come rhinoceros polluter plagal dissension ayah sartor isogonic garget initiative malefactor abamp evulsion deaconry estimable atwitter omission civic ankylose hereon artifice glabrous sch encumbered commanding surveying apologia generality idiopathy praise dandify nonvoter cantorial harmonious myiasis scramming acquiesce sidle foxtail buzzkill tongue lunge manyplies rubdown clonk odontalgia paginated warrantor chessmen gowan inhaler mightiness accrete rosily twangy psychol polyandry techno heronry sulphone synagogal fulsome pygmy albedoes integrator calisaya steaminess mumbler alienor kunzite karyolysis covertness butterfly lathy mosaicked patriciate newborn escadrille abcoulomb fundraiser moneybag anisotropy anticline john timer imbroglio stooge engine wielder rayless shower equanimity unshapely limbic paraffin falsework inertia ectoderm eellike mam belief lateral albescent fishing fungiform lounger thirtieths tibiae rimming fishermen thrippence moi trimeter pend wirer oculist teenager descriptor oxidimetry alcaide brunette slangy immigrate snowbelt epicene plopped pts desperado porticoes geyserite millstream defilade overexpose keypunch coarse propr centromere earliness demagogic foliage kyat impaste brighten sullenness colly obstacle centrifuge advertised fullback oology polyzoan portfolio gamesome server invited androgen devisor fondant brownie linger inevasible adultery wakeless bridewell threnodist solo picofarad bearcat wearied striped taxiway firelock hetman dispersion enc nonlegal sustained cornfield bridged builtin quitrent ginkgoes cragsman siesta goldilocks tidal exotica shiitake mesopause calcific remora regency zlotys enrage hotelier weakness kickoff muster monition algid ripsaw knowledge cimetidine pan rhomboid gorse reselect platoon diddly globulous cumuliform decurrent thine exhort mourning airmail lavolta varve classy midship chisel astr noblewoman cuculiform iceberg hemophilic usable inbeing rakehell outdoors vise band hatbox obbligato satanist trample twiggy twayblade saltpeter removal ranch phlogistic wagtail equipoise prig pesade galleon callowness parental covetous downsize pungent reductase heyday prankster consensus yoicks viceroy feast goniff tumultuous neologism forsworn apple madness hookup folium flatbread ioctl paleolith happen purifier jerkin ascribe odeum venatic diatonic chiromancy acetic tentmaker half skin cakewalk stupefying hoodoo bootlick polybasite squalid fruiter cripes lignite quartet mugged microfiber kibbutzim optative anaconda tended nitrile phot haziness liaise pigfish foreign bohemian hausfrau generalize filbert immixture spurry virtuosic delirium rimose hairworm flybys unguarded accounted hydrator cilium consoled sheepwalk stringent leucoderma tenure maihem scabrous bonnet pent hold lucifer oviform slighting chromous gunwale portrayal repugnance succumb woodlice chalutz misfire lockbox troubled ostosis grandpapa overhung sexton fils baleen pasha hydrolyze fitter porno fidgety monoploid stag sachem purchase nuncio scowl halala drink guaco portative prefix fallfish nun hemicycle quintuplet molecular misnumber blouse eunuch loaiasis pomatum grudge aircrew undoubted pizzicati abstemious airliner fedora lowness aculeus sentimo medium hunt define dysplasia osculant banjoist painfuller popular drypoint ami updo microlith vaudeville axial landslip preclean globate milky caramel coniferous fogdog missionary titanite cancroid motif fecal plasmic scrappily xxvii militia sinecurist lyrebird binominal gusto anergy earthling kurbash locum curriculum peptidase leg skinful viral shastra obdurate drawer minster belting tribunal affusion coagulant gravy mycol toughener scrunchy anhinga cloying reading scrapyard paragraphs putt gunmaker ambulate fauvism decuple deadwood spring bob hautboy ruction stick unrhythmic redolent keratitis orotundity tense gonococcal vitalist righto marmite slaver bacillus torrent sibilance herculean loyal antacid cuirassier dreamland blenched handicap shipwright pietist molly aperiodic forgone country estrous auriculate disperse effendi cuspidor standout chimer neuroblast endarch defeated section phantasm upwind brede austenite hugged specimen headman batch griskin dozily fumigant adduce posting surfeit cessionary urbanize subterfuge decani labeled dozen nitrous ozone asst couchant mucosity sleekit citation agcy nimbly skeet sponge vanning barrister vitellin dockyard bait caeoma cutaway avifauna cushiony moorland hoarse postpone interbred ord videlicet salsify podite nutshell keen sanction knave bandeau coloration pastil meritless morris philter forefoot italic cohere chickadee pepsinogen lawful solicitude arrogant blockish acetonic electable driveshaft rampage beard ungentle blahs troostite fie ctenidia multiparty toggery woodcarver biota novelist pewit sauteed pascal polarizer gaskin zygospore rubbly diseur putz knight wetland offhanded imprecate allegro crambo hexachord gasometry hydrolyses guess vignettist fatless rompish gridiron referent columbium horrific passant splodge hijab transistor furan exclave economizer saphead clathrate pest tolerate gritter zootomy numbles tricky sarcocarp terse racily remand subtile pullback hypomania townee benignant impf slit outwore seasonal appraising nihil unbound embryogeny diagonal tenth stellate ecliptic clade inkblot rave stoat sap concerto voussoir excerpta gnoses heathenish obsequious orrery unexcited spook areaway dualism joyrode philosophy sporogony papa cycloses tighten unfleshly bpm hashtag antipode hypocrite misogynist bellman whacker unteach thee indicant ego ericaceous designedly inflate contra cutis money matins hooray apt drill shabby excellent stoke picul iceblink chromite tabulator lobbyist overflown apteryx grinner din felicity ballistics sidelight wasp kaross acicular moniker epistemic phototypy diskette weatherize towpaths vagary basion heartache neume shirtfront broadsheet deflection pendent guitar juice inquire haunting compote comprehend lysosomal incubate xcix completion roomy previous teniacide blind colloidal sluggard giaour bassline roose prick cubital cumshaw darkie throng priorate heathenry fanboy apogee surge osmunda city herdsman gablet acquitted rubricate emotive chumminess playfellow insetting simba jeez reel bluish velum forerun spokeshave immunology pink wed broomstick tarboosh contralto trichocyst binucleate slurring gonna kalmia aggravate corrode wiretapped coin chevron roble eon abduce vanquisher ramulose jollily salt marlite abba rugging henchman twinflower juggernaut foin actualize agon shovelnose clave waistband escapology tribesmen hairlike underbred leggy geometer solvolysis cadaster paprika elytron scrawny leman mileage ossuary joyfullest knickers teaberry ginny animistic lacquer raptorial burgage mason scrubbing czarevna pomiferous vulturous sepalous seductress blown coccus tineid orificial secondary coopery hardpan lorica foldable sapiens rankle slimy cloudily lacustrine religion efficacy croze duster awhile stencil freeloader bordure memsahib weave hygrometry rigorous dotted spacer putout olefin ovulation carny andesine frontal loupe starchily lecher dognapper diatomite messiness chain overfill zephyr quorum gouache shellbark kneeing extrasolar biofilm heresiarch downburst deistical triecious sugar flopping trinomial lumbar sitemap flextime observable peer rub snipped the definer neediness burly mosasaur dipeptide sporangia innominate ratan laparotomy shaver villose hackish dirk endurable tallyman buffoonish poofter colon meerkat peculator teamster dragonfly locust decorate ruck bechamel fake allonym gown crank mesomorph phoniness fennel mislay hyperbolic outland chemo filibuster renew diaconal benzol ciao usu midstream perm guava kudos mezereum pomology penholder bey outfitter accusatory slam forgive gipon warren slavocracy cloistral womanhood pastorale revolt lip jujitsu forepaw earthman gustatory trampler turnover papular nemertean backer headband nonagon bastion puffy imitative sidestroke comake trippet etude witchy saucily catechism kiddish picnicked equivoque roue cire trialing bucko retiarius eponymy iridic dishrag whiteout den peart diapedesis cineast static sweaty duel whip colossi wetness lowish definable fettuccine flashgun semiarid parlando integrand leerily infamy closing solemnity luncheon badmen hessite coverture hoaxer bumkin squeegee excavation distich overvalue pleonasm enucleate poleaxe asarum dopamine figurant myxedema amnesic delinquent forestay panting purveyance postnasal fermata gunslinger arrive photo beadle simoniacal attention ancon starchy formidably eonian shopfront lummox scutage appetizer guzzler eroticist busman ignominy baccy busgirl warhead philippic custodial intactness throat mongrel wisent volcanoes clepsydra ticket prodigy copestone endrin aguish moly undermine whim malaria yea tallith dunce necropolis ganglion piecewise moped mistress oral eosinophil library dir punster unitedly geniculate polymaths throwaway overroast dressmaker vicarage scrimp sloucher cheesecake turgid chylous bohrium doom uneconomic haeres loving fete fuchsin forenoon computing species goat beverage momentary making said nekton metathetic iconic puritanism revamping blench stub puce useful sauerkraut aster feign axenic grabber affective mussy weblog heeded sob whilom lesbian wafture airbed midcourse hokiest exclusion template crayola decorator pupal indemnify hexagram prochurch pentarchy iceboat kelpie floret stemware collier defecatory resorption midshipmen hognut nonsuit kibosh beadsmen raw appendix sylvanite bluejeans slimmer barrette trimmed sportily midline charr uttermost bondstone shocker cremator idyllize urination misdoes pubescent herder surplus scullery houseful salpa rondelet sheathing cashed poultice buffet homepage neolithic bounce romeo lidless irritator palatalize tongueless intermezzi motherland patter limonitic hurling infinity mobilizer rident misword cheating supervised assailed paretic reinfuse combat expression elenchus orectic pilaster diplex iatrogenic kimberlite betray delineator formate vault horsetail sale dahabeah keeshond seclusion billow louche squishy tiger nectar nicker pang grayness caucus cartoonist steepness smoggy kitschy wharve savage homologue endlong tollbooths castor estuary cuteness kilowatt trimetric arb bionomics rancor got succussion barker glad badminton fleeing discalced femme crosspiece sublunary interspace menisci acrobatics prayerful solemn proton sublimate bide warp signori bankroll tearjerker automatize motioning resinous magdalen tachymetry unrelated anode potent forfend wiry acceptance maillot tonically siccative atrip pinxit neuropathy tacket lagged telnet tattletale frivolity rescission syneresis quartan chantry examiner corium graham ametropia hooey splice frosh dunner asphyxiant muumuu marination showplace deflect off enphytotic lapin ketch hammer perinatal besot holdup lares fraternize sprig silky syndesis lantana hypertext offend prefect spigot broth mammy passional carbonate priapism tonality shaky hereto neurotic linchpin subprime pandybat talipes ostracon cantonment mitzvah vulgus pastie byrnie unworried grapple quintic sesame grassquit arapaima detective cocksucker villa hypnology slaughter reform gisarme somersault rebuttal mum tedium bopping alburnum flightily enrapture triple asthmatic outrode flanch attainable joinder furring dealfish can meltdown alderwoman layoff kenosis shinny strongman autograph subsonic mythic spirited absurdness propretor erogenous shoreline sourwood warrigal scumbag slight interrace millpond perron hokier ankylosaur subchapter ooh snick urolith submersion affirmant ecologic fathomed tripos titles newsprint tacitness stalagmite jobbery exp kreutzer toolbar collusive mezzo darned besotted talapoin alliaceous liter couteau saute dacoity fecundate doer coll squireship schmaltzy pernicious visitable shrillness trusting repulsion canaigre marathon bani oolite charbroil asymmetry typw granite foveola anasarca entrench ringlike gouger klutzy junco era passageway idealistic centesimal cumbrous epistrophe showroom schoolyard balsamic explicate graduation ringlet mustiness marrowfat drayman scrimpy prussiate centrism logomachy impressed bassoonist impassibly cradle carcanet labyrinths chitchat reached parrotfish flatways clutter neuronal cyaneous maharajahs vesiculate voluminous denude aliveness caitiff mercy pejorative sinned sforzati palmar reefer scratchily trunkfish gotten metacenter cromlech partisan shipway robomb ingrain redbug coaster badger majesty miswrite trigonal calycine coheir program fieldfare murky baboon dialogist slanting rom undervalue classic plaster forecourt twilight outargue sodomite tribalism converse stable formulaic figuration surfing tattooer cornerwise torturer gloomily viand schwa complex flask turf ephahs nonpayment limekiln amanuensis datebook partake ceramics yodel perturb bombardon radiometry planetary cowfish telecoms reinstruct ray microspore mourner mitigator demise hypocotyl aloneness chymous fractal vinegar cinchona puppetry pomp bezant segregated agee coatee phylloxera assent suburban raging graphic offhand joule banyan adhibit orgulous corrected muskox subjugate queer fyrd unlovable visceral rhesus southwest usury omitted symbiont trifolium compadre whammed callus subulate kurus moray effect attend nonsked sliminess diadem repartee ranchero zoning ironwood panatella lamentably bracteole showcase splintery capelin umbra morpheme opuscule supersmart virago basely potential actinopod tycoon saleroom tylosis adapter galoot nidicolous noncaking gemmate absence flapper peachy transactor phenom mazuma somehow gay obb clifftop erratic bystreet economics curcuma insulin nightrider ailanthus harmonizer invincibly glummest monoicous ricer keelboat design chervonets pub encourage revisory proleg clvi airhead outlive tragus sideward viziership washermen strontian toner damar hegemonism bluestone melton shoreless sketchily anglophone tottery tessera subtilize daydreamer pleach efface inducement gastritis illuminate downland wadge revised prunella camporee fustily batholith brach eolipile genie witch subjectify laxation mutilated vatted seaman walkup tobacco peahen hungover incarnate fumble evil liquidize ouzel lacteous mesmerist gumdrop cohesion neologize symmetric nidify surcharge rightsize outgunning grasp hung protocol eukaryotic myelin jaeger stuccoes fiducial hobnob varicotomy riveting kep meteoric ingrate prosthetic summat foxtrot inclusion geotaxis ballyhoo enslave lytta bushiness detonate novella banquette triserial talebearer chancroid reawake touche ideology tribe eyeshot impower niveous trapped spaceman dueler treason taliped identical agitate opulence misapply copra canzone creaky kerchief hormonal editable overdye adjacency sedgy frigid theorist unmanly strange cecity liberality bateaux damselfish renunciant besetting fleshy transf biotype whodunit sentient impose changeable peaty instigator hemiplegia polacca fungosity darer overhear asshole apply impale gambling wanderoo redtop souk prioritize ecosystem cockerel tufthunter browband antebellum chthonian saran scutate butch achievable albumose toddler permanent chastity feverish braxy trichinae seabird cummerbund annotated glyphs janitor quetzal waste outdo studbook bluebird worktable gloze imprudent misplace senescent govt doubt allemande schlimazel ovular humid faraway oast doodlesack stile taskbar universal wick louis algal teleview spacewalk expound tragical expanse swordsmen taurine ladanum weak palatine vintage pomposity trifacial collodion assentor inducer iota umbrageous heat expire pitchman sacrality chihuahua brie tragopan vigorless squalene cashmere stge knuckle consulship cuneal sudor malware canoeing gunmen tamarack gagging androecium basanite chukkar anemically feelgood zinfandel disjunct mikva gaz anomalous bascule chicle clanswomen gynaeceum carouser hatching consul catechetic estrone dipsomania forgiver scavenge federative incudes lascar tomtit spine ratoon horologe wine fictitious overprompt tinplate honey mistletoe aerophone tolidine resemble barehanded bailiff eat sing autonomic blocky salivate annates porter placemen sardine clutch pluckily goitrous roband miscreated sedateness domicil oligarchy intrinsic showily safety bothersome wavily flea pinfeather disentitle preserve swerve screened crashing muddle catnapping deepfake intorsion vegan coelostat hygienist sparkle skysail trust knob ptosis sicken snapped anginal cockloft awn detain backslide vilify hamper gummous larval reunionist cogency allowable offender zoometry chela quadruple clansmen brickkiln shutout savarin femininity multiunit scrubland tonic font jail goral snakemouth philomel asparagine orphanage placard speedster undervest spleenwort wittol cacuminal clxi lento gimpy halibut splay chufa nickelous season sandpiper sommelier mesentery comedy badge farmer sprinkler repetition barefaced illative sallowish undoubting rejoice takings cantabile puberulent eigenvalue fiery endorsee martyrdom snickering zeal platinum metronomic smaragdine pressman bkg trombone china triangle methionine prophetic flannel rectus excused lineament redo terrorize caul posse septimal opencast habilitate faerie perisarc postpartum hepper luscious ensilage coenosarc amphigory ceiling bitternut polacre theistical gourd cation misc flagpole trading statuette shotgunned nunnery flyboat course cabalist tactician funiculi onionskin geodesic gumboot varsity nares deluxe proceed synodal solidity cloacae silverware bipolarity spacecraft eschewal gingersnap palatable faceplate flivver keratose handstand embalmer florescent spiderweb whoopla bolthole ambition vair packable decoct macrospore fleawort chutney apostrophe cannular browbeat blither granular displode palatinate rebozo adulterine digitalism earthnut felid reptile hangout glycoside variadic godwit absorbed babble glaziery otalgia murphy nectareous expeller deutzia calorie honk plotted wholewheat vagarious thrall fourgon gust wristwatch monist shaggy sardius vanquished titrant chaeta predicable headstall galena zebu conjure recumbency ammine scammony folksy watchful wraiths maser economical delectate employment anaclitic believably tiemannite absurdism woodman jobbing zilch compassion retroact coppery windblown coast potboy lignaloes pepperoni tall fortify proportion chastiser robin track larkish articulate leotard torchlight odorous cremains commove brumal crosswind darg hometown iridectomy sciential czarevitch kyle screenplay shortstop expensive leporide couth reprehend valuator waterbuck tempera both moleskin nip churr schizopod phasic rapidity peeress entoderm overtrump imminence sensualize cascabel longevous pongid freelance feistily coiffure goofily needed agric musket prancing broke frore sophist plagiarism endorser nictate autistic cohort trencher shaped crabgrass haversack straggly cowitch expediter irides brazilin salesmen slantwise spandex glyptic uncle principled assai lodgment dodgy hyracoid dib pepped homophobic tooth tailband simar billposter incisive receive absolutism hellkite honker sailboat could skulk recentness typeset ephemeron affluence declinable ensconce tube infirmity bombycid allative solvency arkose lymphous thrombotic cot sylvan tiara buckhound hyoscine liberation horror inanimate shoeing algebraic samphire doctrinal nonworking fishpond snappily saline race transverse crawl mauve rel metatarsi nightcap cognizant monitor across oppose mortifying sandfly lyre unfunny retrieve atman metonymy refiner skim squatter lascivious firm apocrine acidophil dryad takeover jor classless pulpit fillet stridulate cytokines oversubtle skint warez skelp crankiness abs remix heredes ventail manifesto depilate robocall grouty neb balneal nonfarm voltaic dominoes springily gobstopper bibb isthmian killer apparitor hierocracy bellyband kinase benison lousewort vestment sectored mure pericardia argument infernal wetting vanillin cuckold petaloid dockside offal glitterati bronchi laryngeal suspender cavendish next nontrivial cryptogam organ peplos afterbody martyr overtask harbinger corona cohosh gratuitous microdont newel evocative winterfeed gram backwater bravura digestions ochlocracy flab curtained sclerotic taker stopped speakable woad shaman implead cubicle bobwhite countable enliven guib meas moccasin reclaimed habitant nevus mythomane liaison spyhole furniture phenazine plur apothecia binder daimyo viability pinstripe palish apostasy butanol prejudiced quoit raj ampersand bricolage exactness maleate uppermost atheling gerfalcon overskirt unison categoric motionless azurite printable glottis orthodoxy lablab irresolute hydrophane intend bathhouse nymphs spike wallow manat communist cornemuse menstruum aedile mountainy grown oviparity maenad cameo bushtit studious wicker checkpoint beating parolee capitol archrival pinfold screwy bollard joyfulness heist kaki babassu cadaverous calico deepen uppity magnify senora swaraj prop kibitz phish cautious accredited capacity tael elsewhere subtype torquey express certitudes inveracity quanta perinea catheter dispraise elegiacal testify pastose democrat evaluation lurching lavash repressive pipsqueak cowhide timeout chancrous resummon sculpin unesthetic panocha epigraphy blammo hirer cross pastiness squatness endoergic monandrous bolt hove rouse fossil squamous trashy lugubrious sperrylite deadbolt pippin chickenpox flavin polit egotistic skimp chef burette chainplate destruct woefuller vitalize catsuit hitter instruct plaque vav abjection citole florin dinnertime notch nonwoven auction subsume priming latchet sufferable immunity doodah meriting homorganic altarpiece piss isothermal bounteous usurer dork autobahn cypsela tremble unoriginal stoop cothurnus hater parataxis convulsion aerobic esoteric halo spritzer interbreed syllepses anteing defendant rainwater endue lubricant emasculate fellator grittiness drover vitiator arrest ottava germy lost nitwit underlay snarly impeccant restrain alterant shitwork creatable treaty alternate cupule bouncily ado jury unwary overjoy limbless missend apologue yawmeter twink flopped fut conium rattlepate savvy booking hibiscus unpoetical quick nineteen pul merry forearm vocalist mfg suslik arousal endermic quinone gametangia defoliant excurrent glottal gambade borak archway excess grudging bawdiness symbol milldam hebetic foodstuff blurry caste vaporize autographs recoup sufferably vet crispbread cannoneer idioblast chopper comedian locavore stackup kronor keybinding spanning cosmos sambo ostracize wroth timeless bouffe wench profit humus geranial nurse mellow brutish texted synaptic miliaria cabbed holist educated muzzily genip hopeless unstamped airtight battik religieux obreption billhead lowering unset another biology columbite drollness embarrass mantellone doodle dilator sideswipe fay underfed concoct junkyard redware annotator waistcoat dilatant guideline precocity maharani insensible siamang obeisant dispose instigate ambiguity quandary vivaria sordino belle curbside sifter jamboree sourish emergent dowdiness begum towering fueler cruzeiro adulation anyplace doubled housebound deter hellhound chess cordial astragalus vulvar troupe windless rife boot cubiculum yuan mintage actable peppiness bun disrepair subaverage toerag crash retinitis rondeau ecol proofread frizz proud illegibly falsifier tasset aft regrade malignant underbid sorites carpentry precut punily tithe tween amuse rhyton east whitewood dichromate gurge moulin arraign sculptress beck laptop neurocele hummer strength contusion espalier refute backcloths sahuaro deutoplasm incant lizard haymaker jell landsmen garnet dissenter appendage allometry diet corticate dater blast fiddlewood pinetum lunula grift spruce moa phalanger tollgate regress constrict resetting negro broad profanity safeguard crinose divulgate esplanade collusion indication movement spoonfed dipole cenotaphs antiviral dkl mutinous delicious zonk explicator substation actinal bawbee slipnoose hwy pole warranty infidel enchilada committee periwinkle subunit polyclinic cheer anacrusis jodhpur tempura bumpkin gestatory betrothal stubbiness intervale purpurin selachian carl fieldsman barycenter overuse worksheet nincompoop rusk realism telescopic cajoler gallantry behind sugarless cameraman decennium subtle hire valveless suited nailbrush subjacency allegory quadrangle industry reamer gonidium acquire wingback liegeman wanted octarchy dibromide breviary excitor livability canned organism capstone syntax delectable pash wifeless resistance dissolute superstate gossip flavorful treat majorette trepan palmitin audiophile mattoid librate cuticle repentant ave expedient ferity epithetic sunroom culicid quean payed scholastic larine ladybird obtainment graceful appendices propene agency sodomy mezuzoth analyzable curio pachalic webpage merriment personable raillery telegraph kop declass pride haymaking dicot zarf extramural austral disbursal runnel oncoming ceorl euphonize accel marker argillite spadices vincible jotting fiacre ogive calcicole pegged noodle enjambment citrin mope unity helicline ostiary encore inevitably subtly wired cartridge pup craal heading dying weeing pillage newscaster airless difficile penfriend lithotrity wariness grade radicchio trisector refractive forwhy flavine immurement amorphism overflew sympathies variably lady fugacity hereat homburg nodus phoneying capeskin brandling tegument breeder smarm breathing chatoyance ash jitter undertook democracy social handout eligibly walloping smaltite cavy regression prevent chitinous foist coquelicot shuck sustenance hornblende cromlechs windsail someday hybrid sanjak blueprint coquetry genit xix quite repp kirigami stinkwood ethyl pea advert groomer judicial legendary story online bedew repertory lustrum biotic laugh dirtball shingly attire runnable fusain granulite triploid astrologic payload teleworker tunicate amoroso tripwire gumshoeing pristine violation scarify allocable hardboard cupid recognizor knicker logogriph pursuance utterable glazing mammoths moralize carbazole chelate fiftieths grimy weighed manginess satanistic deputize loudness brainpan landscaper zenith lop recti stoup mezcaline smiling dreamlike acceptably symmetry strumpet isagogics tailorbird propulsion dickhead assume helotry hubcap panful dicast acarus woodsia sleeve filar carcass fusil antiworld afterglow create gross theater refloat quarterly blubbery diligent formality dressing halophyte frond sunn eye acaricide echinoderm lector driftnet anapest inhibitor haulm tympanic artificial hittable pareve twas epispastic yeasty logy isopleths scrofulous lanneret pheon shattering mythopoeia loadable cooker intimidate smallage psalterium dialyses shofroth homiest occupant delint charted masonry maladapted voc handshake herself myocardium godless campion crucible churchmen clip impossibly lanthanide overmantel insociable redyeing compounded melter overt processor onus prime wrangler teargas survivor rosebush executory merrily adessive sandy diakineses sidewheel pisciform crusade buff fifteenths lutanist assertive dubitation samba jacksnipe bestowal tuitional conn otic corporate biennium cordiform glenoid muskmelon imagism brier pageboy clavier johnny ballplayer ringer topologist likably resistive scathing abnegator pianoforte grandstand imbibe showery unsaleable uneatable retrace adrift pavlova supremo handbook prattle cockney pashm verity dealership jib pillowslip bezoar antitrades nepenthe nomination hustle praxes subj etalon melanism demon turbofan curliness teleology toolbox observer sacker quirkish naevi trimming lachrymose viably infidelity cylinder urbanology winegrower preadapt helpmate formatting inveteracy blend suspensoid peatmoss nonskid andradite strigose inglenook hosp severeness fusebox archpriest aconite ginormous outthink burger addle lobule skinning bast modesty catamaran breeks stetting inaction chivalry dedans judgeship calling cucumber diatribe cockeye paralytic manorial lifetime uprush trichite verifiably organon lanose equivalent sorbet micelle gleeful astonied storax gametocyte watchtower racialize claque window iridize comment leges rainband microfarad week despicably toilsome phallus hydromancy surprisals caiman marl perihelia aurar closet specter evoke dandyism maggoty didymous pustulant formant euphonic refuge aiglet aorist playful risible poniard concha biforate bassinet holocrine mite zingaro flood gregale spotted eclampsia slowish graupel mantua nudism ecdysis espy puberty uxorial effulgent monkshood genome wouldst educible unlay rakishness contango lunch cane turnsole fenland admire woodenhead aneurin wattmeter chub geology varying trend pilfer steampunk kilo jorum pharynx analemma sabin graze theology rigidness stuporous centigrade bilocular horsewoman bulwark retiring pouter preboil moan fisc strontia axon compressed forego valuably rise cordwain satyr pederast teraflops osculum hoot trouser bedpan bobsled serdab squeaker antitoxic mordacious cantaloupe esoterica assured relinquish asci satiric chaffinch masjid stepchild windsock slobber processed rally cosecant assist nondurable gastropod flaxseed harasser gauntlet involved breadcrumb aggie varicocele intercrop popper cropping silkweed telescope nosily unsightly diminished chestful tenderizer feisty komatik ice atonic luau snuggle osculatory inane pamphlet ilia tarmac falconet chugging number suctional octahedra anta roquelaure redness titulary approval compliant ugh placating metical referring gaucheness glaciate entrust exigency roughs overwinter spoliate sailor lakhs asphalt helminthic mut maven superbug blatancy marijuana retainer bitchy sigil deffer opus nonstick visitor edacity shirty bowwow apiarist genitals longeron pleasantry impedance metaphase elevens glucinum unequal gigged nitrosyl rum houseplant retread steelhead presa sandlot spirogyra littleneck fisticuffs derry classism naevus gantry mythmaker enteron inamorata mule weaponry submediant shedder atonalism kilovolt whammy casework dexter realized tenebrific chamberpot gripsack acarology cuddlesome indult ripen mycologist wantad headway pervious vermilion inbreathe spud brutal hateful passion commixture trifecta gallfly jebel federalese phenomena boredom cant abele since carbonado psalmody vert grok paisa tetrarch necessity nonbasic lunatic shrewd tinnily lea laze roper spinose scarecrow watercress illumine exuberant trendily milksop undersell uniliteral gawp pedalfer dependence challenge menthol nil codeword oxpecker codifier wren shoeshine specialist predatory hydro mannose validity accidie bloodily improvise contd plebby tort advertence bossism wooden spitter purposive bahadur activate coequal sprit hahnium duodecimo pomfret agminate clog fosterage dah bulb fabaceous horologist fungous pathname duchy forewing anoa pastiche mediatory caliche customer girlhood primal pibgorn harnesser decile dissed guar zincograph palladous lipsynch platted trustee malaguena cinema recipient scuttle cocainize sousaphone leguminous resitting meninges alkane malm redan torpidity orbital gramophone ligula feme triglyph refuter cowpox flasket jeering foresaid ablate redstart sjambok punchline truth simoniac pike whinstone bindle concern rethought almucantar tamarau combative printery sluggish blackboard eucalypti chez breaker usage advisee chargeable tidings crooner alga fimbriate cascara schemer attainder hereabout intertidal violence nabbing perch outsole coiffing dossal ciliate table meanwhile faro tipstaff bundle signature ulmaceous nepheline defrock libra freezer ossific accost rummy rattish trudge harassing eve grin extensible grout score groveler dehydrator anadem township hulk mumbly pedantry lambswool cochlear predaceous chippy testator tourney invertase call baklava hypotaxis accrue alright ethnicity sock mystical maraud jubilee unravel barmaid brumby irenical circuitry cognate pigging avigation cloudberry ethnology ustulation brother degree bubba misdeed glyph purported colostrum histogen basilar defeatism rumination sentinel squelch roux melanite verbatim outlook wallahs sewing density imply chemical exegeses premial casaba transducer smalltalk concept foreknow deli diminutive hotbed outspent isl giveback cinematize here thuya endamage upheld sacaton unbonnet bootleg pokey shrapnel debacle borstal journeyman apperceive siliculose brandish formalin nomadism caudex enclosed airspeed loofahs cope churchless twister pilose outage espouse bollocking fertilizer antipyrine quartile copepod faulty exegete enrobe candid seventieth nemesis dingo vocation paeon inception drought harrumphs paronymic technician standpoint goalscorer slapjack swept brushed foobar anecdotal heartland panegyrize typewrote crevasse fluky annulate statolatry outreach alcaic erosive nay fantasize activator accumbent wacko tannate mammillate ligate shampooer bumpiness flasher cruft overdubbed cloisonne hour butchery shew laxative victoria secretin garble alchemize burton encase snubbing prevocalic cockhorse geography fishtail geostatic grig climatic phthises oxytocic velleity jimmy currant launchpad aerate solderer daycare preference tango globetrot capacities starry yolk mailman mucous relevancy salubrious changer hysteresis sensual spelling extine chapbook schizogony byssinosis bootless privateer lid poppet forgiving wondering pinna helipad reentrance accounting fed upstate theophany triennial whereupon claybank calmness upholder banshee northwest testudinal autocrat splenetic spavin borderland sonometer laid trilobate therap allow myopically rabbinic centrosome disprize puerile tiffin gonk vicennial soutache lugged ascariases photometer tricorne impala sidemen rush ninefold viewless columnist freewill audited flection panel felonry shovelhead woefulness covariance cacoepy hiddenite flapjack bandurria squish tailpiece slayer epigeal bend patentor trimonthly fairness swear breathable fiefdom accede watershed modern duenna muffle use emir bloodline gigantic meatloaves caseose neckcloth nitration sugarcane worthiness leader keyword peripteral roebuck anticancer works frothiness briefness trimaran ulcerous shrugging psychiatry upsurge snake commit intermix milometer lively redundant snoopy slave iodous zeniths loopy titian pumper gemstone obovoid draft peddle warmish reggae bander lifeless genoa amorino shoemaking treader forage electro disgruntle solvent mishandle fley enfeeble capacitor accord oceanology pimiento heedful cribriform retardant phagocyte finback aboulia dadoes scar pilotless restrike file wrong undaunted adoptee tallness raving providence skiplane perpetrate gentleness naturalist bed incubation filter stalk spade screwiness scanter tubbiness sunsuit salicin bibliog gnarly matron vouch martellato toadeater starter dubnium candlewood daffiness sanctum torbernite overpaid suggestion burg jettison apportion amortize dissuade bittern assumed tested autumn midrib codded saltus doolie pubes postliminy adjutancy contrail fastidious emf whoreish crossbill primeval eduction somnolent stupor bullock expiry pelletize coltsfoot scotia oblation deposal frequenter steep bushy ossifrage telluride tail lopper oxygenic alleviate waggish oxygenate regulated liquorish immodesty nighthawk rural intoxicant worsted fatwa hesitance hemal vitascope dhole preadult hound flashover madam clematis thicken midpoint percussive plus pattern blight basaltic hap ignore amahs luteolin wherefore hit nucleolar tympan bilestone sleet jobbed rhino bluebell addax cinematic senor undead morph rioting deceased caress gumball hidebound sphygmoid daydream assortment utilize frappe sipped vinous nitpicking ducts proverbial socialist yanqui rubbish cuff engagement carnotite testily fibbing taskwork bantering guileful barkeeper constringe creditably freshener minimalist nemeses isobarism howl sixth velodrome infest gurnard boardroom tassel coexecutor maintained swollen numbered nonesuch outlier stymie ghastly miasmal mounter alexia putter dhow pesthole kerbside our kooky capture moneymaker highness haircutter kaleyard pervasive blackhead replica poco dumdum eradicate levier swirl sorrel ferine mansuetude velar espresso eclat microburst joyride rhyme sandbagged limitative front semanteme giddy airing oomph loggerhead ludic elegance rickets done gainer earthy lecithin petard diseuse coenurus dowser chromo hundred toadyism marmoreal batiste beldam bare hepatocyte jukebox sameness ionosphere tailcoat conjugate xerophytic wailing dramatist tamoxifen weathermen brasilin rhumb querist glassful aweless arbor idealize barred uterus revarnish culpable exhalant cyclonic theologue fight motility kersey setting waymarked enveloper tarnation skerry dextrin powdery tetratomic leitmotiv commissary capitula inimical lightproof standpipe agr elastic brusque satchel duad digged uncleanly ventral duodenum endemism hebetude refilter harlot mousseline caught intensive skier zoospore honcho blackish inland miasmatic liquesce chlorella tilled floodlit change inhuman larceny creak vindictive decorative chapter fanciful aril revet barefoot usufruct wahoo fresco picker oversalt diplodocus dislike hardbound procarp athirst septicemic shove headreach macula litas sickroom pry napkin soften amazement gappy driven chippie uncommon maskanonge forepart ragga wage turbulence rambler theocratic houseman airframe cashless glandule climate oxidant overfond foxily shininess apothecary suppl anglepoise paling gastralgia raisin dolerite creep clicker mandrake columnar bootjack direful kibitka stadholder conniver horizontal underwater rep fullish navig outrace centrality skater schoolgirl climatical budging insolvency dallier dentinal bennet absorptive hiragana hyperbaric parallel mayoress defoliator superstar euthanasia porous dustbin stamen ischemia caprice waive voltaism potentate barbate lethargic napper amnesia virile flatcar linguistic rustically bryophyte neophilia passus consult insecure policeman nugget dearness obdt bolometer choppiness hamburger godsend vampy furfuran ponderous sibilate varicose fleshless mastery weeknight flotilla roman butterball puckish spaghetti juvenal stonkered headscarf jugum latecomer germanium geld terseness margarita bethel sarge monotint glasswork bearberry bedevil xylene redraw cisgender jinx forefinger hackwork flute abstruse rift medullated cryogen nutter wanness toward velocity electronic emulous worrying ruth dittany shoddily argufy barbwire bolide smatter bundled cavetto lied rogations apsides remnant ultrasonic undershoot whet papilloma seersucker yeomanry presume impostume draw ante guile gadid averse sobriquet shabbiness archduke horn outwork compliancy gratuity bichromate chordate mydriatic dormice pawn presbyter chimera zingy armyworm paradox opaque bendwise marketable aeropause unreeve cybercafe millionths wat pyritic sparring shark madras johnnycake blasphemer puffiness lignitic pulmonate scoop junior estuarine dysgenic poeticize mortify oarsman ochery chard virginity milkfish slipway swivel boschbok alkaloses pipped singular preciosity algetic doctorate contact dispirited herewith statist foumart abstention abominator culpably maniac cajolery presurmise full contriver reduce vulgar heating ensure pacemaker burgonet relate chute cootch tuna artwork diestock farthing jungle kampong trial devilfish phycology notational backcomb abbess staging neuter profane emigre monaxial roisterous mudflap treen invalid overwork marchese evidence anagram sketch quivery playhouse grub pirn tableland unsphere wirework lanciform corralled fibrillate entryway cauldron contrived crinite underspent xenogamy stuff flexuous cubit isolator preapprove lock oatcake sprat zoonoses mize allograph puggree decoration meringue heartsick aludel anile seriffed spay ripping kosher paraphrast seasoning tester toasty dahlia octane libber better bread indenture cocci reedbird schnorrer dumb hilarious oath muckworm chatter periscopic dither agitated oppilate clockmaker actinon cologne chiack coenzyme bite boxing lent motherhood tonal squeakily deficit allophane behalves pronator philander moisturize vibraharp roarer bang erode pyloric potentilla qiviut divided copular know dutch freelancer mafia gawkily mycetozoan methyl dispute bushing eugenicist chapatti cretic garment amended sorbose endoderm jutty crudites sawbones marguerite masque granduncle tootsie dynamite pyruvate subchaser burial trackage announced hagfish baloney glen beggary loculus venireman poker threadlike barrelhead shandy lenience inculcator heliozoan adonis surtitle rig sememe simulant exfoliator ease continual isometric situla overtime shredded tabulate poof ginkgo circuity coolness decimate pluvial laminous camelback polymeric undutiful outhouse pyrography tatouay bummest timecard losing bezique testa stood canister imperative grassplot loot dismayed pow propmen withal sleeper quinoa melanotic ruler dupery diary equip backcourt bunkum reexchange bottle clang millibar kissogram oracular perfected fulgurant jousting boundless interring evermore lightermen pressure viking cestoid unbridle lavage climbable exhilarate washable hearths primp libidinal hypethral primavera semitone mackle sublethal airbag oboist woolliness caplet imaginably showbread throw asepses krugerrand carousal minicab situ poke tapir omen coffin lampyrid weal pachisi analeptic baseborn learned psilocybin midiron barber bejewel sporty assigned fosterling dysphoric beginner salify transect nongreasy zazen mousetail sauger faveolate squalor prolactin ballroom jawbreaker eventide pin impaction vaulting slub directness advance pregame entangled dudish frat lantern modulator august modicum stockish grubbiness emoticon rinderpest distaste guttate pyrophoric flattie alluvial oilstone moralizer ratter banzai bignonia underbite pleonastic axeman tuneless hinterland blitheness birdieing atelier pentacle nagware feverous charisma messianic looker defecate scull demurring baneful praetorian painful wisteria affix cauline gaunt cerate hairiness plain mousetrap apiece reffed tangential legalistic torn southerly hustler rhizogenic pumpkin sleazebag deserter penni buntline sonnet acrylic juggler hectograph inviolably spontoon dyestuff matutinal flexile calenture humorous collarbone ament fish riata satsuma picrate regnal dodger lifebuoy quadroon dismember gazette shaveling reexport stripy frisk ventricle varletry fluffiness neutralist yod moronic suspensor separable deployable tubulate dotting bought afore boldface perilymph digraphs curium bichloride myogenic childish decampment iffy parabolae sallow passivate filly waltz scrapie betrothed verbose vindicator furriery guaiacum slunk nectarous dbl coulisse umbral stela choler transcribe otherwise cabretta seepage sickbay steroidal impolitic idyll cyanamide appeased sarsen hypersonic sojourn surname pendency canning croupy pious apex claim curler normality tot lusty mender agnate jaywalking stylistic restart coadjutrix photoplay twirl surfactant raglan dare honest upend distraite verse hasty forgather stapes ramjet covenanted gloating snappish decern picador abutter ruralism crenshaw noisette chauffeur dengue bronchiole surprising debatable chromatid dynast forby repellent bbl blasphemy sysop walkway officiant pare".split(/\s+/).filter(Boolean);
  const WORD_BANKS = [WORD_BANK_0, WORD_BANK_1, WORD_BANK_2, WORD_BANK_3, WORD_BANK_4];
  function pickWordBank() {
    return WORD_BANKS[Math.floor(Math.random() * WORD_BANKS.length)];
  }
  function getShiftPct() {
    let v = 10;
    try { v = Number(GM_getValue('kc_shift_pct', 10)); } catch (e) {}
    if (!Number.isFinite(v)) v = 10;
    return Math.max(1, Math.min(100, Math.round(v)));
  }
  function setShiftPct(v) {
    v = Math.max(1, Math.min(100, Math.round(Number(v) || 10)));
    try { GM_setValue('kc_shift_pct', v); } catch (e) {}
    return v;
  }


  let charStats = loadChars();
  let intervalBest = loadIntervals();
  let settings = loadSettings();
  let session = null;
  let lastResultKey = '';
  let wpmSortMode = 'order';
  let uiRoot = null;

  function loadChars() {
    try {
      const o = JSON.parse(GM_getValue(STORAGE_CHARS, '{}') || '{}');
      for (const ch of BASE_CHARS) {
        if (!o[ch]) o[ch] = { pressed: 0, incorrect: 0 };
      }
      return o;
    } catch (e) {
      const o = {};
      for (const ch of BASE_CHARS) o[ch] = { pressed: 0, incorrect: 0 };
      return o;
    }
  }
  function saveChars() { GM_setValue(STORAGE_CHARS, JSON.stringify(charStats)); }

  function loadIntervals() {
    try {
      let raw = GM_getValue(STORAGE_INTERVALS, '{}') || '{}';
      if (typeof raw !== 'string') raw = '{}';
      const o = JSON.parse(raw) || {};
      let dropped = 0;
      for (const k of Object.keys(o)) {
        let v = o[k];
        if (typeof v === 'string') v = parseFloat(v);
        if (typeof v !== 'number' || !isFinite(v) || v < 10 || v > 800) {
          delete o[k];
          dropped++;
          continue;
        }
        o[k] = v;
      }
      if (dropped) {
        console.warn('[KeyConf] purged', dropped, 'bad interval records');
        try { GM_setValue(STORAGE_INTERVALS, JSON.stringify(o)); } catch (e) {}
      }
      return o;
    } catch (e) {
      console.warn('[KeyConf] interval DB corrupt — reset', e);
      try { GM_setValue(STORAGE_INTERVALS, '{}'); } catch (e2) {}
      return {};
    }
  }
  function saveIntervals() { GM_setValue(STORAGE_INTERVALS, JSON.stringify(intervalBest)); }

  function loadSettings() {
    try {
      const s = Object.assign(
        { targetWords: 100, weakCount: 3, enabled: false, excludedChars: [] },
        JSON.parse(GM_getValue(STORAGE_SETTINGS, '{}') || '{}')
      );
      if (!Array.isArray(s.excludedChars)) s.excludedChars = [];
      return s;
    } catch (e) { return { targetWords: 100, weakCount: 3, enabled: false, excludedChars: [] }; }
  }
  function saveSettings() { GM_setValue(STORAGE_SETTINGS, JSON.stringify(settings)); }
  function isCharExcluded(ch) {
    return (settings.excludedChars || []).includes(ch);
  }
  function toggleCharExcluded(ch) {
    if (!settings.excludedChars) settings.excludedChars = [];
    const i = settings.excludedChars.indexOf(ch);
    if (i >= 0) settings.excludedChars.splice(i, 1);
    else settings.excludedChars.push(ch);
    saveSettings();
  }

  function confOf(ch) {
    const s = charStats[ch] || { pressed: 0, incorrect: 0 };
    if (!s.pressed) return 1;
    return 1 - s.incorrect / s.pressed;
  }
  function parseSiteTestTimeMs() {
    // Monkeytype result time: "26.19s", "01:31.71", etc.
    const candidates = [];
    const sels = [
      '#result .group.time .bottom',
      '.group.time .bottom',
      '#result .time .bottom',
      '.result .group.time .bottom',
      '#result .group.time',
      '.group.time'
    ];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.textContent || '').replace(/time/i, '').trim();
        if (t) candidates.push(t);
      });
    }
    // Also scan any bottom element that looks like a duration
    document.querySelectorAll('#result .bottom, .result .bottom').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (/\d/.test(t) && (/s$/i.test(t) || /:/.test(t))) candidates.push(t);
    });

    function parseOne(t) {
      t = String(t).trim();
      let m = t.match(/(\d+(?:\.\d+)?)\s*s$/i);
      if (m) return Math.round(parseFloat(m[1]) * 1000);
      m = t.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
      if (m) {
        const h = m[1] ? parseInt(m[1], 10) : 0;
        const min = parseInt(m[2], 10);
        const s = parseFloat(m[3]);
        return Math.round(((h * 60 + min) * 60 + s) * 1000);
      }
      m = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
      if (m) return Math.round((parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000);
      return null;
    }

    for (const c of candidates) {
      const ms = parseOne(c);
      if (ms != null && ms > 0) return ms;
    }
    return null;
  }

  function computeTimingDebug(keys, digraphIntervals) {
    const list = digraphIntervals || [];
    // Prefer exact chain span (last endpoint - first start) over summing — avoids any double-count illusion
    let digraphSumMs = 0;
    if (list.length && list[0].t0 != null && list[list.length - 1].t1 != null) {
      const chain = list[list.length - 1].t1 - list[0].t0;
      const summed = list.reduce((a, t) => a + (t.interval || 0), 0);
      // If contiguous no-gap chain, sum == chain. If gaps, sum < chain. Use sum of intervals (real digraph time).
      digraphSumMs = summed;
    } else {
      digraphSumMs = list.reduce((a, t) => a + (t.interval || 0), 0);
    }
    const digraphCount = list.length;

    let keySpanMs = null;
    let allKeyGapsMs = 0;
    let keyGapCount = 0;
    let idleGapsMs = 0;
    let rawSumMs = 0; // every inter-key gap, no filters
    if (keys && keys.length >= 2) {
      keySpanMs = keys[keys.length - 1].ts - keys[0].ts;
      for (let i = 1; i < keys.length; i++) {
        const gap = keys[i].ts - keys[i - 1].ts;
        rawSumMs += Math.max(0, gap);
        if (gap < 20) continue;
        if (gap >= IDLE_MS) {
          idleGapsMs += gap;
          continue;
        }
        allKeyGapsMs += gap;
        keyGapCount++;
      }
    }
    let siteMs = parseSiteTestTimeMs();
    // Fallback: site time often matches keySpan when parse fails
    if (siteMs == null && keySpanMs != null) siteMs = keySpanMs;
    const ref = siteMs != null ? siteMs : keySpanMs;
    const coverage = ref ? Math.round((digraphSumMs / ref) * 1000) / 10 : null;
    return {
      digraphSumMs,
      digraphCount,
      keySpanMs,
      allKeyGapsMs,
      keyGapCount,
      idleGapsMs,
      rawSumMs,
      siteMs,
      coveragePct: coverage,
      digraphVsKeySpan: keySpanMs != null ? keySpanMs - digraphSumMs : null,
      digraphVsSite: siteMs != null ? siteMs - digraphSumMs : null,
      keySpanVsSite: siteMs != null && keySpanMs != null ? keySpanMs - siteMs : null
    };
  }

  function ensureChar(ch) {
    if (!charStats[ch]) charStats[ch] = { pressed: 0, incorrect: 0 };
    return charStats[ch];
  }

  function resetSession(reason) {
    // Allow next result to finalize (do not keep previous test's lock)
    if (reason === 'restart' || reason === 'new-test' || reason === 'auto' || reason === 'visible') {
      lastResultKey = '';
    }
    console.log('[KeyConf] resetSession', reason);
    session = {
      reason: reason || 'start',
      started: Date.now(),
      keys: [],
      lastTs: 0,
      slotTsLive: [],
      slotCharLive: [],
      slotPos: 0,
      typeBuf: [], // {ch, ts} final typed stream
      slotTs: Object.create(null),
      slotSig: Object.create(null),
      wordLens: Object.create(null),
      absWordBase: 0,
      firstWordEl: null,
      liveDigraphs: [],
      lastCommit: null,
      commitOrder: 0,
      absWordIdx: 0,
      lastActiveWordEl: null
    };
  }

  function isResultVisible() {
    const result = document.getElementById('result');
    if (!result) return false;
    if (result.classList.contains('hidden')) return false;
    // Monkeytype sets aria-hidden / class when not on result screen
    if (result.getAttribute('aria-hidden') === 'true') return false;
    const st = getComputedStyle(result);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const op = parseFloat(st.opacity);
    if (!isNaN(op) && op < 0.05) return false;
    // Words still visible → we are typing, not on result
    const words = document.getElementById('words');
    if (words && !words.classList.contains('hidden')) {
      const ws = getComputedStyle(words);
      if (ws.display !== 'none' && ws.visibility !== 'hidden') {
        const wr = words.getBoundingClientRect();
        if (wr.width > 20 && wr.height > 20) return false;
      }
    }
    const r = result.getBoundingClientRect();
    return r.width > 80 && r.height > 80;
  }

  function isTestActive() {
    // Zen: ignore spam
    try {
      if (document.querySelector('#words.zen, .pageTest.zen, body.zen')) return false;
    } catch (e) {}
    const words = document.getElementById('words') || document.querySelector('#words');
    const input = document.querySelector('#wordsInput');
    const wordsLive = !!(words && words.querySelector('.word') && words.offsetHeight > 0);
    // Result only when WPM score is painted
    let resultDone = false;
    try {
      const r = document.querySelector('#result');
      if (r && !r.classList.contains('hidden')) {
        const st = window.getComputedStyle(r);
        if (st.display !== 'none') {
          const wpmEl = r.querySelector('.group.wpm .bottom, .wpm .bottom');
          const wpmTxt = (wpmEl && wpmEl.textContent || '').trim();
          if (wpmTxt && /\d/.test(wpmTxt) && r.offsetHeight > 40) resultDone = true;
        }
      }
      if (document.getElementById('resultWordsHistory') && resultDone) resultDone = true;
    } catch (e) {}
    if (resultDone) return false;
    if (input && document.activeElement === input) return true;
    if (wordsLive) return true;
    if (session && session.started && !session._finalized && session.keys && session.keys.length) {
      const last = session.keys[session.keys.length - 1];
      if (last && Date.now() - last.ts < 4000) return true;
    }
    return false;
  }
  function getDomTypingPosition() {
    const words = [...document.querySelectorAll('#words .word')];
    if (!words.length) return null;
    let activeIdx = words.findIndex((w) => w.classList.contains('active'));
    if (activeIdx < 0) activeIdx = 0;
    const word = words[activeIdx];
    const letters = [...word.querySelectorAll('letter, .letter')];
    let done = 0;
    for (const l of letters) {
      const c = l.className || '';
      if (c.includes('correct') || c.includes('incorrect') || c.includes('corrected')) done++;
      else break;
    }
    // Track absolute word index: when the active word element changes, increment
    if (session) {
      if (session.lastActiveWordEl && word && session.lastActiveWordEl !== word) {
        // Moved to a new word element in the sliding DOM window
        session.absWordIdx = (session.absWordIdx || 0) + 1;
      }
      if (word) session.lastActiveWordEl = word;
    }
    const abs = session ? (session.absWordIdx || 0) : activeIdx;
    return { wordIdx: abs, letterIdx: done, letters, word, words, domIdx: activeIdx };
  }

  function recordLiveCommit(ch, ts) {
    if (!session) return;
    const pos = getDomTypingPosition();
    let wordIdx = pos ? pos.wordIdx : (session.absWordIdx || 0);
    let letterIdx = pos ? pos.letterIdx : 0;

    // Space: digraph ends on previous word's trailing space
    if (ch === ' ') {
      letterIdx = -1;
      // After space, next commits belong to next word
      // absWordIdx increments when active element changes; also bump on space
      // so we stay in sync even if DOM recycles the same element node
    }

    const prev = session.lastCommit;
    if (prev && ts - prev.ts >= 20 && ts - prev.ts < IDLE_MS) {
      session.liveDigraphs.push({
        prev: prev.ch,
        cur: ch,
        interval: ts - prev.ts,
        order: session.commitOrder++,
        wordIdx: ch === ' ' ? prev.wordIdx : wordIdx,
        letterIdx: letterIdx
      });
    }
    if (ch === ' ') {
      // Next letter commits are on the following word
      session.absWordIdx = (session.absWordIdx || 0) + 1;
      session.lastActiveWordEl = null; // force re-detect
      session.lastCommit = { ch: ' ', ts: ts, wordIdx: (session.absWordIdx || 1) - 1, letterIdx: -1 };
    } else {
      session.lastCommit = { ch: ch, ts: ts, wordIdx: wordIdx, letterIdx: letterIdx };
    }
  }

  function liveBackspace() {
    if (!session || !session.lastCommit) return;
    if (session.liveDigraphs.length) {
      const last = session.liveDigraphs[session.liveDigraphs.length - 1];
      if (last.cur === session.lastCommit.ch && last.wordIdx === session.lastCommit.wordIdx) {
        session.liveDigraphs.pop();
      }
    }
    // If we backspace over a space boundary, decrement abs word
    if (session.lastCommit.ch === ' ' && session.absWordIdx > 0) {
      session.absWordIdx--;
      session.lastActiveWordEl = null;
    }
    if (session.liveDigraphs.length) {
      const d = session.liveDigraphs[session.liveDigraphs.length - 1];
      session.lastCommit = {
        ch: d.cur,
        ts: session.lastTs,
        wordIdx: d.wordIdx,
        letterIdx: d.letterIdx
      };
    } else {
      session.lastCommit = null;
    }
  }


  function flatSlotIndex(absWord, letterIdx) {
    let flat = 0;
    for (let w = 0; w < absWord; w++) {
      const lens = (session.wordLens && session.wordLens[w] != null) ? session.wordLens[w] : 0;
      flat += lens + 1;
    }
    return flat + letterIdx;
  }

  function refreshAbsWordBase() {
    if (!session) return;
    const words = [...document.querySelectorAll('#words .word')];
    if (!words.length) return;
    if (!session.firstWordEl) {
      session.firstWordEl = words[0];
      if (session.absWordBase == null) session.absWordBase = 0;
      return;
    }
    if (!document.contains(session.firstWordEl)) {
      session.absWordBase = (session.absWordBase || 0) + 1;
      session.firstWordEl = words[0];
    } else if (words[0] !== session.firstWordEl) {
      session.firstWordEl = words[0];
    }
  }

  function syncSlotTimestampsFromDom() {
    if (!session) return;
    if (!session.slotTs) session.slotTs = Object.create(null);
    if (!session.slotSig) session.slotSig = Object.create(null);
    if (!session.wordLens) session.wordLens = Object.create(null);
    const now = Date.now();
    refreshAbsWordBase();
    const words = [...document.querySelectorAll('#words .word')];
    words.forEach((wordEl, domIdx) => {
      const absWord = (session.absWordBase || 0) + domIdx;
      const letters = [...wordEl.querySelectorAll('letter, .letter')];
      let lens = 0;
      for (const l of letters) {
        if (!(l.className || '').includes('extra')) lens++;
      }
      session.wordLens[absWord] = lens;
      letters.forEach((letterEl, li) => {
        const cls = letterEl.className || '';
        if (cls.includes('extra')) return;
        const filled = cls.includes('correct') || cls.includes('incorrect') || cls.includes('corrected');
        const flat = flatSlotIndex(absWord, li);
        if (filled) {
          const sig = (letterEl.textContent || '') + '|' + (cls.includes('incorrect') ? 'i' : 'c');
          if (session.slotSig[flat] !== sig) {
            session.slotTs[flat] = now;
            session.slotSig[flat] = sig;
          }
        } else {
          delete session.slotTs[flat];
          delete session.slotSig[flat];
        }
      });
      if (domIdx + 1 < words.length) {
        const spaceFlat = flatSlotIndex(absWord, lens);
        const nextWord = words[domIdx + 1];
        const nextFilled = [...nextWord.querySelectorAll('letter, .letter')].some((l) => {
          const c = l.className || '';
          return c.includes('correct') || c.includes('incorrect') || c.includes('corrected');
        });
        if (nextFilled && session.slotSig[spaceFlat] !== ' ') {
          session.slotTs[spaceFlat] = now;
          session.slotSig[spaceFlat] = ' ';
        }
      }
    });
  }

  function digraphsFromSlotTimestamps(expectedWords) {
    if (!session || !session.slotTs) return [];
    const flatChars = [];
    for (let wi = 0; wi < expectedWords.length; wi++) {
      for (const ch of expectedWords[wi]) flatChars.push({ ch: ch, wi: wi });
      if (wi < expectedWords.length - 1) flatChars.push({ ch: ' ', wi: wi });
    }
    const transitions = [];
    const keys = Object.keys(session.slotTs).map(Number).sort((a, b) => a - b);
    for (let k = 1; k < keys.length; k++) {
      const i0 = keys[k - 1];
      const i1 = keys[k];
      if (i1 !== i0 + 1) continue;
      const t0 = session.slotTs[i0];
      const t1 = session.slotTs[i1];
      if (t0 == null || t1 == null) continue;
      const interval = t1 - t0;
      if (interval < 1 || interval >= IDLE_MS) continue;
      const prev = flatChars[i0];
      const cur = flatChars[i1];
      if (!prev || !cur) continue;
      let letterIdx = -1;
      if (cur.ch !== ' ') {
        letterIdx = 0;
        for (let j = 0; j < i1; j++) {
          if (flatChars[j] && flatChars[j].wi === cur.wi && flatChars[j].ch !== ' ') letterIdx++;
        }
      }
      transitions.push({
        prev: prev.ch,
        cur: cur.ch,
        interval: interval,
        order: i1,
        wordIdx: cur.wi,
        letterIdx: letterIdx,
        prevTs: t0,
        curTs: t1
      });
    }
    return transitions;
  }

  function onKeyUpSlot(e) {
    if (!settings.enabled) return;
    if (!session) return;
    const midSession = session.started && !session._finalized && (session.keys||[]).length > 0;
    if (!isTestActive() && !midSession) return;
    requestAnimationFrame(() => {
      try { syncSlotTimestampsFromDom(); } catch (err) {}
    });
  }

  function onKeyDown(e) {
    if (!settings.enabled) return;
    // Allow recording when mid-session even if focus flickered
    const midSession = session && session.started && !session._finalized && (session.keys||[]).length > 0;
    if (!isTestActive() && !midSession) return;
    // Extra zen guard
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Quick restart: finalize once if result is showing, then always reset session
      const snap = session;
      const onResult = !!(document.getElementById('resultWordsHistory') ||
        document.querySelector('#result .group.wpm .bottom, .group.wpm .bottom'));
      if (onResult && snap && !snap._finalized &&
          ((snap.keys && snap.keys.length) || (snap.typeBuf && snap.typeBuf.length))) {
        try {
          lastResultKey = '';
          window.__kcFinalizePending = null;
          finalizeTest('enter-restart');
        } catch (err) { console.warn('[KeyConf] enter finalize', err); }
      }
      setTimeout(() => {
        if (session === snap || (session && snap && session.started === snap.started)) {
          resetSession('restart');
        }
      }, onResult ? 300 : 50);
      return;
    }
    if (['Shift','Control','Alt','Meta','CapsLock','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
    // New test after a finished one (restart via UI, not only Enter) — must start clean
    if (!session || session._finalized || (session._resultSeen && !isResultVisible())) {
      resetSession(session && session._finalized ? 'new-test' : 'auto');
      lastResultKey = '';
    }
    const now = Date.now();
    let interval = 0;
    if (session.lastTs && now - session.lastTs < IDLE_MS) interval = now - session.lastTs;

    if (e.key === 'Backspace') {
      // Find last char key — only undo live commit if that char was CORRECT.
      // Wrong keys never advanced lastCommit; undoing would steal the previous correct letter.
      let lastChar = null;
      for (let i = session.keys.length - 1; i >= 0; i--) {
        const k = session.keys[i];
        if (k.type === 'char') { lastChar = k; break; }
        if (k.type === 'backspace' || k.type === 'ctrlBackspace') break;
      }
      session.keys.push({ ts: now, type: (e.ctrlKey || e.metaKey) ? 'ctrlBackspace' : 'backspace', key: 'Backspace', interval });

      if (!session.typeBuf) session.typeBuf = [];
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // pop until after previous space
        if (session.typeBuf.length) session.typeBuf.pop();
        while (session.typeBuf.length && session.typeBuf[session.typeBuf.length - 1].ch !== ' ') {
          session.typeBuf.pop();
        }
      } else {
        if (session.typeBuf.length) session.typeBuf.pop();
      }
      session.slotTsLive = session.typeBuf.map(x => x.ts);
      session.slotCharLive = session.typeBuf.map(x => x.ch);
      session.slotPos = session.typeBuf.length;      session.lastTs = now;
      if (e.ctrlKey || e.metaKey) {
        // ctrl+backspace: drop commits back to previous space
        if (session.commitStack && session.commitStack.length) {
          while (session.commitStack.length) {
            const top = session.commitStack[session.commitStack.length - 1];
            if (top.ch === ' ') break;
            liveBackspace();
          }
        } else {
          session.lastCommit = null;
        }
      } else if (lastChar && !lastChar.wrong) {
        liveBackspace();
      }
      // if lastChar was wrong: lastCommit stays on last correct letter (includes correction time in next digraph)
      return;
    }
    if (e.key.length === 1) {
      // Detect expected letter from active word DOM (before MT updates)
      let expected = null;
      let wordIdx = -1;
      let letterIdx = -1;
      try {
        const activeWord = document.querySelector('#words .word.active');
        if (activeWord) {
          const words = [...document.querySelectorAll('#words .word')];
          wordIdx = words.indexOf(activeWord);
          const letters = [...activeWord.querySelectorAll('letter, .letter')];
          letterIdx = 0;
          for (let i = 0; i < letters.length; i++) {
            const cl = letters[i].className || '';
            // Stay on first non-correct letter (including incorrect — user is still fixing it)
            if (cl.includes('correct')) letterIdx = i + 1;
            else if (cl.includes('extra')) letterIdx = i + 1;
            else break; // bare or incorrect = current expected slot
          }
          if (letterIdx < letters.length) {
            expected = letters[letterIdx].textContent || '';
          } else {
            expected = ' ';
          }
        }
      } catch (err) {}

      const wrong = expected != null && e.key !== expected;
      if (!session.keys.length) {
        console.log('[KeyConf] first key recorded', e.key, 'testActive=', isTestActive(), 'resultVis=', isResultVisible());
      }
      session.keys.push({
        ts: now,
        type: 'char',
        key: e.key,
        interval,
        expected: expected,
        wrong: !!wrong,
        wordIdx,
        letterIdx
      });
      session.lastTs = now;
      // Typed-buffer model: every char key appends; backspace pops.
      // Final buffer = characters left on the page, each with last-write PC time.
      if (!session.typeBuf) session.typeBuf = [];
      session.typeBuf.push({ ch: e.key, ts: now });
      // Keep slotTsLive in sync with typeBuf for digraph helpers
      session.slotTsLive = session.typeBuf.map(x => x.ts);
      session.slotCharLive = session.typeBuf.map(x => x.ch);
      session.slotPos = session.typeBuf.length;
      if (!wrong && expected != null) {
        recordLiveCommit(e.key, now);
      } else if (!wrong && expected == null && e.key === ' ') {
        recordLiveCommit(' ', now);
      }
      requestAnimationFrame(() => { try { syncSlotTimestampsFromDom(); } catch (err) {} });
    }
  }

  function getExpectedWordsFromResult() {
    const roots = [
      document.getElementById('resultWordsHistory'),
      document.querySelector('#resultWordsHistory'),
      document.querySelector('.resultWordsHistory'),
      document.querySelector('#result .words'),
      document.querySelector('#resultWordsHistory .words')
    ].filter(Boolean);
    const words = [];
    const seen = new Set();
    for (const hist of roots) {
      hist.querySelectorAll('.word').forEach((w) => {
        let s = '';
        w.querySelectorAll('letter, .letter').forEach((l) => {
          if (l.classList.contains('extra')) return;
          s += l.textContent || '';
        });
        if (!s) s = (w.textContent || '').replace(/\s/g, '');
        if (s && !seen.has(s + '@' + words.length)) {
          seen.add(s + '@' + words.length);
          words.push(s);
        }
      });
      if (words.length > 5) break;
    }
    return words;
  }

  function reconstructTypedChars(keys) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.type === 'char') out.push({ key: k.key, interval: k.interval, keyIndex: i });
      else if (k.type === 'backspace') { if (out.length) out.pop(); }
      else if (k.type === 'ctrlBackspace') {
        while (out.length && out[out.length - 1].key !== ' ') out.pop();
        if (out.length && out[out.length - 1].key === ' ') out.pop();
      }
    }
    return out;
  }

  // First-mismatch only per word
  /**
   * Commit-based digraph timings:
   * For expected char i, commitTs = last moment it was typed correctly and not
   * later deleted. Digraph interval = commitTs[i] - commitTs[i-1] (includes all
   * mis-types / backspaces on the current letter).
   * Words that still have uncorrected errors contribute NO digraphs (time is
   * pure waste for best-WPM replacement purposes).
   */
  /**
   * Commit-based digraph timings with desync recovery.
   * - Matching char advances and stamps commitTs
   * - Backspace retreats
   * - Space while not at word-end: mark rest of word failed, skip to next word
   *   (handles Monkeytype "continue with errors" without full correction)
   * - Only fully-correct words emit digraphs; interval includes correction time
   */



  function ensureExpectedFlatCaptured() {
    if (!session || session.expectedFlatCaptured) return;
    const words = [];
    document.querySelectorAll('#words .word').forEach((w) => {
      let s = '';
      w.querySelectorAll('letter, .letter').forEach((l) => {
        if ((l.className || '').includes('extra')) return;
        s += l.textContent || '';
      });
      if (s) words.push(s);
    });
    // May be incomplete (sliding window) — still better than nothing; finalize merges with result words
    const flat = [];
    for (let wi = 0; wi < words.length; wi++) {
      for (const ch of words[wi]) flat.push(ch);
      if (wi < words.length - 1) flat.push(' ');
    }
    session.expectedFlatLive = flat;
    session.expectedFlatCaptured = true;
  }
  function liveStampSlot(ch, ts, advance) {
    if (!session) return;
    if (!session.slotTsLive) session.slotTsLive = [];
    if (!session.slotCharLive) session.slotCharLive = [];
    if (session.slotPos == null) session.slotPos = 0;
    const i = session.slotPos;
    session.slotTsLive[i] = ts;
    session.slotCharLive[i] = ch;
    if (advance) session.slotPos = i + 1;
  }

  function liveBackspaceSlot() {
    if (!session || session.slotPos == null || session.slotPos <= 0) return;
    session.slotPos -= 1;
    session.slotTsLive[session.slotPos] = null;
    session.slotCharLive[session.slotPos] = null;
  }

  function liveCtrlBackspaceSlots() {
    if (!session || !session.slotPos) return;
    while (session.slotPos > 0) {
      const prev = session.slotCharLive[session.slotPos - 1];
      session.slotPos -= 1;
      session.slotTsLive[session.slotPos] = null;
      session.slotCharLive[session.slotPos] = null;
      if (prev === ' ') break;
    }
  }

  /** Final chars on page → exact PC-time deltas (s@100,c@102 → 2ms). */

  function buildSlotDebugTable(expectedWords) {
    const buf = (session && session.typeBuf) ? session.typeBuf : [];
    const expected = [];
    for (let wi = 0; wi < (expectedWords || []).length; wi++) {
      for (const ch of expectedWords[wi]) expected.push(ch);
      if (wi < expectedWords.length - 1) expected.push(' ');
    }

    // If typeBuf empty, try rebuild from keys as typed stream (no expected align)
    let rowsSrc = buf;
    if (rowsSrc.length < 2 && session && session.keys) {
      const rebuilt = [];
      for (const k of session.keys) {
        if (k.type === 'char') rebuilt.push({ ch: k.key, ts: k.ts });
        else if (k.type === 'backspace') { if (rebuilt.length) rebuilt.pop(); }
        else if (k.type === 'ctrlBackspace') {
          if (rebuilt.length) rebuilt.pop();
          while (rebuilt.length && rebuilt[rebuilt.length - 1].ch !== ' ') rebuilt.pop();
        }
      }
      rowsSrc = rebuilt;
    }

    const rows = [];
    for (let i = 0; i < rowsSrc.length; i++) {
      const t = rowsSrc[i].ts;
      const prevT = i > 0 ? rowsSrc[i - 1].ts : null;
      const delta = prevT != null ? (t - prevT) : null;
      const typed = rowsSrc[i].ch;
      const exp = i < expected.length ? expected[i] : '';
      rows.push({
        idx: i,
        exp: exp === ' ' ? 'spc' : exp,
        typed: typed === ' ' ? 'spc' : typed,
        lastMs: t,
        deltaMs: delta
      });
    }
    return rows;
  }

  function exportSlotDebug() {
    const last = window.__mtKeyConfLast;
    if (!last || !last.slotDebug || !last.slotDebug.length) {
      alert('No slot debug data yet — finish a test first.');
      return;
    }
    const rows = last.slotDebug;
    const NL = String.fromCharCode(10);
    const TB = String.fromCharCode(9);
    const lines = [];
    // Find first exp/typed mismatch (after mistakes typeBuf index ≠ expected index)
    let firstDesync = -1;
    for (const r of rows) {
      const e = r.exp === 'spc' ? ' ' : r.exp;
      const t = r.typed === 'spc' ? ' ' : r.typed;
      if (e && t && e !== t) { firstDesync = r.idx; break; }
    }
    lines.push('Key Confidence — slot debug (last test)');
    lines.push('typeBuf rows=' + rows.length + (firstDesync >= 0 ? ('  FIRST_DESYNC_idx=' + firstDesync + ' (after errors, typed stream shifts vs expected)') : '  exp/typed aligned'));
    lines.push('Note: typed = actual keystream; exp = quote at same index. Timings follow typed. After a wrong key, columns desync — that is expected.');
    lines.push(['idx','exp','typed','lastMs','deltaMs'].join(TB));
    let sumDelta = 0;
    let firstMs = null;
    let lastMsVal = null;
    let withTime = 0;
    for (const r of rows) {
      const d = (typeof r.deltaMs === 'number' && isFinite(r.deltaMs)) ? r.deltaMs : null;
      lines.push([r.idx, r.exp, r.typed,
        r.lastMs != null ? r.lastMs : '',
        d != null ? d : ''].join(TB));
      if (d != null) sumDelta += d;
      if (r.lastMs != null) {
        withTime++;
        if (firstMs == null) firstMs = r.lastMs;
        lastMsVal = r.lastMs;
      }
    }
    const span = (firstMs != null && lastMsVal != null) ? (lastMsVal - firstMs) : null;
    lines.push('');
    lines.push('--- totals ---');
    lines.push('slots_with_time=' + withTime + ' / ' + rows.length);
    lines.push('sum_deltaMs=' + sumDelta);
    lines.push('first_lastMs=' + (firstMs != null ? firstMs : ''));
    lines.push('last_lastMs=' + (lastMsVal != null ? lastMsVal : ''));
    lines.push('last_minus_first=' + (span != null ? span : ''));
    lines.push('sum_delta_minus_span=' + (span != null ? (sumDelta - span) : ''));
    if (last.timing) {
      lines.push('keySpanMs=' + last.timing.keySpanMs + ' siteMs=' + last.timing.siteMs + ' digraphSumMs=' + last.timing.digraphSumMs);
    }
    const blob = new Blob([lines.join(NL)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'keyconf-slot-debug.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function flatIndexToWordLetter(flatIdx, expectedWords) {
    if (!expectedWords || !expectedWords.length) {
      return { wordIdx: 0, letterIdx: flatIdx };
    }
    let flat = 0;
    for (let wi = 0; wi < expectedWords.length; wi++) {
      const word = expectedWords[wi];
      for (let li = 0; li < word.length; li++) {
        if (flat === flatIdx) return { wordIdx: wi, letterIdx: li };
        flat++;
      }
      if (wi < expectedWords.length - 1) {
        if (flat === flatIdx) return { wordIdx: wi, letterIdx: -1 };
        flat++;
      }
    }
    return { wordIdx: Math.max(0, expectedWords.length - 1), letterIdx: 0 };
  }

  function flattenExpected(expectedWords) {
    const expected = [];
    for (let wi = 0; wi < (expectedWords || []).length; wi++) {
      for (const ch of expectedWords[wi]) expected.push(ch);
      if (wi < expectedWords.length - 1) expected.push(' ');
    }
    return expected;
  }

  /** Digraphs from typeBuf timestamps (same as slot-debug export) + expected labels */
  function digraphsFromLiveSlots(expectedWords) {
    const buf = (session && session.typeBuf) ? session.typeBuf : [];
    const src = [];
    if (buf.length >= 2) {
      for (let i = 0; i < buf.length; i++) src.push({ ch: buf[i].ch, ts: buf[i].ts });
    } else {
      const ts = (session && session.slotTsLive) || [];
      const ch = (session && session.slotCharLive) || [];
      for (let i = 0; i < ts.length; i++) {
        if (ts[i] != null) src.push({ ch: ch[i] || '?', ts: ts[i] });
      }
    }
    if (src.length < 2) return [];

    const expected = flattenExpected(expectedWords);
    // Prefer expected labels when lengths match (correct final text)
    const useExp = expected.length === src.length;
    const out = [];
    for (let i = 1; i < src.length; i++) {
      const interval = src[i].ts - src[i - 1].ts;
      if (interval < 1 || interval >= IDLE_MS) continue;
      const prev = useExp ? expected[i - 1] : src[i - 1].ch;
      const cur = useExp ? expected[i] : src[i].ch;
      const pos = flatIndexToWordLetter(i, expectedWords);
      out.push({
        prev: prev,
        cur: cur,
        pair: (prev === ' ' ? 'spc' : prev) + '\u2192' + (cur === ' ' ? 'spc' : cur),
        interval: interval,
        order: i,
        wordIdx: pos.wordIdx,
        letterIdx: pos.letterIdx,
        isPause: interval > MAX_DIGRAPH_MS,
        t0: src[i - 1].ts,
        t1: src[i].ts
      });
    }
    return out;
  }


  function digraphsFromKeyLog(expectedWords, keys) {
    // Exact model:
    // 1) Replay keys against expected slots
    // 2) slotTs[i] = PC time (ms) of the LAST write that filled slot i
    // 3) digraph i-1→i = slotTs[i] - slotTs[i-1]  (only if both set and ordered)
    // This partitions [firstFilled, lastFilled] exactly once — sum ≤ keySpan.
    if (!keys || !keys.length || !expectedWords || !expectedWords.length) return [];

    const expected = [];
    for (let wi = 0; wi < expectedWords.length; wi++) {
      for (const ch of expectedWords[wi]) expected.push({ ch: ch, wi: wi });
      if (wi < expectedWords.length - 1) expected.push({ ch: ' ', wi: wi });
    }

    const slotTs = new Array(expected.length).fill(null);
    let pos = 0;

    for (const k of keys) {
      if (k.type === 'char') {
        if (k.key === ' ') {
          if (pos < expected.length && expected[pos].ch === ' ') {
            slotTs[pos] = k.ts;
            pos++;
          } else {
            // spaced past unfinished word: stamp remaining letters+space with this space time
            while (pos < expected.length && expected[pos].ch !== ' ') {
              slotTs[pos] = k.ts;
              pos++;
            }
            if (pos < expected.length && expected[pos].ch === ' ') {
              slotTs[pos] = k.ts;
              pos++;
            }
          }
          continue;
        }
        if (pos >= expected.length) continue;
        // Any key into current slot updates last-write time (correct or wrong)
        if (k.key === expected[pos].ch) {
          slotTs[pos] = k.ts;
          pos++;
        } else {
          slotTs[pos] = k.ts; // wrong — stay on slot until backspace or correct
        }
      } else if (k.type === 'backspace') {
        if (pos > 0) {
          pos--;
          slotTs[pos] = null; // emptied
        }
      } else if (k.type === 'ctrlBackspace') {
        if (pos <= 0) continue;
        while (pos > 0 && expected[pos - 1].ch !== ' ') {
          pos--;
          slotTs[pos] = null;
        }
      }
    }

    const out = [];
    for (let i = 1; i < expected.length; i++) {
      const t0 = slotTs[i - 1];
      const t1 = slotTs[i];
      if (t0 == null || t1 == null) continue;
      const interval = t1 - t0;
      // Non-monotonic (shouldn't happen with backspace-clear) — skip
      if (interval < 1 || interval >= IDLE_MS) continue;
      const prev = expected[i - 1];
      const cur = expected[i];
      let letterIdx = -1;
      if (cur.ch !== ' ') {
        letterIdx = 0;
        for (let j = 0; j < i; j++) {
          if (expected[j].wi === cur.wi && expected[j].ch !== ' ') letterIdx++;
        }
      }
      out.push({
        prev: prev.ch,
        cur: cur.ch,
        interval: interval,
        order: i,
        wordIdx: cur.wi,
        letterIdx: letterIdx,
        isPause: interval > MAX_DIGRAPH_MS,
        t0: t0,
        t1: t1
      });
    }
    return out;
  }

  function computeCommitDigraphs(expectedWords, keys) {
    const expected = [];
    for (let wi = 0; wi < expectedWords.length; wi++) {
      for (const ch of expectedWords[wi]) expected.push({ ch: ch, wi: wi });
      if (wi < expectedWords.length - 1) expected.push({ ch: ' ', wi: wi });
    }
    if (!expected.length || !keys.length) return [];

    const commitTs = new Array(expected.length).fill(null);
    let pos = 0;

    function skipRestOfWord(ts) {
      if (pos >= expected.length) return;
      while (pos < expected.length && expected[pos].ch !== ' ') {
        // stamp skipped letters with skip time so timeline stays continuous
        if (commitTs[pos] == null) commitTs[pos] = ts;
        pos++;
      }
      if (pos < expected.length && expected[pos].ch === ' ') {
        if (commitTs[pos] == null) commitTs[pos] = ts;
        pos++;
      }
    }

    for (const k of keys) {
      if (k.type === 'char') {
        if (k.key === ' ') {
          if (pos < expected.length && expected[pos].ch === ' ') {
            commitTs[pos] = k.ts;
            pos++;
          } else {
            skipRestOfWord(k.ts);
          }
          continue;
        }
        if (pos < expected.length && k.key === expected[pos].ch) {
          commitTs[pos] = k.ts;
          pos++;
        }
      } else if (k.type === 'backspace') {
        if (pos > 0) {
          pos--;
          commitTs[pos] = null;
        }
      } else if (k.type === 'ctrlBackspace') {
        if (pos <= 0) continue;
        while (pos > 0 && expected[pos - 1].ch !== ' ') {
          pos--;
          commitTs[pos] = null;
        }
      }
    }

    // If test ended mid-word, stamp remaining with last key time (keeps continuity)
    const lastTs = keys[keys.length - 1].ts;
    for (let i = 0; i < expected.length; i++) {
      if (commitTs[i] == null && i > 0 && commitTs[i - 1] != null) {
        // don't auto-fill trailing untyped — only fill holes between commits later
      }
    }

    // Build continuous digraph chain over positions that have timestamps
    // Fill holes: if a gap of nulls sits between two commits, the time belongs to the digraph
    // crossing the gap (already true if we only emit consecutive non-null pairs... holes break chain)
    // Forward-fill nulls that sit between two committed positions with next commit time
    for (let i = 0; i < expected.length; i++) {
      if (commitTs[i] != null) continue;
      let next = -1;
      for (let j = i + 1; j < expected.length; j++) {
        if (commitTs[j] != null) { next = j; break; }
      }
      if (next < 0) break;
      // only fill if there was a previous commit (otherwise leading untyped)
      let prev = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (commitTs[j] != null) { prev = j; break; }
      }
      if (prev >= 0) {
        commitTs[i] = commitTs[next]; // zero-width until next; time sits on prev→next jumps
      }
    }

    const transitions = [];
    for (let i = 1; i < expected.length; i++) {
      if (commitTs[i] == null || commitTs[i - 1] == null) continue;
      const interval = commitTs[i] - commitTs[i - 1];
      if (interval < 0) continue;
      // allow 0ms (skipped same-ts) to be dropped; keep everything else including long corrections
      if (interval < 20) continue;
      if (interval >= IDLE_MS) continue;
      const prev = expected[i - 1];
      const cur = expected[i];
      let letterIdx = -1;
      if (cur.ch !== ' ') {
        letterIdx = 0;
        for (let j = 0; j < i; j++) {
          if (expected[j].wi === cur.wi && expected[j].ch !== ' ') letterIdx++;
        }
      }
      transitions.push({
        prev: prev.ch,
        cur: cur.ch,
        interval: interval,
        order: i,
        wordIdx: cur.wi,
        letterIdx: letterIdx,
        prevTs: commitTs[i - 1],
        curTs: commitTs[i]
      });
    }
    return transitions;
  }

  function analyzeAlignment(expectedWords, typedStream) {
    const incorrectKeyIndexes = new Set();
    const correctTransitions = [];
    let ti = 0;

    for (let wi = 0; wi < expectedWords.length; wi++) {
      const expWord = expectedWords[wi];
      const typedWord = [];
      while (ti < typedStream.length && typedStream[ti].key !== ' ') {
        typedWord.push(typedStream[ti]);
        ti++;
      }
      if (ti < typedStream.length && typedStream[ti].key === ' ') {
        const spaceTok = typedStream[ti];
        if (typedWord.length) {
          correctTransitions.push({ prev: typedWord[typedWord.length - 1].key, cur: ' ', interval: spaceTok.interval });
        }
        ti++;
      }

      let firstErr = -1;
      const len = Math.max(expWord.length, typedWord.length);
      for (let i = 0; i < len; i++) {
        const e = expWord[i];
        const t = typedWord[i];
        if (!t || !e || t.key !== e) { firstErr = i; break; }
      }
      if (firstErr >= 0 && typedWord[firstErr]) {
        incorrectKeyIndexes.add(typedWord[firstErr].keyIndex);
      }

      const matchLen = firstErr < 0
        ? Math.min(typedWord.length, expWord.length)
        : Math.min(firstErr, typedWord.length, expWord.length);
      for (let i = 0; i < matchLen; i++) {
        if (typedWord[i].key !== expWord[i]) break;
        const prevKey = i === 0 ? (wi === 0 ? null : ' ') : typedWord[i - 1].key;
        if (prevKey != null) {
          correctTransitions.push({ prev: prevKey, cur: typedWord[i].key, interval: typedWord[i].interval });
        }
      }
    }
    return { incorrectKeyIndexes, correctTransitions };
  }

  function finalizeTest(resultKey) {
    if (!settings.enabled) return;
    if (!session) {
      console.warn('[KeyConf] finalize: no session');
      return;
    }
    // Prevent UI from showing the previous test while we recompute
    // (only clear if this is a real new finalize, not a no-op)
    if (!session._finalized) {
      try { window.__mtKeyConfLast = { at: new Date().toISOString(), pending: true }; } catch (e) {}
    }
    console.log('[KeyConf] finalize start keys=', (session.keys||[]).length,
      'typeBuf=', (session.typeBuf||[]).length, 'finalized=', !!session._finalized);
    if (!session.keys) session.keys = [];
    if (!session.slotTs) session.slotTs = Object.create(null);
    try { syncSlotTimestampsFromDom(); } catch (e) {}

    let expectedWords = getExpectedWordsFromResult();
    if (!expectedWords.length) {
      try {
        document.querySelectorAll('#words .word').forEach((w) => {
          let s = '';
          w.querySelectorAll('letter, .letter').forEach((l) => {
            if (l.classList.contains('extra')) return;
            s += l.textContent || '';
          });
          if (s) expectedWords.push(s);
        });
      } catch (e) {}
    }
    if (!expectedWords.length) {
      console.warn('[KeyConf] no result words found — will retry');
      try { refreshPanel(); } catch (e) {}
      return;
    }
    // Rebuild keys from typeBuf if keydown recording failed mid-test
    if ((!session.keys || !session.keys.length) && session.typeBuf && session.typeBuf.length) {
      session.keys = session.typeBuf.map((x) => ({ ts: x.ts, type: 'char', key: x.ch }));
      console.warn('[KeyConf] rebuilt keys from typeBuf', session.keys.length);
    }
    if (!session.keys.length && Object.keys(session.slotTs || {}).length < 2 &&
        !(session.slotTsLive && session.slotTsLive.length >= 2)) {
      console.warn('[KeyConf] no keys/slots yet — will retry');
      try { refreshPanel(); } catch (e) {}
      return;
    }
    // Prevent any second finalize on same session from re-doing work / multi-counting
    if (session._finalized) {
      try { refreshPanel(); } catch (e) {}
      return;
    }
    // NOTE: set _finalized only after successful completion (end of function)
    if (resultKey) lastResultKey = resultKey;

    const typedStream = reconstructTypedChars(session.keys);
    const { incorrectKeyIndexes, correctTransitions } = analyzeAlignment(expectedWords, typedStream);

    // Stats ONCE: pressed = chars in completed quote; errors = live wrong flags only
    const expectedFlat = [];
    for (let wi = 0; wi < expectedWords.length; wi++) {
      for (const ch of expectedWords[wi]) expectedFlat.push(ch);
      if (wi < expectedWords.length - 1) expectedFlat.push(' ');
    }
    const liveErrorKeys = [];
    if (!session._statsApplied) {
      session._statsApplied = true;
      // Pressed: once per character occurrence in the finished quote (not key-log replay)
      for (const ch of expectedFlat) {
        ensureChar(ch).pressed++;
      }
      // Errors: only keys marked wrong live (DOM expected at keydown), deduped by slot
      const seenSlot = new Set();
      for (const k of session.keys) {
        if (k.type !== 'char' || !k.wrong) continue;
        if (k.expected == null || k.expected === '') continue;
        // Prefer absolute-ish slot id from live DOM indices + expected char
        const slotId = String(k.expected) + '|' + String(k.wordIdx) + '|' + String(k.letterIdx);
        if (seenSlot.has(slotId)) continue;
        seenSlot.add(slotId);
        ensureChar(k.expected).incorrect++;
        liveErrorKeys.push({ typed: k.key, expected: k.expected, wordIdx: k.wordIdx, letterIdx: k.letterIdx });
      }
      saveChars();
    }



    // LIVE digraphs have correct intervals (final-commit timing) but wrong DOM wordIdx.
    // SIMULATED digraphs have correct wordIdx/letterIdx from expected text.
    // Align live → expected positions by matching prev→cur pairs in order.
    // Digraphs: slot timestamps + key-log simulation (never throw)
    // Digraphs from typeBuf (same timestamps as slot-debug) — full N-1 digraphs
    let commitTransitions = [];
    try {
      commitTransitions = digraphsFromLiveSlots(expectedWords) || [];
    } catch (e) {
      console.warn('[KeyConf] digraphsFromLiveSlots', e);
    }
    if (!commitTransitions.length) {
      try {
        commitTransitions = digraphsFromKeyLog(expectedWords, session.keys) || [];
      } catch (e) {
        console.warn('[KeyConf] digraphsFromKeyLog', e);
        try { commitTransitions = computeCommitDigraphs(expectedWords, session.keys) || []; } catch (e2) {}
      }
    }
    console.log('[KeyConf] digraphs', commitTransitions.length, 'from', (session.typeBuf||[]).length, 'slots');
    let updatedIntervals = 0;
    const thisTestIntervals = [];
    const thisTestByPair = {};
    for (const tr of commitTransitions) {
      if (!tr.interval || tr.interval < 1 || tr.interval >= IDLE_MS) continue;
      const pair = (tr.pair != null) ? tr.pair : (tr.prev + '→' + tr.cur);
      const isLucky = !!(tr.isLucky || tr.interval < MIN_DIGRAPH_MS);
      const isPause = !!(tr.isPause || tr.interval > MAX_DIGRAPH_MS);
      const historical = intervalBest[pair] != null ? intervalBest[pair] : null;
      thisTestIntervals.push({
        prev: tr.prev, cur: tr.cur, interval: tr.interval, pair, historical,
        order: tr.order, wordIdx: tr.wordIdx, letterIdx: tr.letterIdx,
        isPause: isPause,
        isLucky: isLucky
      });
      // Pauses and lucky presses must not set in-test best or DB records
      if (!isPause && !isLucky) {
        if (!thisTestByPair[pair] || tr.interval < thisTestByPair[pair]) {
          thisTestByPair[pair] = tr.interval;
        }
      }
    }
    for (const [pair, ms] of Object.entries(thisTestByPair)) {
      if (ms < MIN_DIGRAPH_MS || ms > MAX_DIGRAPH_MS) continue; // no lucky / no pause
      if (intervalBest[pair] == null || ms < intervalBest[pair]) {
        intervalBest[pair] = ms;
        updatedIntervals++;
      }
    }
    saveIntervals();

    const fullText = expectedWords.join(' ');
    // Prefer Monkeytype-visible char count; fallback to expected length
    let mtChars = fullText.length;
    try {
      const chEl = document.querySelector('.group.cf .top, .group.characters .bottom, .characters .bottom');
      // characters line like "66/0/0/0" — take first number
      const raw = (document.querySelector('.group.cf .bottom, .group.characters .bottom') || {}).textContent || '';
      const m = raw.match(/(\d+)/);
      if (m) mtChars = parseInt(m[1], 10) || mtChars;
    } catch (e) {}

    const keysSnapshot = session.keys.slice();
    // Intervals are REAL final-commit times only — never artificially scaled.
    // gap(site − digraphs) > 0 means untyped/skipped segments or AFK, not faked coverage.
    const bestWpm = theoreticalBestWpmFromTest(
      thisTestIntervals,
      thisTestByPair,
      keysSnapshot,
      mtChars
    );
    const timingDebug = computeTimingDebug(keysSnapshot, thisTestIntervals);

    const slotDebug = buildSlotDebugTable(expectedWords);
    window.__mtKeyConfLast = {
      liveSlots: (session.slotTsLive || []).length,
      livePos: session.slotPos,
      slotDebug: slotDebug,
      at: new Date().toISOString(),
      expectedWords: expectedWords.length,
      typedChars: typedStream.length,
      mtChars,
      liveErrors: liveErrorKeys.slice(),
      liveErrorCount: liveErrorKeys.length,
      alignMistakes: incorrectKeyIndexes.size,
      intervalsRecorded: thisTestIntervals.length,
      commitTransitions: commitTransitions.length,
      liveDigraphs: (session.liveDigraphs || []).length,
      slotDigraphs: (commitTransitions || []).length,
      slotStampCount: Object.keys(session.slotTs || {}).length,
      simulatedDigraphs: 0,
      timing: timingDebug,
      // top 15 slowest digraphs this test (for debugging long pauses)
      slowestDigraphs: thisTestIntervals.slice().sort((a,b) => b.interval - a.interval).slice(0, 15).map((t) => ({
        pair: t.pair, ms: t.interval, word: t.wordIdx, letter: t.letterIdx
      })),
      uniqueDigraphs: Object.keys(thisTestByPair).length,
      intervalsUpdated: updatedIntervals,
      digraphsInDb: Object.keys(intervalBest).length,
      bestPossibleWpm: bestWpm,
      replacements: (bestWpm && bestWpm.replacements) || []
    };
    if (!window.__mtKeyConfLast) {
      window.__mtKeyConfLast = { at: new Date().toISOString(), partial: true };
    }
    if (resultKey) {
      window.__mtKeyConfLast.resultKey = resultKey;
      lastResultKey = resultKey;
    }
    // Always expose replacements for WPM debug panel
    if (bestWpm && bestWpm.replacements) {
      window.__mtKeyConfLast.replacements = bestWpm.replacements;
      window.__mtKeyConfLast.bestPossibleWpm = bestWpm;
    } else if (!window.__mtKeyConfLast.replacements) {
      window.__mtKeyConfLast.replacements = [];
    }
    session._finalized = true; session._resultSeen = true;
    try { showBestWpm(bestWpm || null); } catch (e) { console.warn(e); }
    try { refreshPanel(); } catch (e) {}
    // Always rebuild WPM replacements (open or closed) so reopening shows latest test
    try { refreshWpmDebugBox(true); } catch (e) {}
    // Refresh WPM replacements panel if user left it open
    try {
      const box = document.getElementById('mt-keyconf-wpm-debug');
      if (box && box.style.display !== 'none' && box.offsetParent != null) {
        refreshWpmDebugBox();
      }
    } catch (e) {}
    console.log('[KeyConf] finalized', window.__mtKeyConfLast);
  }

  /**
   * Realistic theoretical WPM for THIS test:
   * - Walk the correct transitions that actually happened this test
   * - For each, use min(thisTestInterval, personalBest) when a best exists
   * - Do NOT invent 80ms for unknown digraphs
   * - WPM from sum of those intervals over the characters covered
   */
  /**
   * Theoretical best WPM grounded in REAL test duration:
   *   realMs = lastKey.ts - firstKey.ts (same span Monkeytype uses)
   *   For each correct digraph occurrence, if a better time exists
   *   (min of in-test best for that pair + historical PB), credit the savings:
   *     saved += occurrenceInterval - betterInterval
   *   theoreticalMs = realMs - saved
   *   WPM = (charCount/5) / (ms/60000)
   * This way 15 slightly faster digraphs only shave a little off 13.65s —
   * you will NOT jump from 58 to 72.
   */
  function theoreticalBestWpmFromTest(thisTestIntervals, thisTestByPair, sessionKeys, charCount) {
    if (!sessionKeys || sessionKeys.length < 2) return null;

    const firstTs = Number(sessionKeys[0].ts) || 0;
    const lastTs = Number(sessionKeys[sessionKeys.length - 1].ts) || 0;
    if (!firstTs || !lastTs || lastTs <= firstTs) return null;
    // Always use real key-span / site time — never digraph sum (can over/under count)
    let realMs = Math.max(1, lastTs - firstTs);
    const siteMs = parseSiteTestTimeMs();
    if (siteMs != null && siteMs > 0) realMs = siteMs;

    let saved = 0;
    let improved = 0;
    const replacements = [];
    // Deduplicate by order (alignment can rarely double-match)
    const seenOrder = new Set();
    for (let ti = 0; ti < thisTestIntervals.length; ti++) {
      const tr = thisTestIntervals[ti];
      const ord = tr.order != null ? tr.order : ti;
      if (seenOrder.has(ord)) continue;
      seenOrder.add(ord);

      // Lucky presses: show only, never save as record or credit WPM
      if (tr.isLucky || tr.interval < MIN_DIGRAPH_MS) {
        replacements.push({
          order: ord, pair: tr.pair, thisMs: tr.interval, bestMs: tr.interval,
          saved: 0, source: 'lucky press',
          wordIdx: tr.wordIdx, letterIdx: tr.letterIdx, flatIdx: ord
        });
        continue;
      }
      // Pauses (> MAX): show only — never credit "saved" time vs a normal digraph
      if (tr.isPause || tr.interval > MAX_DIGRAPH_MS) {
        replacements.push({
          order: ord, pair: tr.pair, thisMs: tr.interval, bestMs: tr.interval,
          saved: 0, source: 'pause',
          wordIdx: tr.wordIdx, letterIdx: tr.letterIdx, flatIdx: ord
        });
        continue;
      }

      let better = tr.interval;
      let source = 'this';
      const inTestBest = thisTestByPair[tr.pair];
      if (inTestBest != null && inTestBest < better &&
          inTestBest >= MIN_DIGRAPH_MS && inTestBest <= MAX_DIGRAPH_MS) {
        better = inTestBest; source = 'in-test';
      }
      if (tr.historical != null && tr.historical < better &&
          tr.historical >= MIN_DIGRAPH_MS && tr.historical <= MAX_DIGRAPH_MS) {
        better = tr.historical; source = 'historical';
      }

      const delta = better < tr.interval ? (tr.interval - better) : 0;
      if (delta > 0) {
        saved += delta;
        improved++;
      }
      replacements.push({
        order: ord,
        pair: tr.pair,
        thisMs: tr.interval,
        bestMs: better,
        saved: delta,
        source: delta > 0 ? source : '—',
        wordIdx: tr.wordIdx,
        letterIdx: tr.letterIdx,
        flatIdx: ord
      });
    }
    replacements.sort((a, b) => a.order - b.order);

    // Never save more than real duration (prevents absurd WPM like 948000)
    if (saved >= realMs) saved = Math.max(0, realMs - 1);
    const theoreticalMs = Math.max(1, realMs - saved);
    const chars = charCount > 0 ? charCount : (thisTestIntervals.length + 1);
    const realWpm = chars / 5 / (realMs / 60000);
    const bestWpm = chars / 5 / (theoreticalMs / 60000);

    // Consistency estimate: from coefficient of variation of the BEST intervals
    // (smoother best-digraph pace → higher consistency). Clamped 0–100.
    let consistency = null;
    const bestIv = [];
    for (const r of replacements) {
      if (r.bestMs != null && r.bestMs > 0 && r.bestMs <= MAX_DIGRAPH_MS) bestIv.push(r.bestMs);
      else if (r.thisMs != null && r.thisMs > 0 && !(r.source === 'pause')) bestIv.push(r.thisMs);
    }
    if (bestIv.length >= 3) {
      const mean = bestIv.reduce((a, b) => a + b, 0) / bestIv.length;
      let v = 0;
      for (const x of bestIv) v += (x - mean) * (x - mean);
      const std = Math.sqrt(v / bestIv.length);
      const cv = mean > 0 ? std / mean : 1;
      // MT-like: low variation → high consistency
      consistency = Math.max(0, Math.min(100, Math.round((1 - cv) * 1000) / 10));
    }

    return {
      wpm: Math.round(bestWpm * 100) / 100,
      actualWpm: Math.round(realWpm * 100) / 100,
      pairs: thisTestIntervals.length,
      unique: Object.keys(thisTestByPair || {}).length,
      improved,
      savedMs: Math.round(saved),
      realMs: Math.round(realMs),
      theoreticalMs: Math.round(theoreticalMs),
      timeSec: Math.round(theoreticalMs) / 1000,
      consistency: consistency,
      acc: 100,
      replacements
    };
  }

  function theoreticalBestWpm() {
    return null;
  }

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '?';
    if (Math.abs(ms) >= 1000) return (ms / 1000).toFixed(2) + 's';
    return Math.round(ms) + 'ms';
  }

  function showBestWpm(info) {
    // Result-page only (included in Monkeytype screenshot) — no bottom banner
    const result = document.getElementById('result');
    let resEl = document.getElementById('mt-keyconf-best-result');

    // Remove legacy bottom banner if present
    const oldBanner = document.getElementById('mt-keyconf-bestwpm');
    if (oldBanner) oldBanner.remove();

    if (!result) return;

    if (!resEl) {
      resEl = document.createElement('div');
      resEl.id = 'mt-keyconf-best-result';
      const grid = result.querySelector('.wrapper, .resultgrid, .grid, .stats');
      if (grid && grid.parentElement) {
        grid.parentElement.insertBefore(resEl, grid);
      } else {
        result.insertBefore(resEl, result.firstChild);
      }
    }
    if (info && info.wpm != null) {
      const wpm = (Math.round(info.wpm * 100) / 100).toFixed(2);
      const acc = (info.acc != null ? info.acc : 100);
      const tsec = (info.timeSec != null)
        ? (Math.round(info.timeSec * 100) / 100).toFixed(2)
        : (info.theoreticalMs != null ? (info.theoreticalMs / 1000).toFixed(2) : '—');
      resEl.textContent = 'Best possible: ' + wpm + ' wpm  ' + acc + '% acc  ' + tsec + ' time';
      resEl.style.display = '';
    } else {
      resEl.textContent = '';
      resEl.style.display = 'none';
    }
  }


  function clearKcHighlight() {
    document.querySelectorAll('letter.kc-hl, .letter.kc-hl').forEach((el) => el.classList.remove('kc-hl'));
  }

  function getResultWordElements() {
    const roots = [
      document.querySelector('#resultWordsHistory'),
      document.querySelector('.resultWordsHistory'),
      document.querySelector('#resultWordsHistory .words'),
      document.querySelector('#result .words'),
      document.querySelector('.result .words'),
      document.querySelector('#result')
    ].filter(Boolean);

    let best = [];
    for (const root of roots) {
      let w = [...root.querySelectorAll(':scope > .word')];
      if (!w.length) w = [...root.querySelectorAll('.word')];
      // Prefer the list with the most words (full quote)
      if (w.length > best.length) best = w;
    }
    return best;
  }

  function highlightReplacement(rep) {
    clearKcHighlight();
    if (!rep) return false;

    const words = getResultWordElements();
    if (!words.length) {
      console.warn('[KeyConf] highlight: no result words found');
      return false;
    }

    // Flat expected letters (+ synthetic space slots) on the result page
    const flat = [];
    for (let wi = 0; wi < words.length; wi++) {
      const letters = [...words[wi].querySelectorAll('letter, .letter')].filter(
        (l) => !l.classList.contains('extra')
      );
      for (const l of letters) {
        flat.push({ el: l, ch: (l.textContent || '') });
      }
      if (wi < words.length - 1 && letters.length) {
        // space between words — highlight last letter of previous word as stand-in
        flat.push({ el: letters[letters.length - 1], ch: ' ' });
      }
    }
    if (!flat.length) return false;

    const cur = rep.cur;
    let start = (rep.order != null && !isNaN(rep.order)) ? Number(rep.order) : 0;
    // typeBuf can be longer than expected after errors — clamp then search for matching char
    start = Math.max(0, Math.min(start, flat.length - 1));

    let best = start;
    if (cur != null && cur !== '') {
      let found = -1;
      for (let d = 0; d < flat.length; d++) {
        const a = start + d;
        const b = start - d;
        if (a < flat.length && flat[a].ch === cur) { found = a; break; }
        if (d > 0 && b >= 0 && flat[b].ch === cur) { found = b; break; }
      }
      if (found >= 0) best = found;
    }

    const target = flat[best];
    if (!target || !target.el) return false;
    target.el.classList.add('kc-hl');
    try { target.el.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    return true;
  }


  function refreshWpmDebugBox(force) {
    if (typeof wpmSortMode === 'undefined') wpmSortMode = 'order';
    const box = document.getElementById('mt-keyconf-wpm-debug');
    if (!box) return;
    // When force=true (end of test), rebuild HTML even if panel is closed
    if (!force && box.style.display === 'none') return;
    const last = window.__mtKeyConfLast || {};
    let reps = last.replacements || (last.bestPossibleWpm && last.bestPossibleWpm.replacements) || [];
    if (!Array.isArray(reps)) reps = [];
    if (!reps.length) {
      // Result may be up but finalize missed — try once more
      try {
        if (typeof isResultVisible === 'function' && isResultVisible() && session && !session._finalized) {
          lastResultKey = '';
          window.__kcFinalizePending = null;
          if (typeof checkResult === 'function') checkResult();
        }
      } catch (e) {}
      const last2 = window.__mtKeyConfLast || {};
      reps = last2.replacements || (last2.bestPossibleWpm && last2.bestPossibleWpm.replacements) || [];
      if (!Array.isArray(reps)) reps = [];
      if (!reps.length) {
        box.innerHTML = '<div style="padding:4px 0">No digraph replacements on last test. Finish a test first.</div>';
        return;
      }
    }
    const pretty = (p) => String(p).replace(/ /g, 'spc').replace(/\u2192/g, '→');
    const pad = (s, n) => {
      s = String(s);
      return s.length >= n ? s : s + ' '.repeat(n - s.length);
    };
    let sorted = reps.slice();
    if (wpmSortMode === 'saved') {
      sorted.sort((a, b) => (b.saved || 0) - (a.saved || 0) || (a.order || 0) - (b.order || 0));
    } else {
      sorted.sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    const rows = sorted.map((r, i) => ({
      n: String(i + 1),
      dig: pretty(r.pair || ((r.prev || '') + '→' + (r.cur || ''))),
      thisMs: String(r.thisMs),
      bestMs: String(r.bestMs),
      saved: '-' + r.saved,
      source: r.source || '',
      rep: r
    }));
    const maxlen = (arr, fallback) => arr.length ? Math.max(fallback, ...arr) : fallback;
    const wN = maxlen(rows.map((r) => r.n.length), 1);
    const wDig = maxlen(rows.map((r) => r.dig.length), 7);
    const wThis = maxlen(rows.map((r) => r.thisMs.length), 6);
    const wBest = maxlen(rows.map((r) => r.bestMs.length), 6);
    const wSaved = maxlen(rows.map((r) => r.saved.length), 5);

    const header =
      pad('#', wN) + '  ' + pad('digraph', wDig) + '  ' + pad('thisMs', wThis) + '  ' +
      pad('bestMs', wBest) + '  ' + pad('saved', wSaved) + '  source';

    let html = '<div class="kc-sort">Sort: ' +
      '<button type="button" data-sort="order" class="' + (wpmSortMode === 'order' ? 'on' : '') + '">Order</button>' +
      '<button type="button" data-sort="saved" class="' + (wpmSortMode === 'saved' ? 'on' : '') + '">Biggest save</button>' +
      '</div>';
    html += '<div class="kc-row" style="opacity:.65;cursor:default">' + escapeHtml(header) + '</div>';
    for (const r of rows) {
      const line =
        pad(r.n, wN) + '  ' + pad(r.dig, wDig) + '  ' + pad(r.thisMs, wThis) + '  ' +
        pad(r.bestMs, wBest) + '  ' + pad(r.saved, wSaved) + '  ' + r.source;
      const dim = (r.rep.saved === 0) ? ' style="opacity:0.4"' : '';
      html += '<div class="kc-row" data-order="' + (r.rep.order != null ? r.rep.order : '') + '"' +
        ' data-word="' + (r.rep.wordIdx != null ? r.rep.wordIdx : '') + '"' +
        ' data-letter="' + (r.rep.letterIdx != null ? r.rep.letterIdx : '') + '"' + dim + '>' +
        escapeHtml(line) + '</div>';
    }
    box.innerHTML = html;

    box.querySelectorAll('.kc-sort button').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        wpmSortMode = btn.getAttribute('data-sort') || 'order';
        refreshWpmDebugBox();
      };
    });

    box.querySelectorAll('.kc-row[data-word]').forEach((row) => {
      const rep = {
        order: row.getAttribute('data-order') === '' ? null : parseInt(row.getAttribute('data-order'), 10),
        wordIdx: row.getAttribute('data-word') === '' ? null : parseInt(row.getAttribute('data-word'), 10),
        letterIdx: row.getAttribute('data-letter') === '' ? null : parseInt(row.getAttribute('data-letter'), 10)
      };
      row.onmouseenter = () => {
        box.querySelectorAll('.kc-row.kc-active').forEach((x) => x.classList.remove('kc-active'));
        row.classList.add('kc-active');
        highlightReplacement(rep);
      };
      row.onmouseleave = () => {
        row.classList.remove('kc-active');
        clearKcHighlight();
      };
      row.onclick = () => {
        box.querySelectorAll('.kc-row.kc-active').forEach((x) => x.classList.remove('kc-active'));
        row.classList.add('kc-active');
        highlightReplacement(rep);
      };
    });
  }


  function leastConfidentChars(n) {
    return Object.keys(charStats)
      .filter((ch) => charStats[ch].pressed > 0 && !isCharExcluded(ch))
      .map((ch) => ({
        ch,
        conf: confOf(ch),
        pressed: charStats[ch].pressed,
        incorrect: charStats[ch].incorrect
      }))
      .sort((a, b) => a.conf - b.conf || b.incorrect - a.incorrect)
      .slice(0, n);
  }

  function generatePractice(weakChars, targetCount) {
    // Split weak set into letters vs punctuation/symbols
    const letterNeedles = []; // lowercase a-z to match in WORD_BANK
    const wantUpper = {};     // lowercase → true if user needs SHIFT version
    const wantLower = {};     // lowercase → true if user needs non-shift version
    const punctNeedles = [];  // e.g. ',' '.' ' etc.

    for (const raw of weakChars) {
      const c = String(raw);
      if (c.length !== 1) continue;
      if (c >= 'a' && c <= 'z') {
        if (!letterNeedles.includes(c)) letterNeedles.push(c);
        wantLower[c] = true;
      } else if (c >= 'A' && c <= 'Z') {
        const L = c.toLowerCase();
        if (!letterNeedles.includes(L)) letterNeedles.push(L);
        wantUpper[L] = true;
      } else if (c === ' ') {
        // space practiced naturally between words — skip as needle
      } else {
        if (!punctNeedles.includes(c)) punctNeedles.push(c);
      }
    }

    function countLetters(w) {
      const c = {};
      for (const n of letterNeedles) c[n] = (w.match(new RegExp(n, 'gi')) || []).length;
      return c;
    }
    function scoreWord(w) {
      let hits = 0, total = 0;
      const c = countLetters(w);
      for (const n of letterNeedles) {
        total += c[n] || 0;
        if (c[n]) hits++;
      }
      return { hits, total, c };
    }

    // Bucket by how many distinct weak letters appear
    const scored = [];
    const WORD_BANK = pickWordBank();
    for (const w of WORD_BANK) {
      const s = scoreWord(w);
      if (s.hits < 1) continue;
      scored.push({ w, hits: s.hits, total: s.total, c: s.c });
    }
    scored.sort((a, b) => b.hits - a.hits || b.total - a.total);

    const targetPerLetter = Math.max(10, Math.ceil((targetCount * 2) / Math.max(1, letterNeedles.length)));
    const needleCounts = {};
    letterNeedles.forEach((n) => { needleCounts[n] = 0; });
    const picked = [];
    const used = new Set();

    function underfilled() {
      return letterNeedles.filter((n) => needleCounts[n] < targetPerLetter);
    }

    function pickScore(item) {
      // Prefer words that help the most under-filled needles
      let s = 0;
      for (const n of letterNeedles) {
        const need = Math.max(0, targetPerLetter - needleCounts[n]);
        s += (item.c[n] || 0) * (1 + need * 3);
      }
      s += item.hits * 5 + item.total;
      return s;
    }

    // Greedy fill until targetCount words, always boosting lagging letters
    let guard = 0;
    while (picked.length < targetCount && guard < targetCount * 20) {
      guard++;
      const lagging = underfilled();
      let best = null, bestS = -1;
      for (const item of scored) {
        if (used.has(item.w)) continue;
        // If some letters still lag, require word to contain at least one lagging letter when possible
        if (lagging.length && lagging.length < letterNeedles.length) {
          let helps = false;
          for (const n of lagging) if (item.c[n]) { helps = true; break; }
          if (!helps && picked.length < targetCount * 0.85) continue;
        }
        const s = pickScore(item);
        if (s > bestS) { bestS = s; best = item; }
      }
      if (!best) {
        // relax: take any unused scored word
        for (const item of scored) {
          if (!used.has(item.w)) { best = item; break; }
        }
      }
      if (!best) break;
      used.add(best.w);
      for (const n of letterNeedles) needleCounts[n] += best.c[n] || 0;

      // Case: capitalize ONLY letters the user marked as weak capitals (high rate)
      // Do NOT randomly capitalize other letters (was causing excess A/etc.)
      let out = best.w;
      const chars = out.split('');
      for (let i = 0; i < chars.length; i++) {
        const L = chars[i].toLowerCase();
        const shiftP = getShiftPct() / 100;
        if (wantUpper[L] && !wantLower[L]) {
          // only shift form weak → use shift% capitals
          if (Math.random() < shiftP) chars[i] = chars[i].toUpperCase();
        } else if (wantUpper[L] && wantLower[L]) {
          // both weak → still respect shift% for upper form
          if (Math.random() < shiftP) chars[i] = chars[i].toUpperCase();
        }
        // else leave lowercase (never random Title Case)
      }
      picked.push(chars.join(''));
    }

    // Insert punctuation / shift-pair needles (e.g. 3 and # both) ~50/50
    if (punctNeedles.length && picked.length) {
      const SHIFT_PAIRS = {
        '1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')',
        '-':'_','=':'+','[':'{',']':'}','\\':'|',';':':','\'':'"',',':'<','.':'>','/':'?','`':'~'
      };
      const UNSHIFT = {};
      Object.keys(SHIFT_PAIRS).forEach((k) => { UNSHIFT[SHIFT_PAIRS[k]] = k; });
      // Expand each punct with its shift partner so lists mix digit + symbol
      const expanded = [];
      for (const p of punctNeedles) {
        expanded.push(p);
        if (SHIFT_PAIRS[p] && !expanded.includes(SHIFT_PAIRS[p])) expanded.push(SHIFT_PAIRS[p]);
        if (UNSHIFT[p] && !expanded.includes(UNSHIFT[p])) expanded.push(UNSHIFT[p]);
      }
      const punctTarget = Math.max(10, Math.ceil(targetCount / 5));
      const slots = [];
      for (let i = 0; i < picked.length - 1; i++) slots.push(i);
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      const assign = {};
      let si = 0;
      for (const p of expanded) {
        for (let k = 0; k < punctTarget && si < slots.length; k++, si++) {
          // shift% chance of shifted form (#, _), else unshifted (3, -)
          const shiftP = getShiftPct() / 100;
          let ch = p;
          if (SHIFT_PAIRS[p]) {
            // p is unshifted digit/symbol base → emit shifted with shiftP
            ch = (Math.random() < shiftP) ? SHIFT_PAIRS[p] : p;
          } else if (UNSHIFT[p]) {
            // p is shifted form → emit it with shiftP, else partner
            ch = (Math.random() < shiftP) ? p : UNSHIFT[p];
          }
          assign[slots[si]] = ch;
        }
      }
      const withPunct = [];
      for (let i = 0; i < picked.length; i++) {
        let w = picked[i];
        if (assign[i] != null) w = w + assign[i];
        withPunct.push(w);
      }
      // final shuffle of word order while keeping punct attached to words
      for (let i = withPunct.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [withPunct[i], withPunct[j]] = [withPunct[j], withPunct[i]];
      }
      return withPunct.slice(0, targetCount).join(' ');
    }

    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    return picked.slice(0, targetCount).join(' ');
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function saveCustomList(name, body) {
    // Monkeytype saved short texts: localStorage.customText = { "jail": "word word", ... }
    // (same mechanism as Jail / Hotlist scripts)
    try {
      let obj = {};
      try { obj = JSON.parse(localStorage.getItem('customText') || '{}') || {}; } catch (e) { obj = {}; }
      if (typeof obj !== 'object' || Array.isArray(obj)) obj = {};
      obj[name] = body;
      localStorage.setItem('customText', JSON.stringify(obj));
    } catch (e) {
      console.warn('[KeyConf] customText LS write failed', e);
    }

    // Page module CustomText.setCustomText if available
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const CT = w.CustomText;
      if (CT && typeof CT.setCustomText === 'function') {
        CT.setCustomText(name, body, false);
      }
    } catch (e) {}

    const entry = { name: name, text: body, long: false };

    function upsertArray(arr) {
      if (!Array.isArray(arr)) return [entry];
      const idx = arr.findIndex((t) => t && (t.name === name || t.title === name));
      const row = Object.assign({}, idx >= 0 ? arr[idx] : {}, entry, { title: name, value: body });
      if (idx >= 0) arr[idx] = row;
      else arr.push(row);
      return arr;
    }

    // A) Dedicated key always written
    try {
      let ours = [];
      try { ours = JSON.parse(localStorage.getItem('mt_keyconf_custom_texts') || '[]'); } catch (e) {}
      ours = upsertArray(ours);
      localStorage.setItem('mt_keyconf_custom_texts', JSON.stringify(ours));
    } catch (e) {}

    // B) Merge into any localStorage array that looks like saved texts
    let merged = false;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        let raw;
        try { raw = localStorage.getItem(k); } catch (e) { continue; }
        if (!raw || raw[0] !== '[' && raw[0] !== '{') continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { continue; }
        if (Array.isArray(parsed) && parsed.length && parsed[0] &&
            (typeof parsed[0].text === 'string' || typeof parsed[0].name === 'string')) {
          // Heuristic: names like jail / eclipse custom list live here
          const names = parsed.map((x) => x && x.name).filter(Boolean);
          if (names.some((n) => /jail|eclipse|graphite|custom|text/i.test(String(n))) || parsed.length < 30) {
            const next = upsertArray(parsed.slice());
            localStorage.setItem(k, JSON.stringify(next));
            merged = true;
          }
        } else if (parsed && typeof parsed === 'object') {
          // map name -> text
          if (typeof parsed[name] === 'string' || parsed[name] == null) {
            // only if object values are mostly strings
            const vals = Object.values(parsed);
            if (vals.length && vals.every((v) => typeof v === 'string' || (v && typeof v.text === 'string'))) {
              if (typeof parsed[name] === 'string') parsed[name] = body;
              else if (parsed[name] && parsed[name].text != null) parsed[name].text = body;
              else parsed[name] = body;
              localStorage.setItem(k, JSON.stringify(parsed));
              merged = true;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[KeyConf] LS merge', e);
    }

    // C) IndexedDB monkeytype / default
    try {
      const idbNames = await listIDB();
      for (const dbName of idbNames) {
        const ok = await putCustomInIDB(dbName, name, body);
        if (ok) merged = true;
      }
    } catch (e) {}

    // D) UI path: open custom, set text, set name, click save
    try {
      const customBtn = [...document.querySelectorAll('button, .text-button, .word')].find((b) =>
        /^custom$/i.test((b.textContent || '').trim())
      );
      if (customBtn) customBtn.click();
      await sleep(300);
      // open "change" / saved list area if needed
      let ta =
        document.querySelector('#customTextPopup textarea') ||
        document.querySelector('.customText textarea') ||
        document.querySelector('#customText') ||
        document.querySelector('textarea');
      if (!ta) {
        const change = [...document.querySelectorAll('button, .button')].find((b) =>
          /change|custom text/i.test(b.textContent || '')
        );
        if (change) change.click();
        await sleep(250);
        ta =
          document.querySelector('#customTextPopup textarea') ||
          document.querySelector('.customText textarea') ||
          document.querySelector('textarea');
      }
      if (ta) {
        ta.focus();
        ta.value = body;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        const nameInput = document.querySelector(
          '#customTextPopup input[type="text"], .customText input[type="text"], input[placeholder*="name" i]'
        );
        if (nameInput) {
          nameInput.focus();
          nameInput.value = name;
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const saveBtn = [...document.querySelectorAll('button')].find((b) =>
          /^(save|add|ok|done)$/i.test((b.textContent || '').trim())
        );
        if (saveBtn) saveBtn.click();
        merged = true;
      }
    } catch (e) {
      console.warn('[KeyConf] UI save', e);
    }

    if (!merged) {
      try {
        await navigator.clipboard.writeText(body);
        toast('Could not write saved list — text copied. Paste into Custom and save as "' + name + '"');
      } catch (e) {
        toast('Save failed — see panel / clipboard');
      }
      return false;
    }
    return true;
  }

  function listIDB() {
    return new Promise((resolve) => {
      if (!indexedDB.databases) {
        resolve(['monkeytype', 'Monkeytype', 'localforage']);
        return;
      }
      indexedDB.databases().then((dbs) => {
        const names = (dbs || []).map((d) => d.name).filter(Boolean);
        if (!names.includes('monkeytype')) names.push('monkeytype');
        resolve(names);
      }).catch(() => resolve(['monkeytype']));
    });
  }

  function putCustomInIDB(dbName, name, body) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const req = indexedDB.open(dbName);
        req.onerror = () => done(false);
        req.onsuccess = (ev) => {
          try {
            const db = ev.target.result;
            const stores = [...db.objectStoreNames];
            const prefer = stores.filter((n) => /custom|text|save|local|config/i.test(n));
            const list = prefer.length ? prefer : stores;
            if (!list.length) { done(false); return; }
            let left = list.length;
            let any = false;
            for (const storeName of list) {
              try {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const gr = store.getAll();
                gr.onsuccess = () => {
                  const rows = gr.result || [];
                  if (rows.length && rows[0] && (rows[0].text != null || rows[0].name != null)) {
                    const idx = rows.findIndex((r) => r.name === name || r.title === name);
                    const row = Object.assign({}, idx >= 0 ? rows[idx] : {}, { name, title: name, text: body });
                    try {
                      store.put(row);
                      any = true;
                    } catch (e) {}
                  }
                  left--;
                  if (!left) done(any);
                };
                gr.onerror = () => { left--; if (!left) done(any); };
              } catch (e) {
                left--;
                if (!left) done(any);
              }
            }
          } catch (e) {
            done(false);
          }
        };
        setTimeout(() => done(false), 2000);
      } catch (e) {
        done(false);
      }
    });
  }

  function checkResult() {
    if (!settings.enabled) return;
    const hasHist = !!(document.getElementById('resultWordsHistory') ||
      document.querySelector('#resultWordsHistory, .resultWordsHistory'));
    const result = document.getElementById('result') || document.querySelector('.pageResult #result, #result');
    if (!result && !hasHist) return;
    if (result) {
      try {
        const st = window.getComputedStyle(result);
        if (st.display === 'none' && !hasHist) return;
      } catch (e) {}
    }
    // Prefer shared WPM reader (handles MT DOM changes)
    let wpmTxt = '';
    let accTxt = '';
    try {
      if (typeof readWpmFromResultDOM === 'function') {
        const n = readWpmFromResultDOM();
        if (n) wpmTxt = String(n);
      }
    } catch (e) {}
    if (!wpmTxt && result) {
      const wpmEl = result.querySelector('.group.wpm .bottom, .wpm .bottom, .group.wpm');
      const m = String((wpmEl && wpmEl.textContent) || '').match(/(\d+(?:\.\d+)?)/);
      if (m) wpmTxt = m[1];
    }
    if (result) {
      const accEl = result.querySelector('.group.acc .bottom, .group.acc .bottom, .group.acc');
      const m = String((accEl && accEl.textContent) || '').match(/(\d+(?:\.\d+)?)/);
      if (m) accTxt = m[1];
    }
    if (!wpmTxt && !accTxt && !hasHist) return;
    if (!wpmTxt) wpmTxt = '0';
    if (!accTxt) accTxt = '0';
    // Include session start so two tests with same wpm/acc still finalize separately
    const sessId = (session && session.started) ? String(session.started) : 'nosess';
    const key = wpmTxt + '_' + accTxt + '_' + sessId;
    if (lastResultKey === key) return;
    if (window.__mtKeyConfLast && window.__mtKeyConfLast.resultKey === key) {
      lastResultKey = key;
      return;
    }
    // Need session keystrokes (skip only if already finalized this same key)
    if (!session) return;
    if (session._finalized) return;
    if (!(session.keys && session.keys.length) && !(session.typeBuf && session.typeBuf.length) &&
        !(session.slotTsLive && session.slotTsLive.length >= 2)) {
      console.warn('[KeyConf] result showing but no keys/slots recorded — enable KeyConf BEFORE the test');
      return;
    }
    console.log('[KeyConf] checkResult ok wpm=', wpmTxt, 'keys=', (session.keys||[]).length,
      'typeBuf=', (session.typeBuf||[]).length, 'hist=', !!hasHist);
    // Do NOT lock lastResultKey until finalize succeeds (history can load late)
    if (window.__kcFinalizePending === key) return;
    window.__kcFinalizePending = key;
    const attempt = (n) => {
      if (window.__mtKeyConfLast && window.__mtKeyConfLast.resultKey === key) {
        lastResultKey = key;
        window.__kcFinalizePending = null;
        return;
      }
      if (session && session._finalized) {
        lastResultKey = key;
        window.__kcFinalizePending = null;
        return;
      }
      try { finalizeTest(key); } catch (e) { console.warn('[KeyConf] finalize error', e); }
      try { refreshPanel(); } catch (e) {}
      if (window.__mtKeyConfLast && window.__mtKeyConfLast.resultKey === key) {
        lastResultKey = key;
        window.__kcFinalizePending = null;
        return;
      }
      // Retry up to ~5s — resultWordsHistory often appears after the WPM counters
      if (n < 12) {
        setTimeout(() => attempt(n + 1), 400);
      } else {
        console.warn('[KeyConf] finalize gave up after retries for', key);
        window.__kcFinalizePending = null;
        // Allow checkResult to try again later if user stays on result
        lastResultKey = '';
      }
    };
    setTimeout(() => attempt(0), 200);
  }

  function toast(msg) {
    let el = document.getElementById('mt-keyconf-toast');
    if (!el) { el = document.createElement('div'); el.id = 'mt-keyconf-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  }

  function injectStyles() {
    GM_addStyle(`
      #mt-keyconf-toggle {
        position: fixed; right: 392px; bottom: 18px; z-index: 100001;
        background: var(--sub-alt-color,#2c2e31); color: var(--main-color,#e2b714);
        border: 1px solid var(--sub-color,#646669); border-radius: 8px;
        padding: 4px 10px; cursor: pointer; font-size: 11px; font-weight: 700;
      }
      #mt-keyconf-panel.kc-collapsed { max-height: 120px; }
      #mt-keyconf-panel {
        position: fixed; right: 12px; bottom: 60px; z-index: 99999;
        width: 380px; max-height: 55vh; overflow: auto;
        background: var(--bg-color,#323437); color: var(--text-color,#d1d0c5);
        border: 1px solid var(--sub-color,#646669); border-radius: 10px;
        font-size: 12px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
      }
      #mt-keyconf-panel table.kc-all th,
      #mt-keyconf-panel table.kc-all td { padding: 1px 3px; font-size: 11px; }
      #mt-keyconf-panel button.kc-excl,
      #mt-keyconf-panel button.kc-excl-all {
        background: transparent; border: 1px solid var(--sub-color,#646669);
        color: var(--main-color,#e2b714); border-radius: 3px;
        width: 18px; height: 18px; padding: 0; line-height: 1;
        cursor: pointer; font-size: 12px; font-weight: 700;
      }
      #mt-keyconf-panel button.kc-excl-all {
        width: 20px; height: 20px; font-size: 13px;
      }
      #mt-keyconf-panel button.kc-excl:hover {
        background: var(--sub-alt-color,#2c2e31);
      }
      #mt-keyconf-panel td.kc-excluded,
      #mt-keyconf-panel td.kc-excluded code {
        opacity: 0.35; text-decoration: line-through;
      }
      #mt-keyconf-panel.kc-disabled .row,
      #mt-keyconf-panel.kc-disabled .body {
        opacity: 0.4; pointer-events: none;
      }
      #mt-keyconf-panel.kc-disabled h3 {
        opacity: 1; pointer-events: auto;
      }
      #mt-keyconf-wpm-debug {
        max-height: 180px; overflow: auto; font-size: 10px;
        font-family: ui-monospace, monospace; white-space: pre;
        background: rgba(0,0,0,.25); border-radius: 6px; padding: 6px; margin-top: 6px;
      }
      #mt-keyconf-panel h3 { margin: 0 0 8px; font-size: 13px; color: var(--main-color,#e2b714); }
      #mt-keyconf-panel .row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
      #mt-keyconf-panel button, #mt-keyconf-panel select {
        background: var(--sub-alt-color,#2c2e31); color: var(--main-color,#e2b714);
        border: none; border-radius: 6px; padding: 4px 8px; cursor: pointer;
        font-weight: 600; font-size: 11px;
      }
      #mt-keyconf-panel table { width: 100%; border-collapse: collapse; }
      #mt-keyconf-panel th, #mt-keyconf-panel td {
        text-align: left; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,.06);
      }
      #mt-keyconf-panel .low { color: #ca4754; }
      #mt-keyconf-panel .mid { color: #e2b714; }
      #mt-keyconf-panel textarea {
        width: 100%; min-height: 60px; background: var(--sub-alt-color,#2c2e31);
        color: var(--text-color,#d1d0c5); border: none; border-radius: 6px; padding: 6px; font-size: 11px;
      }
      #mt-keyconf-toast {
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(20px);
        background: var(--main-color,#e2b714); color: var(--bg-color,#323437);
        padding: 8px 14px; border-radius: 8px; font-weight: 700; opacity: 0;
        transition: .25s; z-index: 100000; pointer-events: none;
      }
      #mt-keyconf-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #mt-keyconf-best-result {
        display: block;
        width: 100%;
        text-align: center;
        font-size: 1.1rem;
        font-weight: 500;
        color: var(--main-color, #e2b714);
        margin: 0.25rem 0 0.5rem 0;
        letter-spacing: 0.02em;
        pointer-events: none;
        user-select: none;
      }
      #mt-keyconf-bestwpm {
        position: fixed; left: 50%; bottom: 8px; transform: translateX(-50%);
        background: rgba(0,0,0,.8); color: var(--main-color,#e2b714);
        padding: 6px 28px 6px 14px; border-radius: 8px; font-weight: 700; font-size: 11px;
        z-index: 100000; opacity: 0; transition: .3s; pointer-events: none;
        max-width: min(960px, 96vw);
        white-space: normal;
        line-height: 1.35;
        text-align: center;
      }
      #mt-keyconf-bestwpm.show { opacity: 1; pointer-events: auto; }
      #mt-keyconf-bestwpm .kc-bestwpm-x {
        position: absolute; top: 2px; right: 4px;
        background: transparent; border: none; color: var(--main-color,#e2b714);
        font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 6px;
        opacity: 0.7; font-weight: 700;
      }
      #mt-keyconf-bestwpm .kc-bestwpm-x:hover { opacity: 1; }
      letter.kc-hl, .letter.kc-hl {
        outline: 2px solid #e2b714 !important;
        background: rgba(226, 183, 20, 0.35) !important;
        border-radius: 2px;
      }
      #mt-keyconf-wpm-debug .kc-row {
        cursor: pointer; padding: 1px 0;
      }
      #mt-keyconf-wpm-debug .kc-row:hover, #mt-keyconf-wpm-debug .kc-row.kc-active {
        background: rgba(226, 183, 20, 0.15);
        color: var(--main-color, #e2b714);
      }
      #mt-keyconf-wpm-debug .kc-sort {
        margin-bottom: 4px; display: flex; gap: 6px; align-items: center;
      }
      #mt-keyconf-wpm-debug .kc-sort button {
        background: var(--sub-alt-color,#2c2e31); color: var(--main-color,#e2b714);
        border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 10px; font-weight: 600;
      }
      #mt-keyconf-wpm-debug .kc-sort button.on {
        outline: 1px solid var(--main-color,#e2b714);
      }
    `);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function charLabel(ch) {
    if (ch === ' ') return 'spc';
    if (ch === '\n' || ch === 'Enter') return 'ent';
    return ch;
  }

  function isShiftChar(ch) {
    if (ch >= 'A' && ch <= 'Z') return true;
    return '~!@#$%^&*()_+{}|:"<>?'.includes(ch);
  }

  function refreshPanel() {
    if (!uiRoot) return;
    const body = uiRoot.querySelector('.body');

    const unshifted = [];
    const shifted = [];
    for (const ch of Object.keys(charStats)) {
      if (!charStats[ch] || charStats[ch].pressed <= 0) continue;
      const row = {
        ch: ch,
        conf: confOf(ch),
        incorrect: charStats[ch].incorrect,
        pressed: charStats[ch].pressed
      };
      if (isShiftChar(ch)) shifted.push(row);
      else unshifted.push(row);
    }
    unshifted.sort((a, b) => a.conf - b.conf || String(a.ch).localeCompare(String(b.ch)));
    shifted.sort((a, b) => a.conf - b.conf || String(a.ch).localeCompare(String(b.ch)));

    function cells(row) {
      if (!row) return '<td></td><td></td><td></td><td></td>';
      const pct = Math.round(row.conf * 100);
      const cls = row.incorrect > 0 ? (pct < 50 ? 'low' : pct < 85 ? 'mid' : '') : '';
      const excl = isCharExcluded(row.ch);
      const btnLabel = excl ? '+' : '\u2212';
      const btnTitle = excl ? 'Include in list generation' : 'Exclude from list generation';
      const rowCls = excl ? ' kc-excluded' : '';
      return (
        '<td class="' + rowCls + '"><code>' + escapeHtml(charLabel(row.ch)) + '</code></td>' +
        '<td class="' + cls + rowCls + '">' + pct + '%</td>' +
        '<td class="' + rowCls + '">' + row.incorrect + '/' + row.pressed + '</td>' +
        '<td><button type="button" class="kc-excl" data-ch="' +
          encodeURIComponent(row.ch) + '" title="' + btnTitle + '">' + btnLabel + '</button></td>'
      );
    }

    const shiftPctVal = getShiftPct();
    let html = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;font-size:10px">' +
      '<span style="opacity:.75">Use −/+ to exclude keys</span>' +
      '<label style="display:flex;align-items:center;gap:4px;opacity:.9" title="Percent of shift forms (A, #, _) when generating. Rest stay unshifted (a, 3, -).">' +
      '<span>shift %</span>' +
      '<button type="button" id="kc-shift-pct-dec" title="Decrease" style="width:22px;height:20px;padding:0;line-height:1;cursor:pointer;background:#1a1a1a;color:#eee;border:1px solid #555;border-radius:3px">−</button>' +
      '<span id="kc-shift-pct-val" style="min-width:22px;text-align:center;font-variant-numeric:tabular-nums">' + shiftPctVal + '</span>' +
      '<button type="button" id="kc-shift-pct-inc" title="Increase" style="width:22px;height:20px;padding:0;line-height:1;cursor:pointer;background:#1a1a1a;color:#eee;border:1px solid #555;border-radius:3px">+</button>' +
      '</label></div>';
    html += '<table class="kc-all"><thead><tr>' +
      '<th>key</th><th>conf</th><th>err</th>' +
      '<th><button type="button" class="kc-excl-all" data-side="unshifted" title="Exclude/include ALL non-shift keys">−</button></th>' +
      '<th>KEY</th><th>conf</th><th>err</th>' +
      '<th><button type="button" class="kc-excl-all" data-side="shifted" title="Exclude/include ALL shift keys">−</button></th>' +
      '</tr></thead><tbody>';

    const n = Math.max(unshifted.length, shifted.length);
    for (let i = 0; i < n; i++) {
      html += '<tr>' + cells(unshifted[i]) + cells(shifted[i]) + '</tr>';
    }
    html += '</tbody></table>';
    html += '<div style="margin-top:6px;opacity:.7;font-size:10px">interval records: ' + Object.keys(intervalBest).length + ' digraphs in DB</div>';
    body.innerHTML = html;
    body.querySelectorAll('button.kc-excl').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        let ch;
        try { ch = decodeURIComponent(btn.getAttribute('data-ch') || ''); } catch (err) { ch = btn.getAttribute('data-ch'); }
        if (ch == null || ch === '') return;
        toggleCharExcluded(ch);
        refreshPanel();
      };
    });
    body.querySelectorAll('button.kc-excl-all').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const side = btn.getAttribute('data-side');
        const list = side === 'shifted' ? shifted : unshifted;
        if (!list.length) return;
        // If any is still included, exclude all; else include all
        const anyIncluded = list.some((row) => !isCharExcluded(row.ch));
        list.forEach((row) => {
          const ex = isCharExcluded(row.ch);
          if (anyIncluded && !ex) toggleCharExcluded(row.ch);
          if (!anyIncluded && ex) toggleCharExcluded(row.ch);
        });
        refreshPanel();
      };
    });
    const pctValEl = body.querySelector('#kc-shift-pct-val') || document.getElementById('kc-shift-pct-val');
    const decBtn = body.querySelector('#kc-shift-pct-dec') || document.getElementById('kc-shift-pct-dec');
    const incBtn = body.querySelector('#kc-shift-pct-inc') || document.getElementById('kc-shift-pct-inc');
    const bump = (delta) => {
      const next = setShiftPct(getShiftPct() + delta);
      if (pctValEl) pctValEl.textContent = String(next);
    };
    if (decBtn) {
      decBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); bump(-1); };
    }
    if (incBtn) {
      incBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); bump(1); };
    }
  }

  function buildUI() {
    if (document.getElementById('mt-keyconf-toggle')) return;
    injectStyles();
    const toggle = document.createElement('button');
    toggle.id = 'mt-keyconf-toggle';
    toggle.textContent = 'KeyConf';
    toggle.onclick = () => {
      if (!uiRoot) return;
      const open = uiRoot.style.display === 'none';
      uiRoot.style.display = open ? 'block' : 'none';
      if (open) refreshPanel();
      positionKeyconfToggle();
    };
    document.body.appendChild(toggle);

    uiRoot = document.createElement('div');
    uiRoot.id = 'mt-keyconf-panel';
    uiRoot.innerHTML = `
      <h3 style="display:flex;align-items:center;gap:8px;margin:0 0 8px">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-weight:600;margin:0">
          <input type="checkbox" id="kc-enabled" ${settings.enabled ? 'checked' : ''} style="margin:0;cursor:pointer" />
          Key Confidence
        </label>
      </h3>
      <div class="row">
        <label>Weak chars
          <select id="kc-weak">
            ${[1,2,3,4,5,6,8,10].map(n => '<option value="'+n+'"'+(settings.weakCount===n?' selected':'')+'>'+n+'</option>').join('')}
          </select>
        </label>
        <label>Words
          <select id="kc-words">
            ${[50,75,100,150,200,300,500].map(n => '<option value="'+n+'"'+(settings.targetWords===n?' selected':'')+'>'+n+'</option>').join('')}
          </select>
        </label>
        <button id="kc-gen">Generate → low confidence</button>
      </div>
      <div class="body"></div>
      <div class="row" style="margin-top:8px">
        <button id="kc-clear-chars">Clear char stats</button>
        <button id="kc-clear-int">Clear interval records</button>
        <button id="kc-debug">Debug last</button>
        <button id="kc-wpm-debug">WPM replacements</button>
        <button id="kc-slot-debug">Export slot debug</button>
        <button id="kc-shrink" title="Collapse panel body">Shrink</button>
      </div>
      <div id="kc-debug-out" style="font-size:10px;opacity:.75;margin-top:6px;white-space:pre-wrap;max-height:80px;overflow:auto"></div>
      <div id="mt-keyconf-wpm-debug" style="display:none"></div>
    `;
    uiRoot.style.display = 'none'; // start hidden — open via KeyConf toggle
    document.body.appendChild(uiRoot);

    const en = uiRoot.querySelector('#kc-enabled');
    if (en) {
      en.onchange = () => {
        settings.enabled = !!en.checked;
        saveSettings();
        uiRoot.classList.toggle('kc-disabled', !settings.enabled);
        toast(settings.enabled ? 'Key Confidence enabled' : 'Key Confidence disabled');
      };
      uiRoot.classList.toggle('kc-disabled', !settings.enabled);
    }
    uiRoot.querySelector('#kc-weak').onchange = (e) => { settings.weakCount = parseInt(e.target.value,10)||3; saveSettings(); };
    uiRoot.querySelector('#kc-words').onchange = (e) => { settings.targetWords = parseInt(e.target.value,10)||100; saveSettings(); };
    uiRoot.querySelector('#kc-gen').onclick = async () => {
      const weak = leastConfidentChars(40).filter((u) => u.incorrect > 0).slice(0, settings.weakCount);
      if (!weak.length) { toast('No error chars yet'); return; }
      const gen = generatePractice(weak.map(w => w.ch), settings.targetWords);
      await saveCustomList('low confidence', gen);
      toast('Saved "low confidence": ' + weak.map(w => {
        const label = w.ch === ' ' ? 'spc' : (w.ch === ',' ? 'comma' : w.ch);
        return label + '(' + Math.round(w.conf * 100) + '%)';
      }).join(' '));
    };
    uiRoot.querySelector('#kc-clear-chars').onclick = () => {
      if (!confirm('Clear all character pressed/incorrect stats?')) return;
      for (const ch of Object.keys(charStats)) charStats[ch] = { pressed: 0, incorrect: 0 };
      saveChars(); refreshPanel(); toast('Char stats cleared');
    };
    uiRoot.querySelector('#kc-clear-int').onclick = () => {
      if (!confirm('Clear all digraph interval records?')) return;
      intervalBest = {}; saveIntervals(); refreshPanel(); toast('Interval records cleared');
    };
    uiRoot.querySelector('#kc-debug').onclick = () => {
      const el = uiRoot.querySelector('#kc-debug-out');
      const d = window.__mtKeyConfLast;
      if (!d) { el.textContent = 'No finished test yet this page load.'; return; }
      const td = d.timing || {};
      const lines = [];
      lines.push('=== TIMING RECONCILE ===');
      lines.push('digraph sum:          ' + fmtMs(td.digraphSumMs) + '  (' + (td.digraphCount || 0) + ' digraphs)');
      lines.push('all key gaps:         ' + fmtMs(td.allKeyGapsMs) + '  (' + (td.keyGapCount || 0) + ' gaps, excl idle)');
      lines.push('idle gaps (≥AFK):     ' + fmtMs(td.idleGapsMs));
      lines.push('key span (1st→last):  ' + fmtMs(td.keySpanMs));
      lines.push('site result time:     ' + fmtMs(td.siteMs));
      lines.push('site − digraphs:      ' + fmtMs(td.digraphVsSite) + '  (≥0 expected; large = missing digraphs)');
      lines.push('keySpan − digraphs:   ' + fmtMs(td.digraphVsKeySpan));
      lines.push('keySpan − site:       ' + fmtMs(td.keySpanVsSite));
      lines.push('');
      lines.push('Note: digraph sum only includes correct consecutive commits.');
      lines.push('Wrong keys / skipped words / AFK create gaps vs site time.');
      lines.push('');
      lines.push(JSON.stringify(d, null, 2));
      el.textContent = lines.join('\n');
      el.style.maxHeight = '220px';
    };
    uiRoot.querySelector('#kc-wpm-debug').onclick = () => {
      const box = uiRoot.querySelector('#mt-keyconf-wpm-debug') || document.getElementById('mt-keyconf-wpm-debug');
      if (!box) { console.warn('[KeyConf] wpm-debug box missing'); return; }
      const open = box.style.display === 'none' || !box.style.display;
      box.style.display = open ? 'block' : 'none';
      if (open) {
        try { refreshWpmDebugBox(); } catch (e) { console.warn(e); box.textContent = String(e); }
        try { box.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    };
    const slotDbgBtn = uiRoot.querySelector('#kc-slot-debug');
    if (slotDbgBtn) slotDbgBtn.onclick = () => { try { exportSlotDebug(); } catch (e) { console.warn(e); alert(String(e)); } };
    const shrinkBtn = uiRoot.querySelector('#kc-shrink');
    if (shrinkBtn) {
      shrinkBtn.onclick = () => {
        const body = uiRoot.querySelector('.body');
        const collapsed = uiRoot.classList.toggle('kc-collapsed');
        shrinkBtn.textContent = collapsed ? 'Expand' : 'Shrink';
        if (body) body.style.display = collapsed ? 'none' : '';
      };
    }
    refreshPanel();
    positionKeyconfToggle();
    window.addEventListener('resize', positionKeyconfToggle);
  }

  function positionKeyconfToggle() {
    const panel = document.getElementById('mt-keyconf-panel');
    const toggle = document.getElementById('mt-keyconf-toggle');
    if (!panel || !toggle) return;
    const wasHidden = panel.style.display === 'none';
    if (wasHidden) panel.style.display = 'block';
    const r = panel.getBoundingClientRect();
    if (wasHidden) panel.style.display = 'none';
    const tw = toggle.offsetWidth || 72;
    // Align left edges of toggle and panel (nudge a few px right)
    const rightPx = Math.max(8, Math.round(window.innerWidth - r.left - tw) - 8);
    toggle.style.right = rightPx + 'px';
    toggle.style.left = 'auto';
    toggle.style.bottom = '18px';
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUpSlot, true);
  setInterval(() => {
    try {
      checkResult();
      if (!document.getElementById('mt-keyconf-toggle')) buildUI();
      if (settings.enabled) {
        if (isResultVisible()) {
          // Keep session until finalize finishes
          try { checkResult(); } catch (e) {}
        } else if (isTestActive()) {
          if (!session || session._finalized) {
            resetSession(session && session._finalized ? 'new-test' : 'visible');
          }
          const br = document.getElementById('mt-keyconf-best-result');
          if (br) br.style.display = 'none';
        }
      }
    } catch (e) {}
  }, 400);

  
  // ---- Debug helpers (console) ----
  window.__kcDebugResult = function () {
    const r = document.getElementById('result');
    const hist = document.getElementById('resultWordsHistory');
    const wpm = (typeof readWpmFromResultDOM === 'function') ? readWpmFromResultDOM() : null;
    const info = {
      hasResult: !!r,
      resultHidden: r ? r.classList.contains('hidden') : null,
      resultDisplay: r ? getComputedStyle(r).display : null,
      resultHeight: r ? r.offsetHeight : null,
      hasHist: !!hist,
      histWords: hist ? hist.querySelectorAll('.word').length : 0,
      wpmRead: wpm,
      wpmBottomText: (r && r.querySelector('.group.wpm .bottom')) ? r.querySelector('.group.wpm .bottom').textContent : null,
      wpmGroupHTML: (r && r.querySelector('.group.wpm')) ? r.querySelector('.group.wpm').innerHTML.slice(0, 300) : null,
      keyConfEnabled: !!(typeof settings !== 'undefined' && settings && settings.enabled),
      sessionKeys: (typeof session !== 'undefined' && session && session.keys) ? session.keys.length : 0,
      typeBuf: (typeof session !== 'undefined' && session && session.typeBuf) ? session.typeBuf.length : 0,
      finalized: !!(typeof session !== 'undefined' && session && session._finalized),
      lastKey: typeof lastResultKey !== 'undefined' ? lastResultKey : null,
      lastData: window.__mtKeyConfLast ? {
        at: window.__mtKeyConfLast.at,
        replacements: (window.__mtKeyConfLast.replacements || []).length,
        pending: !!window.__mtKeyConfLast.pending
      } : null
    };
    console.log('[KeyConf DEBUG]', info);
    return info;
  };
  window.__eaDebugCapture = function () {
    const wpm = (typeof readWpmFromResultDOM === 'function') ? readWpmFromResultDOM() : null;
    let dom = null;
    try { dom = (typeof readResultFromDOM === 'function') ? readResultFromDOM() : null; } catch (e) { dom = { error: String(e) }; }
    const info = { wpm, dom, hist: !!document.getElementById('resultWordsHistory') };
    console.log('[EA DEBUG]', info);
    return info;
  };

console.log('[KeyConf] v2.2.31 ready \u2014', WORD_BANKS.reduce((n,b)=>n+b.length,0), 'words in', WORD_BANKS.length, 'shards');
})();
