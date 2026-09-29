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
  // 分析用列（order_datetime 等）が無ければ末尾に追加（冪等・軽量）。失敗しても受注取得は続行する。
  try { ensureAnalyticsColumns_(tenantId); } catch (e) { Logger.log(`fetchOrders: ensureAnalyticsColumns_ skip: ${e.message}`); }

  const ss     = getTenantSpreadsheet(tenantId);
  const sheet  = ss.getSheetByName('orders');

  const dateFrom = new Date(); dateFrom.setDate(dateFrom.getDate() - 7);
  const dateTo   = new Date();

  const byOrderDate = searchOrderNumbers_(tenantId, 1, dateFrom, dateTo); // 1=注文日
  const byShipDate  = searchOrderNumbers_(tenantId, 5, dateFrom, dateTo); // 5=出荷完了報告日
  const orderNumbers = [...new Set([...byOrderDate, ...byShipDate])];

  if (orderNumbers.length > 0) {
    const orders = getOrdersByNumbers_(tenantId, orderNumbers);
    upsertOrdersBatch_(sheet, orders);
    Logger.log(`fetchOrders [${tenantId}]: ${orders.length}件取得（注文日軸${byOrderDate.length}件/出荷報告軸${byShipDate.length}件）`);
  } else {
    Logger.log('fetchOrders: 新規受注なし');
  }

  // 7日窓を過ぎてからキャンセルされた注文を検知して status='cancelled' に更新する。
  // searchOrder の通常検索は 100〜700 のみで 800/900 を含まないため、別途同期しないと
  // 「キャンセル済みなのに shipped のまま」の行が残り続ける（分析の母集団が狂う）。
  // 失敗しても受注取得・メール送信には影響させない。
  try {
    const n = syncCancelledOrders_(tenantId, sheet, 60);
    if (n > 0) Logger.log(`fetchOrders [${tenantId}]: キャンセル同期 ${n}件`);
  } catch (e) {
    Logger.log(`fetchOrders: syncCancelledOrders_ skip: ${e.message}`);
  }

  // purchase_count は upsert 後に全行再計算（キャンセル同期の結果も反映される）
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  recomputePurchaseCounts_(sheet, col => header.indexOf(col));
}

/**
 * getOrder を100件チャンクで呼び出し OrderModel の配列を返す（エラーチャンクはスキップ）。
 */
function getOrdersByNumbers_(tenantId, orderNumbers) {
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
      Logger.log(`getOrdersByNumbers_ error (${chunkNums.length}件): ${detailRes.getContentText()}`);
      return;
    }
    const detail = JSON.parse(detailRes.getContentText());
    (detail.OrderModelList || []).forEach(o => orders.push(o));
  });
  return orders;
}

/**
 * 直近 days 日に受注された注文のうちキャンセル(800/900)のものを RMS から取得し、
 * orders タブ上で status が cancelled 以外の行を 'cancelled' に更新する。戻り値は更新件数。
 */
function syncCancelledOrders_(tenantId, sheet, days) {
  const dateFrom = new Date(); dateFrom.setDate(dateFrom.getDate() - (days || 60));
  const dateTo   = new Date();
  const cancelled = new Set(searchOrderNumbers_(tenantId, 1, dateFrom, dateTo, [800, 900]));
  if (cancelled.size === 0) return 0;

  const data      = sheet.getDataRange().getValues();
  const header    = data[0];
  const numIdx    = header.indexOf('order_number');
  const statusIdx = header.indexOf('status');
  let updated = 0;
  for (let i = 1; i < data.length; i++) {
    if (cancelled.has(String(data[i][numIdx])) && data[i][statusIdx] !== 'cancelled') {
      sheet.getRange(i + 1, statusIdx + 1).setValue('cancelled');
      updated++;
    }
  }
  return updated;
}

// searchOrder を指定 dateType で実行し orderNumberList を返す（エラー時は空配列 = fail-closed）
function searchOrderNumbers_(tenantId, dateType, dateFrom, dateTo, progressList) {
  const all = [];
  for (let page = 1; page <= 20; page++) { // 20ページ×1000件を上限とする安全弁
    const searchBody = {
      dateType:          dateType,
      startDatetime:     formatRmsDate_(dateFrom),
      endDatetime:       formatRmsDate_(dateTo),
      orderProgressList: progressList || [100, 200, 300, 400, 500, 600, 700],
      PaginationRequestModel: { requestRecordsAmount: 1000, requestPage: page },
    };
    const res = UrlFetchApp.fetch(`${RMS_BASE}/order/searchOrder/`, {
      method:      'post',
      contentType: 'application/json; charset=UTF-8',
      headers:     getRmsAuthHeader_(tenantId),
      payload:     JSON.stringify(searchBody),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(`searchOrderNumbers_ error (dateType=${dateType}, page=${page}): ${res.getContentText()}`);
      return all; // 途中まで取れた分は返す（fail-closed寄り）
    }
    const list = JSON.parse(res.getContentText()).orderNumberList || [];
    all.push(...list);
    if (list.length < 1000) break;
  }
  return all;
}

function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 注文1件分の行データをヘッダ基準で組み立てる。
 * - ヘッダに存在する列だけを埋める（列追加・列順変更に追従。固定長配列は使わない）
 * - existingRow が渡された場合、ここで扱わない列（review_linked や将来の手入力列）は既存値を保持する
 * 旧実装は Array(13).fill('') で行を作っていたため、列を追加すると upsert のたびに空で上書きされていた。
 */
function buildOrderRow_(header, order, existingRow) {
  const row = existingRow ? existingRow.slice() : [];
  while (row.length < header.length) row.push('');
  const set = (col, v) => { const i = header.indexOf(col); if (i >= 0) row[i] = v; };

  const orderer     = order.OrdererModel || {};
  const buyerKey    = orderer.emailAddress || order.orderNumber;
  const maskedEmail = orderer.emailAddress || '';
  const pkgs        = order.PackageModelList || [];
  const pkg         = pkgs[0] || {};
  const item        = (pkg.ItemModelList || [])[0] || {};
  const shipDate    = pkg.ShippingModelList?.[0]?.shippingDate || pkg.shippingDate || '';
  const status      = mapOrderStatus_(order.orderProgress);

  let units = 0;
  pkgs.forEach(p => (p.ItemModelList || []).forEach(it => { units += Number(it.units) || 0; }));

  set('order_number',   order.orderNumber);
  set('order_date',     (order.orderDatetime || '').substring(0, 10));
  set('order_datetime', formatOrderDatetime_(order.orderDatetime));
  set('buyer_key',      buyerKey);
  set('masked_email',   maskedEmail);
  set('buyer_name',     `${orderer.familyName || ''}${orderer.firstName || ''}`);
  set('item_code',      item.itemNumber || '');
  set('item_name',      item.itemName || '');
  set('amount',         order.totalPrice || 0);
  set('units',          units);
  set('coupon_shop_price', Number(order.couponShopPrice) || 0);
  set('coupon_codes',   (order.CouponModelList || []).map(c => c.couponCode).filter(Boolean).join(','));
  set('goods_price',    Number(order.goodsPrice) || 0);
  set('prefecture',     orderer.prefecture || pkg.SenderModel?.prefecture || '');
  set('ship_date',      shipDate);
  set('status',         status);
  if (!existingRow) {
    set('purchase_count', 1); // 仮値。fetchOrders末尾の recomputePurchaseCounts_ で全行再計算される
    set('review_linked',  'false');
  }
  return row;
}

/**
 * RMS の orderDatetime（例 2026-08-27T10:15:30+0900）を Date 型で返す。
 * 文字列で書くとスプレッドシートのタイムゾーン設定で解釈されて時刻がずれるため、
 * 絶対時刻である Date 型のまま書き込む（読み出し側は Utilities.formatDate で JST に変換する）。
 */
function formatOrderDatetime_(raw) {
  if (!raw) return '';
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? '' : d;
}

/**
 * 複数注文を一括 upsert する（シート読み込み1回・書き込みは既存行の更新＋新規行のまとめ追加）。
 * 旧 upsertOrder_ は1件ごとに全体を読み直していたため、遡及取得（月1000件）では6分制限に抵触する。
 */
function upsertOrdersBatch_(sheet, orders) {
  if (!orders || orders.length === 0) return { updated: 0, inserted: 0 };
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(h => String(h || ''));
  const numIdx = header.indexOf('order_number');
  const rowByNum = {};
  for (let i = 1; i < data.length; i++) {
    const n = data[i][numIdx];
    if (n) rowByNum[String(n)] = i;
  }

  const newRows = [];
  let updated = 0;
  orders.forEach(order => {
    const i = rowByNum[String(order.orderNumber)];
    if (i !== undefined) {
      const existing = data[i].slice(); while (existing.length < header.length) existing.push('');
      const row = buildOrderRow_(header, order, existing);
      sheet.getRange(i + 1, 1, 1, header.length).setValues([row]);
      updated++;
    } else {
      newRows.push(buildOrderRow_(header, order, null));
    }
  });
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, header.length).setValues(newRows);
  }
  return { updated: updated, inserted: newRows.length };
}

/** 互換用：1件だけ upsert（新規コードは upsertOrdersBatch_ を使うこと） */
function upsertOrder_(sheet, idx, order) {
  upsertOrdersBatch_(sheet, [order]);
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

const COUPON_MIN_LEAD_MINUTES_ = 60;

/**
 * クーポン発行リクエストXMLの組み立てと検証（副作用なし）。
 * 構造は公開モデル bububa/rakuten-go の coupon/issue.go（CouponToIssue）と照合済み。itemType=4（受注）固定。
 * p: { name, caption, start(Date), end(Date), issueCount, discountType(1定額/2定率), discountFactor, memberAvailMaxCount, now(省略可) }
 * 戻り値: { ok, xml, errors[] }
 */
function buildCouponIssueXml_(p) {
  const errors = [];
  const now = p.now || new Date();
  const int = v => Number.isInteger(Number(v)) ? Number(v) : NaN;
  if (!p.name)    errors.push('couponName は必須');
  if (!p.caption) errors.push('couponCaption は必須');
  if (!(p.start instanceof Date) || isNaN(p.start.getTime())) errors.push('couponStartDate が不正');
  else if (p.start.getTime() < now.getTime() + COUPON_MIN_LEAD_MINUTES_ * 60 * 1000) errors.push(`couponStartDate は現在+${COUPON_MIN_LEAD_MINUTES_}分以上先にすること`);
  if (!(p.end instanceof Date) || isNaN(p.end.getTime())) errors.push('couponEndDate が不正');
  else if (p.start instanceof Date && p.end.getTime() <= p.start.getTime()) errors.push('couponEndDate は開始より後にすること');
  if (!(int(p.issueCount) >= 1)) errors.push('issueCount は1以上の整数');
  if (![1, 2].includes(int(p.discountType))) errors.push('discountType は 1（定額）か 2（定率）');
  if (!(int(p.discountFactor) >= 1)) errors.push('discountFactor は1以上の整数');
  if (int(p.discountType) === 2 && int(p.discountFactor) > 99) errors.push('定率の discountFactor は99以下');
  if (!(int(p.memberAvailMaxCount) >= 0)) errors.push('memberAvailMaxCount は0以上の整数');
  if (errors.length) return { ok: false, xml: '', errors: errors };

  const fmt = d => Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss'+09:00'");
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<request><couponIssueRequest><coupon>' +
    `<couponName>${escapeXml_(p.name)}</couponName>` +
    `<couponCaption>${escapeXml_(p.caption)}</couponCaption>` +
    `<couponStartDate>${fmt(p.start)}</couponStartDate>` +
    `<couponEndDate>${fmt(p.end)}</couponEndDate>` +
    `<issueCount>${int(p.issueCount)}</issueCount>` +
    '<itemType>4</itemType>' +
    `<discountType>${int(p.discountType)}</discountType>` +
    `<discountFactor>${int(p.discountFactor)}</discountFactor>` +
    `<memberAvailMaxCount>${int(p.memberAvailMaxCount)}</memberAvailMaxCount>`;
  const tail = '</coupon></couponIssueRequest></request>';
  // variant（2026-07-05 に "Request data is wrong format" で失敗した従来形 legacy が、余分な条件要素
  //  ageRangeCond 0/0・multiPrefectureCond=NONE を含むことが疑わしいため、最小構成を用意）
  //  minimal  : 動作実績のある他実装（JakeJP/Rakuten.RMS.Api のサンプル）と同じ最小項目 + multiRankCond
  //  go_model : bububa/rakuten-go の CouponToIssue が常に出力する項目（purchaseHistoryCond>type, birthmonthCond）まで
  //  legacy   : 従来形（既定。挙動を変えない）
  const variant = p.variant || 'legacy';
  let cond;
  if (variant === 'minimal') {
    cond = '<multiRankCond><rankCond>0</rankCond></multiRankCond><combineFlag>0</combineFlag><displayFlag>0</displayFlag>';
  } else if (variant === 'go_model') {
    cond = '<purchaseHistoryCond><type>0</type></purchaseHistoryCond><multiRankCond><rankCond>0</rankCond></multiRankCond>' +
           '<birthmonthCond>0</birthmonthCond><combineFlag>1</combineFlag><displayFlag>0</displayFlag>';
  } else {
    cond = '<purchaseHistoryCond><type>0</type></purchaseHistoryCond>' +
           '<multiRankCond><rankCond>0</rankCond></multiRankCond>' +
           '<ageRangeCond><lowerBound>0</lowerBound><upperBound>0</upperBound></ageRangeCond>' +
           '<birthmonthCond>0</birthmonthCond>' +
           '<multiPrefectureCond><prefectureCond>NONE</prefectureCond></multiPrefectureCond>' +
           '<combineFlag>1</combineFlag><displayFlag>0</displayFlag>';
  }
  return { ok: true, xml: head + cond + tail, errors: [] };
}

/** クーポンAPIへ POST する（ゲート判定は呼び出し側）。応答の systemStatus / couponCode / pcGetUrl を返す */
function postCouponIssue_(tenantId, xml) {
  const res = UrlFetchApp.fetch('https://api.rms.rakuten.co.jp/es/1.0/coupon/issue', {
    method:      'post',
    contentType: 'text/xml; charset=UTF-8',
    headers:     getRmsAuthHeader_(tenantId),
    payload:     xml,
    muteHttpExceptions: true,
  });
  const body = res.getContentText();
  const pick = tag => (body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || '';
  const systemStatus = pick('systemStatus'), couponCode = pick('couponCode');
  return { ok: systemStatus === 'OK' && !!couponCode, http_code: res.getResponseCode(), systemStatus: systemStatus,
           couponCode: couponCode, pcGetUrl: pick('pcGetUrl'), body: body };
}

// クーポン発行（楽天Coupon API v1 — XML形式）
// エンドポイント: POST https://api.rms.rakuten.co.jp/es/1.0/coupon/issue
// couponStartDate は最短60分後制約あり → 現在+65分で設定
/**
 * opts（省略可・テスト専用）:
 *   force      … true なら settings.coupon_enabled ゲートだけを通す（課金ガードは常に有効。settings は変更しない）
 *   params     … { name, caption, start, end, issueCount, discountType, discountFactor, memberAvailMaxCount, variant } ルール由来の値を上書き
 *   testRunId  … 指定すると結果を coupons ではなく sends に coupon_test_{runId} として記録する
 *   out        … 渡したオブジェクトへ { xml, body, ok, variant } を書き戻す（失敗時のレスポンス全文の報告用）
 * 通常運用（opts なし）の挙動は従来どおり。force はテスト専用で、パイプラインからは渡さない。
 */
function issueCoupon(tenantId, target, opts) {
  opts = opts || {};
  // 課金ガード・クーポン有効化ゲート（いずれも fail-closed。未設定は発行しない）
  if (!billingAllows_(tenantId)) { Logger.log(`issueCoupon skip [${tenantId}]: billing_not_allowed`); return null; }
  if (opts.force !== true && !isTenantCouponEnabled_(tenantId)) { Logger.log(`issueCoupon skip [${tenantId}]: settings.coupon_enabled が true ではない（fail-closed）`); return null; }

  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName(opts.testRunId ? 'sends' : 'coupons');
  const nowStr = () => Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  // 記録: 通常は coupons（coupon_id, buyer_key, rule_id, issued_at, valid_until, api_result）、テストは sends（coupon_test_{runId}）
  const record = (code, validUntil, result) => {
    if (opts.testRunId) sheet.appendRow([`coupon_test_${opts.testRunId}`, `coupon_test_${opts.testRunId}`, '', 'coupon_test', nowStr(), 'coupon_test', code ? `OK couponCode=${code} ${result}` : result]);
    else sheet.appendRow([code, target.buyer_key, target.rule_id, nowStr(), validUntil, result]);
  };

  let params, discount;
  if (opts.params) { params = opts.params; discount = params.discountFactor; }
  else {
    const rule = getCouponRules_(tenantId).find(r => r.rule_id === target.rule_id);
    if (!rule) {
      Logger.log(`issueCoupon: rule not found [${target.rule_id}]`);
      return null;
    }
    const validDays = getCouponValidDays_(tenantId); // settings.coupon_valid_days（既定30日）
    const start = new Date(Date.now() + 65 * 60 * 1000);          // 現在+65分
    const end   = new Date(start.getTime() + validDays * 24 * 60 * 60 * 1000); // 開始+validDays日
    params = { name: rule.coupon_name, caption: 'レビュー投稿特典', start: start, end: end,
               issueCount: 100, discountType: 1, discountFactor: rule.discount, memberAvailMaxCount: 0 };
    discount = rule.discount;
  }

  const built = buildCouponIssueXml_(params);
  if (opts.out) opts.out.variant = params.variant || 'legacy';
  if (!built.ok) {
    Logger.log(`issueCoupon FAILED [${tenantId}]: request validation: ${built.errors.join(' / ')}`);
    record('', '', `ERROR: validation: ${built.errors.join(' / ').substring(0, 250)}`);
    if (opts.out) { opts.out.ok = false; opts.out.body = `validation: ${built.errors.join(' / ')}`; opts.out.xml = ''; }
    return null;
  }

  const r = postCouponIssue_(tenantId, built.xml);
  if (opts.out) { opts.out.ok = r.ok; opts.out.xml = built.xml; opts.out.body = r.body; }
  Logger.log(`issueCoupon raw response [${tenantId}]: ${r.body}`);
  const validUntilStr = Utilities.formatDate(params.end, 'Asia/Tokyo', 'yyyy/MM/dd');

  if (!r.ok) {
    Logger.log(`issueCoupon FAILED [${tenantId}]: ${r.body}`);
    record('', '', `ERROR${opts.out ? ' [' + opts.out.variant + ']' : ''}: ${r.body.substring(0, 300)}`);
    return null;
  }

  record(r.couponCode, validUntilStr, opts.testRunId ? `url=${r.pcGetUrl} variant=${opts.out ? opts.out.variant : ''}` : `OK url=${r.pcGetUrl}`);
  Logger.log(`issueCoupon OK [${tenantId}] coupon=${r.couponCode}`);
  return { coupon_id: r.couponCode, valid_until: validUntilStr, get_url: r.pcGetUrl, discount: discount };
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
