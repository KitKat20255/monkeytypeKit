// ==UserScript==
// @name         Monkeytype Kit (Archive + Jail + Hotlist + Dictation)
// @namespace    https://monkeytype.com/kit
// @version      1.0.1
// @description  Bundle: Eternal Archive (local results + graphs), Jail Mode, Hotlist Multi, Kokoro TTS Dictation. Ape Key empty by default.
// @author       kitkat + Grok (Archive/Jail/Hotlist); Dictation based on Kokoro Adaptive TTS
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
  const APE_KEY = ''; // set via Archive panel → Ape Key (never ship a personal key)

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
      // Keep last 2000, drop older than 30 days — heavy quote days need room
      const now = Date.now();
      const trimmed = (arr || [])
        .filter(p => p && now - (p.t || 0) < 30 * 24 * 60 * 60 * 1000)
        .slice(-2000);
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

  function readWpmFromResultDOM() {
    try {
      const candidates = [
        document.querySelector('#result .group.wpm .bottom'),
        document.querySelector('.group.wpm .bottom'),
        document.querySelector('#result .wpm'),
        document.querySelector('.pageTest .group.wpm .bottom')
      ].filter(Boolean);
      for (const el of candidates) {
        const n = parseFloat((el.textContent || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(n) && n > 0) return n;
      }
    } catch (e) {}
    return null;
  }

  function readNumFromResultGroup(groupClass) {
    try {
      const el = document.querySelector('#result .group.' + groupClass + ' .bottom')
        || document.querySelector('.group.' + groupClass + ' .bottom');
      if (!el) return null;
      const n = parseFloat((el.textContent || '').replace(/[^0-9.]/g, ''));
      return isNaN(n) ? null : n;
    } catch (e) { return null; }
  }

  /** Best-effort scrape of the finished test from the result screen DOM */
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
    const wpm = readWpmFromResultDOM();
    if (wpm == null || wpm <= 0) return null;
    const acc = readNumFromResultGroup('acc') ?? readNumFromResultGroup('accuracy');
    const raw = readNumFromResultGroup('raw');
    const cons = readNumFromResultGroup('consistency');

    let mode = 'time';
    let mode2 = '60';
    let language = 'english';
    let punctuation = false;
    let numbers = false;
    let tags = [];
    let quoteLength = undefined;
    let difficulty = 'normal';

    // 1) Authoritative: result screen groups (visible text: "quote short", "eclipse", …)
    try {
      const groups = readResultGroupMap();
      const testType = groups['test type'] || groups['testtype'] || '';
      const tt = testType.toLowerCase();
      if (/\bquote\b/.test(tt)) {
        mode = 'quote';
        if (/\bshort\b/.test(tt)) quoteLength = 0;
        else if (/\bmedium\b/.test(tt)) quoteLength = 1;
        else if (/\blong\b/.test(tt)) quoteLength = 2;
        else if (/\bthicc\b|\bthick\b/.test(tt)) quoteLength = 3;
        mode2 = String(quoteLength != null ? quoteLength : '-1');
      } else if (/\bwords\b/.test(tt)) {
        mode = 'words';
        const wm = tt.match(/\b(10|25|50|100)\b/);
        if (wm) mode2 = wm[1];
      } else if (/\btime\b/.test(tt)) {
        mode = 'time';
        const tm = tt.match(/\b(15|30|60|120)\b/);
        if (tm) mode2 = tm[1];
      } else if (/\bzen\b/.test(tt)) {
        mode = 'zen';
      } else if (/\bcustom\b/.test(tt)) {
        mode = 'custom';
      }
      // language: explicit language group, or last token of test type that is not quote-length
      const SKIP = new Set(['short','medium','long','thicc','thick','quote','words','time','zen','custom','english_1k','english_5k']);
      const tokens = tt.split(/[\s/|]+/).filter(Boolean);
      for (let i = tokens.length - 1; i >= 0; i--) {
        const tok = tokens[i].replace(/[^a-z0-9_]/g, '');
        if (tok && !SKIP.has(tok) && !/^\d+$/.test(tok) && tok.length >= 2) {
          // known pattern: language names
          language = tok;
          break;
        }
      }
      // Prefer "english" if test type contains it as whole word
      if (/\benglish\b/.test(tt)) language = 'english';
      if (groups['language']) {
        language = groups['language'].toLowerCase().replace(/\s+/g, '_').split(/[^a-z0-9_]+/)[0] || language;
      }
      // tags: "eclipse" or multiple (group key may be "tags" after icon strip)
      const tagStr = groups['tags'] || groups['tag'] || '';
      if (tagStr) {
        const rawTags = tagStr.split(/[,\s]+/).map(s => s.trim())
          .filter(s => s && !/^tags?$/i.test(s) && s.length < 40);
        tags = resolveTagNamesToIds(rawTags);
      }
      if (groups['difficulty']) {
        const d = groups['difficulty'].toLowerCase();
        if (['normal','expert','master'].includes(d)) difficulty = d;
      }
    } catch (e) {}

    // 2) Config buttons fallback / supplement
    try {
      if (mode === 'time' || !mode) {
        const modeBtn = document.querySelector('#testConfig .mode .textButton.active, .pageTest .mode .textButton.active');
        if (modeBtn) {
          const t = (modeBtn.textContent || '').trim().toLowerCase();
          if (['time', 'words', 'quote', 'zen', 'custom'].includes(t)) mode = t;
        }
      }
      const wordBtn = document.querySelector('#testConfig .wordCount .textButton.active, .pageTest .wordCount .textButton.active');
      const timeBtn = document.querySelector('#testConfig .time .textButton.active, .pageTest .time .textButton.active');
      if (mode === 'words' && wordBtn) mode2 = (wordBtn.textContent || '').trim();
      else if (mode === 'time' && timeBtn) mode2 = (timeBtn.textContent || '').trim();
      const langEl = document.querySelector('#testConfig .language .textButton.active, .pageTest .language .textButton.active, .current-language');
      if (langEl && language === 'english') {
        language = (langEl.textContent || language).trim().toLowerCase().replace(/\s+/g, '_');
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
      funbox: 'none',
      tags,
      difficulty,
      isPb: !!document.querySelector('#result .group.wpm .badge, #result .pb, #result .crown'),
      testDuration,
      quoteLength,
      _source: 'ea-live-dom'
    };
  }

  function matchPendingStumble(result) {
    if (!result) return result;
    // Allow upgrade when stored stumble is 0/empty but pending has a real count
    const hasReal = result.stumblePct != null && Number(result.stumbledWords || 0) > 0;
    if (hasReal) return result;
    const list = loadPendingStumbles();
    if (!list.length) return result;

    let ts = Number(result.timestamp) || 0;
    if (ts && ts < 1e12) ts *= 1000;
    // Server timestamps can be seconds; also allow "now" when missing
    if (!ts) ts = Date.now();
    const wpm = Number(result.wpm) || 0;
    const acc = Number(result.acc) || 0;

    let best = null;
    let bestScore = Infinity;
    for (const p of list) {
      const dt = Math.abs((p.t || 0) - ts);
      // Allow up to 24h — delayed "Update now" / CSV export later same day
      if (dt > 24 * 60 * 60 * 1000) continue;
      let score = dt / 1000; // prefer closer in time
      if (p.wpm != null && wpm) {
        const dw = Math.abs(p.wpm - wpm);
        if (dw > 4) continue; // tight WPM gate
        score += dw * 30;
      } else if (wpm && p.wpm == null) {
        score += 50; // mild penalty if pending has no wpm
      }
      if (p.acc != null && acc) {
        const da = Math.abs(p.acc - acc);
        if (da > 3) continue;
        score += da * 10;
      }
      if (p.mode && result.mode && String(p.mode) !== String(result.mode)) {
        score += 40;
      }
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) return result;
    const curS = Number(result.stumbledWords) || 0;
    const newS = Number(best.stumbled) || 0;
    // Prefer pending when it has more stumbles or we had none
    if (result.stumblePct == null || newS > curS || (curS === 0 && best.total > 0)) {
      result.stumbledWords = best.stumbled;
      result.cleanWords = best.clean;
      result.totalWords = best.total;
      result.stumblePct = best.stumblePct;
    }
    return result;
  }

  function applyPendingToResults(results) {
    return (results || []).map(r => matchPendingStumble(r));
  }

  async function saveResult(result) {
    matchPendingStumble(result);
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
    // Live-scrape bug: quote length glued onto language
    s = s.replace(/^(short|medium|long|thicc|thick)/, '');
    if (!s || s === 'english' || /english/.test(s)) {
      if (s === 'english' || s === '' || /^english/.test(String(lang).toLowerCase()) || /shortenglish|mediumenglish|longenglish|thiccenglish/.test(String(lang).toLowerCase())) {
        return 'english';
      }
    }
    if (!s) return 'english';
    return s;
  }

  function normalizeResult(raw) {
    const r = { ...raw };
    r.timestamp = Number(r.timestamp) || Date.now();
    r.wpm = Number(r.wpm) || 0;
    r.rawWpm = Number(r.rawWpm || r.raw) || r.wpm;
    r.acc = Number(r.acc) || 0;
    r.consistency = Number(r.consistency) || 0;
    r.mode = r.mode || 'time';
    r.mode2 = r.mode2 != null ? String(r.mode2) : '60';
    r.language = fixLanguageName(r.language);
    r.difficulty = r.difficulty || 'normal';
    r.punctuation = !!r.punctuation;
    r.numbers = !!r.numbers;
    r.funbox = r.funbox || (Array.isArray(r.funbox) ? r.funbox.join('#') : '') || 'none';
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
    return r;
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
    const r = document.querySelector('#result');
    if (!r) return false;
    const style = window.getComputedStyle(r);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (r.offsetHeight < 20) return false;
    return !!(r.querySelector('.group.wpm, .wrapper .group'));
  }

  function isTestActive() {
    if (isResultScreenVisible()) return false;
    const input = document.querySelector('#wordsInput');
    const words = document.querySelector('#words');
    if (input && document.activeElement === input) return true;
    if (words && words.querySelector('.word') && words.offsetHeight > 0) return true;
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
      setTimeout(() => { if (gen === eaCaptureGen) tryCaptureFromPage(); }, 600);
      setTimeout(() => { if (gen === eaCaptureGen) tryCaptureFromPage(); }, 1200);
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
        if (s) await patchLatestResultWithStumble(s);
        return;
      }
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
        const meaningful = isResultScreenVisible() ||
          (r.acc != null && Number(r.acc) > 0) ||
          (stumbleSrc.stumbled > 0);
        if (meaningful) {
          r.stumbledWords = stumbleSrc.stumbled;
          r.cleanWords = stumbleSrc.clean;
          r.totalWords = stumbleSrc.total;
          r.stumblePct = stumbleSrc.stumblePct != null
            ? stumbleSrc.stumblePct
            : (stumbleSrc.total ? (100 * stumbleSrc.stumbled / stumbleSrc.total) : 0);
          // Always queue (including perfect 0-stumble runs) so sync/import can re-attach
          queuePendingStumble(stumbleSrc, r.wpm, { acc: r.acc, mode: r.mode, mode2: r.mode2 });
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
      const isRepeat = (capKey === _eaLastCaptureKey && (now - _eaLastCaptureAt) < 20000);
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
          showToast('Saved test: ' + Number(r.wpm).toFixed(1) + ' wpm' + st + tagHint, 'success', 2200);
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
      // Attach live-session stumbles (API/CSV lack stumble fields)
      normalized = applyPendingToResults(normalized);
      const added = await saveResultsBulk(normalized);
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

  function applyFilters(results) {
    const now = Date.now();
    let filtered = results.slice();

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
      return currentFilters.quoteLength[map[r.quoteLength] || 'short'] !== false;
    });

    filtered = filtered.filter(r => {
      if (r.mode === 'words') {
        const key = ['10','25','50','100'].includes(String(r.mode2)) ? String(r.mode2) : 'custom';
        return currentFilters.words[key] !== false;
      }
      if (r.mode === 'time') {
        const key = ['15','30','60','120'].includes(String(r.mode2)) ? String(r.mode2) : 'custom';
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
        const fb = r.funbox || 'none';
        return currentFilters.funbox.includes(fb);
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
    const leftDecimals = opts.leftDecimals ?? 1;
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
            const stVal = y2Scale.getValueForPixel(y);
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

    // Shift+wheel = zoom X toward cursor. Plain wheel = scroll archive panel.
    const onWheel = (e) => {
      try {
        if (chart.$eaDestroyed) return;
        if (!e.shiftKey) {
          const panel = document.getElementById('ea-panel');
          if (panel) panel.scrollTop += e.deltaY;
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
        if (!el.closest('.ea-yside')) return;
        const panel = document.getElementById('ea-panel');
        if (!panel) return;
        e.preventDefault();
        e.stopPropagation();
        panel.scrollTop += e.deltaY;
      } catch (err) {}
    }, { passive: false, capture: true });
  }






  const crosshairPlugin = createCrosshairPlugin({ leftDecimals: 1, rightDecimals: 2, rightUnit: '%' });


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
    let stumbleMax = 50;
    if (stumbleVals.length) {
      stumbleMax = Math.min(100, Math.max(20, Math.ceil(Math.max(...stumbleVals) / 10) * 10));
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
                return new Date(results[realIndex]?.timestamp || 0).toLocaleString();
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
                  stumbleLine = `Stumble: ${r.stumbledWords}/${r.totalWords} words (${Number(r.stumblePct).toFixed(1)}%)`;
                }
                return [
                  `WPM: ${wpm}`,
                  `Accuracy: ${acc}`,
                  stumbleLine,
                  `Mode: ${r.mode} ${r.mode2}`,
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
            grid: { color: 'rgba(255,255,255,0.05)' }
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
            title: { display: true, text: 'Stumble %', color: '#6ec6ff' },
            ticks: { color: '#6ec6ff' },
            grid: { drawOnChartArea: false },
            offset: true
          }
        }
      },
      plugins: [createCrosshairPlugin({ leftDecimals: 1, rightDecimals: 2, rightUnit: '%' }), createWheelZoomPlugin()]
    });
    try { bindWheelZoomToChart(chartInstance); } catch (e) {}
    try { pinScaleLabels(chartInstance, '#ea-main-frame'); } catch (e) {}
  }

  /*********************************************************************
   *  UI
   *********************************************************************/
  let panelOpen = false;

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
      #ea-panel {
        background: #2c2e31;
        border-radius: 12px;
        width: min(1100px, 100%);
        max-height: 96vh;
        overflow: auto;
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
        overflow: hidden; /* wheel/drag handled by chart zoom plugin on all graphs */
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
            <h2>Monkeytype Eternal Archive</h2>
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
      root.querySelector('#ea-apply-filters').onclick = () => {
        collectFiltersFromUI();
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
    // restore legend state
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
    applyFiltersToUI();
    populateDynamicFilters().then(renderArchive);
  }

  function closePanel() {
    document.getElementById('ea-root')?.classList.remove('open');
    panelOpen = false;
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
    const all = await getAllResults();
    const tagIdsSeen = new Set();
    const langSet = new Set();
    const fbSet = new Set();

    all.forEach(r => {
      (r.tags || []).forEach(t => tagIdsSeen.add(String(t)));
      if (r.language) langSet.add(r.language);
      if (r.funbox && r.funbox !== 'none') fbSet.add(r.funbox);
    });

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

    availableLanguages = [...langSet].sort((a, b) => a.localeCompare(b));
    availableFunboxes = [...fbSet].sort((a, b) => a.localeCompare(b));

    renderChipRow('ea-tags-container', currentFilters.tags, availableTags, { isTag: true });
    renderChipRow('ea-funbox-container', currentFilters.funbox, availableFunboxes);
    renderChipRow('ea-language-container', currentFilters.language, availableLanguages);
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
        deltaStumble: (prevS != null && curS != null) ? (curS - prevS) : null,
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

    const minPx = 28;
    const width = Math.max(
      (container.parentElement?.clientWidth || 600) - 16,
      points.length * minPx
    );
    container.style.width = width + 'px';

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
                    ? `Stumble: ${Number(d.avgStumble).toFixed(1)}% (${d.stumbleCount || 0}/${d.count} tests with data)`
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
            max: Math.max(points.length - 0.5, 0.5),
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
              if (!vals.length) return 50;
              return Math.min(100, Math.max(20, Math.ceil(Math.max(...vals) / 10) * 10));
            })(),
            title: { display: true, text: 'Stumble %', color: '#6ec6ff' },
            ticks: { color: '#6ec6ff' },
            grid: { drawOnChartArea: false },
            offset: true
          }
        }
      },
      plugins: [createCrosshairPlugin({ leftDecimals: 1, rightDecimals: 2, rightUnit: '%' }), createWheelZoomPlugin()]
    });
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
            pointHoverRadius: 6,
            yAxisID: 'y1'
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
            yAxisID: 'y1'
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
                    `Block avg WPM: ${d.avgWpm.toFixed(1)}`,
                    `Block avg Acc: ${d.avgAcc.toFixed(2)}%`,
                    `Tests in block: ${d.count}`,
                    `Hours in block: ${d.hoursInBlock.toFixed(2)}`
                  ];
                  if (d.avgStumble != null) {
                    lines.splice(3, 0, `Block avg Stumble: ${d.avgStumble.toFixed(1)}%`);
                  }
                  return lines;
                }
                const lines = [
                  `Δ WPM: ${d.deltaWpm >= 0 ? '+' : ''}${d.deltaWpm.toFixed(2)}  (${d.prevWpm.toFixed(1)} → ${d.avgWpm.toFixed(1)})`,
                  `Δ Acc: ${d.deltaAcc >= 0 ? '+' : ''}${d.deltaAcc.toFixed(2)}%  (${d.prevAcc.toFixed(2)} → ${d.avgAcc.toFixed(2)})`,
                  `Tests in block: ${d.count}`,
                  `Hours in block: ${d.hoursInBlock.toFixed(2)}`
                ];
                if (d.deltaStumble != null && d.prevStumble != null && d.avgStumble != null) {
                  lines.splice(2, 0,
                    `Δ Stumble: ${d.deltaStumble >= 0 ? '+' : ''}${d.deltaStumble.toFixed(2)}%  (${d.prevStumble.toFixed(1)} → ${d.avgStumble.toFixed(1)})`
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
            max: series.length - 0.5,
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
          }
        }
      },
      plugins: [
        zeroLinePlugin,
        createCrosshairPlugin({ leftDecimals: 2, rightDecimals: 2, rightUnit: '%' }),
        createWheelZoomPlugin()
      ]
    });
    pinScaleLabels(improveChartInstance, '#ea-improve-frame');
    try { bindWheelZoomToChart(improveChartInstance); } catch (e) {}
  }

  async function renderArchive() {
    let all = await getAllResults();
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
    const filtered = applyFilters(all);

    const stats = document.getElementById('ea-stats');
    if (stats) {
      const avgWpm = filtered.length ? Number(weightedMeanFromResults(filtered, r => r.wpm)).toFixed(1) : '–';
      const avgAcc = filtered.length ? Number(weightedMeanFromResults(filtered, r => r.acc)).toFixed(2) : '–';
      const best = filtered.length ? Math.max(...filtered.map(r => r.wpm)).toFixed(1) : '–';
      stats.innerHTML = `
        <span>Showing <b>${filtered.length.toLocaleString()}</b> / ${all.length.toLocaleString()} results</span>
        <span>Avg WPM: <b>${avgWpm}</b></span>
        <span>Avg Acc: <b>${avgAcc}%</b></span>
        <span>Best WPM: <b>${best}</b></span>
      `;
    }
    renderGraph(filtered);
    renderDailyGraph(filtered);
    renderMonthlyGraph(filtered);
    renderImproveGraph(filtered);
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
        // Attach any pending live-session stumbles (CSV has no stumble column)
        normalized = applyPendingToResults(normalized);
        const added = await saveResultsBulk(normalized);
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

    console.log('[Monkeytype Eternal Archive] v1.9.55 ready — fix tag delete UI + dedupe');
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

        checkboxLabel.style.color = state.enabled ? 'var(--main-color, #e2b714)' : 'var(--sub-color, #646669)';
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