// node tests/e2e_onboard_tests.js — 外部店舗受入フロー（招待発行→テナント自動作成→onboard→接続失敗→有効化不可→招待再利用不可→片付け）
// 本番シートには触れないローカル検証。実 GAS での E2E は docs/OPERATOR_ONBOARDING.md の手順で実施する。
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const TID = `e2etest_${runId}`;
const toSigned = b => (b > 127 ? b - 256 : b);
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', SECRETS_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_TOKEN: 'adm' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) };
const fmt = (d, f) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return f === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
const Utilities = {
  base64Encode: x => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => b & 255))).toString('base64'),
  base64Decode: b64 => [...Buffer.from(b64, 'base64')].map(toSigned),
  computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key.map(b => b & 255))).update(Buffer.from(data.map(b => b & 255))).digest()].map(toSigned),
  computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(toSigned),
  newBlob: x => typeof x === 'string' ? { getBytes: () => [...Buffer.from(x, 'utf8')].map(toSigned) } : { getDataAsString: () => Buffer.from(x.map(b => b & 255)).toString('utf8') },
  getUuid: () => crypto.randomUUID(), formatDate: (d, tz, f) => fmt(d, f), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
};
class Sheet { constructor(rows, name) { this.rows = rows.map(r => r.slice()); this.name = name; }
  getName() { return this.name; } setName(n) { this.name = n; if (this.ss) { delete this.ss.sheets[this.key]; this.ss.sheets[n] = this; this.key = n; } }
  getLastColumn() { return Math.max(1, ...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return { getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => v.forEach((row, i) => { while (s.rows.length < r + i) s.rows.push([]); row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }), setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } deleteRow(i) { this.rows.splice(i - 1, 1); } }
let ssSeq = 0;
class SS { constructor(sheets) { this.sheets = sheets; Object.keys(sheets).forEach(k => { sheets[k].ss = this; sheets[k].key = k; }); this.id = 'SS_' + (++ssSeq); books[this.id] = this; }
  getId() { return this.id; } getSheets() { return Object.values(this.sheets); } getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { const sh = new Sheet([], n); sh.ss = this; sh.key = n; return (this.sheets[n] = sh); } }
const books = {};
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'], ['tokyoflower', '東京', 'SS_TF', 'active', 'a@x.jp', '']], 'tenants');
new SS({ tenants: master }); books.MASTER = books.SS_1; delete books.SS_1;
const tf = new SS({ orders: new Sheet([['order_number'], ['240364-20260901-0566501349']], 'orders'), settings: new Sheet([['key', 'value', 'description', 'editable_by_tenant'], ['dry_run', 'false', '', 'FALSE']], 'settings') }); books.SS_TF = tf;
let rmsCode = 401; const notified = [];
const ctx = { PropertiesService, Utilities, Logger: { log() {} }, console, notifyAdmin_: m => notified.push(m), isDryRun_: () => false, RMS_BASE: 'x', formatRmsDate_: () => '',
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => rmsCode, getContentText: () => '{}' }) },
  SpreadsheetApp: { openById: id => books[id], create: () => new SS({ Sheet1: new Sheet([], 'Sheet1') }) } };
vm.createContext(ctx);
['crypto_store.gs', 'auth.gs', 'tenant.gs', 'config.gs', 'billing.gs', 'onboarding.gs', 'admin_api.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
ctx.jsonResponse_ = o => o;   // admin/webapp の応答ラッパー（テスト用に素通し）
vm.runInContext('function jsonResponse_(o) { return o; }', ctx);
ctx.ensureBillingSchema_();
ctx.seedBillingTokyoflower();

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
let invite;
console.log(`E2E ${TID}`);
t('admin: 招待コード発行 → テナント自動作成（setup・billing=trial・trial_end=+30日）', () => {
  const r = ctx.adminCreateInvite_({ tenant_id: TID, shop_name: 'E2E店', shop_email: 'e2e@example.jp' }); assert.equal(r.ok, true); invite = r.invite;
  const row = master.rows.find(x => x[0] === TID); assert.equal(row[3], 'setup');
  const b = ctx.readBillingRow_(TID); assert.equal(b.billing_status, 'trial'); assert.equal(b.billing_provider, 'manual');
  const today = fmt(new Date(), 'yyyy-MM-dd'); const end = new Date(Date.parse(today + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10);
  assert.equal(b.trial_start, today); assert.equal(b.trial_end, end); });
t('テナントタブ（orders/reviews/sends/coupons/settings/templates）が自動生成', () => {
  const ss = books[master.rows.find(x => x[0] === TID)[2]]; ['orders', 'reviews', 'sends', 'coupons', 'settings', 'templates'].forEach(n => assert.ok(ss.getSheetByName(n), n + ' が無い')); });
t('onboard: RMS 接続テスト失敗（ダミーキー）→ 保存されず・招待は消費されない', () => {
  const r = ctx.onboardSubmit_({ invite, sid: '999999', shop_name: 'E2E店', shop_email: 'e2e@example.jp', service_secret: 'DUMMY', license_key: 'DUMMY', smtp_user: 'dummy', smtp_pass: 'dummy', login_password: 'e2e-password1' });
  assert.equal(r.error, 'rms_auth_failed'); assert.equal(ctx.getTenantSecret_(TID, 'rms'), null); assert.equal(ctx.verifyInvite_(invite, false), TID); });
t('接続失敗のテナントは active にできない（RMSキー未登録・SMTP未登録がブロッカー）', () => {
  const r = ctx.adminSetStatus_(TID, 'active'); assert.equal(r.error, 'activation_requirements_not_met'); assert.ok(r.blockers.some(x => x.includes('RMS'))); assert.equal(master.rows.find(x => x[0] === TID)[3], 'setup'); });
t('接続成功なら暗号化保存・招待は1回きり（再利用不可）・tokyoflower データは見えない', () => {
  rmsCode = 200;
  const r = ctx.onboardSubmit_({ invite, sid: '999999', shop_name: 'E2E店', shop_email: 'e2e@example.jp', service_secret: 'SS-E2E', license_key: 'LK-E2E', smtp_user: 'smtpuser', smtp_pass: 'pw', login_password: 'e2e-password1' });
  assert.equal(r.ok, true); assert.equal(r.billing.billing_status, 'trial'); assert.equal(r.billing.payment_url, '');
  assert.ok(!JSON.stringify(books.MASTER.sheets.tenant_secrets.rows).includes('SS-E2E'));
  assert.equal(ctx.onboardSubmit_({ invite, sid: '999999', shop_name: 'x', shop_email: 'e2e@example.jp', service_secret: 'a', license_key: 'b', smtp_user: 'u', smtp_pass: 'p', login_password: 'e2e-password1' }).error, 'invalid_invite');
  const token = r.token; assert.equal(ctx.verifyTenantToken_(token), TID);
  const own = ctx.getTenantSpreadsheet(ctx.verifyTenantToken_(token)); assert.notEqual(own.getId(), 'SS_TF');
  assert.ok(!JSON.stringify(own.getSheetByName('orders').rows).includes('240364')); });
t('顧客の課金 trial 期間内は稼働可、canceled に切替えると不可', () => {
  assert.equal(ctx.billingAllows_(TID), true); ctx.adminSetBilling_(TID, { billing_status: 'canceled' }); assert.equal(ctx.billingAllows_(TID), false); });
t('後片付け: disabled → タブ・行・secrets・billing_events を削除し、全シートに e2etest が残らない', () => {
  ctx.setTenantStatus_(TID, 'disabled');
  const sid = master.rows.find(x => x[0] === TID)[2]; delete books[sid];
  ctx.deleteTenantSecrets_(TID);
  const del = (sh, col) => { for (let i = sh.rows.length - 1; i >= 1; i--) if (String(sh.rows[i][col]) === TID) sh.deleteRow(i + 1); };
  del(master, 0); del(books.MASTER.sheets.billing_events, 2); del(books.MASTER.sheets.tenant_auth, 0); del(books.MASTER.sheets.invites, 0);
  if (books.MASTER.sheets.pipeline_log) del(books.MASTER.sheets.pipeline_log, 0);
  const dump = JSON.stringify(Object.values(books).map(b => Object.values(b.sheets).map(s => s.rows)));
  assert.ok(!dump.includes('e2etest'), 'e2etest が残っている'); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
