/**
 * reviews_ingest.gs — ECOS Webhook 経由のレビュー自動取込（doPost action=ingest_reviews）
 *
 * 背景:
 *  reviews_import.gs は店舗が RMS「レビューチェックツール」CSVを管理画面に貼り付けて取り込む方式。
 *  ECOS 側で楽天レビューを定期取得できるようになったため、同じ reviews タブへ Webhook 経由でも
 *  upsert できるようにする。テナントトークンではなく ECOS 専用の Script Property キーで認証する
 *  （webapp.gs の他アクションと違い、店舗の管理画面ログインとは無関係な機械間連携のため）。
 *
 * 認証・安全設計:
 *  - Script Properties `REVIEW_INGEST_KEY__<tenant_id>`（平文。ADMIN_TOKEN と同方式）を
 *    payload.api_key と hash_equals_（定数時間比較）で照合する。
 *  - 未登録テナント／キー不一致のどちらも理由を区別せず {ok:false, error:'unauthorized'} を返す
 *    （キーが存在するかどうかを外部から推測されないようにする）。
 *  - テナント設定 review_ingest_enabled が文字列 'true' でない限り受信を拒否する（fail-closed。既定 false）。
 *  - 1リクエスト最大 500 件。reviews タブの既存列（review_id|order_number|buyer_key|item_code|rating|
 *    posted_at|body）は削除・並び替えせず、追加列は ensureReviewIngestColumns_ で末尾に追記するのみ。
 *  - ログには APIキー・レビュー本文を出さない（件数と sync_id のみ）。
 *  - 例外はスタックトレースを返さず {ok:false, error:'internal_error'}。
 */

const REVIEW_INGEST_MAX_ROWS_ = 500;

// reviews タブの既存列（review_id|order_number|buyer_key|item_code|rating|posted_at|body）に対して
// 末尾に追記する Webhook 取込専用の列
const REVIEW_INGEST_EXTRA_COLUMNS_ = [
  'review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at', 'matched',
];

/**
 * reviews タブに ingest 用の追加列が無ければ末尾に追加する（冪等。既存列・既存データは一切触らない）。
 * ensureAnalyticsColumns_（analytics_schema.gs）と同じロジック。戻り値: 追加した列名の配列
 */
function ensureReviewIngestColumns_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const header  = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || ''));
  const missing = REVIEW_INGEST_EXTRA_COLUMNS_.filter(c => header.indexOf(c) < 0);
  if (missing.length === 0) return [];

  // ヘッダ末尾の空セルを考慮して「実ヘッダの最終位置」の次から書く
  let realLast = header.length;
  while (realLast > 0 && header[realLast - 1] === '') realLast--;
  sheet.getRange(1, realLast + 1, 1, missing.length).setValues([missing]);
  return missing;
}

/**
 * ECOS から届く1件の生データを、CSV取込（reviews_import.gs）と同じ正規化ルールで整形する。
 * review_id はレビュー詳細URLそのもの（buildReviewId_ に explicitId=URL, reviewUrl=URL の両方を渡す）。
 * buyer_key / item_code はここでは決めない（既存行を持つ場合に上書きしないよう、あえて未定義のままにする）。
 */
function normalizeIngestReviewRow_(raw) {
  raw = raw || {};
  const orderNumber = String(raw.order_number || '').trim();
  const postedAt    = normalizeReviewDate_(raw.posted_at);
  const reviewType  = String(raw.review_type || '');
  const reviewUrl   = String(raw.review_id || '');
  const reviewId    = buildReviewId_(reviewUrl, reviewUrl, reviewType, orderNumber, postedAt);
  const ratingNum   = Number(raw.rating);
  const title       = String(raw.title || '');
  const bodyText    = (title ? `【${title}】\n` : '') + String(raw.body || '');

  return {
    review_id:       reviewId,
    order_number:    orderNumber,
    rating:          isNaN(ratingNum) ? 0 : ratingNum,
    posted_at:       postedAt,
    body:            bodyText.substring(0, 5000),
    review_type:     reviewType,
    product_title:   String(raw.product_title || ''),
    rakuten_item_id: String(raw.rakuten_item_id || ''),
    source:          'ecos_webhook',
    deleted:         !!raw.deleted, // 列ではなく判定用フラグ。deleted_at は呼び出し側で now/'' に変換する
  };
}

/**
 * orders タブの order_number 集合を作り、reviews.matched 列を一括更新する（TRUE/FALSE の文字列）。
 * 戻り値: { matched, unmatched }（reviews タブの全行に対する件数）
 */
function markReviewOrderMatches_(tenantId) {
  const ss     = getTenantSpreadsheet(tenantId);
  const orders = ss.getSheetByName('orders');
  const sheet  = ss.getSheetByName('reviews');
  if (!orders || !sheet) return { matched: 0, unmatched: 0 };

  const orderData   = orders.getDataRange().getValues();
  const orderHeader = orderData[0].map(String);
  const orderNumIdx = orderHeader.indexOf('order_number');
  const orderNumbers = new Set(
    orderData.slice(1).map(r => String(r[orderNumIdx] || '')).filter(Boolean)
  );

  ensureReviewIngestColumns_(sheet);
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(String);
  const orderIdx   = header.indexOf('order_number');
  const matchedIdx = header.indexOf('matched');
  if (data.length < 2 || matchedIdx < 0 || orderIdx < 0) return { matched: 0, unmatched: 0 };

  let matched = 0, unmatched = 0;
  const values = data.slice(1).map(row => {
    const on = String(row[orderIdx] || '');
    const isMatch = !!on && orderNumbers.has(on);
    if (isMatch) matched++; else unmatched++;
    return [isMatch ? 'TRUE' : 'FALSE'];
  });
  if (values.length) sheet.getRange(2, matchedIdx + 1, values.length, 1).setValues(values);
  return { matched, unmatched };
}

/**
 * doPost action=ingest_reviews のハンドラ。戻り値をそのまま webapp.gs 側で jsonResponse_ する。
 */
function handleIngestReviews_(payload) {
  try {
    payload = payload || {};
    const tenantId = String(payload.tenant_id || '').trim().toLowerCase();
    const apiKey   = String(payload.api_key || '');
    if (!tenantId || !apiKey) return { ok: false, error: 'unauthorized' };

    const storedKey = PropertiesService.getScriptProperties().getProperty(`REVIEW_INGEST_KEY__${tenantId}`);
    if (!storedKey || !hash_equals_(storedKey, apiKey)) return { ok: false, error: 'unauthorized' };

    const enabled = getTenantSettingValue_(tenantId, 'review_ingest_enabled');
    if (enabled !== 'true') return { ok: false, error: 'review_ingest_disabled' };

    const syncId = payload.sync_id || '';
    const rawRows = payload.reviews;
    if (!Array.isArray(rawRows) || rawRows.length > REVIEW_INGEST_MAX_ROWS_) {
      return { ok: false, error: 'invalid_payload' };
    }

    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const records = rawRows
      .map(r => normalizeIngestReviewRow_(r))
      .filter(x => x.review_id)
      .map(rec => {
        rec.updated_at = now;
        rec.deleted_at = rec.deleted ? now : ''; // deleted:false は既存の deleted_at を空で上書き＝復活
        delete rec.deleted;
        return rec;
      });

    const ss    = getTenantSpreadsheet(tenantId);
    const sheet = ss.getSheetByName('reviews');
    if (!sheet) return { ok: false, error: 'internal_error' };
    ensureReviewIngestColumns_(sheet);

    const data  = sheet.getDataRange().getValues();
    const hdr   = data[0].map(String);
    const idIdx = hdr.indexOf('review_id');
    const rowByIdx = {};
    for (let i = 1; i < data.length; i++) {
      const id = String(data[i][idIdx] || '');
      if (id) rowByIdx[id] = i;
    }

    // ここに含めない列（matched）は markReviewOrderMatches_ が別途更新する。
    // buyer_key / item_code は normalizeIngestReviewRow_ が意図的に未定義のままにしており、
    // 既存行を更新する際もここで触れない（CSV取込で入った値を webhook 側が消さないため）。
    const cols = [
      'review_id', 'order_number', 'rating', 'posted_at', 'body',
      'review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at',
    ];
    const toRow = (rec, existingRow) => {
      const row = existingRow ? existingRow.slice() : Array(hdr.length).fill('');
      while (row.length < hdr.length) row.push('');
      cols.forEach(c => {
        const i = hdr.indexOf(c);
        if (i >= 0 && rec[c] !== undefined) row[i] = rec[c];
      });
      return row;
    };

    let inserted = 0, updated = 0;
    const newRows = [];
    records.forEach(rec => {
      const i = rowByIdx[rec.review_id];
      if (i !== undefined) {
        sheet.getRange(i + 1, 1, 1, hdr.length).setValues([toRow(rec, data[i])]);
        updated++;
      } else {
        newRows.push(toRow(rec, null));
        inserted++;
      }
    });
    if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, hdr.length).setValues(newRows);

    try { linkOrdersReviews(tenantId); } catch (e) { Logger.log(`[${tenantId}] ingest_reviews linkOrdersReviews error: ${e.message}`); }
    const matchResult = markReviewOrderMatches_(tenantId);

    Logger.log(`[${tenantId}] ingest_reviews sync_id=${syncId} received=${rawRows.length} inserted=${inserted} updated=${updated} matched=${matchResult.matched} unmatched=${matchResult.unmatched}`);

    return {
      ok: true,
      upserted: inserted + updated,
      inserted: inserted,
      updated: updated,
      matched: matchResult.matched,
      unmatched: matchResult.unmatched,
      sync_id: syncId,
    };
  } catch (e) {
    return { ok: false, error: 'internal_error' };
  }
}

// ===== GASエディタ用ヘルパー（tokyoflower・読み取りのみ／設定投入のみ） =====

/** 読み取り専用: 設定値・キー登録有無（値は出さない）・reviews 行数・matched/unmatched をログに出す */
function previewReviewIngestStatusTokyoflower() {
  const tenantId = 'tokyoflower';
  const enabled = getTenantSettingValue_(tenantId, 'review_ingest_enabled');
  const hasKey  = !!PropertiesService.getScriptProperties().getProperty(`REVIEW_INGEST_KEY__${tenantId}`);

  const ss     = getTenantSpreadsheet(tenantId);
  const sheet  = ss.getSheetByName('reviews');
  const data   = sheet ? sheet.getDataRange().getValues() : [];
  const header = data[0] ? data[0].map(String) : [];
  const matchedIdx = header.indexOf('matched');
  let matched = 0, unmatched = 0;
  if (matchedIdx >= 0) {
    data.slice(1).forEach(row => { (String(row[matchedIdx]).toUpperCase() === 'TRUE') ? matched++ : unmatched++; });
  }
  const rows = Math.max(data.length - 1, 0);
  Logger.log(`[${tenantId}] review_ingest_enabled=${enabled} REVIEW_INGEST_KEY登録=${hasKey} reviews行数=${rows} matched=${matched} unmatched=${unmatched}`);
  return { enabled, hasKey, rows, matched, unmatched };
}

/** STEP5用: 送らずにレビューお礼メールの対象一覧だけを返す（既存関数のラッパー） */
function dryRunReviewThanksTokyoflower() {
  return previewPendingReviewThanksTokyoflower();
}

/** ensureTenantSettingsKeys_ を呼び、review_ingest_enabled 等の未追加キーを投入する（冪等） */
function ensureReviewIngestSettingsTokyoflower() {
  const added = ensureTenantSettingsKeys_('tokyoflower');
  Logger.log(added.length ? `追加: ${added.join(', ')}` : '追加なし（すべて存在）');
  return added;
}
