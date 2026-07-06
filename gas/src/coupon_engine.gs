/**
 * coupon_engine.gs — クーポン判定（楽天ガイドライン準拠・300円統一）
 *
 * ルール（楽天市場ガイドライン準拠）：
 *  - 「今回の注文」への値引き・送料無料は付与しない
 *  - レビュー投稿の有無を reviews タブで確認
 *  - 評価・内容によらず一律条件で付与
 *  - 購入回数ごとの一律特典は可
 *
 * クーポン金額・有効/無効はテナントの settings タブ（coupon_rules, JSON）で変更可能。
 * purchase_count のレンジやレビュー必須・クーポン名などの「構造」はコード側
 * (COUPON_RULE_STRUCTURE_) で固定し、settings 側では discount と enabled のみ編集させる
 * （テナントが不用意にJSONを壊して判定条件そのものを変えてしまうのを防ぐ設計）。
 */

// ===== クーポンルールの構造（購入回数レンジ等）。金額はsettingsタブ側で管理 =====
const COUPON_RULE_STRUCTURE_ = {
  first_purchase: {
    description:        '初回購入特典',
    purchase_count_min:  1,
    purchase_count_max:  1,
    requires_review:     true,
    coupon_name:         '初回ご購入ありがとうクーポン',
  },
  repeat_purchase: {
    description:        'リピート特典（2回目以降）',
    purchase_count_min:  2,
    purchase_count_max:  9999,
    requires_review:     true,
    coupon_name:         'リピーター感謝クーポン',
  },
};

/**
 * テナントの settings タブ（coupon_rules キー、JSON配列）から
 * { rule_id, discount, enabled } を読み取り、COUPON_RULE_STRUCTURE_ の構造情報と合成して返す。
 * settings タブが無い/JSON不正/未知のrule_idは fail-closed（そのルールを除外・対象0件）。
 */
function getCouponRules_(tenantId) {
  const raw = getTenantSettingValue_(tenantId, 'coupon_rules');
  if (!raw) {
    Logger.log(`[${tenantId}] getCouponRules_: settings.coupon_rules が見つからないためクーポン対象なし（fail-closed）`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    Logger.log(`[${tenantId}] getCouponRules_: coupon_rules JSON解析失敗のためクーポン対象なし（fail-closed）: ${e.message}`);
    return [];
  }

  return parsed
    .filter(r => r.enabled !== false)
    .map(r => {
      const base = COUPON_RULE_STRUCTURE_[r.rule_id];
      if (!base) {
        Logger.log(`[${tenantId}] getCouponRules_: 未知の rule_id をスキップ: ${r.rule_id}`);
        return null;
      }
      return Object.assign({}, base, { rule_id: r.rule_id, discount: Number(r.discount) });
    })
    .filter(Boolean);
}

/**
 * 配信対象（クーポン発行対象）を抽出
 */
function evaluateCoupons(tenantId) {
  const ss      = getTenantSpreadsheet(tenantId);
  const orders  = ss.getSheetByName('orders');
  const coupons = ss.getSheetByName('coupons');
  const data    = orders.getDataRange().getValues();
  const header  = data[0];
  const idx     = col => header.indexOf(col);
  const rules   = getCouponRules_(tenantId);

  // 発行済み（buyer_key + rule_id）セットで重複防止
  // 成功行のみを対象にする。失敗行（api_result が ERROR: で始まる）は除外し、
  // 次回以降そのルールで再発行を試せるようにする（mailer.gs alreadySent_ と同方針）。
  // TODO: 偽陰性（実際は発行済みなのに応答がエラーだった）場合、再試行で二重発行の可能性あり。恒久対策は別途検討。
  const couponData = coupons.getDataRange().getValues();
  const issuedSet  = new Set(
    couponData.slice(1)
      .filter(row => !String(row[5]).startsWith('ERROR'))
      .map(row => `${row[1]}__${row[2]}`)
  );

  const goLiveDate = getGoLiveDate_();
  if (!goLiveDate) {
    Logger.log(`[${tenantId}] evaluateCoupons: GO_LIVE_DATE未設定のため全スキップ`);
    return [];
  }

  const followDays = getFollowDaysAfterShip_(tenantId);
  if (followDays === null) {
    Logger.log(`[${tenantId}] evaluateCoupons: settings.follow_days_after_ship 未設定/不正のため全スキップ（fail-closed）`);
    return [];
  }

  const targets = [];
  const now     = new Date();

  data.slice(1).forEach(row => {
    if (!row[idx('order_number')]) return;

    const status        = row[idx('status')];
    const reviewLinked  = row[idx('review_linked')];
    const buyerKey      = row[idx('buyer_key')];
    const orderNum      = row[idx('order_number')];
    const purchaseCount = Number(row[idx('purchase_count')]) || 1;
    const shipDate      = row[idx('ship_date')];

    // レビュー投稿済みの注文は判定理由をログに出す（デバッグ）
    const isReviewed = isLinked_(reviewLinked);
    if (isReviewed) {
      const dd = shipDate ? Math.floor((now - new Date(shipDate)) / (1000*60*60*24)) : -1;
      Logger.log(`[review済] ${orderNum} status=${status} ship=${shipDate} 経過=${dd}日 count=${purchaseCount}`);
    }

    if (status === 'cancelled') return;   // キャンセル除外
    if (!shipDate) return;                 // 未発送除外
    if (new Date(shipDate) < goLiveDate) return; // GO_LIVE_DATEより前に発送された注文は対象外

    // 発送後N日経過チェック（Nはsettings.follow_days_after_ship）
    const diffDays = Math.floor((now - new Date(shipDate)) / (1000 * 60 * 60 * 24));
    if (diffDays < followDays) return;

    rules.forEach(rule => {
      if (purchaseCount < rule.purchase_count_min) return;
      if (purchaseCount > rule.purchase_count_max) return;
      if (rule.requires_review && !isLinked_(reviewLinked)) return;

      const key = `${buyerKey}__${rule.rule_id}`;
      if (issuedSet.has(key)) return;

      targets.push({
        order_number: orderNum,
        buyer_key:    buyerKey,
        rule_id:      rule.rule_id,
      });
    });
  });

  Logger.log(`evaluateCoupons [${tenantId}]: ${targets.length}件対象`);
  return targets;
}

/**
 * review_linked の値が「紐づけ済み」を表すか判定する。
 * Google Sheets はセルの 'true' をブール値 TRUE に自動変換するため、
 * 文字列 'true'/'TRUE' とブール値 true の両方を受け付ける。
 */
function isLinked_(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}
