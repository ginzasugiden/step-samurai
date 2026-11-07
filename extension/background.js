/* service worker（classic）。送信・状態・バッジ・通知・自動同期の判定を担当する。レビューのデータは保存しない。
 * 自動取り込み: chrome.alarms で3時間ごと（インストール直後と Chrome 起動時にも1回）。RMS のログイン情報は保存・送信しない
 * （ブラウザのログイン済みセッションで取得し、未ログインなら通知で知らせるだけ）。 */
importScripts('lib/config.js', 'lib/time.js', 'lib/csv.js', 'lib/fetcher.js', 'lib/sender.js', 'lib/state.js');

(function () {
  'use strict';
  var SSX = globalThis.SSX;
  var config = SSX.config, time = SSX.time, sender = SSX.sender, state = SSX.state, fetcher = SSX.fetcher, csv = SSX.csv;

  var ALARM_AUTO = 'auto-sync', ALARM_START = 'startup-sync';
  var NOTIFY_PROBLEM = 'ssx-problem', NOTIFY_RESUMED = 'ssx-resumed';

  var store = {
    get: function () { return chrome.storage.local.get(state.KEYS); },
    set: function (patch) { return chrome.storage.local.set(patch); },
  };
  var deps = {
    fetchFn: function (url, opts) { return fetch(url, opts); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    decode: csv.decodeShiftJis,
  };

  // 同期の開始判定を直列化（アラーム・ポップアップ・RMS ページの同時実行で二重にしない）
  var chain = Promise.resolve();
  function locked(fn) { var run = chain.then(fn); chain = run.catch(function () {}); return run; }

  async function updateBadge() {
    try {
      var b = state.badgeFor(await store.get(), Date.now());
      await chrome.action.setBadgeText({ text: b.text });
      await chrome.action.setBadgeBackgroundColor({ color: b.color });
    } catch (e) { /* バッジ更新の失敗は無視 */ }
  }

  // ===== 通知 =====
  function notifyProblem(cls) {
    var msg = cls === 'not_logged_in'
      ? 'RMS にログインしてください。ログインすると、レビューの自動取り込みが再開します。'
      : 'レビューの自動取り込みに失敗しています。RMS を開いて状態を確認してください。';
    try {
      chrome.notifications.create(NOTIFY_PROBLEM, {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'ステップ侍：レビュー取り込みが止まっています', message: msg,
        requireInteraction: true, buttons: [{ title: 'RMSを開く' }],
      });
    } catch (e) { /* 通知が出せなくてもバッジと帯で伝わる */ }
  }
  function notifyResumed() {
    try {
      chrome.notifications.create(NOTIFY_RESUMED, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'ステップ侍', message: '取り込みを再開しました。', requireInteraction: false });
      chrome.notifications.clear(NOTIFY_PROBLEM);
    } catch (e) { /* 無視 */ }
  }
  function openRms() { return chrome.tabs.create({ url: config.RMS_LOGIN_URL }); }
  chrome.notifications.onButtonClicked.addListener(function (id) { if (id === NOTIFY_PROBLEM) { openRms(); chrome.notifications.clear(id); } });
  chrome.notifications.onClicked.addListener(function (id) { if (id === NOTIFY_PROBLEM) { openRms(); chrome.notifications.clear(id); } });

  /** 同期のあとに呼ぶ。要対応なら通知（失敗中は同期のたびに再通知）、正常に戻ったら一度だけ「再開しました」 */
  async function afterSync() {
    var raw = await store.get();
    var s = state.normalize(raw);
    if (!s.token) { await updateBadge(); return; }
    var cls = state.classify(raw);
    if (cls !== 'ok') { notifyProblem(cls); if (s.notified !== 'problem') await store.set({ notified: 'problem' }); }
    else if (s.notified === 'problem') { notifyResumed(); await store.set({ notified: '' }); }
    await updateBadge();
  }

  /** 開始許可 → 検証（dry_run）→ 取得期間の決定。失敗時は状態を保存して { ok:false } */
  async function prepare(auto) {
    var now = Date.now();
    var b = await locked(function () { return state.beginSync(store, now, auto); });
    if (!b.ok) return b;
    var p = await sender.probe(b.token, deps);
    if (!p.ok) { await state.finishSync(store, b.startedAt, p); return { ok: false, reason: 'probe_failed', error: p.error }; }
    var period = time.computePeriod({ now: now, lastSyncAt: b.lastSyncAt, initialFrom: p.initialFrom });
    return { ok: true, from: period.fromMs, to: period.toMs, token: b.token, startedAt: b.startedAt };
  }

  /** バックグラウンドの取り込み（アラーム・起動時・ポップアップの「今すぐ取り込む」）。RMS のタブは不要 */
  async function runSync() {
    var p = await prepare(false);
    if (!p.ok) { if (p.reason === 'probe_failed') await afterSync(); return { ok: false, reason: p.reason, error: p.error }; }
    var result;
    try {
      var r = await fetcher.collectReviews({ fromMs: p.from, toMs: p.to }, deps);
      result = await sender.sendAll(pickAll(r.reviews), p.token, deps);
    } catch (e) {
      result = { ok: false, error: e && typeof e.code === 'string' ? e.code : 'fetch_failed' };
    }
    await state.finishSync(store, p.startedAt, result);
    if (!result.ok) {
      // 取得側の失敗は GAS にも知らせる（送信側の失敗は GAS に届かないので報告しない）
      var fromFetch = ['login_required', 'csv_format', 'cap_unsplittable', 'fetch_failed'].indexOf(result.error) >= 0;
      if (fromFetch) { try { await sender.reportStatus(p.token, result.error === 'login_required' ? 'not_logged_in' : 'failed', deps); } catch (e) { /* 無視 */ } }
    }
    await afterSync();
    return { ok: !!result.ok, error: result.error };
  }

  function pickAll(list) {
    return (Array.isArray(list) ? list : []).map(function (r) {
      return { review_type: r.review_type, review_id: r.review_id, rating: r.rating, posted_at: r.posted_at, order_number: r.order_number };
    });
  }

  function isFromRmsContent(sender_) {
    return sender_ && sender_.id === chrome.runtime.id && typeof sender_.url === 'string' && sender_.url.indexOf(config.RMS_ORIGIN + '/') === 0;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender_, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    var job;
    if (msg.type === 'manual_sync') {
      if (sender_.id !== chrome.runtime.id || sender_.tab) return;   // 拡張のポップアップからのみ
      job = runSync();
    } else if (msg.type === 'open_rms') {
      if (sender_.id !== chrome.runtime.id || sender_.tab) return;
      job = openRms().then(function () { return { ok: true }; });
    } else if (msg.type === 'get_banner') {
      // RMS の画面に帯を出すかの問い合わせ（状態の種別だけを返す）
      if (!isFromRmsContent(sender_)) return;
      job = store.get().then(function (raw) { return { show: state.needsAction(raw, Date.now()) }; });
    } else return;
    job.then(sendResponse, function () { sendResponse({ ok: false }); }).then(updateBadge);
    return true;
  });

  function ensureAlarms() { chrome.alarms.get(ALARM_AUTO, function (a) { if (!a) chrome.alarms.create(ALARM_AUTO, { delayInMinutes: 1, periodInMinutes: config.AUTO_SYNC_MINUTES }); }); }
  chrome.runtime.onInstalled.addListener(function () { ensureAlarms(); chrome.alarms.create(ALARM_START, { delayInMinutes: 1 }); updateBadge(); });   // インストール直後に初回
  chrome.runtime.onStartup.addListener(function () { ensureAlarms(); chrome.alarms.create(ALARM_START, { delayInMinutes: 0.5 }); updateBadge(); afterNotifyOnStartup(); });   // Chrome 起動時
  chrome.alarms.onAlarm.addListener(function (a) {
    if (a.name === ALARM_AUTO || a.name === ALARM_START) runSync().catch(function () { return afterSync(); });
  });
  /** 起動直後、失敗中なら（同期を待たずに）再通知する */
  async function afterNotifyOnStartup() {
    var raw = await store.get(); var cls = state.classify(raw);
    if (state.normalize(raw).token && cls !== 'ok') notifyProblem(cls);
  }
  chrome.storage.onChanged.addListener(function (_c, area) { if (area === 'local') updateBadge(); });
  ensureAlarms();
  updateBadge();
})();
