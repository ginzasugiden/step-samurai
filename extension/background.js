/* service worker（classic）。送信・状態・バッジ・自動同期の判定を担当する。レビューのデータは保存しない。 */
importScripts('lib/config.js', 'lib/time.js', 'lib/sender.js', 'lib/state.js');

(function () {
  'use strict';
  var SSX = globalThis.SSX;
  var config = SSX.config, time = SSX.time, sender = SSX.sender, state = SSX.state;

  var store = {
    get: function () { return chrome.storage.local.get(state.KEYS); },
    set: function (patch) { return chrome.storage.local.set(patch); },
  };
  var deps = {
    fetchFn: function (url, opts) { return fetch(url, opts); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
  };

  // 同期の開始判定を直列化（複数タブの同時 auto_check で二重実行しない）
  var chain = Promise.resolve();
  function locked(fn) { var run = chain.then(fn); chain = run.catch(function () {}); return run; }

  async function updateBadge() {
    try {
      var b = state.badgeFor(await store.get(), Date.now());
      await chrome.action.setBadgeText({ text: b.text });
      await chrome.action.setBadgeBackgroundColor({ color: b.color });
    } catch (e) { /* バッジ更新の失敗は無視 */ }
  }

  /** 開始許可 → 検証（dry_run）→ 取得期間の決定。失敗時は状態を保存して { ok:false } */
  async function prepare(auto) {
    var now = Date.now();
    var b = await locked(function () { return state.beginSync(store, now, auto); });
    if (!b.ok) return b;
    var p = await sender.probe(b.token, deps);
    if (!p.ok) { await state.finishSync(store, b.startedAt, p); return { ok: false, reason: 'probe_failed', error: p.error }; }
    var period = time.computePeriod({ now: now, lastSyncAt: b.lastSyncAt, initialFrom: p.initialFrom });
    return { ok: true, from: period.fromMs, to: period.toMs };
  }

  function isFromRmsContent(sender_) {
    return sender_ && sender_.id === chrome.runtime.id && typeof sender_.url === 'string' && sender_.url.indexOf(config.RMS_ORIGIN + '/') === 0;
  }

  /** content から届いた配列を5項目だけに絞り直す（防御的） */
  function pick(list) {
    return (Array.isArray(list) ? list : []).map(function (r) {
      return { review_type: r.review_type, review_id: r.review_id, rating: r.rating, posted_at: r.posted_at, order_number: r.order_number };
    });
  }

  async function handleCollected(msg) {
    var s = state.normalize(await store.get());
    if (!state.isSyncing(s, Date.now())) return { ok: false };   // 同期中でなければ受け付けない
    var r = await sender.sendAll(pick(msg.reviews), s.token, deps);
    await state.finishSync(store, s.syncingSince, r);
    return { ok: r.ok };
  }

  async function handleManual() {
    var tabs = await chrome.tabs.query({ url: config.RMS_MATCH });
    if (!tabs.length) return { ok: false, reason: 'no_tab' };
    var p = await prepare(false);
    if (!p.ok) return { ok: false, reason: p.reason, error: p.error };
    try {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'collect', from: p.from, to: p.to });
    } catch (e) {
      var s = state.normalize(await store.get());
      await state.finishSync(store, s.syncingSince, { ok: false, error: 'no_content' });
      return { ok: false, reason: 'no_content' };
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender_, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    var job;
    if (msg.type === 'manual_sync') {
      if (sender_.id !== chrome.runtime.id || sender_.tab) return;   // 拡張のポップアップからのみ
      job = handleManual();
    } else if (msg.type === 'auto_check') {
      if (!isFromRmsContent(sender_)) return;
      job = prepare(true).then(function (p) { return p.ok ? { run: true, from: p.from, to: p.to } : { run: false }; });
    } else if (msg.type === 'collected') {
      if (!isFromRmsContent(sender_)) return;
      job = handleCollected(msg);
    } else if (msg.type === 'collect_failed') {
      if (!isFromRmsContent(sender_)) return;
      job = store.get().then(function (raw) {
        var s = state.normalize(raw);
        if (!state.isSyncing(s, Date.now())) return { ok: false };
        return state.finishSync(store, s.syncingSince, { ok: false, error: typeof msg.error === 'string' ? msg.error : 'fetch_failed' }).then(function () { return { ok: true }; });
      });
    } else return;
    job.then(sendResponse, function () { sendResponse({ ok: false, run: false }); }).then(updateBadge);
    return true;
  });

  // 1日1回（と起動時）にバッジを更新する。RMS を勝手に開かない。
  function ensureAlarm() { chrome.alarms.create('daily-badge', { delayInMinutes: 1, periodInMinutes: 24 * 60 }); }
  chrome.runtime.onInstalled.addListener(function () { ensureAlarm(); updateBadge(); });
  chrome.runtime.onStartup.addListener(function () { ensureAlarm(); updateBadge(); });
  chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'daily-badge') updateBadge(); });
  chrome.storage.onChanged.addListener(function (_c, area) { if (area === 'local') updateBadge(); });
  updateBadge();
})();
