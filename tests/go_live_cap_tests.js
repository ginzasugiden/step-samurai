// node tests/go_live_cap_tests.js — 修正2: 1回あたり送信上限(max_sends_per_run)と go_live_date の過去日検証
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- GAS mock（multitenant_tests.js と同等） ----
let props = { TENANT_MASTER_SHEET_ID: 'MASTER', DRY_RUN: 'false' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) };
const cacheStore = {};
const CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) };
const Utilities = { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
  formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0');
    const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; } };
const logs = []; const Logger = { log: m => logs.push(String(m)) };
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); }
  getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => v.forEach((row, i) => { while (s.rows.length < r + i) s.rows.push([]); row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }),
    setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
}
class SS { constructor(sheets) { this.sheets = sheets; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } getSpreadsheetTimeZone() { return 'Asia/Tokyo'; } }

const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email','plan','billing_provider','billing_status','trial_start','trial_end','fincode_customer_id','fincode_subscription_id','billing_updated_at','billing_note'],
  ['capshop','キャップ店','SS_C','active','c@x.jp','','standard','manual','active','','','','','','']]);
const settings = new Sheet([['key','value','description','editable_by_tenant'],
  ['follow_days_after_ship','5','','TRUE'], ['go_live_date','2026-08-22','','FALSE'], ['dry_run','false','','FALSE'], ['exclude_orders','','','FALSE']]);
const hdr = ['order_number','order_date','buyer_key','masked_email','buyer_name','item_code','item_name','amount','purchase_count','prefecture','ship_date','status','review_linked'];
const N = 120;
const orderNo = i => `240364-20260901-${String(i).padStart(10, '0')}`;
const orders = new Sheet([hdr].concat(Array.from({ length: N }, (_, i) => [orderNo(i), '2026-09-01', 'b' + i, `m${i}@pc.fw.rakuten.ne.jp`, '客' + i, '', '', 1000, 1, '', '2026-09-01', 'shipped', ''])));
const sends = new Sheet([['send_id','order_number','buyer_key','type','sent_at','template_id','result']]);
const templates = new Sheet([['template_id','subject','body','updated_at'], ['follow_v1', '件名', '本文', ''], ['review_thanks_v1', '礼', '本文', '']]);
const reviews = new Sheet([['review_id','order_number','buyer_key','item_code','rating','posted_at','body']]);
const books = { MASTER: new SS({ tenants: master }), SS_C: new SS({ settings, templates, orders, sends, reviews }) };
const SpreadsheetApp = { openById: id => books[id] };
const sent = []; const fail = { n: 0 };
const ctx = { PropertiesService, CacheService, Utilities, Logger, SpreadsheetApp, console, isDryRun_: () => false, __sent: sent, __fail: fail };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'billing.gs', 'mailer.gs', 'review_thanks.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext(`
  getRmsCredentials = () => ({ shop_name: 'S', from_email: 'c@x.jp', from_name: 'S', reply_to: 'c@x.jp', cc_email: '', shop_signature: '署名' });
  sendViaBridge_ = (tenantId, to) => { if (__fail.n > 0) { __fail.n--; throw new Error('bridge down'); } __sent.push(to); return { ok: true }; };
`, ctx);
const clear = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
const setSetting = (k, v) => { const r = settings.rows.find(x => x[0] === k); if (r) r[1] = v; else settings.rows.push([k, v, '', 'FALSE']); clear(); };
const okFollow = () => sends.rows.slice(1).filter(r => r[3] === 'follow' && r[6] === 'sent').map(r => r[1]);

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };

console.log('max_sends_per_run');
t('getMaxSendsPerRun_: 未設定・不正は既定50、正の数はそのまま', () => {
  assert.equal(ctx.getMaxSendsPerRun_('capshop'), 50);
  [['', 50], ['abc', 50], ['0', 50], ['-3', 50], ['7', 7], ['7.9', 7]].forEach(([v, e]) => { setSetting('max_sends_per_run', v); assert.equal(ctx.getMaxSendsPerRun_('capshop'), e, v); });
  setSetting('max_sends_per_run', ''); });
t('既定50: 120件の対象でも1回目は50件だけ送る', () => {
  ctx.sendPendingMails('capshop'); assert.equal(sent.length, 50); assert.equal(okFollow().length, 50);
  assert.ok(logs.some(l => l.includes('上限 50 件に達した') && l.includes('70 件'))); });
t('次回以降に残りを送り、重複送信しない（sends の冪等性）: 50→100→120→120', () => {
  ctx.sendPendingMails('capshop'); assert.equal(sent.length, 100);
  ctx.sendPendingMails('capshop'); assert.equal(sent.length, 120);
  ctx.sendPendingMails('capshop'); assert.equal(sent.length, 120);
  const so = okFollow(); assert.equal(so.length, 120); assert.equal(new Set(so).size, 120, '同一注文に2回送っていない'); });
t('上限は settings で変更でき、dry_run は数えず送らない', () => {
  sends.rows.length = 1; sent.length = 0; setSetting('max_sends_per_run', '10');
  ctx.sendPendingMails('capshop'); assert.equal(sent.length, 10);
  setSetting('dry_run', 'true'); logs.length = 0; ctx.sendPendingMails('capshop'); assert.equal(sent.length, 10, 'dry_run では送らない');
  assert.equal(logs.filter(l => l.includes('[DRY_RUN]')).length, 110, 'dry_run は上限に関係なく全件ログ');
  setSetting('dry_run', 'false'); });
t('送信失敗も1回分に数え、失敗した注文は次回に再試行される', () => {
  sends.rows.length = 1; sent.length = 0; setSetting('max_sends_per_run', '5'); fail.n = 2;
  ctx.sendPendingMails('capshop'); assert.equal(sent.length, 3, '2件失敗＋3件成功で上限5');
  const errs = sends.rows.slice(1).filter(r => String(r[6]).startsWith('error')).map(r => r[1]); assert.equal(errs.length, 2);
  for (let i = 0; i < 30; i++) ctx.sendPendingMails('capshop');
  assert.equal(sent.length, 120, '最終的に全件送られる'); assert.equal(new Set(okFollow()).size, 120); assert.ok(errs.every(o => okFollow().includes(o)), '失敗分も再試行で送られた'); });

console.log('review_thanks にも上限');
t('sendPendingReviewThanks も1回あたり max_sends_per_run まで・再送しない', () => {
  sends.rows.length = 1; sent.length = 0; setSetting('max_sends_per_run', '4'); setSetting('review_thanks_since', '2026-09-01'); setSetting('review_thanks_min_rating', '3');
  for (let i = 0; i < 9; i++) reviews.appendRow([`R${i}`, orderNo(i), 'b', '', 5, '2026-09-10', '']);
  ctx.sendPendingReviewThanks('capshop'); assert.equal(sent.length, 4);
  ctx.sendPendingReviewThanks('capshop'); assert.equal(sent.length, 8);
  ctx.sendPendingReviewThanks('capshop'); assert.equal(sent.length, 9);
  ctx.sendPendingReviewThanks('capshop'); assert.equal(sent.length, 9, '送信済みには再送しない'); });

console.log('go_live_date の過去日検証');
t('checkGoLiveDateNotPast_: 空・不正・過去・当日・未来', () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
  assert.equal(ctx.checkGoLiveDateNotPast_('').error, 'empty'); assert.equal(ctx.checkGoLiveDateNotPast_('xx').error, 'invalid');
  assert.equal(ctx.checkGoLiveDateNotPast_('2020-01-01').error, 'past'); assert.equal(ctx.checkGoLiveDateNotPast_(today).ok, true); assert.equal(ctx.checkGoLiveDateNotPast_(tomorrow).ok, true); });
t('既存の保存値は検証されない: 過去の go_live_date(2026-08-22) のままでも sendPendingMails は従来どおり動く', () => {
  sends.rows.length = 1; sent.length = 0; setSetting('max_sends_per_run', '3'); ctx.sendPendingMails('capshop'); assert.equal(sent.length, 3); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
