// node tests/multitenant_tests.js — テナント別ガード / レビューCSV取込 / 管理者ステータス制御
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- GAS mock ----
let props = {};
const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
  deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) };
const cacheStore = {};
const CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) };
const Utilities = { formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0');
  const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; } };
const Logger = { log: () => {} };
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
  ['tokyoflower','東京フラワー','SS_TF','active','info@tokyoflower.jp',''],
  ['demo','デモ店','SS_DEMO','setup','demo@example.jp',''],
  ['gone','退会店','SS_GONE','disabled','x@example.jp','']]);
const tenantAuth = new Sheet([['tenant_id','token_hash','issued_at','status'],['tokyoflower','h1','2026-01-01','active']]);
const settingsTF = new Sheet([['key','value','description','editable_by_tenant'],['follow_days_after_ship','5','','TRUE'],['coupon_valid_days','30','','TRUE']]);
const settingsDemo = new Sheet([['key','value','description','editable_by_tenant'],['follow_days_after_ship','3','','TRUE'],['go_live_date','','','FALSE'],['dry_run','true','','FALSE']]);
const reviewsDemo = new Sheet([['review_id','order_number','buyer_key','item_code','rating','posted_at','body']]);
const ordersDemo = new Sheet([['order_number','order_date','buyer_key','masked_email','buyer_name','item_code','item_name','amount','purchase_count','prefecture','ship_date','status','review_linked'],
  ['D-1','2026-08-01','b','m@fw','','','',1000,1,'','2026-08-02','shipped','false']]);
const books = { MASTER: new SS({ tenants: master, tenant_auth: tenantAuth }), SS_TF: new SS({ settings: settingsTF }), SS_DEMO: new SS({ settings: settingsDemo, reviews: reviewsDemo, orders: ordersDemo }) };
const SpreadsheetApp = { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } };
props.TENANT_MASTER_SHEET_ID = 'MASTER';

const ctx = { PropertiesService, CacheService, Utilities, Logger, SpreadsheetApp, console, isDryRun_: () => props.DRY_RUN === 'true' };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'reviews_import.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
// rakuten_api の linkOrdersReviews だけ抜き出して評価
const rapi = load('rakuten_api.gs'); const li = rapi.indexOf('function linkOrdersReviews('); vm.runInContext(rapi.substring(li, rapi.indexOf('\n}\n', li) + 3), ctx);

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const clearCache = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);

console.log('tenant status');
t('listActiveTenants は active のみ', () => assert.deepEqual(ctx.listActiveTenants().map(x => x.tenant_id), ['tokyoflower']));
t('getTenantSpreadsheet は setup も開ける', () => assert.ok(ctx.getTenantSpreadsheet('demo')));
t('getTenantSpreadsheet は disabled を拒否', () => assert.throws(() => ctx.getTenantSpreadsheet('gone')));
t('setTenantStatus_ は不正値を拒否', () => assert.equal(ctx.setTenantStatus_('demo', 'live').ok, false));

console.log('per-tenant guards');
t('go_live_date: tokyoflower は旧グローバルへフォールバック', () => { props.GO_LIVE_DATE = '2026-08-22'; clearCache(); assert.equal(ctx.getTenantGoLiveDate_('tokyoflower'), '2026-08-22'); });
t('go_live_date: 他テナントはフォールバックしない（fail-closed）', () => { clearCache(); assert.equal(ctx.getTenantGoLiveDate_('demo'), null); });
t('go_live_date: settings があればそれを優先', () => { settingsTF.appendRow(['go_live_date', '2026-09-01', '', 'FALSE']); clearCache(); assert.equal(ctx.getTenantGoLiveDate_('tokyoflower'), '2026-09-01'); });
t('dry_run: グローバル true は全テナント true', () => { props.DRY_RUN = 'true'; clearCache(); assert.equal(ctx.isTenantDryRun_('tokyoflower'), true); assert.equal(ctx.isTenantDryRun_('demo'), true); });
t('dry_run: グローバル false でも demo は settings.dry_run=true', () => { props.DRY_RUN = 'false'; clearCache(); assert.equal(ctx.isTenantDryRun_('demo'), true); });
t('dry_run: tokyoflower は settings 無しなら旧グローバルに従う(false)', () => { clearCache(); assert.equal(ctx.isTenantDryRun_('tokyoflower'), false); });
t('dry_run: settings が無い新テナントは安全側 true', () => { books.SS_X = new SS({ settings: new Sheet([['key','value','description','editable_by_tenant']]) }); master.appendRow(['x','X','SS_X','setup','x@x.jp','']); clearCache(); assert.equal(ctx.isTenantDryRun_('x'), true); });
t('exclude_orders: tokyoflower は旧グローバルと合算', () => { props.EXCLUDE_ORDERS = 'A,B'; settingsTF.appendRow(['exclude_orders', 'C', '', 'FALSE']); clearCache(); assert.deepEqual([...ctx.getTenantExcludedOrders_('tokyoflower')].sort(), ['A', 'B', 'C']); });
t('exclude_orders: demo はグローバルを見ない', () => { clearCache(); assert.equal(ctx.getTenantExcludedOrders_('demo').size, 0); });
t('signature: demo に旧 SHOP_SIGNATURE__OVERRIDE は効かない', () => { props.SHOP_SIGNATURE__OVERRIDE = 'LEGACY'; clearCache(); assert.equal(ctx.getTenantSignatureOverride_('demo'), null); assert.equal(ctx.buildSignature_('デモ店', '1', 'demo').indexOf('LEGACY'), -1); });
t('ensureTenantSettingsKeys_: 不足キーを追記、既存は触らない', () => { clearCache(); const added = ctx.ensureTenantSettingsKeys_('demo'); assert.ok(added.includes('exclude_orders')); assert.ok(!added.includes('go_live_date')); assert.equal(settingsDemo.rows.find(r => r[0] === 'follow_days_after_ship')[1], '3'); assert.equal(ctx.ensureTenantSettingsKeys_('demo').length, 0); });
t('setTenantSettingValueAdmin_: 編集不可キーも管理者は書ける', () => { clearCache(); assert.equal(ctx.setTenantSettingValueAdmin_('demo', 'go_live_date', '2026-10-01').ok, true); clearCache(); assert.equal(ctx.getTenantGoLiveDate_('demo'), '2026-10-01'); });
t('setTenantSettingValue_(テナント): 編集不可キーは拒否', () => assert.equal(ctx.setTenantSettingValue_('demo', 'go_live_date', '2020-01-01').error, 'not_editable'));

console.log('review csv import');
const csv = '\uFEFF"レビューID","投稿日時","商品管理番号","注文番号","総合評価","レビュー内容"\r\n"R1","2026/08/05 20:44:58","rose-10","D-1","5","とても良い, ""また買う"""\r\n"R2","2026-08-06","card","D-9","3","改行\r\nあり"\r\n';
t('parseCsv_: BOM/CRLF/クォート内改行/エスケープ', () => { const r = ctx.parseCsv_(csv); assert.equal(r.length, 3); assert.equal(r[1][5], 'とても良い, "また買う"'); assert.equal(r[2][5], '改行\nあり'); });
t('normalizeReviewDate_', () => { assert.equal(ctx.normalizeReviewDate_('2026/08/05 20:44:58'), '2026-08-05 20:44:58'); assert.equal(ctx.normalizeReviewDate_('2026年8月6日'), '2026-08-06'); });
t('preview は書き込まない', () => { const r = ctx.importReviewsFromCsv_('demo', csv, true); assert.equal(r.ok, true); assert.equal(r.valid_rows, 2); assert.equal(r.column_map.rating, '総合評価'); assert.equal(reviewsDemo.rows.length, 1); });
t('import は upsert し review_linked を更新', () => { const r = ctx.importReviewsFromCsv_('demo', csv, false); assert.equal(r.inserted, 2); assert.equal(reviewsDemo.rows.length, 3); assert.equal(ordersDemo.rows[1][12], 'true'); const r2 = ctx.importReviewsFromCsv_('demo', csv, false); assert.equal(r2.inserted, 0); assert.equal(r2.updated, 2); assert.equal(reviewsDemo.rows.length, 3); });
t('必須列が無ければ拒否', () => { const r = ctx.importReviewsFromCsv_('demo', 'a,b\n1,2\n', true); assert.equal(r.error, 'csv_columns_not_recognized'); });
t('review_id が無い CSV は注文番号＋日時から生成', () => { const r = ctx.importReviewsFromCsv_('demo', '注文番号,評価,投稿日\nD-1,4,2026/08/07\n', true); assert.equal(r.sample[0].review_id, 'csv_D-1_20260807'); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
