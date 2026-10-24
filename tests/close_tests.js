// node tests/close_tests.js — send_test_mail の status ゲート（setup/active のみ）と、解約後の削除リマインド（checkPurgeReminders_）
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
  appendRow(r) { this.rows.push(r.slice()); } deleteRow(i) { this.rows.splice(i - 1, 1); } }
class SS { constructor(sh) { this.sheets = sh; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'],
  ['tokyoflower', '東京', 'S1', 'active', 'a@x.jp', ''], ['setupshop', '準備', 'S2', 'setup', 'b@x.jp', ''], ['pausedshop', '停止', 'S3', 'paused', 'c@x.jp', ''],
  ['disabledshop', '無効', 'S4', 'active', 'd@x.jp', ''], ['demo', 'デモ', 'S5', 'disabled', 'e@x.jp', '']]);
const books = { MASTER: new SS({ tenants: master }) };

const ctx = { PropertiesService, Utilities, Logger, console, SpreadsheetApp: { openById: id => books[id] }, hash_equals_: (a, b) => a === b,
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) } };
vm.createContext(ctx);
['crypto_store.gs', 'config.gs', 'tenant.gs', 'billing.gs', 'purge.gs', 'webapp.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext('var __today = "2026-11-01"; function billingToday_() { return __today; } function billingNowStr_() { return __today + " 12:00:00"; }', ctx);
const setToday = d => vm.runInContext(`__today = "${d}"`, ctx);
const mails = []; ctx.MailApp = { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } };
ctx.checkHourlyHealth_ = () => 'ok';

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
ctx.ensureBillingSchema_();
const events = (id, type) => books.MASTER.sheets.billing_events.rows.slice(1).filter(r => r[2] === id && (!type || r[4] === type));

console.log('send_test_mail の status ゲート');
let sent = 0;
ctx.getRmsCredentials = () => ({ shop_name: 'S', shop_signature: 'sig', from_email: 'shop@x.jp', from_name: 'S', reply_to: '' });
ctx.getTenantTemplateRaw_ = () => ({ subject: 's', body: 'b' });
ctx.renderTemplate_ = s => s;
ctx.jsonResponse_ = o => o;
ctx.sendViaBridge_ = () => { sent++; };
ctx.isTenantDryRun_ = () => false;
const setStatus = (id, st) => { master.rows.find(r => r[0] === id)[3] = st; };
['paused', 'disabled', 'canceled', 'weird', ''].forEach(st => t(`status=${JSON.stringify(st)} は拒否（送信関数は呼ばれない）`, () => {
  setStatus('pausedshop', st); sent = 0; const r = ctx.handleSendTestMail_('pausedshop');
  assert.equal(r.ok, false); assert.equal(r.error, 'tenant_not_sendable'); assert.equal(r.message, '停止中のためテスト送信できません'); assert.equal(sent, 0); }));
['setup', 'active'].forEach(st => t(`status=${st} は許可（dry_run=false で送信）`, () => {
  setStatus('pausedshop', st); sent = 0; const r = ctx.handleSendTestMail_('pausedshop'); assert.equal(r.ok, true); assert.equal(sent, 1); }));
t('paused かつ dry_run=true でも拒否（status 判定が先）', () => {
  setStatus('pausedshop', 'paused'); ctx.isTenantDryRun_ = () => true; sent = 0; const r = ctx.handleSendTestMail_('pausedshop');
  assert.equal(r.error, 'tenant_not_sendable'); assert.equal(r.dry_run, undefined); ctx.isTenantDryRun_ = () => false; });
t('active + dry_run=true は dry_run 応答（送信なし）', () => { ctx.isTenantDryRun_ = () => true; sent = 0; const r = ctx.handleSendTestMail_('tokyoflower'); assert.equal(r.dry_run, true); assert.equal(sent, 0); ctx.isTenantDryRun_ = () => false; });
t('テナント行が取得できない・一覧取得が例外なら拒否（fail-closed）', () => {
  assert.equal(ctx.handleSendTestMail_('nosuch').error, 'tenant_not_sendable');
  const orig = ctx.listAllTenants_; ctx.listAllTenants_ = () => { throw new Error('x'); }; assert.equal(ctx.handleSendTestMail_('tokyoflower').error, 'tenant_not_sendable'); ctx.listAllTenants_ = orig; });

console.log('解約後の削除リマインド');
props.ADMIN_EMAIL = 'admin@example.jp';
setStatus('pausedshop', 'paused');
t('setTenantStatus_ で disabled にすると billing_events に status_disabled が残る（status 変更は成功）', () => {
  setToday('2026-10-01');
  assert.equal(ctx.setTenantStatus_('setupshop', 'disabled').ok, true);
  const e = events('setupshop', 'status_disabled'); assert.equal(e.length, 1); assert.equal(e[0][5], 'setup'); assert.equal(e[0][6], 'disabled');
  assert.equal(master.rows.find(r => r[0] === 'setupshop')[3], 'disabled'); });
t('イベント記録が失敗しても status 変更は成功する', () => {
  const o = ctx.appendBillingEvent_; ctx.appendBillingEvent_ = () => { throw new Error('boom'); };
  assert.equal(ctx.setTenantStatus_('pausedshop', 'disabled').ok, true); assert.equal(master.rows.find(r => r[0] === 'pausedshop')[3], 'disabled'); ctx.appendBillingEvent_ = o; setStatus('pausedshop', 'paused'); });
t('起点から22日（10/23）の setupshop は通知しない・記録なし demo は初回に「記録なし」通知＋起点イベント', () => {
  setToday('2026-10-23'); mails.length = 0; const r = Array.from(ctx.checkPurgeReminders_());
  assert.deepEqual(r, ['demo']); assert.equal(mails.length, 1); assert.equal(mails[0].to, 'admin@example.jp');
  assert.ok(mails[0].body.includes('demo') && mails[0].body.includes('記録なし（本日を起点に記録）') && mails[0].body.includes('2026-11-22') && mails[0].body.includes('完全削除（purge）'));
  assert.equal(events('demo', 'disabled_observed').length, 1); assert.equal(events('demo', 'purge_reminder_sent').length, 1); });
t('起点から23日（10/24）で setupshop に通知。本文にテナントID・disabled日・期限・purge_tenant', () => {
  setToday('2026-10-24'); mails.length = 0; const r = Array.from(ctx.checkPurgeReminders_()); assert.deepEqual(r, ['setupshop']);
  const b = mails[0].body; assert.ok(b.includes('setupshop') && b.includes('2026-10-01') && b.includes('2026-10-31') && b.includes('完全削除（purge）') && b.includes('最終削除') && b.includes('同日')); assert.ok(!b.includes('記録なし')); assert.ok(mails[0].subject.includes('setupshop') && mails[0].subject.includes('2026-10-31') && mails[0].subject.includes('最終削除')); });
t('同日2回目は通知しない', () => { mails.length = 0; assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), []); assert.equal(mails.length, 0); });
t('翌日は再通知（日ごとに1回）。demo は起点（10/23）+23日の 11/15 から', () => {
  setToday('2026-10-25'); mails.length = 0; assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), ['setupshop']);
  setToday('2026-11-14'); mails.length = 0; assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), ['setupshop']);
  setToday('2026-11-15'); mails.length = 0; assert.deepEqual(Array.from(ctx.checkPurgeReminders_()).sort(), ['demo', 'setupshop']);
  assert.ok(!mails.find(m => m.body.includes('demo')).body.includes('記録なし')); });
t('purge 済み（purge_tenant イベントあり / マスター行なし）は通知しない', () => {
  setToday('2026-11-16'); ctx.appendBillingEvent_('setupshop', 'manual', 'purge_tenant', 'disabled', 'purged', 'x');
  mails.length = 0; assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), ['demo']);
  master.rows.splice(master.rows.findIndex(r => r[0] === 'demo'), 1); setToday('2026-11-17'); mails.length = 0; assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), []); });
t('tokyoflower（active）・active/paused には通知もイベント追記もしない', () => {
  ['tokyoflower', 'disabledshop', 'pausedshop'].forEach(id => assert.equal(events(id, 'purge_reminder_sent').length + events(id, 'disabled_observed').length, 0)); });
t('ADMIN_EMAIL 未設定ならログのみ（イベントも追記しない）', () => {
  master.rows.push(['ghost', 'G', 'S9', 'disabled', 'g@x.jp', '']); delete props.ADMIN_EMAIL; logs.length = 0; mails.length = 0;
  assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), []); assert.equal(mails.length, 0); assert.ok(logs.some(l => l.includes('ADMIN_EMAIL 未設定') && l.includes('ghost'))); assert.equal(events('ghost').length, 0); props.ADMIN_EMAIL = 'admin@example.jp'; });
t('checkBillingDaily から呼ばれ、失敗しても完走する', () => {
  mails.length = 0; ctx.checkBillingDaily(); assert.ok(mails.some(m => m.body.includes('ghost')));
  ctx.checkPurgeReminders_ = () => { throw new Error('x'); }; assert.doesNotThrow(() => ctx.checkBillingDaily()); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
