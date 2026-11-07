// node tests/monitor_trial_tests.js — モニター店舗（plan=monitor・無料60日）
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
  appendRow(r) { this.rows.push(r.slice()); } deleteRows(from, n) { this.rows.splice(from - 1, n); } }
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
['crypto_store.gs', 'tenant.gs', 'billing.gs', 'monitor_tools.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f })); fixDate(ctx);

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const events = () => books.MASTER.sheets.billing_events.rows.slice(1);
const B = id => ctx.readBillingRow_(id);
ctx.seedBillingTokyoflower();
const mk = (id, st) => master.rows.push([id, id, 'S_' + id, st, id + '@x.jp', '']);
mk('mon1', 'setup'); mk('mon2', 'setup'); mk('std1', 'setup'); mk('act1', 'active'); mk('pd1', 'active'); mk('mon3', 'setup');
ctx.initPendingTrialBilling_('mon1', 'monitor'); ctx.initPendingTrialBilling_('std1'); ctx.initPendingTrialBilling_('mon2'); ctx.initPendingTrialBilling_('mon3');
ctx.writeBillingFields_('act1', { plan: 'standard', billing_provider: 'manual', billing_status: 'active', trial_start: '', trial_end: '' });
ctx.writeBillingFields_('pd1', { plan: 'standard', billing_provider: 'manual', billing_status: 'past_due', trial_start: '', trial_end: '' });
const snap = id => JSON.stringify(B(id));

console.log('日数計算');
t('testMonitorTrialDays_ が全項目 OK', () => { ctx.testMonitorTrialDays_(); assert.ok(logs.includes('全項目 OK')); });
t('trial_days 設定が90でも monitor は60、standard は30', () => { const row = books.MASTER.sheets.settings.rows.find(x => x[0] === 'trial_days'); row[1] = '90'; assert.equal(ctx.getTrialDaysForPlan_('monitor'), 60); assert.equal(ctx.getTrialDaysForPlan_('standard'), 30); row[1] = '30'; });

console.log('起算');
t('monitor は申込完了時に今日+60日、standard は+30日（plan は保持）', () => {
  ctx.startTrialIfPending_('mon1'); ctx.startTrialIfPending_('std1');
  assert.equal(B('mon1').plan, 'monitor'); assert.equal(B('mon1').trial_start, '2026-09-29'); assert.equal(B('mon1').trial_end, '2026-11-28');
  assert.equal(B('std1').plan, 'standard'); assert.equal(B('std1').trial_end, '2026-10-29');
  assert.ok(events().some(e => e[2] === 'mon1' && e[4] === 'trial_start' && e[7].includes('plan=monitor;days=60'))); });
t('initTrialBilling_ は既存 plan を上書きしない（exttest 等も保持、空なら standard）', () => {
  ctx.writeBillingFields_('mon2', { plan: 'exttest' }); ctx.initTrialBilling_('mon2'); assert.equal(B('mon2').plan, 'exttest'); assert.equal(B('mon2').trial_end, '2026-10-29');
  ctx.writeBillingFields_('mon2', { plan: '' }); ctx.initTrialBilling_('mon2'); assert.equal(B('mon2').plan, 'standard'); });

console.log('make_monitor');
t('起算前: plan だけ monitor、期間は空のまま。起算時に60日', () => {
  const r = ctx.adminSetBilling_('mon3', { make_monitor: true }); assert.equal(r.ok, true); assert.equal(B('mon3').plan, 'monitor'); assert.equal(B('mon3').trial_end, '');
  ctx.startTrialIfPending_('mon3'); assert.equal(B('mon3').trial_end, '2026-11-28');
  assert.ok(events().some(e => e[2] === 'mon3' && e[4] === 'monitor_set')); });
t('起算済み trial: trial_end を trial_start+60日に延長し、billing_events に変更前後を残す', () => {
  const r = ctx.adminSetBilling_('std1', { make_monitor: true }); assert.equal(r.ok, true); assert.equal(B('std1').plan, 'monitor'); assert.equal(B('std1').trial_start, '2026-09-29'); assert.equal(B('std1').trial_end, '2026-11-28');
  const ev = events().filter(e => e[2] === 'std1' && e[4] === 'monitor_set'); assert.equal(ev.length, 1); assert.ok(ev[0][7].includes('trial_end:2026-10-29->2026-11-28')); assert.ok(ev[0][7].includes('plan:standard->monitor')); });
t('再実行は冪等（変更なし・イベント追加なし）', () => { const n = events().length; const r = ctx.adminSetBilling_('std1', { make_monitor: true }); assert.equal(r.ok, true); assert.equal(r.unchanged, true); assert.equal(events().length, n); });
t('既に60日以上なら短くしない', () => { ctx.writeBillingFields_('mon1', { trial_end: '2026-12-31' }); ctx.adminSetBilling_('mon1', { make_monitor: true }); assert.equal(B('mon1').trial_end, '2026-12-31'); });
t('active / past_due には適用しない（not_in_trial・値は不変）。tokyoflower も不変', () => {
  ['act1', 'pd1', 'tokyoflower'].forEach(id => { const s = snap(id); const n = events().length; const r = ctx.adminSetBilling_(id, { make_monitor: true }); assert.equal(r.ok, false); assert.equal(r.error, 'not_in_trial'); assert.equal(snap(id), s); assert.equal(events().length, n); }); });
t('canceled にも適用しない', () => { ctx.adminSetBilling_('std1', { billing_status: 'canceled' }); assert.equal(ctx.adminSetBilling_('std1', { make_monitor: true }).error, 'not_in_trial'); });
t('make_monitor 以外（true 以外）では何も起きない', () => { const s = snap('mon2'); ctx.adminSetBilling_('mon2', { make_monitor: 'yes' }); assert.equal(snap('mon2'), s); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
