/**
 * main.gs — エントリ・トリガー登録
 */

/** 指定注文1件の生レスポンス確認（item_id検証用・読み取りのみ） */
function debugGetOrderRawTestOrder() {
  debugGetOrderRawFor_('tokyoflower', '240364-20260827-0309500953');
}

// 毎時実行：受注取得→紐づけ→クーポン判定→メール送信
function runPipeline() {
  const tenants = listActiveTenants();
  tenants.forEach(tenant => {
    if (!billingAllows_(tenant.tenant_id)) return;   // 課金ガード（クーポン発行を含む全経路をスキップ）
    try {
      Logger.log(`[${tenant.tenant_id}] pipeline start`);
      fetchOrders(tenant.tenant_id);
      // fetchReviews(tenant.tenant_id); // 2026-07-05: 楽天レビューAPI(/es/2.0/review/list/)が404のため無効化。
      // レビュー取得は Selenium版 review_fetcher.py が reviews シートへ直接書き込む運用に一本化。詳細は rakuten_api.gs の fetchReviews 参照。
      linkOrdersReviews(tenant.tenant_id);
      const targets = evaluateCoupons(tenant.tenant_id);
      targets.forEach(t => {
        if (isTenantDryRun_(tenant.tenant_id)) {
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
      try { sendPendingReviewThanks(tenant.tenant_id); } catch(e) { Logger.log(`[${tenant.tenant_id}] sendPendingReviewThanks error: ${e.message}`); }
      Logger.log(`[${tenant.tenant_id}] pipeline done`);
      pipelineLog_(tenant.tenant_id, 'pipeline_done', '');
    } catch(e) {
      Logger.log(`[${tenant.tenant_id}] pipeline error: ${e.message}`);
      notifyAdmin_(`[step-samurai] ${tenant.tenant_id} パイプラインエラー: ${e.message}`);
    }
  });
}

// ===== 毎時パイプラインの実行全体の記録（pipeline_log の tenant_id='_hourly' 行） =====
const HOURLY_LOG_ID_ = '_hourly';
/** 前回の hourly_start からこの分数を超えて空いたら「発火漏れ」(hourly_gap)。毎時トリガーの揺らぎを見込んだ閾値 */
const HOURLY_GAP_THRESHOLD_MIN_ = 90;
/** run の終了マーカー（どれか1つが同じ run にあれば正常に終わったとみなす） */
const HOURLY_END_EVENTS_ = ['hourly_done', 'hourly_error', 'hourly_skip'];

function hourlyNow_() { return new Date(); }

function hourlyRunOf_(detail) { const m = /(?:^|\s)run=(\S+)/.exec(String(detail || '')); return m ? m[1] : ''; }

/** pipeline_log の at（'yyyy-MM-dd HH:mm:ss' JST の文字列、またはシートが変換した Date）をミリ秒に。解釈できなければ NaN */
function hourlyAtMs_(v) {
  if (v instanceof Date) return v.getTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(v || ''));
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`) : NaN;
}

function hourlyAtStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : String(v);
}

/**
 * 過去の _hourly 行から異常を判定する（純粋関数）。
 *  incomplete: 直近の hourly_start の run に終了マーカーが無い / gap: 直近 start から閾値超
 *  prevAnomalous: 前回 run の開始時にも異常（hourly_incomplete / hourly_gap が prev run で記録済み）が検知されていたか
 *  alertedToday: 今日すでに hourly_alert を送ったか
 */
function analyzeHourlyHistory_(rows, nowMs, todayStr) {
  const out = { incomplete: null, gap: null, prevRun: '', prevAnomalous: false, alertedToday: false };
  let last = -1;
  rows.forEach((r, i) => { if (r.event === 'hourly_start') last = i; });
  rows.forEach(r => {
    const ms = hourlyAtMs_(r.at);
    if (r.event === 'hourly_alert' && !isNaN(ms) && Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'yyyy-MM-dd') === todayStr) out.alertedToday = true;
  });
  if (last < 0) return out;
  const prevRun = hourlyRunOf_(rows[last].detail), prevMs = hourlyAtMs_(rows[last].at);
  out.prevRun = prevRun;
  const ended = rows.some(r => HOURLY_END_EVENTS_.indexOf(r.event) >= 0 && hourlyRunOf_(r.detail) === prevRun);
  if (!ended) out.incomplete = { prev: prevRun, prevStart: hourlyAtStr_(rows[last].at) };
  if (!isNaN(prevMs)) { const min = Math.round((nowMs - prevMs) / 60000); if (min > HOURLY_GAP_THRESHOLD_MIN_) out.gap = { min: min }; }
  out.prevAnomalous = rows.some(r => (r.event === 'hourly_incomplete' || r.event === 'hourly_gap') && hourlyRunOf_(r.detail) === prevRun);
  return out;
}

/** 管理者通知の安全ラッパ。失敗しても処理は継続（console.error + Logger.log）。戻り値: 例外なく終われば true */
function notifyAdminSafe_(message) {
  try { notifyAdmin_(message); return true; }
  catch (e) { Logger.log(`notifyAdmin_ failed: ${e.message}`); consoleError_(`notifyAdmin_ failed: ${e.message}`); return false; }
}

/**
 * 開始時の検知（hourly_start を書く前に呼ぶ）。incomplete / gap を記録し、2回連続なら 1日1回まで ADMIN_EMAIL へ通知する。
 * 読み出しに失敗したら検知をスキップして続行する（例外は出さない）。
 */
function detectHourlyAnomalies_(runId, now) {
  try {
    const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
    const a = analyzeHourlyHistory_(readHourlyLogRows_(), now.getTime(), today);
    if (a.incomplete) pipelineLog_(HOURLY_LOG_ID_, 'hourly_incomplete', `run=${runId} prev=${a.incomplete.prev} prev_start=${a.incomplete.prevStart}`);
    if (a.gap) pipelineLog_(HOURLY_LOG_ID_, 'hourly_gap', `run=${runId} gap_min=${a.gap.min}`);
    if (!(a.incomplete || a.gap) || !a.prevAnomalous) return a;
    if (a.alertedToday) { Logger.log('hourly alert: 本日分は通知済みのためスキップ'); return a; }
    const msg = `[step-samurai] 毎時パイプラインの異常が2回連続で検知されました（run=${runId} prev=${a.prevRun}）。` +
      (a.incomplete ? ' 前回実行が未完了のまま終わっています(incomplete)。' : '') + (a.gap ? ` 発火間隔が ${a.gap.min} 分空いています(gap)。` : '') +
      ' master の pipeline_log タブの _hourly 行を確認してください。';
    if (!PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL')) { Logger.log(`hourly alert: ADMIN_EMAIL 未設定のため通知せず。内容: ${msg}`); return a; }
    if (notifyAdminSafe_(msg)) pipelineLog_(HOURLY_LOG_ID_, 'hourly_alert', `run=${runId} prev=${a.prevRun}`);
    return a;
  } catch (e) {
    Logger.log(`detectHourlyAnomalies_ skip: ${e.message}`);
    consoleError_(`detectHourlyAnomalies_ skip: ${e.message}`);
    return null;
  }
}

/**
 * フォローメール専用の毎時エントリポイント。
 * evaluateCoupons/issueCoupon は呼ばない
 * （楽天Coupon APIの仕様未解決＝本番投入前の段階のため、クーポン経路は runPipeline 側に残したまま
 *  ここでは動かさない。フォローメールのみを本番前に独立して安定運用させるための分離）。
 * トリガー登録はこの関数の中では行わない（登録はGASエディタの「トリガー」画面から手動で行う運用）。
 *
 * 実行全体は pipeline_log に tenant_id='_hourly' で残す: hourly_start → hourly_done / hourly_error / hourly_skip（run=<実行ID>）。
 * 開始前に前回未完了(hourly_incomplete)・発火漏れ(hourly_gap)を検知する。
 */
function runHourlyFollowPipeline() {
  const runId = Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  const stats = { tenants: 0, ran: 0, billing_skipped: 0, errors: 0 };
  let stage = 'detect';
  try {
    detectHourlyAnomalies_(runId, hourlyNow_());
    pipelineLog_(HOURLY_LOG_ID_, 'hourly_start', `run=${runId}`);   // 失敗しても処理は止めない
    stage = 'listActiveTenants';
    const tenants = listActiveTenants();
    stats.tenants = tenants.length;
    if (!tenants.length) {
      pipelineLog_(HOURLY_LOG_ID_, 'hourly_skip', `run=${runId} reason=no_active_tenants`);
      return;
    }
    tenants.forEach(tenant => {
      try {
        stage = 'billing';
        if (!billingAllows_(tenant.tenant_id)) { stats.billing_skipped++; return; }   // 課金ガード（理由は billing_skip に記録済み）
        Logger.log(`[${tenant.tenant_id}] runHourlyFollowPipeline start`);
        stage = 'fetchOrders';
        fetchOrders(tenant.tenant_id);
        stage = 'linkOrdersReviews';
        linkOrdersReviews(tenant.tenant_id);
        stage = 'sendPendingMails';
        sendPendingMails(tenant.tenant_id);
        // レビューお礼メール（クーポン無し）。フォローメールを巻き込まないよう独立して try/catch する
        stage = 'sendPendingReviewThanks';
        try {
          sendPendingReviewThanks(tenant.tenant_id);
        } catch(e) {
          stats.errors++;
          Logger.log(`[${tenant.tenant_id}] sendPendingReviewThanks error: ${e.message}`);
          notifyAdminSafe_(`[step-samurai] ${tenant.tenant_id} レビューお礼メールエラー: ${e.message}`);
        }
        Logger.log(`[${tenant.tenant_id}] runHourlyFollowPipeline done`);
        pipelineLog_(tenant.tenant_id, 'hourly_done', `run=${runId}`);
        stats.ran++;
      } catch(e) {
        stats.errors++;
        Logger.log(`[${tenant.tenant_id}] runHourlyFollowPipeline error: ${e.message}`);
        pipelineLog_(tenant.tenant_id, 'hourly_error', `run=${runId} stage=${stage} msg=${e.message}`);
        notifyAdminSafe_(`[step-samurai] ${tenant.tenant_id} runHourlyFollowPipelineエラー: ${e.message}`);
      }
    });
    pipelineLog_(HOURLY_LOG_ID_, 'hourly_done', `run=${runId} tenants=${stats.tenants} ran=${stats.ran} billing_skipped=${stats.billing_skipped} errors=${stats.errors}`);
  } catch(e) {
    Logger.log(`runHourlyFollowPipeline fatal (stage=${stage}): ${e.message}`);
    pipelineLog_(HOURLY_LOG_ID_, 'hourly_error', `run=${runId} stage=${stage} msg=${e.message}`);
    notifyAdminSafe_(`[step-samurai] runHourlyFollowPipeline 全体エラー (stage=${stage}): ${e.message}`);
  }
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

/**
 * このスクリプトが管理するトリガー（冪等に登録する対象）。ここに無いハンドラのトリガーは触らない。
 * runPipeline（クーポン経路を含む）は GO_LIVE.md のとおり登録しない。
 */
const MANAGED_TRIGGERS_ = [
  { handler: 'runHourlyFollowPipeline', build: b => b.timeBased().everyHours(1) },
  { handler: 'checkBillingDaily',       build: b => b.timeBased().everyDays(1).atHour(9) },
  { handler: 'runLicenseCheck',       build: b => b.timeBased().everyDays(1).atHour(9) },
];

/**
 * 既存トリガーのハンドラ名一覧から、作るべきもの・重複して消すべきものを決める（純粋関数）。
 * 管理対象ごとに 0 本なら create、2 本以上なら 1 本目を残して残りを dedupe（インデックスで返す）。管理対象外は何もしない。
 */
function planManagedTriggers_(existingHandlers, managed) {
  const plan = { create: [], dedupe: [], keep: [] };
  managed.forEach(m => {
    const idxs = [];
    existingHandlers.forEach((h, i) => { if (h === m.handler) idxs.push(i); });
    if (!idxs.length) plan.create.push(m.handler);
    else { plan.keep.push(m.handler); idxs.slice(1).forEach(i => plan.dedupe.push(i)); }
  });
  return plan;
}

/**
 * トリガーの登録（GAS エディタから手動で1回実行。何度実行しても結果は同じ）。
 * 管理対象（MANAGED_TRIGGERS_）が未登録なら作成し、重複していれば1本に減らす。それ以外のトリガーは削除しない。
 * 既存の管理対象トリガーは作り直さない（実行時刻が変わらない）。
 */
function setupTriggers() {
  const existing = ScriptApp.getProjectTriggers();
  const plan = planManagedTriggers_(existing.map(t => t.getHandlerFunction()), MANAGED_TRIGGERS_);
  plan.dedupe.forEach(i => ScriptApp.deleteTrigger(existing[i]));
  plan.create.forEach(h => MANAGED_TRIGGERS_.find(m => m.handler === h).build(ScriptApp.newTrigger(h)).create());
  const after = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  Logger.log(`setupTriggers: 作成=${JSON.stringify(plan.create)} 重複削除=${plan.dedupe.length}件 維持=${JSON.stringify(plan.keep)} / 現在のトリガー=${JSON.stringify(after)}`);
  return { created: plan.create, deduped: plan.dedupe.length, kept: plan.keep, triggers: after };
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

/**
 * 署名の問い合わせURLに sid が入るかの確認（読み取り専用・sends 等へは書かない）。
 * shop_signature_override を無視した経路（buildSignature_ の自動生成）で 240364 が含まれることを確認する。
 */
function testSignatureSidTokyoflower() {
  const runId = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss');
  const c = getRmsCredentials('tokyoflower');
  const auto = buildSignature_(c.shop_name, c.sid, null);   // tenantId=null → override を参照しない自動生成
  Logger.log(`test_signature_sid_${runId}: sid=${c.sid} inquiry_url=${c.inquiry_url} contains240364=${auto.indexOf('240364') >= 0}`);
  return auto.indexOf('240364') >= 0;
}

function setupConfigSheetsTokyoflower() {
  return setupTenantConfigSheets_('tokyoflower');
}
