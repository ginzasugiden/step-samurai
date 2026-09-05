/**
 * analytics_schema.gs — 分析機能のためのスキーマ拡張
 *
 * orders タブに以下の列を追加する（既存列は一切変更しない。無い列だけ末尾に追加）。
 *   order_datetime    受注日時 'yyyy-MM-dd HH:mm:ss'（JST）。時間帯別集計の根拠
 *   units             注文内の合計点数
 *   coupon_shop_price 店舗負担クーポン割引額（RMS couponShopPrice）
 *   coupon_codes      使用クーポンコード（カンマ区切り）。coupons タブと突合して利用率を出す
 *
 * 列の追加は fetchOrders の冒頭から毎時呼ばれる（ヘッダ確認のみなので軽量・冪等）。
 * 既存の buildOrderRow_ はヘッダに存在する列だけを埋めるため、
 * この関数を実行しなくても既存機能は壊れない（新列が空のままになるだけ）。
 */

const ANALYTICS_ORDER_COLUMNS_ = ['order_datetime', 'units', 'coupon_shop_price', 'coupon_codes'];

/**
 * orders タブに分析用列が無ければ末尾に追加する（冪等）。
 * 戻り値: 追加した列名の配列
 */
function ensureAnalyticsColumns_(tenantId) {
  const ss     = getTenantSpreadsheet(tenantId);
  const sheet  = ss.getSheetByName('orders');
  if (!sheet) return [];
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const header  = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || ''));
  const missing = ANALYTICS_ORDER_COLUMNS_.filter(c => header.indexOf(c) < 0);
  if (missing.length === 0) return [];

  // ヘッダ末尾の空セルを考慮して「実ヘッダの最終位置」の次から書く
  let realLast = header.length;
  while (realLast > 0 && header[realLast - 1] === '') realLast--;
  sheet.getRange(1, realLast + 1, 1, missing.length).setValues([missing]);
  Logger.log(`ensureAnalyticsColumns_ [${tenantId}]: 列を追加 ${missing.join(', ')}`);
  return missing;
}

/** GASエディタ用ラッパー */
function ensureAnalyticsColumnsTokyoflower() {
  const added = ensureAnalyticsColumns_('tokyoflower');
  Logger.log(added.length ? `追加: ${added.join(', ')}` : '追加なし（すべて存在）');
}
