/**
 * analytics_agg.gs — 集計ロジック（純粋関数）
 *
 * GAS の API（SpreadsheetApp / Utilities 等）には一切依存しない。
 * analytics_query.gs がシートを読んで正規化した plain object を渡し、ここで集計する。
 * そのため Node.js でそのまま単体テストできる。
 *
 * 入力（すべて文字列は JST の 'yyyy-MM-dd' / 'yyyy-MM-dd HH:mm:ss' に正規化済み）:
 *  orders : { order_number, order_date, order_datetime, buyer_key, masked_email, item_code, item_name,
 *             amount, units, purchase_count, prefecture, ship_date, status, review_linked, coupon_codes }
 *  reviews: { order_number, rating, posted_at }
 *  sends  : { order_number, type, sent_at, result }
 *  coupons: { coupon_id, buyer_key, issued_at, api_result }
 *  opts   : { from: 'yyyy-MM-dd', to: 'yyyy-MM-dd' }   両端含む・受注日基準
 *
 * 集計方針:
 *  - 母集団は「受注日が期間内」かつ status !== 'cancelled' の注文
 *  - 新規/リピート/不明: masked_email が無い注文は「不明」（buyer_key が注文番号のため同一人物判定不能）、
 *    purchase_count <= 1 を「新規」、それ以外を「リピート」
 *  - レビュー率 = レビュー紐づき注文 / 母集団。星分布は紐づいたレビューの rating
 *  - フォロー送信率 = フォローメール送信成功注文 / 発送済み母集団
 *  - クーポン利用率 = coupons タブ発行のコードが、その後の注文の coupon_codes に現れた数 / 発行数
 */

const AGG_LEAD_BUCKETS_ = [
  { label: '0-1日',  min: 0,  max: 1 },
  { label: '2-3日',  min: 2,  max: 3 },
  { label: '4-7日',  min: 4,  max: 7 },
  { label: '8-14日', min: 8,  max: 14 },
  { label: '15-30日', min: 15, max: 30 },
  { label: '31日+',  min: 31, max: Infinity },
];

function aggDateOnly_(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function aggHour_(datetime) {
  const m = String(datetime || '').match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}):/);
  return m ? Number(m[1]) : null;
}

function aggDaysBetween_(d1, d2) {
  const a = aggDateOnly_(d1), b = aggDateOnly_(d2);
  if (!a || !b) return null;
  const t1 = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const t2 = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((t2 - t1) / 86400000);
}

function aggWeekday_(dateStr) {
  const d = aggDateOnly_(dateStr);
  if (!d) return null;
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay(); // 0=日
}

function aggCustomerType_(o) {
  if (!o.masked_email) return 'unknown';
  return (Number(o.purchase_count) || 1) <= 1 ? 'new' : 'repeat';
}

function aggRate_(num, den) {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : 0; // 小数1桁の%
}

function computeAnalytics_(orders, reviews, sends, coupons, opts) {
  const from = aggDateOnly_(opts.from);
  const to   = aggDateOnly_(opts.to);
  const warnings = [];

  // ---- 母集団 ----
  const inPeriod = orders.filter(o => {
    const d = aggDateOnly_(o.order_date) || aggDateOnly_(o.order_datetime);
    return d && d >= from && d <= to;
  });
  const cancelled = inPeriod.filter(o => o.status === 'cancelled').length;
  const pop = inPeriod.filter(o => o.status !== 'cancelled');
  const popSet = new Set(pop.map(o => String(o.order_number)));
  const shipped = pop.filter(o => o.status === 'shipped' || (o.ship_date && o.status !== 'pending'));

  // ---- 基本 ----
  const sales = pop.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const goodsSales = pop.reduce((s, o) => s + (Number(o.goods_price) || 0), 0);
  const couponShop = pop.reduce((s, o) => s + (Number(o.coupon_shop_price) || 0), 0);
  const goodsMissing = pop.filter(o => !o.goods_price).length;
  if (pop.length > 0 && goodsMissing > 0) warnings.push(`商品代金(goods_price)が未取得の注文が ${goodsMissing}件あります（遡及取得前のデータ）。RMS準拠売上はそれらを含みません`);
  const units = pop.reduce((s, o) => s + (Number(o.units) || 0), 0);

  // ---- 顧客区分 ----
  const customer = { new: 0, repeat: 0, unknown: 0 };
  pop.forEach(o => { customer[aggCustomerType_(o)]++; });
  if (pop.length > 0 && customer.unknown / pop.length > 0.2) {
    warnings.push(`顧客区分「不明」が ${aggRate_(customer.unknown, pop.length)}% あります（メールアドレス未取得の注文）。新規/リピート比率は参考値です`);
  }

  // ---- 時間帯・曜日・日別 ----
  const hourlyOrders = Array(24).fill(0);
  const hourlySales  = Array(24).fill(0);
  const weekday      = Array(7).fill(0);
  let noTime = 0;
  const dailyMap = {};
  pop.forEach(o => {
    const h = aggHour_(o.order_datetime);
    if (h === null) noTime++; else { hourlyOrders[h]++; hourlySales[h] += Number(o.amount) || 0; }
    const w = aggWeekday_(o.order_date || o.order_datetime);
    if (w !== null) weekday[w]++;
    const d = aggDateOnly_(o.order_date) || aggDateOnly_(o.order_datetime);
    const rec = dailyMap[d] || (dailyMap[d] = { date: d, orders: 0, sales: 0, goods_sales: 0, new: 0, repeat: 0, unknown: 0 });
    rec.orders++; rec.sales += Number(o.amount) || 0; rec.goods_sales += Number(o.goods_price) || 0; rec[aggCustomerType_(o)]++;
  });
  if (noTime > 0) {
    warnings.push(`受注時刻が未取得の注文が ${noTime}件あります（遡及取得前のデータ）。時間帯別グラフはそれらを含みません`);
  }
  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // ---- フォローメール ----
  const followSentSet = new Set(
    sends.filter(s => s.type === 'follow' && String(s.result || '').toLowerCase() === 'sent')
         .map(s => String(s.order_number))
  );
  const followSent = pop.filter(o => followSentSet.has(String(o.order_number))).length;

  // ---- レビュー ----
  const reviewByOrder = {};
  reviews.forEach(r => {
    const n = String(r.order_number || '');
    if (n && popSet.has(n)) (reviewByOrder[n] = reviewByOrder[n] || []).push(r);
  });
  const reviewedOrders = Object.keys(reviewByOrder).length;
  const linkedButNoReview = pop.filter(o => o.review_linked && !reviewByOrder[String(o.order_number)]).length;
  const reviewedTotal = reviewedOrders + linkedButNoReview; // review_linked=true だが reviews 行が消えている場合も件数には含める

  const stars = [0, 0, 0, 0, 0]; // index0 = ★1
  const lead  = AGG_LEAD_BUCKETS_.map(b => ({ label: b.label, count: 0 }));
  const hourlyReviews = Array(24).fill(0);
  let reviewsWithTime = 0, reviewsTotal = 0;
  const orderByNum = {};
  pop.forEach(o => { orderByNum[String(o.order_number)] = o; });
  Object.keys(reviewByOrder).forEach(n => {
    reviewByOrder[n].forEach(r => {
      reviewsTotal++;
      const rating = Math.round(Number(r.rating));
      if (rating >= 1 && rating <= 5) stars[rating - 1]++;
      const h = aggHour_(r.posted_at);
      if (h !== null) { reviewsWithTime++; hourlyReviews[h]++; }
      const o = orderByNum[n];
      const days = aggDaysBetween_(o && (o.ship_date || o.order_date), r.posted_at);
      if (days !== null && days >= 0) {
        const b = AGG_LEAD_BUCKETS_.findIndex(x => days >= x.min && days <= x.max);
        if (b >= 0) lead[b].count++;
      }
    });
  });
  const reviewTimeRate = reviewsTotal > 0 ? reviewsWithTime / reviewsTotal : 0;

  // ---- クーポン ----
  const issued = coupons.filter(c => c.coupon_id && !String(c.api_result || '').startsWith('ERROR'));
  const issuedInPeriod = issued.filter(c => { const d = aggDateOnly_(c.issued_at); return d && d >= from && d <= to; });
  const usedCodes = new Set();
  orders.forEach(o => String(o.coupon_codes || '').split(',').map(s => s.trim()).filter(Boolean).forEach(c => usedCodes.add(c)));
  const couponsUsed = issuedInPeriod.filter(c => usedCodes.has(String(c.coupon_id))).length;

  // ---- 商品・都道府県 ----
  const itemMap = {}, prefMap = {};
  pop.forEach(o => {
    const k = o.item_name || o.item_code || '(不明)';
    const it = itemMap[k] || (itemMap[k] = { name: k, orders: 0, sales: 0 });
    it.orders++; it.sales += Number(o.amount) || 0;
    const p = o.prefecture || '(不明)';
    prefMap[p] = (prefMap[p] || 0) + 1;
  });
  const topItems = Object.values(itemMap).sort((a, b) => b.orders - a.orders).slice(0, 10);
  const topPrefs = Object.keys(prefMap).map(k => ({ name: k, orders: prefMap[k] })).sort((a, b) => b.orders - a.orders).slice(0, 10);

  // ---- 月別推移（期間内の月ごと） ----
  const monthlyMap = {};
  pop.forEach(o => {
    const ym = (aggDateOnly_(o.order_date) || aggDateOnly_(o.order_datetime)).slice(0, 7);
    const m = monthlyMap[ym] || (monthlyMap[ym] = { ym: ym, orders: 0, sales: 0, goods_sales: 0, new: 0, repeat: 0, unknown: 0, reviews: 0, follow_sent: 0 });
    m.orders++; m.sales += Number(o.amount) || 0; m.goods_sales += Number(o.goods_price) || 0; m[aggCustomerType_(o)]++;
    if (reviewByOrder[String(o.order_number)] || o.review_linked) m.reviews++;
    if (followSentSet.has(String(o.order_number))) m.follow_sent++;
  });
  const monthly = Object.values(monthlyMap).sort((a, b) => a.ym.localeCompare(b.ym));

  return {
    period: { from: from, to: to },
    summary: {
      orders:            pop.length,
      cancelled_excluded: cancelled,
      sales:             sales,
      goods_sales:       goodsSales,
      coupon_shop_total: couponShop,
      goods_sales_net:   goodsSales - couponShop,
      avg_order:         pop.length ? Math.round(sales / pop.length) : 0,
      units:             units,
      new:               customer.new,
      repeat:            customer.repeat,
      unknown:           customer.unknown,
      repeat_rate:       aggRate_(customer.repeat, customer.new + customer.repeat),
      shipped:           shipped.length,
      follow_sent:       followSent,
      follow_rate:       aggRate_(followSent, shipped.length),
      reviewed_orders:   reviewedTotal,
      review_rate:       aggRate_(reviewedTotal, pop.length),
      reviews_total:     reviewsTotal,
      avg_rating:        reviewsTotal ? Math.round((stars.reduce((s, c, i) => s + c * (i + 1), 0) / reviewsTotal) * 100) / 100 : 0,
      coupons_issued:    issuedInPeriod.length,
      coupons_used:      couponsUsed,
      coupon_use_rate:   aggRate_(couponsUsed, issuedInPeriod.length),
    },
    hourly_orders:  hourlyOrders,
    hourly_sales:   hourlySales,
    weekday_orders: weekday,
    daily:          daily,
    monthly:        monthly,
    star_dist:      stars,
    review_lead:    lead,
    hourly_reviews: reviewTimeRate >= 0.5 ? hourlyReviews : null,
    review_time_rate: Math.round(reviewTimeRate * 100),
    top_items:      topItems,
    top_prefectures: topPrefs,
    warnings:       warnings,
  };
}
