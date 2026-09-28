// node tests/billing_tests.js — 課金レイヤー（稼働ガード・trial・手動切替・fincode Webhook・日次チェック）
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const props = { TENANT_MASTER_SHEET_ID: 'MASTER' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) };
const fmtJst = (d, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
const Utilities = { getUuid: () => 'u' + Math.random().toString(36).slice(2), formatDate: fmtJst };
const logs = []; const Logger = { log: m => logs.push(String(m)) };
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } }
class SS { constructor(sh) { this.sheets = sh; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'],
  ['tokyoflower', '東京', 'S1', 'active', 'a@x.jp', ''], ['legacyshop', '旧', 'S2', 'active', 'b@x.jp', ''], ['newshop', '新', 'S3', 'setup', 'c@x.jp', ''], ['cancelshop', '解', 'S4', 'active', 'd@x.jp', '']]);
const books = { MASTER: new SS({ tenants: master }) };
const toJst = v => { if (!v) return null; if (v instanceof Date) return fmtJst(v, 'yyyy-MM-dd'); const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(v)); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const base = () => ({ PropertiesService, Utilities, Logger, console, SpreadsheetApp: { openById: id => books[id] }, hash_equals_: (a, b) => a === b,
  toJstDateString_: toJst, CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) } });
// billing.gs の日付は「今日」を固定するため billingToday_ / billingNowStr_ を後勝ちで差し替える
const fixDate = c => vm.runInContext('var __today = "2026-09-29"; function billingToday_() { return __today; } function billingNowStr_() { return __today + " 12:00:00"; }', c);
const setToday = (c, d) => vm.runInContext(`__today = "${d}"`, c);

const ctx = base(); vm.createContext(ctx);
['tenant.gs', 'billing.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f })); fixDate(ctx);

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const events = () => books.MASTER.sheets.billing_events.rows.slice(1);
const B = id => ctx.readBillingRow_(id);

console.log('schema');
t('列追加は末尾のみ・既存列は不変・冪等', () => {
  const before = master.rows[0].slice(); const r = ctx.ensureBillingSchema_();
  assert.deepEqual(master.rows[0].slice(0, 6), before); assert.equal(r.columns_added.length, 9); assert.equal(master.rows[0].length, 15);
  assert.equal(ctx.ensureBillingSchema_().columns_added.length, 0);
  const g = books.MASTER.sheets.settings.rows; assert.equal(g.find(x => x[0] === 'plan_price_monthly')[1], '9800'); assert.equal(g.find(x => x[0] === 'setup_fee')[1], '0'); assert.equal(g.find(x => x[0] === 'trial_days')[1], '30'); assert.ok(g.find(x => x[0] === 'fincode_payment_url')); });
t('trial_days は上限30に丸める', () => { const row = books.MASTER.sheets.settings.rows.find(x => x[0] === 'trial_days'); row[1] = '90'; assert.equal(ctx.getTrialDays_(), 30); row[1] = '14'; assert.equal(ctx.getTrialDays_(), 14); row[1] = 'abc'; assert.equal(ctx.getTrialDays_(), 30); row[1] = '30'; });

console.log('billingAllows_（fail-closed）');
t('未設定テナント（billing 列が空）は拒否。フォールバックで通さない', () => { assert.equal(ctx.billingAllows_('legacyshop'), false); assert.ok(logs.some(l => l.includes('legacyshop') && l.includes('billing_unset'))); });
t('tokyoflower を明示セット → 許可（冪等）', () => { assert.equal(ctx.seedBillingTokyoflower().ok, true); assert.equal(B('tokyoflower').billing_provider, 'manual'); assert.equal(B('tokyoflower').billing_status, 'active'); assert.equal(ctx.billingAllows_('tokyoflower'), true); assert.equal(ctx.seedBillingTokyoflower().unchanged, true); });
t('trial: trial_end 当日まで許可、翌日から拒否', () => {
  ctx.initTrialBilling_('newshop'); const b = B('newshop');
  assert.equal(b.billing_status, 'trial'); assert.equal(b.trial_start, '2026-09-29'); assert.equal(b.trial_end, '2026-10-29'); assert.equal(b.billing_provider, 'manual');
  assert.equal(ctx.billingAllows_('newshop'), true); setToday(ctx, '2026-10-29'); assert.equal(ctx.billingAllows_('newshop'), true); setToday(ctx, '2026-10-30'); assert.equal(ctx.billingAllows_('newshop'), false); setToday(ctx, '2026-09-29'); });
t('past_due / canceled は拒否、存在しないテナントも拒否', () => {
  ctx.adminSetBilling_('cancelshop', { billing_status: 'canceled' }); assert.equal(ctx.billingAllows_('cancelshop'), false);
  ctx.adminSetBilling_('legacyshop', { billing_status: 'past_due' }); assert.equal(ctx.billingAllows_('legacyshop'), false); assert.equal(ctx.billingAllows_('ghost'), false); });

console.log('パイプライン各経路の skip（canceled テナント）');
{
  const calls = [];
  const c2 = Object.assign(base(), {
    fetchOrders: id => calls.push('fetchOrders:' + id), linkOrdersReviews: () => {}, sendPendingMails: id => calls.push('mails:' + id),
    evaluateCoupons: id => { calls.push('coupon:' + id); return []; }, notifyAdmin_: () => {}, isTenantDryRun_: () => true,
    collectPendingReviewThanks_: id => { calls.push('collect:' + id); return { targets: [], skipped: {} }; },
    sendReviewThanksMail: () => {}, issueCoupon: () => null, findOrderByNumber_: () => null,
  });
  vm.createContext(c2);
  ['tenant.gs', 'billing.gs', 'main.gs'].forEach(f => vm.runInContext(load(f), c2, { filename: f }));
  // review_thanks.gs は依存が多いので sendPendingReviewThanks だけ抜き出して評価する
  const rt = load('review_thanks.gs'); const i = rt.indexOf('function sendPendingReviewThanks('); vm.runInContext(rt.substring(i, rt.indexOf('\n}\n', i) + 3), c2);
  fixDate(c2);
  ['cancelshop', 'legacyshop', 'newshop'].forEach(id => { master.rows.find(r => r[0] === id)[3] = 'active'; });
  t('runHourlyFollowPipeline / runPipeline(クーポン含む) / sendPendingReviewThanks が canceled/past_due を skip', () => {
    c2.runHourlyFollowPipeline(); c2.runPipeline();
    assert.deepEqual(calls.filter(x => x.includes('cancelshop') || x.includes('legacyshop')), []);
    assert.ok(calls.includes('fetchOrders:tokyoflower') && calls.includes('fetchOrders:newshop'));
    assert.equal(c2.sendPendingReviewThanks('cancelshop'), 0); assert.ok(!calls.includes('collect:cancelshop'));
    c2.sendPendingReviewThanks('tokyoflower'); assert.ok(calls.includes('collect:tokyoflower'), 'active は通る'); });
  t('tokyoflower(active) の実行では skip ログが出ない', () => { assert.ok(!logs.some(l => l.includes('[tokyoflower] billing skip'))); });
  ['legacyshop', 'newshop'].forEach(id => { master.rows.find(r => r[0] === id)[3] = 'setup'; });
}

console.log('手動切替・freee');
t('billing_events に手動記録、note に freee 請求済を追記', () => {
  const r = ctx.adminSetBilling_('newshop', { billing_status: 'active', freee_invoiced: true, freee_date: '2026-09-30', freee_invoice_no: 'INV-001', billing_note: '請求書送付' });
  assert.equal(r.ok, true); const b = B('newshop'); assert.equal(b.billing_status, 'active'); assert.ok(b.billing_note.includes('freee請求済 2026-09-30 請求書番号:INV-001'));
  const e = events().filter(x => x[2] === 'newshop' && x[3] === 'manual'); assert.equal(e.length, 1); assert.equal(e[0][5], 'trial'); assert.equal(e[0][6], 'active'); });
t('不正な値は拒否', () => { assert.equal(ctx.adminSetBilling_('newshop', { billing_status: 'free' }).error, 'invalid_billing_status'); assert.equal(ctx.adminSetBilling_('newshop', { billing_provider: 'x' }).error, 'invalid_billing_provider'); });

console.log('checkBillingDaily');
t('trial 期限超過に「trial期限切れ」を記録・ステータスは変えない・二重記録しない', () => {
  ctx.adminSetBilling_('newshop', { billing_status: 'trial' }); setToday(ctx, '2026-11-05');
  assert.deepEqual(Array.from(ctx.checkBillingDaily()), ['newshop']); const b = B('newshop'); assert.equal(b.billing_status, 'trial'); assert.ok(b.billing_note.includes('trial期限切れ'));
  assert.deepEqual(Array.from(ctx.checkBillingDaily()), []); setToday(ctx, '2026-09-29'); });

console.log('fincode webhook');
const ev = o => Object.assign({ bridge_token: 'BT', fincode_event_id: 'e1', event_payload: {} }, o);
t('BRIDGE_TOKEN / FINCODE_WEBHOOK_SECRET 未設定なら拒否（fail-closed）', () => {
  assert.equal(ctx.handleFincodeWebhook_(ev({})).error, 'not_configured'); props.BRIDGE_TOKEN = 'BT'; assert.equal(ctx.handleFincodeWebhook_(ev({})).error, 'not_configured'); props.FINCODE_WEBHOOK_SECRET = 'S'; });
t('BRIDGE_TOKEN 不一致は拒否', () => assert.equal(ctx.handleFincodeWebhook_(ev({ bridge_token: 'bad' })).error, 'unauthorized'));
t('課金成功: trial → active（customer_id で突合）', () => {
  ctx.adminSetBilling_('newshop', { billing_status: 'trial' }); ctx.writeBillingFields_('newshop', { fincode_customer_id: 'cus_1', fincode_subscription_id: 'sub_1' });
  const r = ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'pay1', event_payload: { event: 'payments.card.capture', status: 'CAPTURED', customer_id: 'cus_1', subscription_id: 'sub_1' } }));
  assert.equal(r.billing_status, 'active'); assert.equal(B('newshop').billing_status, 'active'); assert.equal(B('newshop').billing_provider, 'fincode'); });
t('冪等: 同じ fincode_event_id は無視', () => {
  ctx.writeBillingFields_('newshop', { billing_status: 'trial' });
  const r = ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'pay1', event_payload: { event: 'payments.card.capture', status: 'CAPTURED', customer_id: 'cus_1' } }));
  assert.equal(r.duplicate, true); assert.equal(B('newshop').billing_status, 'trial'); });
t('課金失敗 → past_due / 解約 → canceled', () => {
  assert.equal(ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'f1', event_payload: { event: 'payments.card.exec', status: 'FAILED', error_code: 'E01', customer_id: 'cus_1' } })).billing_status, 'past_due');
  assert.equal(ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'c1', event_payload: { event: 'subscription.card.update', status: 'CANCELED', subscription_id: 'sub_1' } })).billing_status, 'canceled');
  assert.equal(ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'c2', event_payload: { event: 'subscription.card.delete', subscription_id: 'sub_1' } })).billing_status, 'canceled'); });
t('無関係イベント・未突合顧客は状態を変えない', () => {
  ctx.writeBillingFields_('newshop', { billing_status: 'active' });
  assert.equal(ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'i1', event_payload: { event: 'payments.card.regist', status: 'UNPROCESSED', customer_id: 'cus_1' } })).ignored, 'event');
  assert.equal(ctx.handleFincodeWebhook_(ev({ fincode_event_id: 'i2', event_payload: { event: 'payments.card.capture', status: 'CAPTURED', customer_id: 'nobody' } })).ignored, 'tenant_not_matched');
  assert.equal(B('newshop').billing_status, 'active'); });
t('event_id 無しは拒否', () => assert.equal(ctx.handleFincodeWebhook_({ bridge_token: 'BT', event_payload: {} }).error, 'event_id_required'));

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
