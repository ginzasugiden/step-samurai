// node tests/terms_consent_tests.js — 規約同意の必須化と記録（billing_events の terms_agreed）。e2e_onboard_tests.js のモック流儀を踏襲
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
vm.runInContext('function listBackfillPendingTenants_() { return []; }', ctx);   // analytics_backfill.gs 非読込のためスタブ
ctx.ensureBillingSchema_();
ctx.seedBillingTokyoflower();

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const base = inv => ({ invite: inv, sid: '999999', shop_name: '規約店', shop_email: 'terms@example.jp', service_secret: 'SS-T', license_key: 'LK-T', smtp_user: 'smtpuser', smtp_pass: 'pw', login_password: 'terms-password1' });
const events = () => books.MASTER.sheets.billing_events.rows.slice(1);
const termsEv = tid => events().filter(r => r[2] === tid && r[4] === 'terms_agreed');
rmsCode = 200;
const r0 = ctx.adminCreateInvite_({ tenant_id: TID, shop_name: '規約店', shop_email: 'terms@example.jp' }); const invite = r0.invite;
const tfBefore = JSON.stringify([master.rows.find(x => x[0] === 'tokyoflower'), tf.sheets.settings.rows, tf.sheets.orders.rows, ctx.readBillingRow_('tokyoflower')]);
const evBefore = events().length;

t('TERMS_VERSION は 1.0', () => assert.equal(vm.runInContext('TERMS_VERSION', ctx), '1.0'));
t('terms_version 無しは terms_not_agreed で拒否', () => { assert.equal(ctx.onboardSubmit_(base(invite)).error, 'terms_not_agreed'); });
t("版違い('0.9') と空文字も拒否", () => { ['0.9', '', '1.0.1', null].forEach(v => assert.equal(ctx.onboardSubmit_(Object.assign(base(invite), { terms_version: v })).error, 'terms_not_agreed')); });
t('拒否時は secret 保存なし・招待未消費・terms_agreed なし・パスワード/トークン未発行', () => {
  assert.equal(ctx.getTenantSecret_(TID, 'rms'), null); assert.equal(ctx.getTenantSecret_(TID, 'smtp'), null);
  assert.equal(ctx.verifyInvite_(invite, false), TID); assert.equal(termsEv(TID).length, 0);
  assert.equal(master.rows.find(x => x[0] === TID)[1], '規約店'.length ? master.rows.find(x => x[0] === TID)[1] : '');
  assert.equal(ctx.readBillingRow_(TID).trial_start, '', 'trial 未起算'); assert.equal(notified.length, 0); });
t('無効な招待は terms より先に invalid_invite（招待検証が最初）', () => { assert.equal(ctx.onboardSubmit_(Object.assign(base('bogus'), { terms_version: '1.0' })).error, 'invalid_invite'); });
let ok;
t('同意ありなら成功し billing_events に terms_agreed（source=onboard, JST ISO8601）が1件記録される', () => {
  ok = ctx.onboardSubmit_(Object.assign(base(invite), { terms_version: '1.0' })); assert.equal(ok.ok, true);
  const ev = termsEv(TID); assert.equal(ev.length, 1); assert.equal(ev[0][3], 'onboard');
  assert.match(ev[0][7], /^terms_version=1\.0;terms_agreed_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  assert.equal(ctx.verifyInvite_(invite, false), null, '招待は消費済み'); });
t('記録失敗（billing_events 書込不可）でも登録自体は成功する', () => {
  const inv2 = ctx.adminCreateInvite_({ tenant_id: TID + 'b', shop_name: '規約店2', shop_email: 't2@example.jp' }).invite;
  const orig = ctx.appendBillingEvent_; ctx.appendBillingEvent_ = () => { throw new Error('boom'); };
  try { const r = ctx.onboardSubmit_(Object.assign(base(inv2), { terms_version: '1.0' })); assert.equal(r.ok, true); } finally { ctx.appendBillingEvent_ = orig; } });
t('tokyoflower の行・settings・orders・billing・events は変わらない', () => {
  assert.equal(JSON.stringify([master.rows.find(x => x[0] === 'tokyoflower'), tf.sheets.settings.rows, tf.sheets.orders.rows, ctx.readBillingRow_('tokyoflower')]), tfBefore);
  assert.equal(events().filter(r => r[2] === 'tokyoflower' && r[4] === 'terms_agreed').length, 0); });
t('adminListTenants_ は terms 情報を返し、未記録テナントは空', () => {
  const list = ctx.adminListTenants_(); const me = list.find(x => x.tenant_id === TID), tfRow = list.find(x => x.tenant_id === 'tokyoflower');
  assert.equal(me.terms_version, '1.0'); assert.equal(me.terms_agreed_at, termsEv(TID)[0][7].split('terms_agreed_at=')[1]);
  assert.equal(tfRow.terms_version, ''); assert.equal(tfRow.terms_agreed_at, ''); });
t('adminListTenants_ は最新の terms_agreed を採用する', () => {
  ctx.appendBillingEvent_(TID, 'onboard', 'terms_agreed', '', '', 'terms_version=1.1;terms_agreed_at=2099-01-01T00:00:00+09:00');
  const me = ctx.adminListTenants_().find(x => x.tenant_id === TID); assert.equal(me.terms_version, '1.1'); assert.equal(me.terms_agreed_at, '2099-01-01T00:00:00+09:00'); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
