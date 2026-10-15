// node tests/billing_digest_tests.js — 修正3: checkBillingDaily の ADMIN_EMAIL 宛て一覧メール（7日前・当日・期限切れ）
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
['crypto_store.gs', 'tenant.gs', 'billing.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f })); fixDate(ctx);


// MailApp はモック（実メールは送らない）
const mails = [];
ctx.MailApp = { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } };

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const events = () => books.MASTER.sheets.billing_events.rows.slice(1);
const set = (id, f) => ctx.writeBillingFields_(id, f);
ctx.ensureBillingSchema_();
ctx.seedBillingTokyoflower();
// 4店: 7日後に終了 / 今日終了 / 過去に終了 / 余裕あり
set('legacyshop', { billing_status: 'trial', trial_start: '2026-09-09', trial_end: '2026-10-06' });   // 今日(2026-09-29)+7 → 7日前
set('newshop', { billing_status: 'trial', trial_start: '2026-08-30', trial_end: '2026-09-29' });      // 当日
set('cancelshop', { billing_status: 'trial', trial_start: '2026-08-01', trial_end: '2026-08-31' });   // 期限切れ
props.ADMIN_EMAIL = 'admin@example.jp';

console.log('trial 期限の一覧メール');
t('7日前・当日・期限切れ（初検知）が1通にまとまり ADMIN_EMAIL 宛てに送られる', () => {
  master.rows.push(['okshop', '余裕', 'S8', 'active', 'o@x.jp', '']);
  const flagged = Array.from(ctx.checkBillingDaily()); assert.deepEqual(flagged, ['cancelshop']);
  assert.equal(mails.length, 1); const m = mails[0]; assert.equal(m.to, 'admin@example.jp');
  assert.ok(m.body.includes('7日後') && m.body.includes('legacyshop')); assert.ok(m.body.includes('今日で終わります') && m.body.includes('newshop')); assert.ok(m.body.includes('送信を停止') && m.body.includes('cancelshop'));
  assert.ok(!m.body.includes('tokyoflower') && !m.body.includes('okshop'), 'active は含めない');
  assert.equal(events().filter(e => e[4] === 'trial_digest_sent').length, 1); });
t('同じ日に2回実行しても重複して送らない', () => {
  assert.deepEqual(Array.from(ctx.checkBillingDaily()), []); assert.equal(mails.length, 1);
  assert.ok(logs.some(l => l.includes('送信済みのためスキップ'))); });
t('翌日は別の対象があれば送る（日付ごとに1通）', () => {
  setToday(ctx, '2026-09-30'); const n = mails.length; ctx.checkBillingDaily();
  assert.equal(mails.length, n + 1, '9/30 は newshop が期限切れの初検知'); assert.ok(mails[mails.length - 1].body.includes('newshop'));
  ctx.checkBillingDaily(); assert.equal(mails.length, n + 1, '同日2回目は送らない'); });
t('対象が無い日は送らない', () => {
  setToday(ctx, '2026-12-20'); const n = mails.length; ctx.checkBillingDaily();
  assert.equal(mails.length, n + 1, 'legacyshop が期限切れの初検知（これで全員検知済み）');
  setToday(ctx, '2027-01-10'); ctx.checkBillingDaily(); assert.equal(mails.length, n + 1, '新規の対象が無い日は送らない'); });
t('ADMIN_EMAIL 未設定なら送らずログのみ・イベントも記録しない・例外にしない', () => {
  setToday(ctx, '2026-09-29'); delete props.ADMIN_EMAIL;
  set('okshop', { billing_status: 'trial', trial_start: '2026-09-01', trial_end: '2026-09-29' });
  const n = mails.length, ev = events().filter(e => e[4] === 'trial_digest_sent').length; logs.length = 0;
  assert.doesNotThrow(() => ctx.checkBillingDaily()); assert.equal(mails.length, n); assert.equal(events().filter(e => e[4] === 'trial_digest_sent').length, ev);
  assert.ok(logs.some(l => l.includes('ADMIN_EMAIL 未設定') && l.includes('okshop'))); });
t('メール送信が例外でも checkBillingDaily は完走する（期限切れの記録は残る）', () => {
  props.ADMIN_EMAIL = 'admin@example.jp'; setToday(ctx, '2026-10-02'); set('okshop', { billing_status: 'trial', trial_start: '2026-09-01', trial_end: '2026-09-01', billing_note: '' });
  ctx.MailApp.sendEmail = () => { throw new Error('quota'); };
  assert.doesNotThrow(() => ctx.checkBillingDaily()); assert.ok(B('okshop').billing_note.includes('trial期限切れ')); assert.ok(logs.some(l => l.includes('digest error'))); });

function B(id) { return ctx.readBillingRow_(id); }
console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
