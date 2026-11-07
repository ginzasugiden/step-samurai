// node tests/extension_background_tests.js — 拡張の自動取り込み（alarms）・通知・バッジ・GAS への状態報告（chrome をモック）
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const EXT = path.join(__dirname, '..', 'extension');
const TOKEN = 'sse_' + 'a'.repeat(40);

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };

function setup(initialStorage) {
  const storage = Object.assign({}, initialStorage);
  const notifications = [], alarms = {}, badges = [], gasCalls = [], listeners = {};
  let rmsMode = 'ok';   // ok | login | broken
  let gasInitialFrom = '2026-09-01';
  const csvBody = n => ['レビュータイプ,商品名,レビュー詳細URL,評価,投稿時間,タイトル,レビュー本文,フラグ,注文番号,未対応フラグ']
    .concat(Array.from({ length: n }, (_, i) => `商品レビュー,x,https://review.rakuten.co.jp/item/1/a/b${i}/,5,2026/11/08 9:00:00,,本文,0,240364-20261107-000000${i},`)).join('\r\n') + '\r\n';
  let reviewCount = 0;
  const fetchFn = async (url, opts) => {
    if (url.startsWith('https://review.rms.rakuten.co.jp/search/csv/')) {
      if (rmsMode === 'login') return { ok: true, status: 200, url: 'https://glogin.rms.rakuten.co.jp/login', arrayBuffer: async () => new ArrayBuffer(0) };
      if (rmsMode === 'broken') return { ok: false, status: 500, url, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(csvBody(reviewCount)) };
    }
    const body = JSON.parse(opts.body); gasCalls.push(body);
    let data = { ok: true, initial_from: gasInitialFrom, inserted: 0, updated: 0 };
    return { ok: true, status: 200, json: async () => data };
  };
  const chrome = {
    runtime: { id: 'x', onMessage: { addListener: f => { listeners.msg = f; } }, onInstalled: { addListener: f => { listeners.installed = f; } }, onStartup: { addListener: f => { listeners.startup = f; } }, sendMessage: async () => ({}) },
    storage: { local: { get: async keys => { const o = {}; keys.forEach(k => { if (k in storage) o[k] = storage[k]; }); return o; }, set: async p => { Object.assign(storage, p); } }, onChanged: { addListener: () => {} } },
    action: { setBadgeText: async o => { badges.push(o.text); }, setBadgeBackgroundColor: async () => {} },
    alarms: { get: (n, cb) => cb(alarms[n]), create: (n, o) => { alarms[n] = o; }, onAlarm: { addListener: f => { listeners.alarm = f; } } },
    notifications: { create: (id, o) => { notifications.push(Object.assign({ id }, o)); }, clear: () => {}, onButtonClicked: { addListener: () => {} }, onClicked: { addListener: () => {} } },
    tabs: { create: async () => {} },
  };
  const ctx = { chrome, fetch: fetchFn, console, setTimeout: f => { f(); return 0; }, TextDecoder: class { decode(b) { return Buffer.from(b).toString('utf8'); } }, URL, importScripts: (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f })) };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // csv.decodeShiftJis は TextDecoder('shift_jis') だが、テストの CSV は UTF-8 なので差し替える
  ctx.SSX.csv.decodeShiftJis = b => Buffer.from(b).toString('utf8');
  return { ctx, storage, notifications, alarms, badges, gasCalls, listeners, setRms: m => { rmsMode = m; }, setReviews: n => { reviewCount = n; } };
}
const tick = async h => { await h.listeners.alarm({ name: 'auto-sync' }); await new Promise(r => setImmediate(r)); };

(async () => {
  console.log('chrome.alarms による自動取り込み');
  await t('インストール直後に初回、以降3時間ごとのアラームを登録する', async () => {
    const h = setup({ token: TOKEN }); h.listeners.installed();
    assert.equal(h.alarms['auto-sync'].periodInMinutes, 180); assert.equal(h.alarms['auto-sync'].delayInMinutes, 1); assert.ok(h.alarms['startup-sync']);
  });
  await t('取り込み成功（0件でも）: 通知なし・バッジなし・lastSyncAt 更新。RMS のタブ不要', async () => {
    const h = setup({ token: TOKEN }); h.setReviews(0); await tick(h);
    assert.equal(h.storage.status, 'ok'); assert.ok(h.storage.lastSyncAt > 0); assert.equal(h.notifications.length, 0); assert.equal(h.badges.slice(-1)[0], '');
    assert.ok(h.gasCalls.some(c => c.action === 'ext_ingest_reviews' && c.payload.dry_run === false && c.payload.ext_version === '1.1.0'));
  });
  await t('未ログイン: 赤い!・requireInteraction の通知（RMSを開くボタン）・GAS へ not_logged_in を報告', async () => {
    const h = setup({ token: TOKEN }); h.setRms('login'); await tick(h);
    assert.equal(h.storage.status, 'login_required'); assert.equal(h.badges.slice(-1)[0], '!');
    const n = h.notifications.slice(-1)[0]; assert.equal(n.requireInteraction, true); assert.deepEqual(n.buttons.map(b => b.title), ['RMSを開く']); assert.ok(/ログイン/.test(n.message));
    const rep = h.gasCalls.find(c => c.action === 'ext_report_status'); assert.equal(rep.payload.status, 'not_logged_in'); assert.equal(rep.payload.version, '1.1.0'); assert.equal(rep.payload.token, TOKEN);
  });
  await t('失敗中は3時間ごと（アラームのたび）と起動時に再通知。正常に戻ったら「再開」を一度だけ通知しバッジを消す', async () => {
    const h = setup({ token: TOKEN }); h.setRms('broken'); await tick(h);
    assert.equal(h.gasCalls.find(c => c.action === 'ext_report_status').payload.status, 'failed');
    const n1 = h.notifications.length; await tick(h); assert.equal(h.notifications.length, n1 + 1);
    h.listeners.startup(); await new Promise(r => setImmediate(r)); assert.equal(h.notifications.length, n1 + 2);
    assert.ok(h.notifications.every(n => n.requireInteraction));
    h.setRms('ok'); h.setReviews(0); await tick(h);
    const resumed = h.notifications.filter(n => /再開/.test(n.message)); assert.equal(resumed.length, 1); assert.equal(h.badges.slice(-1)[0], '');
    const total = h.notifications.length; await tick(h); assert.equal(h.notifications.length, total, '正常が続く間は通知しない');
  });
  await t('トークン未設定なら何もしない（通知・取得なし）', async () => {
    const h = setup({}); await tick(h); assert.equal(h.notifications.length, 0); assert.equal(h.gasCalls.length, 0);
  });
  console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
})();
