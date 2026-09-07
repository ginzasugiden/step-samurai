/**
 * test_review_flow.gs — レビュー取込 → 紐づけ → メール送信 の実機検証（tokyoflower・自分のテスト注文のみ）
 *
 * 安全設計:
 *  - 送信先は TEST_ORDER_NUMBER_ の orders.masked_email に限定し、さらに TEST_MASKED_EMAIL_ と一致しなければ
 *    何も送らずに停止する（グローバル TEST_MAIL_TO は使わない＝毎時トリガーの実顧客宛メールを横取りしない）
 *  - sends には 'coupon_test' / 'review_thanks_test' として記録し、本番の重複判定（'coupon' / 'review_thanks'）を汚さない
 *  - reviews タブへ入れる検証レビューの review_id は 'test_' で始め、cleanupTestReviewFlow() で除去できる
 *  - 実CSV（他のお客様のレビュー）は一切使わない。実CSVの取込は管理画面（store UI）から行う
 */

const TEST_TENANT_ID_       = 'tokyoflower';
const TEST_ORDER_NUMBER_    = '240364-20260827-0309500953';
const TEST_MASKED_EMAIL_    = '85d3519122ea1a2817a610a308ff402ds1@pc.fw.rakuten.ne.jp';
const TEST_REVIEW_URL_      = 'https://review.rakuten.co.jp/item/1/240364_test/step-samurai-test/';

/** 事前準備（冪等・追記のみ）: settings の不足キーと templates の review_thanks_v1 行を追加する */
function setupReviewThanksTokyoflower() {
  const keys = ensureTenantSettingsKeys_(TEST_TENANT_ID_);
  const tpls = ensureTenantTemplateRows_(TEST_TENANT_ID_);
  Logger.log(`settings 追加キー: ${JSON.stringify(keys)} / templates 追加行: ${JSON.stringify(tpls)}`);
  Logger.log(`review_thanks_since=${getReviewThanksSince_(TEST_TENANT_ID_)} min_rating=${getReviewThanksMinRating_(TEST_TENANT_ID_)}`);
  return { keys, tpls };
}

/** 本体: 各STEPの PASS/FAIL を Logger に出す。1件でも FAIL があれば末尾に RESULT: FAIL */
function testReviewMailFlow() {
  const tenantId = TEST_TENANT_ID_;
  const results  = [];
  const step = (name, fn) => {
    try { const detail = fn(); results.push({ name, ok: true, detail }); Logger.log(`PASS ${name} ${detail ? JSON.stringify(detail) : ''}`); }
    catch (e) { results.push({ name, ok: false, detail: e.message }); Logger.log(`FAIL ${name}: ${e.message}`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // STEP0 安全確認
  let order;
  step('0 安全確認（テスト注文と宛先の一致）', () => {
    order = findOrderByNumber_(tenantId, TEST_ORDER_NUMBER_);
    assert(order, `orders に ${TEST_ORDER_NUMBER_} が存在しない`);
    assert(String(order.masked_email).toLowerCase() === TEST_MASKED_EMAIL_.toLowerCase(),
      `masked_email が想定と不一致（送信を中止）: ${order.masked_email}`);
    assert(!PropertiesService.getScriptProperties().getProperty('TEST_MAIL_TO'), 'TEST_MAIL_TO が設定されている（本番横取りの恐れ）→ 中止');
    return { status: order.status, ship_date: toJstDateString_(order.ship_date), dry_run: isTenantDryRun_(tenantId) };
  });
  if (!results[0].ok) { Logger.log('RESULT: FAIL（STEP0 で中止）'); return results; }

  // STEP1 RMS CSV と同じヘッダで検証レビューを取込（preview → 本取込）
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd H:mm:ss');
  const csv = [
    'レビュータイプ,商品名,レビュー詳細URL,評価,投稿時間,タイトル,レビュー本文,フラグ,注文番号,未対応フラグ',
    `商品レビュー,テスト商品,${TEST_REVIEW_URL_},5,${now},検証,"ステップ侍 検証用レビュー（自動テスト）",0,${TEST_ORDER_NUMBER_},`,
  ].join('\r\n') + '\r\n';
  step('1 CSV preview（列判定・書き込みなし）', () => {
    const r = importReviewsFromCsv_(tenantId, csv, true);
    assert(r.ok, `preview 失敗: ${JSON.stringify(r)}`);
    assert(r.column_map.posted_at === '投稿時間', `posted_at 列が認識されていない: ${JSON.stringify(r.column_map)}`);
    assert(r.column_map.order_number === '注文番号' && r.column_map.rating === '評価', '注文番号/評価 列の認識失敗');
    assert(r.sample[0].review_id === TEST_REVIEW_URL_, `review_id はURL由来のはず: ${r.sample[0].review_id}`);
    return r.column_map;
  });
  step('2 CSV 本取込（reviews upsert + review_linked）', () => {
    const r = importReviewsFromCsv_(tenantId, csv, false);
    assert(r.ok && r.linked, `取込失敗: ${JSON.stringify(r)}`);
    const r2 = importReviewsFromCsv_(tenantId, csv, false);
    assert(r2.inserted === 0 && r2.updated === 1, `冪等性NG: ${JSON.stringify(r2)}`);
    const ss  = getTenantSpreadsheet(tenantId);
    const od  = ss.getSheetByName('orders').getDataRange().getValues();
    const h   = od[0]; const row = od.find(r => r[h.indexOf('order_number')] === TEST_ORDER_NUMBER_);
    assert(row && isLinked_(row[h.indexOf('review_linked')]), 'orders.review_linked が true になっていない');
    return { inserted: r.inserted, updated: r.updated };
  });

  // STEP3 判定ロジック（送らない）
  step('3 クーポン判定 evaluateCoupons（テスト注文はキャンセル済みなので対象外が正）', () => {
    const t = evaluateCoupons(tenantId).filter(x => x.order_number === TEST_ORDER_NUMBER_);
    assert(t.length === 0 || order.status !== 'cancelled', 'キャンセル注文がクーポン対象に含まれている');
    return { targets_for_test_order: t.length };
  });
  step('4 お礼メール判定 collectPendingReviewThanks_（送らない）', () => {
    const p = collectPendingReviewThanks_(tenantId);
    const inTargets = p.targets.some(x => x.order_number === TEST_ORDER_NUMBER_);
    assert(!inTargets, 'キャンセル済みテスト注文が review_thanks 対象に入っている');
    const reason = Object.keys(p.skipped).find(k => p.skipped[k].includes(TEST_ORDER_NUMBER_));
    return { disabled: p.disabled || null, test_order_skip_reason: reason || '(reviews に無い/条件外)', real_targets: p.targets.length };
  });

  // STEP5/6 実送信（テスト注文の masked_email 宛のみ・記録 type は *_test）
  step('5 お礼メール 実送信 → 自分のマスクアドレス', () => {
    const r = sendReviewThanksMail(tenantId, order, { recordType: 'review_thanks_test' });
    assert(r && (r.sent || r.skipped), `不明な戻り値: ${JSON.stringify(r)}`);
    if (r.skipped) assert(r.skipped === 'dry_run', `送信されず: ${r.skipped}`);
    return { to: r.to, subject: r.subject, sent: !!r.sent, skipped: r.skipped || null };
  });
  step('6 クーポンメール 実送信（ダミークーポン・API発行なし）→ 自分のマスクアドレス', () => {
    const dummy = { coupon_id: 'TEST-DUMMY', discount: 300, valid_until: '2026/10/07', get_url: 'https://coupon.rakuten.co.jp/getCoupon?getkey=TESTDUMMY' };
    const before = getTenantSpreadsheet(tenantId).getSheetByName('sends').getLastRow();
    sendCouponMail(tenantId, order, dummy, { recordType: 'coupon_test' });
    const sends = getTenantSpreadsheet(tenantId).getSheetByName('sends');
    const after = sends.getLastRow();
    if (isTenantDryRun_(tenantId)) return { skipped: 'dry_run' };
    assert(after > before || alreadySent_(sends, TEST_ORDER_NUMBER_, 'coupon_test'), 'sends に coupon_test が記録されていない');
    const last = sends.getRange(after, 1, 1, 7).getValues()[0];
    assert(String(last[6]) === 'sent' || alreadySent_(sends, TEST_ORDER_NUMBER_, 'coupon_test'), `送信結果: ${last[6]}`);
    return { result: last[6] };
  });

  const fail = results.filter(r => !r.ok).length;
  Logger.log(fail ? `RESULT: FAIL (${fail}件)` : 'RESULT: PASS（受信箱でお礼メールとクーポンメールの2通を確認してください）');
  return results;
}

/** 後片付け: 検証レビュー行を削除し、テスト注文の review_linked を空に戻す（sends の *_test 行は監査のため残す） */
function cleanupTestReviewFlow() {
  const ss = getTenantSpreadsheet(TEST_TENANT_ID_);
  const rv = ss.getSheetByName('reviews');
  const data = rv.getDataRange().getValues();
  let removed = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === TEST_REVIEW_URL_ || String(data[i][0]).startsWith('test_')) { rv.deleteRow(i + 1); removed++; }
  }
  const od = ss.getSheetByName('orders');
  const o  = od.getDataRange().getValues(); const h = o[0];
  const ri = o.findIndex((r, i) => i > 0 && r[h.indexOf('order_number')] === TEST_ORDER_NUMBER_);
  if (ri > 0) od.getRange(ri + 1, h.indexOf('review_linked') + 1).setValue('');
  Logger.log(`検証レビュー削除: ${removed}件 / review_linked リセット: ${ri > 0 ? 'done' : 'not found'}`);
}
