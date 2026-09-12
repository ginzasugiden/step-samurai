// node tests/review_ingest_tests.js — ECOS Webhook 経由のレビュー自動取込（action=ingest_reviews）
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- GAS mock（review_thanks_tests.js と同等） ----
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

const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email'], ['tokyoflower','東京フラワー','SS_TF','active','info@tokyoflower.jp','']]);
const settings = new Sheet([['key','value','description','editable_by_tenant']]);
const reviews = new Sheet([['review_id','order_number','buyer_key','item_code','rating','posted_at','body']]);
const orders = new Sheet([['order_number','order_date','buyer_key','masked_email','buyer_name','item_code','item_name','amount','purchase_count','prefecture','ship_date','status','review_linked'],
  ['240364-20260901-0566501349','2026-09-01','b1','a@pc.fw.rakuten.ne.jp','山田','','',5000,1,'','2026-09-05','shipped',''],
]);
const sends = new Sheet([['send_id','order_number','buyer_key','type','sent_at','template_id','result']]);
const books = { MASTER: new SS({ tenants: master }), SS_TF: new SS({ settings, reviews, orders, sends }) };
const SpreadsheetApp = { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } };

const ctx = { PropertiesService, CacheService, Utilities, Logger, SpreadsheetApp, console, isDryRun_: () => props.DRY_RUN === 'true' };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'auth.gs', 'reviews_import.gs', 'review_thanks.gs', 'reviews_ingest.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
const rapi = load('rakuten_api.gs'); const li = rapi.indexOf('function linkOrdersReviews('); vm.runInContext(rapi.substring(li, rapi.indexOf('\n}\n', li) + 3), ctx);

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const clearCache = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);

const KEY = 'ecos-secret-key-12345';

const basePayload = () => ({
  tenant_id: 'tokyoflower',
  api_key: KEY,
  sync_id: 'run-0001',
  reviews: [
    { review_id: 'https://review.rakuten.co.jp/item/1/240364_10000409/ccl6-1/', order_number: '240364-20260901-0566501349',
      review_type: '商品レビュー', rating: 5, title: '', body: '写真の通り、とても綺麗でした。', posted_at: '2026-09-10 17:27:54',
      product_title: '＼銀座から贈る…', rakuten_item_id: '10000409', deleted: false },
    { review_id: 'https://review.rakuten.co.jp/shop/4/240364_240364/ccl6-2/', order_number: '240364-20260901-0566501349',
      review_type: 'ショップレビュー', rating: 4, title: 'とても良い', body: '対応が早かったです。', posted_at: '2026/09/11 10:00:00',
      product_title: '', rakuten_item_id: '', deleted: false },
    { review_id: 'https://review.rakuten.co.jp/item/1/240364_999/ccl6-3/', order_number: '240364-20260902-0000000001',
      review_type: '商品レビュー', rating: 5, title: '', body: '注文にない番号（unmatched検証用）', posted_at: '2026-09-09 09:00:00',
      product_title: 'テスト商品', rakuten_item_id: '999', deleted: false },
  ],
});

console.log('認証・有効化ゲート');
t('(a) キー未登録 → unauthorized', () => {
  const r = ctx.handleIngestReviews_(basePayload());
  assert.deepEqual(r, { ok: false, error: 'unauthorized' });
});
t('(b) キー不一致 → unauthorized', () => {
  ctx.PropertiesService.getScriptProperties().setProperty('REVIEW_INGEST_KEY__tokyoflower', KEY);
  const p = basePayload(); p.api_key = 'wrong-key';
  const r = ctx.handleIngestReviews_(p);
  assert.deepEqual(r, { ok: false, error: 'unauthorized' });
});
t('(c) review_ingest_enabled 未設定/false → review_ingest_disabled（キー正しくても）', () => {
  const r = ctx.handleIngestReviews_(basePayload());
  assert.deepEqual(r, { ok: false, error: 'review_ingest_disabled' });
});

console.log('取込・冪等性・削除フラグ・突合');
t('(d) 有効化後、3件 upsert → inserted=3、既存列順不変・追加列は末尾', () => {
  ctx.setTenantSettingValueAdmin_('tokyoflower', 'review_ingest_enabled', 'true');
  clearCache();
  const r = ctx.handleIngestReviews_(basePayload());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.inserted, 3);
  assert.equal(r.updated, 0);
  assert.equal(r.upserted, 3);
  assert.equal(reviews.rows.length, 4); // header + 3

  const header = reviews.rows[0];
  assert.deepEqual(header.slice(0, 7), ['review_id', 'order_number', 'buyer_key', 'item_code', 'rating', 'posted_at', 'body']);
  assert.deepEqual(header.slice(7), ['review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at', 'matched']);
});
t('(g) matched判定: orders にある注文番号はTRUE、無いのはFALSE', () => {
  const header = reviews.rows[0];
  const matchedIdx = header.indexOf('matched');
  const orderIdx = header.indexOf('order_number');
  const byOrder = on => reviews.rows.slice(1).filter(r => r[orderIdx] === on).map(r => r[matchedIdx]);
  assert.deepEqual(byOrder('240364-20260901-0566501349'), ['TRUE', 'TRUE']);
  assert.deepEqual(byOrder('240364-20260902-0000000001'), ['FALSE']);
});
t('(h) タイトルありは【タイトル】+本文、投稿日時はハイフン区切りに正規化', () => {
  const header = reviews.rows[0];
  const bodyIdx = header.indexOf('body'), postedIdx = header.indexOf('posted_at');
  const row2 = reviews.rows.find(r => r[bodyIdx].startsWith('【とても良い】'));
  assert.equal(row2[bodyIdx], '【とても良い】\n対応が早かったです。');
  assert.equal(row2[postedIdx], '2026-09-11 10:00:00'); // '2026/09/11 10:00:00' から正規化
});
t('(e) 同じpayloadの再送 → inserted=0 / updated=3（冪等）', () => {
  clearCache();
  const r = ctx.handleIngestReviews_(basePayload());
  assert.equal(r.ok, true);
  assert.equal(r.inserted, 0);
  assert.equal(r.updated, 3);
  assert.equal(reviews.rows.length, 4);
});
t('(f) deleted:true → deleted_at が入り、collectReviewsByOrder_ がその注文を除外する', () => {
  clearCache();
  const p = basePayload();
  p.reviews = [p.reviews[2]]; // unmatched の1件だけを削除フラグ付きで再送
  p.reviews[0].deleted = true;
  const r = ctx.handleIngestReviews_(p);
  assert.equal(r.ok, true);
  assert.equal(r.updated, 1);

  const header = reviews.rows[0];
  const orderIdx = header.indexOf('order_number'), deletedIdx = header.indexOf('deleted_at');
  const deletedRow = reviews.rows.find(row => row[orderIdx] === '240364-20260902-0000000001');
  assert.ok(String(deletedRow[deletedIdx]).trim() !== '', 'deleted_at が空のまま');

  const byOrder = ctx.collectReviewsByOrder_('tokyoflower');
  assert.ok(!byOrder['240364-20260902-0000000001'], '削除済みレビューの注文が対象に残っている');
  assert.ok(byOrder['240364-20260901-0566501349'], '削除していない注文まで消えている');
});
t('(復活) deleted:false を再送すると deleted_at がクリアされる', () => {
  clearCache();
  const p = basePayload();
  p.reviews = [p.reviews[2]];
  p.reviews[0].deleted = false;
  ctx.handleIngestReviews_(p);
  const header = reviews.rows[0];
  const orderIdx = header.indexOf('order_number'), deletedIdx = header.indexOf('deleted_at');
  const row = reviews.rows.find(r => r[orderIdx] === '240364-20260902-0000000001');
  assert.equal(row[deletedIdx], '');
});

console.log('入力検証');
t('(i) 501件 → invalid_payload', () => {
  clearCache();
  const p = basePayload();
  p.reviews = Array.from({ length: 501 }, (_, i) => ({
    review_id: `https://review.rakuten.co.jp/item/1/x_${i}/`, order_number: `ORDER-${i}`,
    review_type: '商品レビュー', rating: 5, title: '', body: 'x', posted_at: '2026-09-01 00:00:00', deleted: false,
  }));
  const r = ctx.handleIngestReviews_(p);
  assert.deepEqual(r, { ok: false, error: 'invalid_payload' });
});
t('reviews が配列でない → invalid_payload', () => {
  const p = basePayload(); p.reviews = 'not-an-array';
  const r = ctx.handleIngestReviews_(p);
  assert.deepEqual(r, { ok: false, error: 'invalid_payload' });
});

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
