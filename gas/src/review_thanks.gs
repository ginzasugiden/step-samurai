/**
 * review_thanks.gs — レビューお礼メール（クーポン無し）
 *
 * 背景:
 *  楽天 Coupon API が停止中のため、従来の「レビュー → クーポン発行 → クーポンメール」経路は
 *  issueCoupon が null を返してメールまで到達しない。レビューを書いてくださったお客様への
 *  お礼だけを先行して自動化する経路をここに分離する（クーポン復旧後もそのまま併存できる）。
 *
 * 対象条件（すべて満たす注文にのみ送る・fail-closed）:
 *  1. settings.review_thanks_since が設定済み（未設定なら全スキップ＝過去レビューへの一斉送信を防ぐ）
 *  2. reviews タブに order_number が一致するレビューがあり、その最新 posted_at ≧ review_thanks_since
 *  3. そのレビューの最低評価 ≧ settings.review_thanks_min_rating（既定3。低評価は自動送信せずログ）
 *  4. orders.status ≠ cancelled、ship_date あり、ship_date ≧ go_live_date
 *  5. settings.exclude_orders に含まれない
 *  6. sends に type='review_thanks' の成功行が無い（同一注文に二度送らない）
 *  7. dry_run でない（dry_run 中はログのみ）
 *
 * sends への記録 type は 'review_thanks'（analytics_agg.gs は type==='follow' のみ集計するため影響なし）。
 */

/** reviews タブを注文番号でまとめる: { order_number: { posted_at, rating, review_id } }（最新投稿・最低評価） */
function collectReviewsByOrder_(tenantId) {
  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('reviews');
  if (!sheet) return {};
  const data   = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const header = data[0].map(String);
  const idx    = col => header.indexOf(col);
  const deletedIdx = idx('deleted_at'); // Webhook取込(reviews_ingest.gs)が付ける列。無ければ従来どおり全件対象
  const map    = {};
  data.slice(1).forEach(row => {
    const orderNumber = String(row[idx('order_number')] || '').trim();
    if (!orderNumber) return;
    if (deletedIdx >= 0 && String(row[deletedIdx] || '').trim() !== '') return; // 削除済みレビューにはお礼を送らない
    const postedAt = toJstDateString_(row[idx('posted_at')]) || '';
    const rating   = Number(row[idx('rating')]);
    const cur = map[orderNumber];
    if (!cur) {
      map[orderNumber] = { posted_at: postedAt, rating: isNaN(rating) ? 0 : rating, review_id: String(row[idx('review_id')] || '') };
      return;
    }
    if (postedAt > cur.posted_at) cur.posted_at = postedAt;
    if (!isNaN(rating) && rating < cur.rating) cur.rating = rating;
  });
  return map;
}

function buildReviewThanksMailVars_(order, creds) {
  return {
    buyer_name:     order.buyer_name || 'お客様',
    shop_name:      creds.shop_name,
    ship_date:      formatShipDateJa_(order.ship_date),
    shop_signature: creds.shop_signature,
    review_url:     buildReviewUrl_(order.order_number),
  };
}

/**
 * 1注文にレビューお礼メールを送る。
 * opts.recordType: sends に記録する type（既定 'review_thanks'。検証時は 'review_thanks_test' を渡し本番判定を汚さない）
 * opts.force:      alreadySent_ / dry_run を無視しない（既定 false）。検証関数からも false のまま使う
 */
function sendReviewThanksMail(tenantId, order, opts) {
  opts = opts || {};
  const recordType = opts.recordType || 'review_thanks';
  const ss    = getTenantSpreadsheet(tenantId);
  const sends = ss.getSheetByName('sends');
  if (alreadySent_(sends, order.order_number, recordType)) return { skipped: 'already_sent' };

  const creds = getRmsCredentials(tenantId);
  const tpl   = getTenantTemplateRaw_(tenantId, 'review_thanks_v1');
  if (!tpl) {
    Logger.log(`[${tenantId}] sendReviewThanksMail: templates タブ or review_thanks_v1 が見つからないためスキップ（fail-closed） order=${order.order_number}`);
    return { skipped: 'template_missing' };
  }

  const vars    = buildReviewThanksMailVars_(order, creds);
  const subject = renderTemplate_(tpl.subject, vars);
  const body    = renderTemplate_(tpl.body, vars);
  const to      = resolveRecipient_(order.masked_email);

  if (isTenantDryRun_(tenantId)) {
    Logger.log(`[DRY_RUN] would send review_thanks mail to ${to} (order=${order.order_number}) subject=${subject}`);
    return { skipped: 'dry_run', to: to, subject: subject };
  }

  let result;
  try {
    result = sendViaBridge_(tenantId, to, creds.from_email, creds.from_name, subject, body, '', creds.reply_to, creds.cc_email);
    recordSend_(sends, order.order_number, order.buyer_key, recordType, 'review_thanks_v1', 'sent');
  } catch (e) {
    recordSend_(sends, order.order_number, order.buyer_key, recordType, 'review_thanks_v1', `error: ${e.message}`);
    throw e;
  }
  return { sent: true, to: to, subject: subject, bridge: result };
}

/**
 * 送信対象を抽出する（送信はしない）。sendPendingReviewThanks と検証関数の両方がこれを使う。
 * 戻り値: { targets: [order...], skipped: { reason: [order_number...] } }
 */
function collectPendingReviewThanks_(tenantId) {
  const out = { targets: [], skipped: {} };
  const skip = (reason, orderNumber) => { (out.skipped[reason] = out.skipped[reason] || []).push(orderNumber); };

  const since = getReviewThanksSince_(tenantId);
  if (!since) {
    Logger.log(`[${tenantId}] review_thanks: settings.review_thanks_since 未設定のため全スキップ（fail-closed）`);
    out.disabled = 'review_thanks_since_unset';
    return out;
  }
  const goLiveDate = getTenantGoLiveDate_(tenantId);
  if (!goLiveDate) {
    Logger.log(`[${tenantId}] review_thanks: settings.go_live_date 未設定のため全スキップ（fail-closed）`);
    out.disabled = 'go_live_date_unset';
    return out;
  }
  const minRating = getReviewThanksMinRating_(tenantId);
  const excluded  = getTenantExcludedOrders_(tenantId);
  const reviews   = collectReviewsByOrder_(tenantId);
  if (!Object.keys(reviews).length) return out;

  const ss     = getTenantSpreadsheet(tenantId);
  const sends  = ss.getSheetByName('sends');
  const orders = ss.getSheetByName('orders');
  const data   = orders.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);

  data.slice(1).forEach(row => {
    const orderNumber = row[idx('order_number')];
    if (!orderNumber) return;
    const rv = reviews[orderNumber];
    if (!rv) return;

    if (excluded.has(orderNumber))                          return skip('excluded', orderNumber);
    if (row[idx('status')] === 'cancelled')                 return skip('cancelled', orderNumber);
    const shipDate = row[idx('ship_date')];
    if (!shipDate)                                          return skip('not_shipped', orderNumber);
    if (!isOnOrAfterGoLiveDate_(shipDate, goLiveDate))      return skip('before_go_live', orderNumber);
    if (!rv.posted_at || rv.posted_at < since)              return skip('review_before_since', orderNumber);
    if (rv.rating < minRating)                              return skip('low_rating', orderNumber);
    if (alreadySent_(sends, orderNumber, 'review_thanks'))  return skip('already_sent', orderNumber);

    out.targets.push({
      order_number: orderNumber,
      masked_email: row[idx('masked_email')],
      buyer_key:    row[idx('buyer_key')],
      buyer_name:   row[idx('buyer_name')] || '',
      ship_date:    shipDate,
      status:       row[idx('status')],
      review_rating:    rv.rating,
      review_posted_at: rv.posted_at,
    });
  });

  if (out.skipped.low_rating && out.skipped.low_rating.length) {
    Logger.log(`[${tenantId}] review_thanks: 低評価(<${minRating})のため自動送信しない注文（個別対応を検討）: ${out.skipped.low_rating.join(', ')}`);
  }
  return out;
}

/** 毎時バッチ用: 未送信のレビューお礼メールを全件処理 */
function sendPendingReviewThanks(tenantId) {
  const pending = collectPendingReviewThanks_(tenantId);
  Logger.log(`[${tenantId}] review_thanks: 対象 ${pending.targets.length}件 / skipped=${JSON.stringify(Object.keys(pending.skipped).reduce((o, k) => { o[k] = pending.skipped[k].length; return o; }, {}))}`);
  pending.targets.forEach(order => {
    try {
      sendReviewThanksMail(tenantId, order);
    } catch (e) {
      Logger.log(`sendReviewThanksMail error [${order.order_number}]: ${e.message}`);
    }
  });
  return pending.targets.length;
}

/** GASエディタ用: 送らずに対象一覧だけをログに出す（本番投入前の目視確認） */
function previewPendingReviewThanksTokyoflower() {
  const p = collectPendingReviewThanks_('tokyoflower');
  Logger.log('=== review_thanks 送信予定（送信はしていません） ===');
  if (p.disabled) Logger.log(`無効: ${p.disabled}`);
  p.targets.forEach(t => Logger.log(`SEND  ${t.order_number}  rating=${t.review_rating}  posted=${t.review_posted_at}  ship=${toJstDateString_(t.ship_date)}  to=${t.masked_email}`));
  Object.keys(p.skipped).forEach(k => Logger.log(`skip[${k}] ${p.skipped[k].length}件: ${p.skipped[k].join(', ')}`));
  Logger.log(`合計 送信予定=${p.targets.length}`);
  return p;
}
