/**
 * rakuten_api.gs — 楽天 WEB API連携
 *
 * 楽天ペイ受注API v1 を使用。
 * 認証ヘッダ: ESA <base64(serviceSecret:licenseKey)>
 */

const RMS_BASE = 'https://api.rms.rakuten.co.jp/es/2.0';

function getRmsAuthHeader_(tenantId) {
  const creds = getRmsCredentials(tenantId);
  const token = Utilities.base64Encode(`${creds.service_secret}:${creds.license_key}`);
  return { 'Authorization': `ESA ${token}` };
}

// 受注取得（注文日ベース + 出荷完了報告日ベースの2軸・過去7日差分）→ ordersタブへupsert
// 配達日指定（母の日・誕生日・命日等）で注文から7日以上あとに発送される注文は、
// 注文日ベースの検索窓だけでは発送後に再取得されず ship_date が空のまま残る。
// そのため「直近7日に出荷完了報告された注文」(dateType:5) も併せて取得しマージする。
function fetchOrders(tenantId) {
  const ss     = getTenantSpreadsheet(tenantId);
  const sheet  = ss.getSheetByName('orders');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx    = col => header.indexOf(col);

  const dateFrom = new Date(); dateFrom.setDate(dateFrom.getDate() - 7);
  const dateTo   = new Date();

  const byOrderDate = searchOrderNumbers_(tenantId, 1, dateFrom, dateTo); // 1=注文日
  const byShipDate  = searchOrderNumbers_(tenantId, 5, dateFrom, dateTo); // 5=出荷完了報告日
  const orderNumbers = [...new Set([...byOrderDate, ...byShipDate])];

  if (orderNumbers.length === 0) { Logger.log('fetchOrders: 新規受注なし'); return; }

  // getOrder は1リクエスト最大100件のためチャンク分割して取得
  const orders = [];
  chunk_(orderNumbers, 100).forEach(chunkNums => {
    const detailRes = UrlFetchApp.fetch(`${RMS_BASE}/order/getOrder/`, {
      method:      'post',
      contentType: 'application/json; charset=UTF-8',
      headers:     getRmsAuthHeader_(tenantId),
      payload:     JSON.stringify({ orderNumberList: chunkNums, version: 7 }),
      muteHttpExceptions: true,
    });
    if (detailRes.getResponseCode() !== 200) {
      Logger.log(`fetchOrders getOrder error (${chunkNums.length}件): ${detailRes.getContentText()}`);
      return;
    }
    const detail = JSON.parse(detailRes.getContentText());
    (detail.OrderModelList || []).forEach(o => orders.push(o));
  });

  orders.forEach(order => upsertOrder_(sheet, idx, order));
  recomputePurchaseCounts_(sheet, idx);
  Logger.log(`fetchOrders [${tenantId}]: ${orders.length}件取得（注文日軸${byOrderDate.length}件/出荷報告軸${byShipDate.length}件）`);
}

// searchOrder を指定 dateType で実行し orderNumberList を返す（エラー時は空配列 = fail-closed）
function searchOrderNumbers_(tenantId, dateType, dateFrom, dateTo) {
  const searchBody = {
    dateType:          dateType,
    startDatetime:     formatRmsDate_(dateFrom),
    endDatetime:       formatRmsDate_(dateTo),
    orderProgressList: [100, 200, 300, 400, 500, 600, 700],
    PaginationRequestModel: { requestRecordsAmount: 1000, requestPage: 1 },
  };
  const res = UrlFetchApp.fetch(`${RMS_BASE}/order/searchOrder/`, {
    method:      'post',
    contentType: 'application/json; charset=UTF-8',
    headers:     getRmsAuthHeader_(tenantId),
    payload:     JSON.stringify(searchBody),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log(`searchOrderNumbers_ error (dateType=${dateType}): ${res.getContentText()}`);
    return [];
  }
  return JSON.parse(res.getContentText()).orderNumberList || [];
}

function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function upsertOrder_(sheet, idx, order) {
  const data = sheet.getDataRange().getValues();
  const existingRow = data.findIndex((row, i) =>
    i > 0 && row[idx('order_number')] === order.orderNumber
  );

  const orderer     = order.OrdererModel || {};
  const buyerKey    = orderer.emailAddress || order.orderNumber;
  const maskedEmail = orderer.emailAddress || '';
  const pkg         = order.PackageModelList?.[0] || {};
  const item        = pkg.ItemModelList?.[0] || {};
  const shipDate    = pkg.ShippingModelList?.[0]?.shippingDate || pkg.shippingDate || '';
  const status      = mapOrderStatus_(order.orderProgress);

  const rowData = Array(13).fill('');
  rowData[idx('order_number')]   = order.orderNumber;
  rowData[idx('order_date')]     = (order.orderDatetime || '').substring(0, 10);
  rowData[idx('buyer_key')]      = buyerKey;
  rowData[idx('masked_email')]   = maskedEmail;
  rowData[idx('buyer_name')]     = `${orderer.familyName || ''}${orderer.firstName || ''}`;
  rowData[idx('item_code')]      = item.itemNumber || '';
  rowData[idx('item_name')]      = item.itemName || '';
  rowData[idx('amount')]         = order.totalPrice || 0;
  rowData[idx('purchase_count')] = 1; // 仮値。fetchOrders末尾のrecomputePurchaseCounts_で全行再計算される
  rowData[idx('prefecture')]     = orderer.prefecture || pkg.SenderModel?.prefecture || '';
  rowData[idx('ship_date')]      = shipDate;
  rowData[idx('status')]         = status;
  rowData[idx('review_linked')]  = existingRow > 0
    ? sheet.getRange(existingRow + 1, idx('review_linked') + 1).getValue()
    : 'false';

  if (existingRow > 0) {
    sheet.getRange(existingRow + 1, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

function mapOrderStatus_(progress) {
  // 楽天ペイ受注API orderProgress:
  //  100:注文確認待ち 200:楽天処理中 300:発送待ち 400:変更確定待ち
  //  500:発送済 600:支払手続き中 700:支払手続き済 800:キャンセル確定待ち 900:キャンセル確定
  // 300/400は未発送のため pending。600/700は後払い等で発送後に遷移するため shipped 扱い
  // （ship_date空ガードが最終防衛線として機能する）。
  // 旧実装は 300/400 を shipped にしていたため「shippedなのにship_date空」の注文を量産していた。
  const map = {
    100: 'pending', 200: 'pending', 300: 'pending', 400: 'pending',
    500: 'shipped', 600: 'shipped', 700: 'shipped',
    800: 'cancelled', 900: 'cancelled',
  };
  return map[progress] || 'pending';
}

function formatRmsDate_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss'+0900'");
}

// レビュー取得 → reviewsタブへupsert
// 2026-07-05: /es/2.0/review/list/ がエラー404を返すことを確認（本番DRY_RUN確認時）。恒久原因（エンドポイント仕様変更/廃止か）は未調査。
// レビューデータは Selenium版 review_fetcher.py が reviews シートへ直接書き込む運用に一本化されており、
// linkOrdersReviews() は reviews シートを直接読むため、この関数が動かなくてもクーポン判定には影響しない。
// 恒久対応（正しいAPI仕様の確認・復旧）まで本体を無効化。
function fetchReviews(tenantId) {
  /*
  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('reviews');
  const creds = getRmsCredentials(tenantId);

  const res = UrlFetchApp.fetch(
    `${RMS_BASE}/review/list/?serviceSecret=${encodeURIComponent(creds.service_secret)}&licenseKey=${encodeURIComponent(creds.license_key)}`,
    { muteHttpExceptions: true }
  );

  if (res.getResponseCode() !== 200) {
    Logger.log(`fetchReviews error: ${res.getContentText()}`);
    return;
  }

  const result  = JSON.parse(res.getContentText());
  const reviews = result.reviewList || [];
  reviews.forEach(review => upsertReview_(sheet, review));
  Logger.log(`fetchReviews [${tenantId}]: ${reviews.length}件取得`);
  */
  Logger.log(`fetchReviews [${tenantId}]: 無効化中（Selenium版 review_fetcher.py が reviews シートを直接更新するため未使用）`);
}

function upsertReview_(sheet, review) {
  const data = sheet.getDataRange().getValues();
  const existingRow = data.findIndex((row, i) =>
    i > 0 && row[0] === String(review.reviewId)
  );
  const rowData = [
    String(review.reviewId),
    review.orderNumber  || '',
    review.reviewerCode || '',
    review.itemNumber   || '',
    review.rating       || 0,
    review.postedDate   || '',
    review.body         || '',
  ];
  if (existingRow > 0) {
    sheet.getRange(existingRow + 1, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

// orders ⇄ reviews を order_number で突合
function linkOrdersReviews(tenantId) {
  const ss      = getTenantSpreadsheet(tenantId);
  const orders  = ss.getSheetByName('orders');
  const reviews = ss.getSheetByName('reviews');

  const reviewMap = {};
  reviews.getDataRange().getValues().slice(1).forEach(row => {
    if (row[1]) reviewMap[row[1]] = true;
  });

  const orderData   = orders.getDataRange().getValues();
  const header      = orderData[0];
  const linkedIdx   = header.indexOf('review_linked');
  const orderNumIdx = header.indexOf('order_number');

  orderData.slice(1).forEach((row, i) => {
    if (reviewMap[row[orderNumIdx]]) {
      orders.getRange(i + 2, linkedIdx + 1).setValue('true');
    }
  });
}

// クーポン発行（楽天Coupon API v1 — XML形式）
// エンドポイント: POST https://api.rms.rakuten.co.jp/es/1.0/coupon/issue
// couponStartDate は最短60分後制約あり → 現在+65分で設定
function issueCoupon(tenantId, target) {
  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('coupons');

  const rule = getCouponRules_(tenantId).find(r => r.rule_id === target.rule_id);
  if (!rule) {
    Logger.log(`issueCoupon: rule not found [${target.rule_id}]`);
    return null;
  }

  const validDays = getCouponValidDays_(tenantId); // settings.coupon_valid_days（既定30日）
  const fmt   = d => Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss'+09:00'");
  const start = new Date(Date.now() + 65 * 60 * 1000);          // 現在+65分
  const end   = new Date(start.getTime() + validDays * 24 * 60 * 60 * 1000); // 開始+validDays日

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<request><couponIssueRequest><coupon>' +
    `<couponName>${escapeXml_(rule.coupon_name)}</couponName>` +
    '<couponCaption>レビュー投稿特典</couponCaption>' +
    `<couponStartDate>${fmt(start)}</couponStartDate>` +
    `<couponEndDate>${fmt(end)}</couponEndDate>` +
    '<issueCount>100</issueCount>' +
    '<itemType>4</itemType>' +
    '<discountType>1</discountType>' +
    `<discountFactor>${rule.discount}</discountFactor>` +
    '<memberAvailMaxCount>0</memberAvailMaxCount>' +
    '<purchaseHistoryCond><type>0</type></purchaseHistoryCond>' +
    '<multiRankCond><rankCond>0</rankCond></multiRankCond>' +
    '<ageRangeCond><lowerBound>0</lowerBound><upperBound>0</upperBound></ageRangeCond>' +
    '<birthmonthCond>0</birthmonthCond>' +
    '<multiPrefectureCond><prefectureCond>NONE</prefectureCond></multiPrefectureCond>' +
    '<combineFlag>1</combineFlag>' +
    '<displayFlag>0</displayFlag>' +
    '</coupon></couponIssueRequest></request>';

  const res  = UrlFetchApp.fetch('https://api.rms.rakuten.co.jp/es/1.0/coupon/issue', {
    method:      'post',
    contentType: 'text/xml; charset=UTF-8',
    headers:     getRmsAuthHeader_(tenantId),
    payload:     xml,
    muteHttpExceptions: true,
  });

  const body         = res.getContentText();
  Logger.log(`issueCoupon raw response [${tenantId}]: ${body}`);
  const systemStatus = (body.match(/<systemStatus>([^<]*)<\/systemStatus>/) || [])[1] || '';
  const couponCode   = (body.match(/<couponCode>([^<]*)<\/couponCode>/)   || [])[1] || '';
  const pcGetUrl     = (body.match(/<pcGetUrl>([^<]*)<\/pcGetUrl>/)       || [])[1] || '';
  const validUntilStr = Utilities.formatDate(end, 'Asia/Tokyo', 'yyyy/MM/dd');

  if (systemStatus !== 'OK' || !couponCode) {
    Logger.log(`issueCoupon FAILED [${tenantId}]: ${body}`);
    sheet.appendRow([
      '', target.buyer_key, target.rule_id,
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
      '', `ERROR: ${body.substring(0, 300)}`,
    ]);
    return null;
  }

  sheet.appendRow([
    couponCode, target.buyer_key, target.rule_id,
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    validUntilStr, `OK url=${pcGetUrl}`,
  ]);

  Logger.log(`issueCoupon OK [${tenantId}] coupon=${couponCode}`);
  return { coupon_id: couponCode, valid_until: validUntilStr, get_url: pcGetUrl, discount: rule.discount };
}

// XML特殊文字エスケープ
function escapeXml_(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

// =========================================================
// デバッグ用：getOrderの生レスポンスを1件分ログ出力
// 構造確認後は不要。実行して OrdererModel.emailAddress 等の実際のキーを確認する。
// =========================================================
function debugGetOrderRaw(tenantId) {
  tenantId = tenantId || 'tokyoflower';
  const dateFrom = new Date(); dateFrom.setDate(dateFrom.getDate() - 7);
  const dateTo   = new Date();

  const searchRes = UrlFetchApp.fetch(`${RMS_BASE}/order/searchOrder/`, {
    method:      'post',
    contentType: 'application/json; charset=UTF-8',
    headers:     getRmsAuthHeader_(tenantId),
    payload: JSON.stringify({
      dateType: 1,
      startDatetime: formatRmsDate_(dateFrom),
      endDatetime:   formatRmsDate_(dateTo),
      orderProgressList: [100,200,300,400,500,600,700],
      PaginationRequestModel: { requestRecordsAmount: 1, requestPage: 1 }
    }),
    muteHttpExceptions: true,
  });
  const orderNumbers = (JSON.parse(searchRes.getContentText()).orderNumberList || []).slice(0, 1);
  if (orderNumbers.length === 0) { Logger.log('受注なし'); return; }

  const detailRes = UrlFetchApp.fetch(`${RMS_BASE}/order/getOrder/`, {
    method:      'post',
    contentType: 'application/json; charset=UTF-8',
    headers:     getRmsAuthHeader_(tenantId),
    payload:     JSON.stringify({ orderNumberList: orderNumbers, version: 7 }),
    muteHttpExceptions: true,
  });

  const order = JSON.parse(detailRes.getContentText()).OrderModelList[0];
  // 重要フィールドだけ抜粋表示
  Logger.log('orderNumber: ' + order.orderNumber);
  Logger.log('OrdererModel: ' + JSON.stringify(order.OrdererModel));
  Logger.log('PackageModelList[0].ItemModelList[0].itemName: ' + (order.PackageModelList?.[0]?.ItemModelList?.[0]?.itemName));
  Logger.log(`ItemModelList[0] full: ${JSON.stringify(order.PackageModelList?.[0]?.ItemModelList?.[0] || {}, null, 2)}`);
}

/**
 * デバッグ用：指定した注文番号1件の getOrder 生レスポンスをログ出力する（読み取りのみ・副作用なし）。
 */
function debugGetOrderRawFor_(tenantId, orderNumber) {
  const detailRes = UrlFetchApp.fetch(`${RMS_BASE}/order/getOrder/`, {
    method:      'post',
    contentType: 'application/json; charset=UTF-8',
    headers:     getRmsAuthHeader_(tenantId),
    payload:     JSON.stringify({ orderNumberList: [orderNumber], version: 7 }),
    muteHttpExceptions: true,
  });

  const order = JSON.parse(detailRes.getContentText()).OrderModelList[0];
  Logger.log('orderNumber: ' + order.orderNumber);
  Logger.log('OrdererModel: ' + JSON.stringify(order.OrdererModel));
  Logger.log('PackageModelList[0].ItemModelList[0].itemName: ' + (order.PackageModelList?.[0]?.ItemModelList?.[0]?.itemName));
  Logger.log(`ItemModelList[0] full: ${JSON.stringify(order.PackageModelList?.[0]?.ItemModelList?.[0] || {}, null, 2)}`);
}

/**
 * orders シート全体を走査し、buyer_key ごとに order_date 昇順で
 * 「その注文が何回目の購入か」を purchase_count 列へ一括書き戻す。
 * キャンセル注文は回数にカウントしない。
 * 注意: buyer_key は現状マスクアドレス。同一顧客で注文間の安定性が未検証のため、
 * リピート判定の精度はこのキーの安定性に依存する（不安定と判明したら別キーへ移行）。
 */
function recomputePurchaseCounts_(sheet, idx) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  const rows = data.slice(1).map((row, i) => ({
    rowIndex:  i,
    buyerKey:  row[idx('buyer_key')],
    orderDate: String(row[idx('order_date')] || ''),
    orderNum:  String(row[idx('order_number')] || ''),
    cancelled: row[idx('status')] === 'cancelled',
  })).filter(r => r.orderNum);

  const byBuyer = {};
  rows.forEach(r => {
    (byBuyer[r.buyerKey] = byBuyer[r.buyerKey] || []).push(r);
  });

  const counts = new Array(data.length - 1).fill(null);
  Object.values(byBuyer).forEach(list => {
    list.sort((a, b) => (a.orderDate + a.orderNum).localeCompare(b.orderDate + b.orderNum));
    let n = 0;
    list.forEach(r => {
      if (!r.cancelled) n++;
      counts[r.rowIndex] = Math.max(n, 1);
    });
  });

  const colValues = counts.map((c, i) => [c === null ? data[i + 1][idx('purchase_count')] : c]);
  sheet.getRange(2, idx('purchase_count') + 1, colValues.length, 1).setValues(colValues);
}
