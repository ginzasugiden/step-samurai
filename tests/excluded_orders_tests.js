// node tests/excluded_orders_tests.js — 修正6: 店舗が除外注文を追加・削除できる。操作は自店のみ（サーバ側でセッションから強制）
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

let props = {};
const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
  deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) };
const cacheStore = {};
const CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) };
const Utilities = { formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0');
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
}
class SS { constructor(sheets, tz) { this.sheets = sheets; this.tz = tz || 'Asia/Tokyo'; }
  getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } getSpreadsheetTimeZone() { return this.tz; } }

const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email'],
  ['shopa','A店','SS_A','active','a@x.jp',''], ['shopb','B店','SS_B','active','b@x.jp',''], ['shopc','C店(停止)','SS_C','disabled','c@x.jp','']]);
const mkSettings = ex => new Sheet([['key','value','description','editable_by_tenant'], ['follow_days_after_ship','5','','TRUE'], ['go_live_date','2026-08-22','','FALSE'], ['dry_run','false','','FALSE'], ['exclude_orders', ex, '', 'FALSE']]);
const setA = mkSettings(''), setB = mkSettings('111111-20260101-0000000001'), setC = mkSettings('');
const books = { MASTER: new SS({ tenants: master }), SS_A: new SS({ settings: setA }), SS_B: new SS({ settings: setB }), SS_C: new SS({ settings: setC }) };
const SpreadsheetApp = { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } };
props.TENANT_MASTER_SHEET_ID = 'MASTER'; props.EXCLUDE_ORDERS = '999999-20250101-9999999999';   // 旧グローバル値（tokyoflower 互換用。他店には効かない）
let lockHeld = false, lockAvailable = true;
const LockService = { getScriptLock: () => ({ tryLock: () => { if (!lockAvailable) return false; lockHeld = true; return true; }, releaseLock: () => { lockHeld = false; } }) };
const tokens = { 'tok-a': 'shopa', 'tok-b': 'shopb', 'tok-c': 'shopc' };
const ctx = { PropertiesService, CacheService, Utilities, Logger, SpreadsheetApp, LockService, console, isDryRun_: () => false, verifyTenantToken_: tk => tokens[tk] || null };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'webapp.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext('function jsonResponse_(o) { return o; }', ctx);
const act = (token, action, payload) => ctx.handleTenantAction_({ token, action, payload });
const val = (sheet, key) => sheet.rows.find(r => r[0] === key)[1];
const clear = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const N1 = '222222-20260301-0123456789', N2 = '222222-20260302-0123456780';

console.log('除外注文の追加・削除（店舗権限）');
t('追加すると自店の settings.exclude_orders に入り、一覧に出る（重複追加は1件のまま）', () => {
  assert.deepEqual(Array.from(act('tok-a', 'get_excluded_orders').orders), []);
  let r = act('tok-a', 'add_excluded_order', { order_number: N1 }); assert.equal(r.ok, true); assert.deepEqual(Array.from(r.orders), [N1]);
  r = act('tok-a', 'add_excluded_order', { order_number: N1 }); assert.deepEqual(Array.from(r.orders), [N1]);
  r = act('tok-a', 'add_excluded_order', { order_number: ' ' + N2 + ' ' }); assert.deepEqual(Array.from(r.orders), [N1, N2]);
  assert.equal(val(setA, 'exclude_orders'), `${N1},${N2}`); assert.deepEqual(Array.from(act('tok-a', 'get_excluded_orders').orders), [N1, N2]); });
t('削除できる（無い番号の削除は何も起きない）', () => {
  let r = act('tok-a', 'remove_excluded_order', { order_number: N1 }); assert.deepEqual(Array.from(r.orders), [N2]);
  r = act('tok-a', 'remove_excluded_order', { order_number: N1 }); assert.equal(r.ok, true); assert.deepEqual(Array.from(r.orders), [N2]); assert.equal(val(setA, 'exclude_orders'), N2); });
t('追加した注文は送信対象から外れる（getTenantExcludedOrders_）', () => { clear(); assert.ok(ctx.getTenantExcludedOrders_('shopa').has(N2)); assert.ok(!ctx.getTenantExcludedOrders_('shopa').has(N1)); });

console.log('他店への操作はサーバ側で拒否');
t('payload に他店の tenant_id を入れても、自店（セッションの店舗）だけが変わる', () => {
  const beforeB = val(setB, 'exclude_orders');
  const r = act('tok-a', 'add_excluded_order', { tenant_id: 'shopb', tenantId: 'shopb', order_number: N1 }); assert.equal(r.ok, true);
  assert.equal(val(setB, 'exclude_orders'), beforeB, 'B は変わらない'); assert.ok(val(setA, 'exclude_orders').includes(N1));
  const r2 = act('tok-a', 'remove_excluded_order', { tenant_id: 'shopb', order_number: '111111-20260101-0000000001' }); assert.equal(r2.ok, true); assert.equal(val(setB, 'exclude_orders'), beforeB, 'B の登録は消えない');
  const g = act('tok-a', 'get_excluded_orders', { tenant_id: 'shopb' }); assert.ok(!Array.from(g.orders).includes('111111-20260101-0000000001'), 'B の一覧は見えない'); });
t('トークン無し・不正トークンは unauthorized で何も書かない', () => {
  const snap = JSON.stringify([setA.rows, setB.rows]);
  ['', 'bad', null, undefined].forEach(tk => { ['get_excluded_orders', 'add_excluded_order', 'remove_excluded_order'].forEach(a => assert.equal(act(tk, a, { order_number: N1 }).error, 'unauthorized')); });
  assert.equal(JSON.stringify([setA.rows, setB.rows]), snap); });
t('disabled の店舗のセッションは自店の設定にも触れない（シートに到達できず例外→internal_error）', () => {
  const r = act('tok-c', 'add_excluded_order', { order_number: N1 }); assert.notEqual(r.ok, true); assert.equal(val(setC, 'exclude_orders'), ''); });

console.log('入力検証');
t('注文番号の形式が不正なら拒否（カンマ・改行・式・短すぎる値・空）', () => {
  const before = val(setA, 'exclude_orders');
  ['', 'abc', '1,2', `${N1},${N2}`, '=HYPERLINK("x")', '222222-2026-1', `${N1}\n${N2}`, '<script>', '222222-20260301-12'].forEach(v => assert.equal(act('tok-a', 'add_excluded_order', { order_number: v }).error, 'invalid_order_number', JSON.stringify(v)));
  assert.equal(act('tok-a', 'add_excluded_order', {}).error, 'invalid_order_number'); assert.equal(val(setA, 'exclude_orders'), before); });
t('件数の上限（500件）', () => {
  const many = Array.from({ length: 500 }, (_, i) => `333333-20260101-${String(1000 + i).padStart(10, '0')}`); setB.rows.find(r => r[0] === 'exclude_orders')[1] = many.join(','); clear();
  assert.equal(act('tok-b', 'add_excluded_order', { order_number: N1 }).error, 'too_many_excluded_orders');
  assert.equal(act('tok-b', 'remove_excluded_order', { order_number: many[0] }).ok, true); assert.equal(act('tok-b', 'add_excluded_order', { order_number: N1 }).ok, true); });
t('ロック: 取れなければ busy（書かない）、取れたら必ず解放する', () => {
  lockAvailable = false; const before = val(setA, 'exclude_orders'); assert.equal(act('tok-a', 'add_excluded_order', { order_number: N1 + '9' }).error === undefined, false);
  lockAvailable = true; assert.equal(val(setA, 'exclude_orders'), before);
  lockAvailable = false; assert.equal(act('tok-a', 'add_excluded_order', { order_number: '222222-20260909-0000000009' }).error, 'busy'); lockAvailable = true;
  act('tok-a', 'add_excluded_order', { order_number: '222222-20260909-0000000009' }); assert.equal(lockHeld, false, 'ロックを解放している'); });
t('旧グローバル EXCLUDE_ORDERS は他店の一覧に出ない・店舗の画面から消せない', () => {
  assert.ok(!Array.from(act('tok-a', 'get_excluded_orders').orders).includes('999999-20250101-9999999999')); });
t('exclude_orders 行が無い店舗でも追加でき、行が作られる（setting 定義に従う）', () => {
  const noRow = new Sheet([['key','value','description','editable_by_tenant'], ['follow_days_after_ship','5','','TRUE']]); books.SS_A.sheets.settings = noRow; clear();
  const r = act('tok-a', 'add_excluded_order', { order_number: N1 }); assert.equal(r.ok, true); assert.equal(noRow.rows.find(x => x[0] === 'exclude_orders')[1], N1); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
