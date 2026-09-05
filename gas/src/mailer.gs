/**
 * mailer.gs — メール配信（あんしんメルアドSMTPブリッジ経由）
 *
 * 店舗情報（差出人・署名・問い合わせURL）は tenant.gs の
 * getRmsCredentials() が api_key シートから全自動導出する。
 */

function sendViaBridge_(tenantId, to, fromEmail, fromName, subject, body, htmlBody, replyTo, ccEmail) {
  const props  = PropertiesService.getScriptProperties();
  const url    = props.getProperty('BRIDGE_URL');
  const secret = props.getProperty('BRIDGE_SECRET');
  if (!url || !secret) throw new Error('BRIDGE_URL/BRIDGE_SECRET未設定');

  const payload = {
    tenant_id:  tenantId,
    to:         to,
    from_email: fromEmail,
    from_name:  fromName,
    subject:    subject,
    body:       body,
    html_body:  htmlBody || '',
    reply_to:   replyTo  || fromEmail,
    cc:         ccEmail  || '',
  };

  const res = UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'X-Bridge-Token': secret },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code    = res.getResponseCode();
  const bodyRes = JSON.parse(res.getContentText());
  if (code !== 200 || !bodyRes.ok) {
    throw new Error(`Bridge error ${code}: ${JSON.stringify(bodyRes)}`);
  }
  return bodyRes;
}

// =========================================================
// フォローメール（発送後N日後、Nは settings.follow_days_after_ship）
// =========================================================
function sendFollowMail(tenantId, order) {
  const ss    = getTenantSpreadsheet(tenantId);
  const sends = ss.getSheetByName('sends');
  if (alreadySent_(sends, order.order_number, 'follow')) return;

  const creds = getRmsCredentials(tenantId);
  const tpl   = getTenantTemplateRaw_(tenantId, 'follow_v1');
  if (!tpl) {
    Logger.log(`[${tenantId}] sendFollowMail: templates タブ or follow_v1 が見つからないためスキップ（fail-closed） order=${order.order_number}`);
    return;
  }

  const vars    = buildFollowMailVars_(order, creds);
  const subject = renderTemplate_(tpl.subject, vars);
  const body    = renderTemplate_(tpl.body, vars);
  const to      = resolveRecipient_(order.masked_email);

  if (isTenantDryRun_(tenantId)) {
    Logger.log(`[DRY_RUN] would send follow mail to ${to} (order=${order.order_number}) subject=${subject}`);
    return;
  }

  let result;
  try {
    result = sendViaBridge_(
      tenantId, to,
      creds.from_email, creds.from_name,
      subject, body, '', creds.reply_to, creds.cc_email
    );
    recordSend_(sends, order.order_number, order.buyer_key, 'follow', 'follow_v1', 'sent');
  } catch(e) {
    recordSend_(sends, order.order_number, order.buyer_key, 'follow', 'follow_v1', `error: ${e.message}`);
    throw e;
  }
  return result;
}

function buildFollowMailVars_(order, creds) {
  return {
    buyer_name:     order.buyer_name || 'お客様',
    shop_name:      creds.shop_name,
    ship_date:      formatShipDateJa_(order.ship_date),
    shop_signature: creds.shop_signature,
    review_url:     buildReviewUrl_(order.order_number),
  };
}

/**
 * ship_date（Date型/文字列いずれも可）を「yyyy/MM/dd」の日本語向け表記に整形する。
 * 値が無い/不正な場合は「先日」を返す（文面が破綻しないためのフォールバック）。
 */
function formatShipDateJa_(value) {
  const str = toJstDateString_(value); // config.gs の既存関数（yyyy-MM-dd を返す）
  if (!str) return '先日';
  return str.replace(/-/g, '/');
}

/**
 * 対象注文のレビュー投稿画面への直リンクを生成する。
 * key=注文番号のみ指定（subkey=内部商品IDは未保持のため省略。省略時は
 * 注文単位のレビュー画面に遷移し、そこから対象商品のレビューを書ける）。
 */
function buildReviewUrl_(orderNumber) {
  return `https://manager.review.rakuten.co.jp/?menu=write&act=id&service_id=1&key=${encodeURIComponent(orderNumber)}`;
}

// =========================================================
// クーポンメール
// =========================================================
function sendCouponMail(tenantId, order, coupon) {
  const ss    = getTenantSpreadsheet(tenantId);
  const sends = ss.getSheetByName('sends');
  if (alreadySent_(sends, order.order_number, 'coupon')) return;

  const creds = getRmsCredentials(tenantId);
  const tpl   = getTenantTemplateRaw_(tenantId, 'coupon_v1');
  if (!tpl) {
    Logger.log(`[${tenantId}] sendCouponMail: templates タブ or coupon_v1 が見つからないためスキップ（fail-closed） order=${order.order_number}`);
    return;
  }

  const vars    = buildCouponMailVars_(order, coupon, creds);
  const subject = renderTemplate_(tpl.subject, vars);
  const body    = renderTemplate_(tpl.body, vars);
  const to      = resolveRecipient_(order.masked_email);

  if (isTenantDryRun_(tenantId)) {
    Logger.log(`[DRY_RUN] would send coupon mail to ${to} (order=${order.order_number}, coupon=${coupon.coupon_id}) subject=${subject}`);
    return;
  }

  let result;
  try {
    result = sendViaBridge_(
      tenantId, to,
      creds.from_email, creds.from_name,
      subject, body, '', creds.reply_to, creds.cc_email
    );
    recordSend_(sends, order.order_number, order.buyer_key, 'coupon', 'coupon_v1', 'sent');
  } catch(e) {
    recordSend_(sends, order.order_number, order.buyer_key, 'coupon', 'coupon_v1', `error: ${e.message}`);
    throw e;
  }
  return result;
}

function buildCouponMailVars_(order, coupon, creds) {
  return {
    buyer_name:         order.buyer_name || 'お客様',
    shop_name:          creds.shop_name,
    discount:           (coupon.discount !== undefined && coupon.discount !== null) ? coupon.discount : '',
    coupon_valid_until: coupon.valid_until,
    coupon_get_url:     coupon.get_url || '',
    shop_signature:     creds.shop_signature,
  };
}

/**
 * 一時措置: 本番送信手前の監査で ship_date 不整合等が見つかった注文番号を、
 * 原因調査が終わるまで一時的にフォローメール対象から除外するための緊急ブレーキ。
 * Script Properties の EXCLUDE_ORDERS（カンマ区切りの order_number、未設定なら除外なし）を読む。
 * 恒久対応ではない。原因判明後は EXCLUDE_ORDERS を空にして通常運用に戻すこと。
 */
function getExcludedOrderNumbers_() {
  const raw = PropertiesService.getScriptProperties().getProperty('EXCLUDE_ORDERS');
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// 発送後N日経過した未送信フォローメールを全件処理（Nは settings.follow_days_after_ship）
function sendPendingMails(tenantId) {
  const ss     = getTenantSpreadsheet(tenantId);
  const orders = ss.getSheetByName('orders');
  const data   = orders.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);
  const now    = new Date();

  const goLiveDate = getTenantGoLiveDate_(tenantId);
  if (!goLiveDate) {
    Logger.log(`[${tenantId}] sendPendingMails: settings.go_live_date 未設定のため全スキップ（fail-closed）`);
    return;
  }

  const followDays = getFollowDaysAfterShip_(tenantId);
  if (followDays === null) {
    Logger.log(`[${tenantId}] sendPendingMails: settings.follow_days_after_ship 未設定/不正のため全スキップ（fail-closed）`);
    return;
  }

  const excludedOrders = getTenantExcludedOrders_(tenantId);

  data.slice(1).forEach(row => {
    if (!row[idx('order_number')]) return;
    const orderNumber = row[idx('order_number')];

    if (excludedOrders.has(orderNumber)) {
      Logger.log(`[${tenantId}] sendPendingMails: EXCLUDE_ORDERS設定によりスキップ（一時措置） order=${orderNumber}`);
      return;
    }

    if (row[idx('status')] === 'cancelled') return;
    const shipDate = row[idx('ship_date')];
    if (!shipDate) return;
    if (!isOnOrAfterGoLiveDate_(shipDate, goLiveDate)) return; // GO_LIVE_DATEより前に発送された注文は対象外（当日は含む）

    const diffDays = Math.floor((now - new Date(shipDate)) / (1000 * 60 * 60 * 24));
    if (diffDays < followDays) return;

    const order = {
      order_number: row[idx('order_number')],
      masked_email: row[idx('masked_email')],
      buyer_key:    row[idx('buyer_key')],
      buyer_name:   row[idx('buyer_name')] || '',
      ship_date:    shipDate,
      status:       row[idx('status')],
    };

    try {
      sendFollowMail(tenantId, order);
    } catch(e) {
      Logger.log(`sendFollowMail error [${order.order_number}]: ${e.message}`);
    }
  });
}

function alreadySent_(sendsSheet, orderNumber, type) {
  const data = sendsSheet.getDataRange().getValues();
  return data.slice(1).some(row =>
    row[1] === orderNumber && row[3] === type && !String(row[6]).startsWith('error')
  );
}

function recordSend_(sendsSheet, orderNumber, buyerKey, type, templateId, result) {
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  sendsSheet.appendRow([Utilities.getUuid(), orderNumber, buyerKey, type, now, templateId, result]);
}

// Phase 1疎通テスト（完了済み・残置）
function testSendToMaskedAddress() {
  Logger.log('Phase 1テスト完了済み');
}

/**
 * TEST_MAIL_TO が Script Properties に設定されている場合、
 * すべての送信先をそのアドレスに強制差し替えする。
 * 本番では TEST_MAIL_TO を削除するか空にすること。
 */
function resolveRecipient_(maskedEmail) {
  const testTo = PropertiesService.getScriptProperties().getProperty('TEST_MAIL_TO');
  if (testTo) {
    Logger.log(`[TEST_MAIL] redirect ${maskedEmail} -> ${testTo}`);
    return testTo;
  }
  return maskedEmail;
}
