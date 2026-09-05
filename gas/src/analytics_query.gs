/**
 * analytics_query.gs — 分析データの取得（シート読み込み → 正規化 → 集計 → キャッシュ）
 *
 * webapp.gs の handleTenantAction_ から 'get_analytics' で呼ばれる。
 * payload: { from: 'yyyy-MM-dd', to: 'yyyy-MM-dd' }（省略時は今年1/1〜今日）
 * 結果は tenant + 期間ごとに CacheService で5分キャッシュ（管理画面の再描画で毎回シートを読まない）。
 *
 * 安全設計:
 *  - 読み取り専用。シートへの書き込みは一切しない
 *  - tenantId は verifyTenantToken_ で解決済みのものだけが渡される（payload の tenant_id は無視）
 *  - 集計結果に個人情報（氏名・メールアドレス）は含めない
 */

const ANALYTICS_CACHE_TTL_SEC_ = 300;
const ANALYTICS_MAX_RANGE_DAYS_ = 400;

function analyticsDateStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return aggDateOnly_(String(v));
}

function analyticsDatetimeStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  return String(v);
}

function analyticsBool_(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

/** シートを {header→値} の plain object 配列に変換（空行除外） */
function analyticsReadSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0].map(h => String(h || ''));
  return data.slice(1)
    .filter(row => row.some(v => v !== '' && v !== null))
    .map(row => header.reduce((obj, h, i) => { if (h) obj[h] = row[i]; return obj; }, {}));
}

function normalizeOrders_(rows) {
  return (rows || []).map(r => ({
    order_number:   String(r.order_number || ''),
    order_date:     analyticsDateStr_(r.order_date),
    order_datetime: analyticsDatetimeStr_(r.order_datetime),
    buyer_key:      String(r.buyer_key || ''),
    masked_email:   String(r.masked_email || ''),
    item_code:      String(r.item_code || ''),
    item_name:      String(r.item_name || ''),
    amount:         Number(r.amount) || 0,
    goods_price:    Number(r.goods_price) || 0,
    coupon_shop_price: Number(r.coupon_shop_price) || 0,
    units:          Number(r.units) || 0,
    purchase_count: Number(r.purchase_count) || 1,
    prefecture:     String(r.prefecture || ''),
    ship_date:      analyticsDateStr_(r.ship_date),
    status:         String(r.status || ''),
    review_linked:  analyticsBool_(r.review_linked),
    coupon_codes:   String(r.coupon_codes || ''),
  })).filter(o => o.order_number);
}

function normalizeReviews_(rows) {
  return (rows || []).map(r => ({
    order_number: String(r.order_number || ''),
    rating:       Number(r.rating) || 0,
    posted_at:    analyticsDatetimeStr_(r.posted_at),
  }));
}

function normalizeSends_(rows) {
  return (rows || []).map(r => ({
    order_number: String(r.order_number || ''),
    type:         String(r.type || ''),
    sent_at:      analyticsDatetimeStr_(r.sent_at),
    result:       String(r.result || ''),
  }));
}

function normalizeCoupons_(rows) {
  return (rows || []).map(r => ({
    coupon_id:  String(r.coupon_id || ''),
    buyer_key:  String(r.buyer_key || ''),
    issued_at:  analyticsDatetimeStr_(r.issued_at),
    api_result: String(r.api_result || ''),
  }));
}

/** 期間の妥当性チェック。不正なら {ok:false,error} */
function analyticsResolvePeriod_(payload) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const from  = aggDateOnly_(payload.from) || today.slice(0, 4) + '-01-01';
  const to    = aggDateOnly_(payload.to)   || today;
  if (from > to) return { ok: false, error: 'invalid_period' };
  if (aggDaysBetween_(from, to) > ANALYTICS_MAX_RANGE_DAYS_) return { ok: false, error: 'period_too_long' };
  return { ok: true, from: from, to: to };
}

/**
 * 分析結果を返す（webapp.gs から呼ばれる本体）。
 */
function getAnalytics_(tenantId, payload) {
  const period = analyticsResolvePeriod_(payload || {});
  if (!period.ok) return period;

  const cache    = CacheService.getScriptCache();
  const cacheKey = `analytics__${tenantId}__${period.from}__${period.to}`;
  if (!(payload && payload.nocache)) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const ss      = getTenantSpreadsheet(tenantId);
  const orders  = normalizeOrders_(analyticsReadSheet_(ss, 'orders'));
  const reviews = normalizeReviews_(analyticsReadSheet_(ss, 'reviews'));
  const sends   = normalizeSends_(analyticsReadSheet_(ss, 'sends'));
  const coupons = normalizeCoupons_(analyticsReadSheet_(ss, 'coupons'));

  const result = computeAnalytics_(orders, reviews, sends, coupons, { from: period.from, to: period.to });
  result.ok = true;
  result.generated_at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  const json = JSON.stringify(result);
  if (json.length < 90000) { // CacheService の1件上限(100KB)を超える場合はキャッシュしない
    try { cache.put(cacheKey, json, ANALYTICS_CACHE_TTL_SEC_); } catch (e) { /* キャッシュ失敗は無視 */ }
  }
  return result;
}

// =========================================================
// 事前プローブ（読み取り専用）
// 分析の前提がデータ上で成り立つかを確認する。go-live 前に1回実行してログを確認する。
// =========================================================
function probeAnalyticsTokyoflower() {
  const rows = probeAnalytics_('tokyoflower');
  Logger.log('\n| 項目 | 値 |\n|---|---|\n' + rows.map(r => `| ${r[0]} | ${r[1]} |`).join('\n'));
}

/**
 * 分析の前提がデータ上で成り立つかを確認する（読み取り専用）。
 * 戻り値は [[項目, 値], ...]。GASエディタ用ラッパーと管理者API（probe_tenant）の両方から使う。
 */
function probeAnalytics_(tenantId) {
  const ss = getTenantSpreadsheet(tenantId);
  const out = [];
  const line = (k, v) => out.push([k, v]);

  line('p0_spreadsheet_timezone', ss.getSpreadsheetTimeZone());
  const ordersSheet = ss.getSheetByName('orders');
  const header = ordersSheet ? ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0].map(String) : [];
  line('p1_analytics_columns_present', ANALYTICS_ORDER_COLUMNS_.map(c => `${c}=${header.indexOf(c) >= 0}`).join(' '));

  const orders = normalizeOrders_(analyticsReadSheet_(ss, 'orders'));
  const dates  = orders.map(o => o.order_date).filter(Boolean).sort();
  line('p2_orders_rows', orders.length);
  line('p2_orders_date_range', dates.length ? `${dates[0]} 〜 ${dates[dates.length - 1]}` : '-');
  line('p2_status_counts', JSON.stringify(orders.reduce((m, o) => { m[o.status] = (m[o.status] || 0) + 1; return m; }, {})));
  line('p3_order_datetime_hasTimeRate', orders.length ? `${Math.round(orders.filter(o => aggHour_(o.order_datetime) !== null).length / orders.length * 100)}%` : '-');
  line('p3_goods_price_filledRate', orders.length ? `${Math.round(orders.filter(o => o.goods_price > 0).length / orders.length * 100)}%` : '-');
  line('p4_masked_email_missingRate', orders.length ? `${Math.round(orders.filter(o => !o.masked_email).length / orders.length * 100)}%` : '-');
  line('p4_purchase_count_gt1', orders.filter(o => o.purchase_count > 1).length);

  const reviews = normalizeReviews_(analyticsReadSheet_(ss, 'reviews'));
  const orderSet = new Set(orders.map(o => o.order_number));
  line('p5_reviews_rows', reviews.length);
  line('p5_postedAt_hasTimeRate', reviews.length ? `${Math.round(reviews.filter(r => aggHour_(r.posted_at) !== null).length / reviews.length * 100)}%` : '-');
  line('p5_rating_dist', JSON.stringify(reviews.reduce((m, r) => { m[r.rating] = (m[r.rating] || 0) + 1; return m; }, {})));
  line('p5_reviews_matched_to_orders', reviews.filter(r => orderSet.has(r.order_number)).length);

  const sends = normalizeSends_(analyticsReadSheet_(ss, 'sends'));
  line('p6_sends_rows', sends.length);
  line('p6_sends_result_counts', JSON.stringify(sends.reduce((m, s) => { const k = `${s.type}/${s.result.split(':')[0]}`; m[k] = (m[k] || 0) + 1; return m; }, {})));

  const coupons = normalizeCoupons_(analyticsReadSheet_(ss, 'coupons'));
  line('p7_coupons_rows', coupons.length);
  line('p7_coupon_codes_in_orders', orders.filter(o => o.coupon_codes).length);

  const t0 = Date.now();
  const res = getAnalytics_(tenantId, { nocache: true });
  line('p8_getAnalytics_ms', Date.now() - t0);
  line('p8_summary', JSON.stringify(res.summary || res));
  line('p8_warnings', (res.warnings || []).join(' / ') || '-');
  return out;
}

/**
 * テナントシートのタイムゾーンを Asia/Tokyo に揃える（表示上の整合のため。集計は Date 型で行うので必須ではない）。
 * 既存の order_date / ship_date は 'yyyy-MM-dd' の日付のみで、TZ 変更で日付が変わることはない。
 */
function fixSpreadsheetTimezoneTokyoflower() {
  const ss = getTenantSpreadsheet('tokyoflower');
  const before = ss.getSpreadsheetTimeZone();
  if (before === 'Asia/Tokyo') { Logger.log('既に Asia/Tokyo です'); return; }
  ss.setSpreadsheetTimeZone('Asia/Tokyo');
  Logger.log(`タイムゾーンを ${before} → ${ss.getSpreadsheetTimeZone()} に変更しました`);
}
