/**
 * coupon_test.gs — クーポン実発行テスト（tokyoflower・1件・GASエディタから手動実行）
 *
 * 目的: 2026-07-05 に "Request data is wrong format" で止まったクーポン経路の疎通確認。
 * 安全設計:
 *  - settings.coupon_enabled は変更しない（issueCoupon の force=true でそのゲートだけを通す。テスト専用）
 *  - 課金ガード（billingAllows_）とテナント dry_run は常に有効（dry_run=true なら発行しない）
 *  - 1回の実行で発行されるクーポンは最大1件（成功した時点で止まる）。失敗した試行は何も発行しない
 *  - 結果は sends に coupon_test_{runId}（type=coupon_test）として追記のみ（既存行は触らない）
 *  - 試行は最大3回。"wrong format" 以外のエラー（認可・権限など）は形式の問題ではないので再試行しない
 */

const COUPON_TEST_TENANT_ = 'tokyoflower';
const COUPON_TEST_VARIANTS_ = ['minimal', 'go_model', 'legacy'];

/** テスト用パラメータ: 定額100円 / 発行上限1枚 / 1人1回 / 開始=翌日10:00 JST / 有効期間2日 / itemType=4（ビルダー側で固定） */
function couponTestParams_(now, variant) {
  now = now || new Date();
  const tomorrow = Utilities.formatDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), 'Asia/Tokyo', 'yyyy-MM-dd');
  const start = new Date(`${tomorrow}T10:00:00+09:00`);
  const end   = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
  return { name: 'ステップ侍API疎通テスト', caption: 'API疎通テスト用（削除してください）', start: start, end: end,
           issueCount: 1, discountType: 1, discountFactor: 100, memberAvailMaxCount: 1, variant: variant, now: now };
}

/** 送らずに3形式のリクエストXMLと検証結果をログ出力する（Orchestrator のスキーマ照合用）。副作用なし */
function dryRunCouponTestTokyoflower() {
  COUPON_TEST_VARIANTS_.forEach(v => {
    const b = buildCouponIssueXml_(couponTestParams_(new Date(), v));
    Logger.log(`[dry-run:${v}] ok=${b.ok} ${b.ok ? '\n' + b.xml : b.errors.join(' / ')}`);
  });
  Logger.log(`billing=${billingDecision_(COUPON_TEST_TENANT_).reason} dry_run=${isTenantDryRun_(COUPON_TEST_TENANT_)} coupon_enabled=${isTenantCouponEnabled_(COUPON_TEST_TENANT_)}（未設定のままで正常）`);
}

/**
 * 実発行（Real-World Transaction。事前承認済みの1件のみ）。GASエディタで引数なしで実行する。
 * 成功時: 最終ログに couponCode / 取得URL / 有効期間を出力し、sends に coupon_test_{runId} を記録。
 */
function runCouponTestTokyoflower() {
  const tenantId = COUPON_TEST_TENANT_;
  const runId = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss');
  if (isTenantDryRun_(tenantId)) { Logger.log(`runCouponTestTokyoflower 中止: dry_run=true（発行しない） runId=${runId}`); return null; }

  let last = null;
  for (let i = 0; i < COUPON_TEST_VARIANTS_.length; i++) {
    const variant = COUPON_TEST_VARIANTS_[i], out = {};
    const params = couponTestParams_(new Date(), variant);
    const target = { order_number: `coupon_test_${runId}`, buyer_key: '', rule_id: 'coupon_test' };
    const coupon = issueCoupon(tenantId, target, { force: true, params: params, testRunId: runId, out: out });
    Logger.log(`[coupon_test_${runId}] 試行${i + 1}/${COUPON_TEST_VARIANTS_.length} variant=${variant} ok=${!!coupon}\n--- 送信XML ---\n${out.xml}\n--- レスポンス全文 ---\n${out.body}`);
    if (coupon) {
      Logger.log(`[coupon_test_${runId}] 成功 couponCode=${coupon.coupon_id} get_url=${coupon.get_url} 開始=${Utilities.formatDate(params.start, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')} 終了=${Utilities.formatDate(params.end, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')} variant=${variant}`);
      return { ok: true, runId: runId, coupon: coupon, variant: variant };
    }
    last = out;
    if (!/wrong format/i.test(String(out.body || ''))) { Logger.log(`[coupon_test_${runId}] 形式以外のエラーのため再試行しません`); break; }
  }
  Logger.log(`[coupon_test_${runId}] 失敗（発行されていません）。最後のレスポンス: ${last ? last.body : ''}`);
  return { ok: false, runId: runId };
}
