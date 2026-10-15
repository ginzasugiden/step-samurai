// node tests/license_check_tests.js — checkLicenseExpiry: active 全テナント対象・同日重複なし・ADMIN_EMAIL 未設定はログのみ・1件の失敗で止まらない
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
  appendRow(r) { this.rows.push(r.slice()); } }
class SS { constructor(sh) { this.sheets = sh; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'],
  ['soon', '近', 'S1', 'active', 'a@x.jp', ''], ['gone', '切', 'S2', 'active', 'b@x.jp', ''], ['far', '遠', 'S3', 'active', 'c@x.jp', ''],
  ['noexp', '無', 'S4', 'active', 'd@x.jp', ''], ['paused', '停', 'S5', 'paused', 'e@x.jp', ''], ['soon2', '近2', 'S6', 'active', 'f@x.jp', ''], ['bad', '不正', 'S7', 'active', 'g@x.jp', '']]);
const books = { MASTER: new SS({ tenants: master }) };
const ctx = { PropertiesService, Utilities, Logger, console, SpreadsheetApp: { openById: id => books[id] }, hash_equals_: (a, b) => a === b,
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) } };
vm.createContext(ctx);
['crypto_store.gs', 'tenant.gs', 'billing.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext('var __today = "2026-10-20"; function billingToday_() { return __today; } function billingNowStr_() { return __today + " 09:00:00"; }', ctx);
const setToday = d => vm.runInContext(`__today = "${d}"`, ctx);

const mails = []; ctx.MailApp = { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } };
const iso = days => new Date(Date.now() + days * 864e5).toISOString();
const expiry = { soon: iso(10), soon2: iso(30.5 - 1), gone: iso(-5), far: iso(60), noexp: '', paused: iso(3), bad: 'not-a-date' };
ctx.getTenantSecretMeta_ = id => ({ meta: { expiry: expiry[id] } });
props.ADMIN_EMAIL = 'admin@example.jp';
const evs = () => (books.MASTER.sheets.billing_events ? books.MASTER.sheets.billing_events.rows.slice(1) : []).filter(e => e[4] === 'license_notice_sent');

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

t('30日以内と失効済みだけ ADMIN_EMAIL に送る（31日以上・expiry無し・不正日付・非activeは送らない）／全テナント対象', () => {
  const r = ctx.checkLicenseExpiry();
  assert.equal(mails.length, 3); assert.ok(mails.every(m => m.to === 'admin@example.jp'));
  const all = mails.map(m => m.body).join('\n');
  assert.ok(all.includes('（soon）') && all.includes('（soon2）') && all.includes('（gone）') && all.includes('失効済み'));
  assert.ok(!all.includes('（far）') && !all.includes('（noexp）') && !all.includes('（paused）') && !all.includes('（bad）'));
  assert.equal(r.sent, 3); assert.equal(evs().length, 3);
  assert.ok(logs.some(l => l.includes('[bad]') && l.includes('不正'))); });
t('同じ日に2回目は重複送信しない', () => {
  const r = ctx.checkLicenseExpiry(); assert.equal(mails.length, 3); assert.equal(r.duplicate, 3); assert.equal(r.sent, 0); assert.equal(evs().length, 3); });
t('翌日は再送する', () => { setToday('2026-10-21'); ctx.checkLicenseExpiry(); assert.equal(mails.length, 6); assert.equal(evs().length, 6); });
t('ADMIN_EMAIL 未設定なら送らずログのみ・イベントも記録しない・例外にしない', () => {
  setToday('2026-10-22'); delete props.ADMIN_EMAIL; logs.length = 0; const n = mails.length, e = evs().length;
  assert.doesNotThrow(() => ctx.checkLicenseExpiry()); assert.equal(mails.length, n); assert.equal(evs().length, e);
  assert.ok(logs.some(l => l.includes('ADMIN_EMAIL 未設定') && l.includes('soon'))); });
t('1件の送信例外でも他テナントは処理され、失敗分は記録されない', () => {
  props.ADMIN_EMAIL = 'admin@example.jp'; setToday('2026-10-23'); const n = mails.length, e = evs().length; logs.length = 0;
  ctx.MailApp.sendEmail = (to, s, body) => { if (body.includes('（soon）')) throw new Error('quota'); mails.push({ to, subject: s, body }); };
  let r; assert.doesNotThrow(() => { r = ctx.checkLicenseExpiry(); });
  assert.equal(mails.length, n + 2); assert.equal(evs().length, e + 2); assert.equal(r.errors, 1);
  assert.ok(logs.some(l => l.includes('error [soon]')));
  assert.ok(!evs().some(x => x[2] === 'soon' && String(x[7]).startsWith('2026-10-23'))); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
