// node tests/run_tests.js  — analytics_agg / buildOrderRow_ / upsertOrdersBatch_ / syncCancelledOrders_ のテスト
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- GAS mock ----
const logs = [];
const Utilities = {
  formatDate: (d, tz, fmt) => {
    const j = new Date(d.getTime() + 9 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`;
    if (fmt === 'yyyy-MM') return s.slice(0, 7);
    if (fmt === 'yyyy-MM-dd') return s;
    return `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`;
  },
  base64Encode: s => Buffer.from(s).toString('base64'),
};
const Logger = { log: m => logs.push(String(m)) };

class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); }
  getLastRow() { return this.rows.length; }
  getDataRange() { const self = this; return { getValues: () => self.rows.map(r => { const c = r.slice(); while (c.length < self.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) {
    const self = this;
    return {
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = self.rows[r - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '')); } return out; },
      getValue: () => (self.rows[r - 1] || [])[c - 1] ?? '',
      setValues: vals => { vals.forEach((v, i) => { while (self.rows.length < r + i) self.rows.push([]); const row = self.rows[r - 1 + i]; v.forEach((x, j) => { row[c - 1 + j] = x; }); }); },
      setValue: v => { while (self.rows.length < r) self.rows.push([]); self.rows[r - 1][c - 1] = v; },
    };
  }
}

// RMS mock
let rmsCancelled = [];
let fetchCalls = [];
const UrlFetchApp = { fetch: (url, opt) => {
  fetchCalls.push({ url, body: JSON.parse(opt.payload) });
  const body = JSON.parse(opt.payload);
  if (url.includes('searchOrder')) {
    const list = (body.orderProgressList.includes(900)) ? rmsCancelled : [];
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ orderNumberList: list }) };
  }
  return { getResponseCode: () => 500, getContentText: () => 'unexpected' };
}};
const getRmsAuthHeader_ = () => ({}); const getRmsCredentials = () => ({ service_secret: 's', license_key: 'l' });
const getTenantSpreadsheet = () => { throw new Error('not used in tests'); };
const ensureAnalyticsColumns_ = () => [];
const PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };

const ctx = { Utilities, Logger, UrlFetchApp, getRmsAuthHeader_, getRmsCredentials, getTenantSpreadsheet, ensureAnalyticsColumns_, PropertiesService, console };
const vm = require('vm');
vm.createContext(ctx);
['analytics_agg.gs', 'rakuten_api.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };

// ================= analytics_agg =================
console.log('analytics_agg');
const O = (n, d, extra) => Object.assign({ order_number: n, order_date: d.slice(0, 10), order_datetime: d.length > 10 ? d : '', buyer_key: 'b' + n, masked_email: 'x@fw', item_code: 'I', item_name: 'ばら', amount: 5000, units: 1, purchase_count: 1, prefecture: '東京都', ship_date: d.slice(0, 10), status: 'shipped', review_linked: false, coupon_codes: '' }, extra);
const base = [
  O('1', '2026-08-01 09:15:00'),
  O('2', '2026-08-01 21:30:00', { purchase_count: 2, amount: 8000 }),
  O('3', '2026-08-02 09:05:00', { masked_email: '', buyer_key: '3' }),
  O('4', '2026-08-03 12:00:00', { status: 'cancelled' }),
  O('5', '2026-07-31 23:59:00'),           // 期間外
  O('6', '2026-08-05', { review_linked: true }), // 時刻なし
];
const reviews = [
  { order_number: '1', rating: 5, posted_at: '2026-08-04 10:00:00' },
  { order_number: '2', rating: 3, posted_at: '2026-08-20' },
  { order_number: '9', rating: 1, posted_at: '2026-08-04' }, // 母集団外
];
const sends = [
  { order_number: '1', type: 'follow', sent_at: '2026-08-03 10:00:00', result: 'sent' },
  { order_number: '2', type: 'follow', sent_at: '2026-08-03 10:00:00', result: 'error: x' },
  { order_number: '4', type: 'follow', sent_at: '2026-08-03 10:00:00', result: 'sent' }, // キャンセル注文
];
const coupons = [
  { coupon_id: 'C1', buyer_key: 'b1', issued_at: '2026-08-05 10:00:00', api_result: 'OK' },
  { coupon_id: 'C2', buyer_key: 'b2', issued_at: '2026-08-05 10:00:00', api_result: 'OK' },
  { coupon_id: '',   buyer_key: 'b3', issued_at: '2026-08-05 10:00:00', api_result: 'ERROR: x' },
];
const ordersWithUse = base.concat([O('7', '2026-09-01 10:00:00', { coupon_codes: 'C1,ZZ' })]);
const r = ctx.computeAnalytics_(ordersWithUse, reviews, sends, coupons, { from: '2026-08-01', to: '2026-08-31' });

t('母集団: 期間内かつキャンセル除外', () => { assert.equal(r.summary.orders, 4); assert.equal(r.summary.cancelled_excluded, 1); });
t('売上・客単価', () => { assert.equal(r.summary.sales, 23000); assert.equal(r.summary.avg_order, 5750); });
t('新規/リピート/不明', () => { assert.equal(r.summary.new, 2); assert.equal(r.summary.repeat, 1); assert.equal(r.summary.unknown, 1); });
t('時間帯別: 時刻なし行は除外', () => { assert.equal(r.hourly_orders[9], 2); assert.equal(r.hourly_orders[21], 1); assert.equal(r.hourly_orders.reduce((a, b) => a + b), 3); });
t('時刻なし警告', () => assert.ok(r.warnings.some(w => w.includes('受注時刻'))));
t('フォロー送信率: sent のみ・キャンセル除外', () => { assert.equal(r.summary.follow_sent, 1); assert.equal(r.summary.follow_rate, 25); });
t('レビュー: 母集団内のみ + review_linked 補完', () => { assert.equal(r.summary.reviews_total, 2); assert.equal(r.summary.reviewed_orders, 3); assert.equal(r.summary.review_rate, 75); });
t('星分布', () => assert.deepEqual(r.star_dist, [0, 0, 1, 0, 1]));
t('平均評価', () => assert.equal(r.summary.avg_rating, 4));
t('レビュー時刻率50%で時間帯別レビューを出す', () => { assert.equal(r.review_time_rate, 50); assert.ok(r.hourly_reviews); assert.equal(r.hourly_reviews[10], 1); });
t('リードタイム分布', () => { const m = Object.fromEntries(r.review_lead.map(b => [b.label, b.count])); assert.equal(m['2-3日'], 1); assert.equal(m['15-30日'], 1); });
t('クーポン: 期間内発行2・利用1（期間外注文での利用も数える）', () => { assert.equal(r.summary.coupons_issued, 2); assert.equal(r.summary.coupons_used, 1); assert.equal(r.summary.coupon_use_rate, 50); });
t('日別', () => { assert.equal(r.daily.length, 3); assert.equal(r.daily[0].orders, 2); });
t('月別', () => { assert.equal(r.monthly.length, 1); assert.equal(r.monthly[0].reviews, 3); });
t('曜日別（2026-08-01は土曜）', () => assert.equal(r.weekday_orders[6], 2));
t('商品・都道府県上位', () => { assert.equal(r.top_items[0].orders, 4); assert.equal(r.top_prefectures[0].name, '東京都'); });
t('空データでも落ちない', () => { const e = ctx.computeAnalytics_([], [], [], [], { from: '2026-01-01', to: '2026-12-31' }); assert.equal(e.summary.orders, 0); assert.equal(e.summary.review_rate, 0); });
t('order_date が空でも order_datetime から日付を取る', () => { const e = ctx.computeAnalytics_([O('a', '2026-08-01 10:00:00', { order_date: '' })], [], [], [], { from: '2026-08-01', to: '2026-08-31' }); assert.equal(e.summary.orders, 1); });

// ================= buildOrderRow_ / upsertOrdersBatch_ =================
console.log('rakuten_api');
const HEADER13 = ['order_number','order_date','buyer_key','masked_email','buyer_name','item_code','item_name','amount','purchase_count','prefecture','ship_date','status','review_linked'];
const HEADER17 = HEADER13.concat(['order_datetime','units','coupon_shop_price','coupon_codes']);
const rmsOrder = (n, prog, extra) => Object.assign({
  orderNumber: n, orderDatetime: '2026-08-27T10:15:30+0900', orderProgress: prog, totalPrice: 6600, couponShopPrice: 300,
  OrdererModel: { emailAddress: 'm@pc.fw.rakuten.ne.jp', familyName: '山田', firstName: '花子', prefecture: '東京都' },
  PackageModelList: [{ ItemModelList: [{ itemNumber: 'rose-10', itemName: 'バラ10本', units: 2 }, { itemNumber: 'card', itemName: 'カード', units: 1 }], ShippingModelList: [{ shippingDate: '2026-08-28' }] }],
  CouponModelList: [{ couponCode: 'ABC' }],
}, extra);

t('buildOrderRow_: 17列ヘッダで全列が埋まる', () => {
  const row = ctx.buildOrderRow_(HEADER17, rmsOrder('N1', 500), null);
  const g = c => row[HEADER17.indexOf(c)];
  assert.equal(g('order_date'), '2026-08-27'); assert.equal(Object.prototype.toString.call(g('order_datetime')), '[object Date]'); assert.equal(Utilities.formatDate(g('order_datetime'),'Asia/Tokyo','yyyy-MM-dd HH:mm:ss'), '2026-08-27 10:15:30');
  assert.equal(g('units'), 3); assert.equal(g('coupon_shop_price'), 300); assert.equal(g('coupon_codes'), 'ABC');
  assert.equal(g('status'), 'shipped'); assert.equal(g('ship_date'), '2026-08-28'); assert.equal(g('review_linked'), 'false');
  assert.equal(g('purchase_count'), 1); assert.equal(row.length, 17);
});
t('buildOrderRow_: 13列ヘッダ（旧シート）でも壊れない', () => {
  const row = ctx.buildOrderRow_(HEADER13, rmsOrder('N1', 500), null);
  assert.equal(row.length, 13); assert.equal(row[HEADER13.indexOf('status')], 'shipped');
});
t('buildOrderRow_: 既存行の review_linked / purchase_count / 未知列を保持', () => {
  const header = HEADER17.concat(['memo']);
  const existing = ctx.buildOrderRow_(header, rmsOrder('N1', 300), null);
  existing[header.indexOf('review_linked')] = true; existing[header.indexOf('purchase_count')] = 3; existing[header.indexOf('memo')] = '手入力';
  const row = ctx.buildOrderRow_(header, rmsOrder('N1', 500), existing);
  assert.equal(row[header.indexOf('review_linked')], true); assert.equal(row[header.indexOf('purchase_count')], 3);
  assert.equal(row[header.indexOf('memo')], '手入力'); assert.equal(row[header.indexOf('status')], 'shipped');
});
t('upsertOrdersBatch_: 新規追加と既存更新、列追加後も既存値が消えない', () => {
  const sheet = new Sheet([HEADER17, ctx.buildOrderRow_(HEADER17, rmsOrder('N1', 300), null)]);
  sheet.rows[1][HEADER17.indexOf('review_linked')] = 'true';
  const res = ctx.upsertOrdersBatch_(sheet, [rmsOrder('N1', 500), rmsOrder('N2', 100)]);
  assert.deepEqual(res, { updated: 1, inserted: 1 });
  assert.equal(sheet.rows.length, 3);
  assert.equal(sheet.rows[1][HEADER17.indexOf('status')], 'shipped');
  assert.equal(sheet.rows[1][HEADER17.indexOf('review_linked')], 'true');
  assert.equal(sheet.rows[2][HEADER17.indexOf('order_number')], 'N2');
});
t('upsertOrdersBatch_: 冪等（同じ注文を2回入れても行が増えない）', () => {
  const sheet = new Sheet([HEADER17]);
  ctx.upsertOrdersBatch_(sheet, [rmsOrder('N1', 500)]);
  ctx.upsertOrdersBatch_(sheet, [rmsOrder('N1', 500)]);
  assert.equal(sheet.rows.length, 2);
});
t('mapOrderStatus_: 800/900 は cancelled', () => { assert.equal(ctx.mapOrderStatus_(800), 'cancelled'); assert.equal(ctx.mapOrderStatus_(900), 'cancelled'); });
t('syncCancelledOrders_: RMS で取消済みの行だけ cancelled にする', () => {
  const sheet = new Sheet([HEADER17, ctx.buildOrderRow_(HEADER17, rmsOrder('N1', 500), null), ctx.buildOrderRow_(HEADER17, rmsOrder('N2', 500), null)]);
  rmsCancelled = ['N2', 'N9']; fetchCalls = [];
  const n = ctx.syncCancelledOrders_('tokyoflower', sheet, 60);
  assert.equal(n, 1);
  assert.equal(sheet.rows[1][HEADER17.indexOf('status')], 'shipped');
  assert.equal(sheet.rows[2][HEADER17.indexOf('status')], 'cancelled');
  assert.deepEqual(fetchCalls[0].body.orderProgressList, [800, 900]);
});
t('syncCancelledOrders_: 取消なしなら0件・書き込みなし', () => {
  const sheet = new Sheet([HEADER17, ctx.buildOrderRow_(HEADER17, rmsOrder('N1', 500), null)]);
  rmsCancelled = [];
  assert.equal(ctx.syncCancelledOrders_('tokyoflower', sheet, 60), 0);
});
t('searchOrderNumbers_: 既定ステータスは 100-700', () => {
  fetchCalls = []; rmsCancelled = [];
  ctx.searchOrderNumbers_('t', 1, new Date(), new Date());
  assert.deepEqual(fetchCalls[0].body.orderProgressList, [100, 200, 300, 400, 500, 600, 700]);
  assert.equal(fetchCalls[0].body.PaginationRequestModel.requestPage, 1);
});
t('recomputePurchaseCounts_: キャンセルは回数に含めない', () => {
  const h = HEADER17;
  const rows = [h];
  const mk = (n, d, prog) => { const o = rmsOrder(n, prog, { orderDatetime: d }); return ctx.buildOrderRow_(h, o, null); };
  rows.push(mk('A1', '2026-06-01T10:00:00+0900', 500));
  rows.push(mk('A2', '2026-07-01T10:00:00+0900', 900));
  rows.push(mk('A3', '2026-08-01T10:00:00+0900', 500));
  const sheet = new Sheet(rows);
  ctx.recomputePurchaseCounts_(sheet, c => h.indexOf(c));
  const pc = i => sheet.rows[i][h.indexOf('purchase_count')];
  assert.equal(pc(1), 1); assert.equal(pc(2), 1); assert.equal(pc(3), 2);
});

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
