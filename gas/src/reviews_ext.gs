/**
 * reviews_ext.gs — 店舗配布用 Chrome 拡張からのレビュー取込（doPost action=ext_ingest_reviews）
 *
 * 背景:
 *  ECOS 経由の ingest_reviews（reviews_ingest.gs）は Script Properties のキー登録が運営の手作業で、
 *  外部店舗には使えない。店舗が自分の RMS 画面から取得した CSV の最小項目だけを、拡張が GAS へ直接送る経路を用意する。
 *
 * 認証・安全設計:
 *  - レビュー取込専用トークン（tenant_auth の kind='ext_review'）。保存はハッシュのみ。平文は issueExtToken_ の戻り値に一度だけ。
 *    テナントにつき有効な ext_review は1つ（再発行で旧を revoked にする）。
 *  - ext_review は verifyTenantToken_ では受け付けない（管理画面のテナント用アクションには使えない）。revokeTenantToken_ にも巻き込まない。
 *  - tenant_id はトークンから解決する。本文の tenant_id は読まない。
 *  - 拒否の順: unauthorized / token_revoked / tenant_not_active(active・setup 以外) / billing_not_allowed / invalid_payload / too_many_rows。
 *    dry_run でも同じ検証を行う。review_ingest_enabled は要求しない（ECOS 経路専用。トークン発行が有効化の意思表示）。
 *  - 受け付ける項目は review_type / review_id / rating / posted_at / order_number の5つだけ。他のキーは捨てる（書かない・ログに出さない）。
 *  - 既存行の更新で書くのは order_number / rating / posted_at / review_type / updated_at のみ。新規行は source='chrome_ext'、body・product_title は空。
 *  - 書き込みは ScriptLock で直列化。ログには tenant_id と件数のみ（トークン・URL・注文番号は出さない）。
 *  - dry_run は検証と件数だけ（シート・認証シートへ一切書かない）。
 */

const EXT_TOKEN_KIND_ = 'ext_review';
const EXT_MAX_ROWS_ = 500;
const EXT_MAX_BYTES_ = 2 * 1024 * 1024;
const EXT_STALE_DAYS_ = 3;
const EXT_STALE_EVENT_ = 'ext_stale_notified';
const EXT_INITIAL_FROM_DAYS_ = 30;

const EXT_MESSAGES_ = {
  unauthorized:       'トークンが正しくありません。',
  token_revoked:      'このトークンは無効になっています。運営に再発行を依頼してください。',
  tenant_not_active:  'この店舗は現在停止中のため取り込めません。',
  billing_not_allowed: 'ご利用状況の確認が必要なため取り込めません。',
  invalid_payload:    '送信内容の形式が正しくありません。',
  too_many_rows:      `1回に送れるのは${EXT_MAX_ROWS_}件までです。`,
  busy:               '他の処理が実行中です。しばらくして再試行してください。',
  internal_error:     '内部エラーが発生しました。',
};

function extError_(code) {
  return { ok: false, error: code, message: EXT_MESSAGES_[code] || EXT_MESSAGES_.internal_error };
}

// ===== トークンの発行・失効・解決（tenant_auth の kind='ext_review'） =====

/**
 * 拡張用トークンを発行（再発行）する。既存の有効な ext_review は revoked にする。
 * 平文（sse_ + 英数64文字）は戻り値にのみ含まれ、シートにはハッシュだけを保存する。
 */
function issueExtToken_(tenantId) {
  const token = 'sse_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const sheet  = ensureAuthColumns_();
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(String);
  const idx    = c => header.indexOf(c);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx('tenant_id')]) === tenantId && String(data[i][idx('kind')]) === EXT_TOKEN_KIND_ && data[i][idx('status')] === 'active') {
      sheet.getRange(i + 1, idx('status') + 1).setValue('revoked');
    }
  }
  const row = Array(header.length).fill('');
  row[idx('tenant_id')] = tenantId; row[idx('token_hash')] = hashToken_(token);
  row[idx('issued_at')] = nowJst_(); row[idx('status')] = 'active'; row[idx('kind')] = EXT_TOKEN_KIND_;
  sheet.appendRow(row);
  Logger.log(`[管理者用] 拡張用トークンを発行しました tenant_id=${tenantId}（平文はログに残していません）`);
  return token;
}

/** 有効な ext_review を全て失効させる（kind='token' 等には触れない）。戻り値: 失効した件数 */
function revokeExtToken_(tenantId) {
  const sheet  = getTenantAuthSheet_();
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(String);
  const idx    = c => header.indexOf(c);
  if (idx('kind') < 0) return 0;
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx('tenant_id')]) === tenantId && String(data[i][idx('kind')]) === EXT_TOKEN_KIND_ && data[i][idx('status')] === 'active') {
      sheet.getRange(i + 1, idx('status') + 1).setValue('revoked'); n++;
    }
  }
  return n;
}

/**
 * 平文トークンから { status: 'ok', tenant_id } | { status: 'revoked' } | { status: 'unknown' } を返す。
 * 失効行にハッシュが一致すれば revoked、どの ext_review にも一致しなければ unknown。
 */
function resolveExtToken_(token) {
  if (typeof token !== 'string' || !token || token.length > 200) return { status: 'unknown' };
  const hash   = hashToken_(token);
  const data   = getTenantAuthSheet_().getDataRange().getValues();
  const header = data[0].map(String);
  const idx    = c => header.indexOf(c);
  if (idx('kind') < 0) return { status: 'unknown' };
  let revoked = false;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[idx('kind')]) !== EXT_TOKEN_KIND_) continue;
    if (!hash_equals_(String(row[idx('token_hash')]), hash)) continue;
    if (row[idx('status')] === 'active') return { status: 'ok', tenant_id: String(row[idx('tenant_id')]) };
    revoked = true;
  }
  return { status: revoked ? 'revoked' : 'unknown' };
}

/** 有効な ext_review 行の last_used_at に JST 日時を記録する（実書き込み成功時のみ呼ぶ） */
function recordExtLastUsed_(token) {
  const sheet  = ensureAuthColumns_();
  const hash   = hashToken_(token);
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(String);
  const idx    = c => header.indexOf(c);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx('kind')]) === EXT_TOKEN_KIND_ && data[i][idx('status')] === 'active' && hash_equals_(String(data[i][idx('token_hash')]), hash)) {
      sheet.getRange(i + 1, idx('last_used_at') + 1).setValue(nowJst_());
      return true;
    }
  }
  return false;
}

// ===== 1行の検証（5項目だけを取り出す。他のキーは読まない） =====

const EXT_DATE_RE_ = /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;
const EXT_NORMALIZED_DATE_RE_ = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;
const EXT_TYPE_RE_ = /^[A-Za-z0-9_ ぀-ヿ㐀-鿿＀-￯]{1,30}$/;

/** 戻り値: { rec } または { reason }（reason は固定コードのみ。入力値は返さない） */
function validateExtRow_(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not_object' };

  const reviewId = typeof raw.review_id === 'string' ? raw.review_id.trim() : '';
  if (!/^https?:\/\//i.test(reviewId) || reviewId.length > 500) return { reason: 'review_id' };

  const orderNumber = typeof raw.order_number === 'string' ? raw.order_number.trim() : '';
  if (!/^[0-9][0-9\-]*$/.test(orderNumber) || orderNumber.length > 64) return { reason: 'order_number' };

  const ratingRaw = raw.rating;
  const rating = (typeof ratingRaw === 'number' || (typeof ratingRaw === 'string' && /^\d$/.test(ratingRaw.trim()))) ? Number(ratingRaw) : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { reason: 'rating' };

  const postedRaw = typeof raw.posted_at === 'string' ? raw.posted_at.trim() : '';
  if (!EXT_DATE_RE_.test(postedRaw)) return { reason: 'posted_at' };
  const postedAt = normalizeReviewDate_(postedRaw);
  const m = EXT_NORMALIZED_DATE_RE_.exec(postedAt);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31
      || (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59))) return { reason: 'posted_at' };

  let reviewType = '';
  if (raw.review_type !== undefined && raw.review_type !== null && raw.review_type !== '') {
    reviewType = typeof raw.review_type === 'string' ? raw.review_type.trim() : '';
    if (!EXT_TYPE_RE_.test(reviewType)) return { reason: 'review_type' };
  }

  return { rec: { review_id: reviewId, order_number: orderNumber, rating: rating, posted_at: postedAt, review_type: reviewType } };
}

// ===== doPost action=ext_ingest_reviews =====

/** 戻り値をそのまま webapp.gs 側で jsonResponse_ する。payload: { token, dry_run, reviews } */
function handleExtIngestReviews_(payload) {
  try {
    payload = payload || {};
    const token = payload.token;

    const auth = resolveExtToken_(token);
    if (auth.status === 'revoked') return extError_('token_revoked');
    if (auth.status !== 'ok') return extError_('unauthorized');
    const tenantId = auth.tenant_id;

    const t = listAllTenants_().find(x => x.tenant_id === tenantId);
    if (!t || (t.status !== 'active' && t.status !== 'setup')) return extError_('tenant_not_active');
    if (!billingDecision_(tenantId).allowed) return extError_('billing_not_allowed');

    // dry_run は fail-closed: false / 未指定 / 'false' 以外は dry_run として扱う
    const dp = payload.dry_run;
    const dryRun = !(dp === undefined || dp === null || dp === false || dp === 'false');

    const rawRows = payload.reviews;
    if (!Array.isArray(rawRows) || JSON.stringify(rawRows).length > EXT_MAX_BYTES_) return extError_('invalid_payload');
    if (rawRows.length > EXT_MAX_ROWS_) return extError_('too_many_rows');

    // 検証。同一リクエスト内の重複 review_id は後勝ち
    const reasons = {};
    let valid = 0;
    const byId = {};
    rawRows.forEach(raw => {
      const v = validateExtRow_(raw);
      if (!v.rec) { reasons[v.reason] = (reasons[v.reason] || 0) + 1; return; }
      valid++;
      byId[v.rec.review_id] = v.rec;
    });
    const records = Object.keys(byId).map(k => byId[k]);
    const result = {
      ok: true, dry_run: dryRun, received: rawRows.length, valid: valid, rejected: rawRows.length - valid,
      rejected_reasons: reasons, duplicates: valid - records.length, inserted: 0, updated: 0,
      initial_from: getReviewThanksSince_(tenantId) || addDaysStr_(billingToday_(), -EXT_INITIAL_FROM_DAYS_),
    };

    const sheet = getTenantSpreadsheet(tenantId).getSheetByName('reviews');

    if (dryRun) {
      // 読み取りのみ（ensure 系・last_used_at の記録もしない）
      const existing = {};
      if (sheet && records.length) {
        const data = sheet.getDataRange().getValues();
        const idI = data[0].map(String).indexOf('review_id');
        if (idI >= 0) for (let i = 1; i < data.length; i++) { const id = String(data[i][idI] || ''); if (id) existing[id] = true; }
      }
      result.would_update = records.filter(r => existing[r.review_id]).length;
      result.would_insert = records.length - result.would_update;
      Logger.log(`[${tenantId}] ext_ingest_reviews dry_run received=${result.received} valid=${valid} rejected=${result.rejected} would_insert=${result.would_insert} would_update=${result.would_update}`);
      return result;
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return extError_('busy');
    try {
      if (records.length) {
        if (!sheet) return extError_('internal_error');
        ensureReviewIngestColumns_(sheet);
        const data = sheet.getDataRange().getValues();
        const hdr  = data[0].map(String);
        const col  = c => hdr.indexOf(c);
        const idI = col('review_id'), ordI = col('order_number'), ratI = col('rating'), postI = col('posted_at');
        const typeI = col('review_type'), srcI = col('source'), updI = col('updated_at');
        if (idI < 0 || ordI < 0 || ratI < 0 || postI < 0) return extError_('internal_error');

        const rowById = {};
        for (let i = 1; i < data.length; i++) { const id = String(data[i][idI] || ''); if (id) rowById[id] = i; }

        const now = nowJst_();
        const newRows = [];
        let typeTouched = false;
        records.forEach(rec => {
          const i = rowById[rec.review_id];
          if (i !== undefined) {
            // 既存行: 書いてよいのは order_number / rating / posted_at / review_type / updated_at のみ
            data[i][ordI] = rec.order_number; data[i][ratI] = rec.rating; data[i][postI] = rec.posted_at;
            if (typeI >= 0 && rec.review_type !== '') { data[i][typeI] = rec.review_type; typeTouched = true; }
            if (updI >= 0) data[i][updI] = now;
            result.updated++;
          } else {
            const row = Array(hdr.length).fill('');
            row[idI] = rec.review_id; row[ordI] = rec.order_number; row[ratI] = rec.rating; row[postI] = rec.posted_at;
            if (typeI >= 0) row[typeI] = rec.review_type;
            if (srcI >= 0) row[srcI] = 'chrome_ext';
            if (updI >= 0) row[updI] = now;
            newRows.push(row);
            result.inserted++;
          }
        });

        // 1行ずつ書かず、更新対象の列だけを列単位でまとめて書く（他の列は触らない）
        if (result.updated > 0 && data.length > 1) {
          const cols = [ordI, ratI, postI];
          if (typeTouched) cols.push(typeI);
          if (updI >= 0) cols.push(updI);
          cols.forEach(c => sheet.getRange(2, c + 1, data.length - 1, 1).setValues(data.slice(1).map(r => [r[c]])));
        }
        if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, hdr.length).setValues(newRows);

        try { linkOrdersReviews(tenantId); } catch (e) { Logger.log(`[${tenantId}] ext_ingest_reviews linkOrdersReviews error: ${e.message}`); }
        markReviewOrderMatches_(tenantId);
      }
    } finally { lock.releaseLock(); }

    // 同期完了の心拍として、空配列でも最終受信日時を記録する（失敗しても取込結果は返す）
    try { recordExtLastUsed_(token); } catch (e) { Logger.log(`[${tenantId}] ext_ingest_reviews last_used_at error: ${e.message}`); }

    Logger.log(`[${tenantId}] ext_ingest_reviews received=${result.received} valid=${valid} rejected=${result.rejected} inserted=${result.inserted} updated=${result.updated}`);
    return result;
  } catch (e) {
    return extError_('internal_error');
  }
}

// ===== 受信途絶の日次チェック（checkBillingDaily から try/catch 付きで呼ぶ） =====
//
// 対象: status=active で、有効な ext_review トークンを持ち、last_used_at が一度でも記録されていて、
//       最終受信から EXT_STALE_DAYS_ 日を超えている（JST 日付差が3日より大きい）テナント。ちょうど3日は通知しない。
// 同一テナントへの通知は1日1回（billing_events の ext_stale_notified。note 先頭に JST 日付）。
// ADMIN_EMAIL 未設定ならログのみ（記録しない）。メール本文は tenant_id と日数のみ。
// 戻り値: 通知（または送信試行）したテナント ID の配列
function checkExtStale_() {
  const today = billingToday_();
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  const done = [];
  const authData = getTenantAuthSheet_().getDataRange().getValues();
  const summary = extTokenSummaryByTenant_(authData);
  listAllTenants_().forEach(t => {
    if (t.status !== 'active') return;
    const s = summary[t.tenant_id];
    if (!s || !s.last_received_at) return;
    try {
      const last = toJstDateString_(s.last_received_at);
      if (!last) return;
      const days = daysBetweenStr_(last, today);
      if (days <= EXT_STALE_DAYS_) return;
      const ev = getBillingEventsSheet_().getDataRange().getValues().slice(1).filter(r => String(r[2]) === t.tenant_id);
      if (ev.some(r => r[4] === EXT_STALE_EVENT_ && String(r[7]).indexOf(today) === 0)) return;   // 同日2回目
      const body = [
        `テナントID: ${t.tenant_id}`,
        `レビュー取込（Chrome 拡張）の最終受信から ${days} 日が経過しています（${EXT_STALE_DAYS_} 日を超えると通知）。`,
        '',
        '店舗へ RMS のレビュー画面を開いて同期するよう案内してください。',
      ].join('\n');
      if (!adminEmail) { Logger.log(`checkExtStale_: ADMIN_EMAIL 未設定のためメール送信せず。内容:\n${body}`); return; }
      MailApp.sendEmail(adminEmail, `[step-samurai] レビュー取込の受信が途絶えています（${t.tenant_id}）`, body);
      appendBillingEvent_(t.tenant_id, 'system', EXT_STALE_EVENT_, '', '', `${today} days=${days}`);
      done.push(t.tenant_id);
    } catch (e) { Logger.log(`checkExtStale_ error [${t.tenant_id}]: ${e.message}`); }
  });
  return done;
}
