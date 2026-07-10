/**
 * main.gs — エントリ・トリガー登録
 */

// 毎時実行：受注取得→紐づけ→クーポン判定→メール送信
function runPipeline() {
  const tenants = listActiveTenants();
  tenants.forEach(tenant => {
    try {
      Logger.log(`[${tenant.tenant_id}] pipeline start`);
      fetchOrders(tenant.tenant_id);
      // fetchReviews(tenant.tenant_id); // 2026-07-05: 楽天レビューAPI(/es/2.0/review/list/)が404のため無効化。
      // レビュー取得は Selenium版 review_fetcher.py が reviews シートへ直接書き込む運用に一本化。詳細は rakuten_api.gs の fetchReviews 参照。
      linkOrdersReviews(tenant.tenant_id);
      const targets = evaluateCoupons(tenant.tenant_id);
      targets.forEach(t => {
        if (isDryRun_()) {
          Logger.log(`[DRY_RUN] would issue coupon: ${JSON.stringify(t)}`);
          return;
        }
        const coupon = issueCoupon(tenant.tenant_id, t);
        // クーポン発行できたら、対象注文にクーポンメール送信
        if (coupon && coupon.coupon_id) {
          const order = findOrderByNumber_(tenant.tenant_id, t.order_number);
          if (order) sendCouponMail(tenant.tenant_id, order, coupon);
        }
      });
      sendPendingMails(tenant.tenant_id);
      Logger.log(`[${tenant.tenant_id}] pipeline done`);
    } catch(e) {
      Logger.log(`[${tenant.tenant_id}] pipeline error: ${e.message}`);
      notifyAdmin_(`[step-samurai] ${tenant.tenant_id} パイプラインエラー: ${e.message}`);
    }
  });
}

/**
 * フォローメール専用の毎時エントリポイント。
 * evaluateCoupons/issueCoupon は呼ばない
 * （楽天Coupon APIの仕様未解決＝本番投入前の段階のため、クーポン経路は runPipeline 側に残したまま
 *  ここでは動かさない。フォローメールのみを本番前に独立して安定運用させるための分離）。
 * トリガー登録はこの関数の中では行わない（登録はGASエディタの「トリガー」画面から手動で行う運用）。
 */
function runHourlyFollowPipeline() {
  const tenants = listActiveTenants();
  tenants.forEach(tenant => {
    try {
      Logger.log(`[${tenant.tenant_id}] runHourlyFollowPipeline start`);
      fetchOrders(tenant.tenant_id);
      linkOrdersReviews(tenant.tenant_id);
      sendPendingMails(tenant.tenant_id);
      Logger.log(`[${tenant.tenant_id}] runHourlyFollowPipeline done`);
    } catch(e) {
      Logger.log(`[${tenant.tenant_id}] runHourlyFollowPipeline error: ${e.message}`);
      notifyAdmin_(`[step-samurai] ${tenant.tenant_id} runHourlyFollowPipelineエラー: ${e.message}`);
    }
  });
}

// 注文番号から注文オブジェクトを取得（クーポンメール用）
function findOrderByNumber_(tenantId, orderNumber) {
  const ss     = getTenantSpreadsheet(tenantId);
  const orders = ss.getSheetByName('orders');
  const data   = orders.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);
  const row    = data.slice(1).find(r => r[idx('order_number')] === orderNumber);
  if (!row) return null;
  return {
    order_number: row[idx('order_number')],
    masked_email: row[idx('masked_email')],
    buyer_key:    row[idx('buyer_key')],
    buyer_name:   row[idx('buyer_name')] || '',
    ship_date:    row[idx('ship_date')],
    status:       row[idx('status')],
  };
}

// 月初実行：月次レポート
function runMonthlyReport() {
  listActiveTenants().forEach(t => sendMonthlyReport(t.tenant_id));
}

// 日次実行：ライセンスキー失効チェック
function runLicenseCheck() {
  checkLicenseExpiry();
}

// 初回手動実行：トリガー登録
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runPipeline')
    .timeBased().everyHours(1).create();

  ScriptApp.newTrigger('runLicenseCheck')
    .timeBased().everyDays(1).atHour(9).create();

  ScriptApp.newTrigger('runMonthlyReport')
    .timeBased().onMonthDay(1).atHour(8).create();

  Logger.log('トリガー登録完了');
}

// 管理者通知（メール）
function notifyAdmin_(message) {
  const email = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (email) {
    MailApp.sendEmail(email, '[step-samurai] 通知', message);
  }
}

// Script Properties の DRY_RUN='true' の間はクーポン発行・メール送信を実行しない
function isDryRun_() {
  return PropertiesService.getScriptProperties().getProperty('DRY_RUN') === 'true';
}

/**
 * 実送信前の安全確認用（読み取り専用・副作用なし）。
 * DRY_RUNの現在値と、登録済みトリガー数を1回の実行でまとめて確認できる。
 */
function debugSafetyCheck_() {
  const result = {
    dryRun:       isDryRun_(),
    triggerCount: ScriptApp.getProjectTriggers().length,
  };
  Logger.log(`debugSafetyCheck_: ${JSON.stringify(result)}`);
  return result;
}

// GO_LIVE_DATE（Script Properties, YYYY-MM-DD）より前に発送された注文を対象外にする日付ガード。
// 'yyyy-MM-dd' 文字列を返す（Date型ではない。isOnOrAfterGoLiveDate_ と組み合わせて使うことで
// タイムゾーン起因の9時間ズレを避ける。詳細は config.gs の toJstDateString_ のコメント参照）。
// 未設定・空・不正な値の場合は null を返す（呼び出し側で fail-closed に全件スキップする）。
function getGoLiveDate_() {
  const raw = PropertiesService.getScriptProperties().getProperty('GO_LIVE_DATE');
  if (!raw) return null;
  return toJstDateString_(raw);
}


// =========================================================
// 手動実行ユーティリティ（GASエディタから個別に実行）
// =========================================================

/** 受注取得のみテスト */
function testFetchOrders() {
  fetchOrders('tokyoflower');
}

/** レビュー取得のみテスト */
function testFetchReviews() {
  fetchReviews('tokyoflower');
}

/** 受注→レビュー紐づけのみテスト */
function testLinkOrdersReviews() {
  linkOrdersReviews('tokyoflower');
}

/** クーポン判定（対象抽出）のみテスト。発行はしない */
function testEvaluateCoupons() {
  const targets = evaluateCoupons('tokyoflower');
  Logger.log('クーポン対象: ' + JSON.stringify(targets, null, 2));
}

/**
 * 指定した注文1件だけクーポンを本発行し、そのクーポンメールのみ送信するテスト。
 * DRY_RUNの状態に関わらず issueCoupon() は常に実発行する（isDryRun_チェックを持たないため）。
 * sendPendingMails は呼ばないため、フォローメール対象には一切影響しない。
 */
function testIssueOneCoupon(orderNumber, ruleId) {
  const tenantId = 'tokyoflower';
  ruleId = ruleId || 'first_purchase';

  const order = findOrderByNumber_(tenantId, orderNumber);
  if (!order) {
    Logger.log(`testIssueOneCoupon: 注文が見つかりません ${orderNumber}`);
    return;
  }

  const target = { order_number: order.order_number, buyer_key: order.buyer_key, rule_id: ruleId };
  const coupon = issueCoupon(tenantId, target);
  if (!coupon || !coupon.coupon_id) {
    Logger.log(`testIssueOneCoupon: クーポン発行失敗 order=${orderNumber}`);
    return;
  }

  const mailResult = sendCouponMail(tenantId, order, coupon);
  Logger.log(`testIssueOneCoupon: bridge応答 ${JSON.stringify(mailResult)}`);
  Logger.log(`testIssueOneCoupon 完了: order=${orderNumber} coupon=${coupon.coupon_id}`);
}

/** GASエディタから引数なしで実行するための固定値ラッパー（Block2本発行テスト用） */
function runTestIssueOneCoupon_0991235433() {
  testIssueOneCoupon('240364-20260620-0991235433', 'first_purchase');
}

/**
 * フォローメール送信のみを本番実行するラッパ。
 * クーポン経路（evaluateCoupons/issueCoupon）は一切呼ばない。
 * fetchOrders/fetchReviews/linkOrdersReviews も呼ばず、現在の orders シートの状態のみを使う。
 */
function runFollowMailsOnly() {
  const tenantId = 'tokyoflower';
  sendPendingMails(tenantId);
  Logger.log('runFollowMailsOnly 完了');
}

/** パイプライン全体を tokyoflower のみで手動実行 */
function testPipelineTokyoflower() {
  const tenantId = 'tokyoflower';
  fetchOrders(tenantId);
  fetchReviews(tenantId);
  linkOrdersReviews(tenantId);
  const targets = evaluateCoupons(tenantId);
  Logger.log('クーポン対象: ' + targets.length + '件');
  targets.forEach(t => {
    const coupon = issueCoupon(tenantId, t);
    if (coupon && coupon.coupon_id) {
      const order = findOrderByNumber_(tenantId, t.order_number);
      if (order) sendCouponMail(tenantId, order, coupon);
    }
  });
  sendPendingMails(tenantId);
  Logger.log('パイプライン手動実行 完了');
}

/** getOrder生レスポンス確認（構造デバッグ用） */
function testDebugGetOrderRaw() {
  debugGetOrderRaw('tokyoflower');
}

/**
 * テナント初期作成（初回のみ・重複注意）。
 * 末尾アンダースコアでGASエディタのドロップダウンから隠し、誤実行を防ぐ。
 * 新規テナントを作成したい場合は、その都度このtenant_id専用の明示的なラッパー関数を
 * 作成してから実行する運用とする（既存のsetupConfigSheetsTokyoflowerのように、
 * 対象テナントが名前に入った公開ラッパーを都度用意すること）。
 * 既に対象テナントが稼働テナントとして存在する場合は、二重にスプレッドシートを
 * 作成してしまわないようスキップする（誤って再実行してもデータが壊れないためのガード）。
 */
function createNewTenant_DANGEROUS_(shopName, tenantId, shopEmail, ccEmail) {
  const existing = listActiveTenants().find(t => t.tenant_id === tenantId);
  if (existing) {
    Logger.log(`createNewTenant_DANGEROUS_: tenant_id=${tenantId} は既に存在するため作成をスキップしました（spreadsheet_id: ${existing.spreadsheet_id}）`);
    return;
  }
  const id = createTenant(shopName, tenantId, shopEmail, ccEmail);
  Logger.log('作成完了 spreadsheet_id: ' + id);
}

/**
 * GASエディタの関数選択ドロップダウンは末尾アンダースコア付き関数を表示しないため、
 * 引数なしで呼べる公開ラッパーを用意する
 * （実体は debugSafetyCheck_ / issueTenantToken_ / setupTenantConfigSheets_ のまま）。
 */
function debugSafetyCheck() {
  return debugSafetyCheck_();
}

function issueTokenTokyoflower() {
  Logger.log(issueTenantToken_('tokyoflower'));
}

function setupConfigSheetsTokyoflower() {
  return setupTenantConfigSheets_('tokyoflower');
}
