/**
 * review_tiers.gs — ★段階別レビューお礼 / 店舗向け設定 API / プレビュー・テスト送信 / 設定履歴 / tokyoflower 移行
 *
 * 保存先（既存の仕組みを使う）:
 *  - follow_delay_days ........... settings タブ（旧 follow_days_after_ship は未保存時のフォールバック）
 *  - follow_subject / follow_body . templates タブ follow_v1
 *  - review_tier_count / review_tier_b1 / review_tier_b2 / tier{N}_enabled / tier{N}_subject / tier{N}_body / tier{N}_coupon_url
 *      ........................... settings タブ（editable_by_tenant=FALSE。店舗は saveStoreSettings_ 経由でのみ書ける）
 *  - 履歴 ......................... settings_history タブ（id, saved_at, saved_by, kind, before_json, after_json）
 *
 * 安全設計: 店舗用関数は呼び出し元（webapp.gs）が verifyTenantToken_ で解決した tenantId だけを受け取る。
 * レビュー段階の設定が未保存の間は送らない（fail-closed）。例外は LEGACY_REVIEW_THANKS_TENANTS_ のみ（移行完了までの暫定）。
 */

const TIER_MAX_ = 3;
const MAIL_SUBJECT_MAX_ = 120;
const MAIL_BODY_MAX_ = 5000;
const FOLLOW_DELAY_MIN_ = 1;
const FOLLOW_DELAY_MAX_ = 30;
const TOS_COUPON_VERSION_ = '1.3';   // 段階別クーポンの保存に必要な規約バージョン
const LEGACY_REVIEW_THANKS_TENANTS_ = ['tokyoflower'];   // 段階設定が未保存でも従来の min_rating 方式で動かす店舗（migrateTokyoflowerTiers 実行後は不要）

// 画面・プレビューに出す使える変数（{{...}} が正式。{coupon_url} {rating} は単括弧でも書ける）
const TIER_MAIL_VARIABLES_ = ['buyer_name', 'shop_name', 'ship_date', 'shop_signature', 'review_url', 'rating', 'coupon_url'];

const REVIEW_TIER_SETTING_KEYS_ = (function () {
  const keys = ['follow_delay_days', 'review_tier_count', 'review_tier_b1', 'review_tier_b2', 'tier_coupon_diff_agreed_at', 'tier_coupon_diff_agreed_by'];
  for (let n = 1; n <= TIER_MAX_; n++) ['enabled', 'subject', 'body', 'coupon_url'].forEach(f => keys.push(`tier${n}_${f}`));
  return keys;
})();

// ===== 区切りの検証と★→段階の対応 =====

/**
 * 段階数と区切りを検証する。★5〜1 が重複も抜けもなくどれか1つの段階に入ること。
 * tier1=★5〜b1 / (3段階のみ) tier2=★(b1-1)〜b2 / 最後の段階=★(前の区切り-1)〜1。
 * 戻り値: { ok:true, count, b1, b2, ranges:[{tier,from,to}] } | { ok:false, error }
 */
function validateTierBoundaries_(count, b1, b2) {
  const isInt = v => typeof v === 'number' ? Number.isInteger(v) : /^\d+$/.test(String(v));
  if (!isInt(count)) return { ok: false, error: 'bad_tier_count' };
  const c = Number(count);
  if (c < 1 || c > TIER_MAX_) return { ok: false, error: 'bad_tier_count' };
  if (c === 1) return { ok: true, count: 1, b1: null, b2: null, ranges: [{ tier: 1, from: 5, to: 1 }] };
  if (!isInt(b1)) return { ok: false, error: 'bad_boundary' };
  const x1 = Number(b1);
  if (c === 2) {
    if (x1 < 2 || x1 > 5) return { ok: false, error: 'bad_boundary' };   // tier1=★5〜x1, tier2=★(x1-1)〜1 が空にならない
    return { ok: true, count: 2, b1: x1, b2: null, ranges: [{ tier: 1, from: 5, to: x1 }, { tier: 2, from: x1 - 1, to: 1 }] };
  }
  if (!isInt(b2)) return { ok: false, error: 'bad_boundary' };
  const x2 = Number(b2);
  if (x1 <= x2) return { ok: false, error: 'bad_boundary' };            // b1 > b2 が必須
  if (x1 < 3 || x1 > 5 || x2 < 2 || x2 > 4) return { ok: false, error: 'bad_boundary' };   // どの段階も空にしない
  return { ok: true, count: 3, b1: x1, b2: x2, ranges: [{ tier: 1, from: 5, to: x1 }, { tier: 2, from: x1 - 1, to: x2 }, { tier: 3, from: x2 - 1, to: 1 }] };
}

/** ★(1〜5の整数) → 段階番号。設定が不正・★が範囲外なら null（送らない） */
function resolveReviewTier_(settings, rating) {
  settings = settings || {};
  const v = validateTierBoundaries_(settings.review_tier_count, settings.review_tier_b1, settings.review_tier_b2);
  if (!v.ok) return null;
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return null;
  const hit = v.ranges.filter(x => r <= x.from && r >= x.to);
  return hit.length === 1 ? hit[0].tier : null;
}

// ===== クーポンURL・文面の検証 =====

/** https のみ、ホストは *.rakuten.co.jp。空は ok（クーポン無し）。戻り値: { ok, value } | { ok:false, error } */
function validateCouponUrl_(raw) {
  const v = String(raw === null || raw === undefined ? '' : raw).trim();
  if (v === '') return { ok: true, value: '' };
  if (v.length > 500 || /[\s　\\<>"'`]/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'bad_coupon_url' };
  const m = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.rakuten\.co\.jp(?::443)?(?:[\/?#][^\s]*)?$/i.exec(v);
  if (!m) return { ok: false, error: 'bad_coupon_url' };
  return { ok: true, value: v };
}

function validateMailText_(subject, body) {
  if (typeof subject !== 'string' || typeof body !== 'string') return { ok: false, error: 'text_required' };
  if (subject.trim() === '' || body.trim() === '') return { ok: false, error: 'text_required' };
  if (subject.length > MAIL_SUBJECT_MAX_) return { ok: false, error: 'subject_too_long' };
  if (body.length > MAIL_BODY_MAX_) return { ok: false, error: 'body_too_long' };
  return { ok: true };
}

/** {coupon_url} {rating} の単括弧を {{...}} に揃える（既存の {{変数}} 形式に統一） */
function normalizeTierText_(s) {
  return String(s).replace(/\{\{\s*(coupon_url|rating)\s*\}\}|\{\s*(coupon_url|rating)\s*\}/g, (m, a, b) => `{{${a || b}}}`);
}

/** 既知でない変数名（{{x}} と単括弧 {x}）を列挙（保存時の警告用） */
function findUnknownTierPlaceholders_(str) {
  const found = {};
  const s = String(str);
  let m;
  const re2 = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  while ((m = re2.exec(s)) !== null) if (TIER_MAIL_VARIABLES_.indexOf(m[1]) < 0 && KNOWN_TEMPLATE_PLACEHOLDERS_.indexOf(m[1]) < 0) found[m[1]] = true;
  const re1 = /(^|[^{])\{\s*([a-zA-Z0-9_]+)\s*\}(?!\})/g;
  while ((m = re1.exec(s)) !== null) if (TIER_MAIL_VARIABLES_.indexOf(m[2]) < 0 && KNOWN_TEMPLATE_PLACEHOLDERS_.indexOf(m[2]) < 0) found[m[2]] = true;
  return Object.keys(found);
}

/** coupon_url が空のとき、{{coupon_url}} を含む行を丸ごと削除する（本文）。件名からはトークンだけを取り除く */
function applyCouponLine_(text, couponUrl, isSubject) {
  const t = normalizeTierText_(text);
  if (couponUrl) return t;
  if (isSubject) return t.replace(/\{\{coupon_url\}\}/g, '').replace(/\s+$/g, '');
  return t.split(/\r?\n/).filter(line => line.indexOf('{{coupon_url}}') < 0).join('\n');
}

/** 段階メールの件名・本文を組み立てる。vars に coupon_url / rating を足して renderTemplate_ へ */
function renderTierMail_(tierCfg, vars, rating) {
  const v = Object.assign({}, vars, { coupon_url: tierCfg.coupon_url || '', rating: rating === undefined || rating === null ? '' : String(rating) });
  return {
    subject: renderTemplate_(applyCouponLine_(tierCfg.subject, tierCfg.coupon_url, true), v),
    body: renderTemplate_(applyCouponLine_(tierCfg.body, tierCfg.coupon_url, false), v),
  };
}

// ===== 設定の読み出し =====

function settingMap_(tenantId) {
  const rows = getTenantSettingsRaw_(tenantId) || [];
  const m = {};
  rows.forEach(r => { m[r.key] = r.value; });
  return m;
}

function isTrueStr_(v) { return String(v || '').toLowerCase() === 'true'; }

/**
 * 段階設定を読む。未保存（review_tier_count が空/不正）なら null。
 * 戻り値: { count, b1, b2, ranges, tiers:{1:{enabled,subject,body,coupon_url},...} }（使われない段階の値は tiers に含めない）
 */
function getReviewTierConfig_(tenantId) {
  const m = settingMap_(tenantId);
  const v = validateTierBoundaries_(m.review_tier_count, m.review_tier_b1, m.review_tier_b2);
  if (!v.ok) return null;
  const tiers = {};
  for (let n = 1; n <= v.count; n++) {
    tiers[n] = {
      enabled: isTrueStr_(m[`tier${n}_enabled`]),
      subject: String(m[`tier${n}_subject`] || ''),
      body: String(m[`tier${n}_body`] || ''),
      coupon_url: String(m[`tier${n}_coupon_url`] || ''),
    };
  }
  return { count: v.count, b1: v.b1, b2: v.b2, ranges: v.ranges, tiers: tiers };
}

/** 段階設定が使えない（未保存）店舗でも従来方式で動かしてよいか（暫定の例外） */
function isLegacyReviewThanksTenant_(tenantId) { return LEGACY_REVIEW_THANKS_TENANTS_.indexOf(tenantId) >= 0; }

// ===== settings_history =====

const SETTINGS_HISTORY_HEADER_ = ['id', 'saved_at', 'saved_by', 'kind', 'before_json', 'after_json'];

function getSettingsHistorySheet_(tenantId) {
  const ss = getTenantSpreadsheet(tenantId);
  let sh = ss.getSheetByName('settings_history');
  if (!sh) {
    sh = ss.insertSheet('settings_history');
    sh.appendRow(SETTINGS_HISTORY_HEADER_);
  }
  return sh;
}

/** 履歴を1行追加し、行ID(uuid)を返す。before/after はキー→値のオブジェクト（変更があったキーのみ） */
function appendSettingsHistory_(tenantId, savedBy, kind, before, after) {
  const sh = getSettingsHistorySheet_(tenantId);
  const id = Utilities.getUuid();
  sh.appendRow([id, tierNowJst_(), savedBy, kind, sheetSafeText_(JSON.stringify(before)), sheetSafeText_(JSON.stringify(after))]);
  return id;
}

// ===== 保存（検証 → 書き込み → 履歴） =====

/** 現在値のスナップショット（フォロー文面は templates から） */
function snapshotStoreSettings_(tenantId) {
  const m = settingMap_(tenantId);
  const out = {};
  REVIEW_TIER_SETTING_KEYS_.forEach(k => { out[k] = m[k] === undefined ? '' : m[k]; });
  const f = getTenantTemplateRaw_(tenantId, 'follow_v1');
  out.follow_subject = f ? f.subject : '';
  out.follow_body = f ? f.body : '';
  return out;
}

function currentFollowDelay_(tenantId) {
  const m = settingMap_(tenantId);
  if (m.follow_delay_days !== undefined && m.follow_delay_days !== '') return m.follow_delay_days;
  return m.follow_days_after_ship === undefined ? '' : m.follow_days_after_ship;
}

/** 規約 v1.3 以降に同意済みか（billing_events の terms_agreed の最新を見る。既存の同意の仕組みを使う） */
function hasAgreedCouponTerms_(tenantId) {
  const v = latestTermsVersionFor_(tenantId);
  return !!v && compareTermsVersion_(v, TOS_COUPON_VERSION_) >= 0;
}

function compareTermsVersion_(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function latestTermsVersionFor_(tenantId) {
  let best = '';
  try {
    const data = getBillingEventsSheet_().getDataRange().getValues();
    data.slice(1).forEach(r => {
      if (String(r[2]) !== tenantId || String(r[4]) !== 'terms_agreed') return;
      const ver = ((String(r[7] || '').match(/terms_version=([^;]*)/) || [])[1] || '').trim();
      if (ver && (!best || compareTermsVersion_(ver, best) > 0)) best = ver;
    });
  } catch (e) { return ''; }
  return best;
}

/** 規約への同意を記録する（ログイン中の店舗が自分の分だけ。version は現行 TERMS_VERSION のみ受け付ける） */
function agreeTermsStore_(tenantId, payload) {
  if (!payload || payload.agree !== true) return { ok: false, error: 'agree_required' };
  appendBillingEvent_(tenantId, 'store_ui', 'terms_agreed', '', '', `terms_version=${TERMS_VERSION};terms_agreed_at=${termsNowIso_()}`);
  return { ok: true, terms_version: TERMS_VERSION };
}

/**
 * 店舗設定の保存。payload の形:
 *  { follow:{delay_days,subject,body}, review:{tier_count,b1,b2,tiers:{1:{enabled,subject,body,coupon_url},...}}, confirm_diff_coupon:bool }
 * どちらか（follow / review）だけを送ってもよい。戻り値: { ok:true, warnings, history_id } | { ok:false, error, fields? }
 */
function saveStoreSettings_(tenantId, payload, savedBy) {
  payload = payload || {};
  savedBy = savedBy || `store:${tenantId}`;
  const writes = {};       // settings タブへ書くキー → 値
  let followTpl = null;    // templates へ書く { subject, body }
  const warnings = [];
  const before = snapshotStoreSettings_(tenantId);
  const beforeDelay = currentFollowDelay_(tenantId);

  // --- A. フォロー ---
  if (payload.follow !== undefined) {
    const f = payload.follow || {};
    const d = f.delay_days;
    if (!(typeof d === 'number' ? Number.isInteger(d) : /^\d+$/.test(String(d))) || Number(d) < FOLLOW_DELAY_MIN_ || Number(d) > FOLLOW_DELAY_MAX_) return { ok: false, error: 'bad_follow_delay' };
    const tv = validateMailText_(f.subject, f.body);
    if (!tv.ok) return { ok: false, error: 'follow_' + tv.error };
    writes.follow_delay_days = String(Number(d));
    followTpl = { subject: f.subject, body: f.body };
    [f.subject, f.body].forEach(s => findUnknownTierPlaceholders_(s).forEach(u => warnings.push(`不明な変数 ${u}（フォローメール）`)));
  }

  // --- B/C. レビューお礼 ---
  let couponUrlsTouched = false;
  if (payload.review !== undefined) {
    const r = payload.review || {};
    const bv = validateTierBoundaries_(r.tier_count, r.b1, r.b2);
    if (!bv.ok) return { ok: false, error: bv.error };
    const tiersIn = r.tiers || {};
    writes.review_tier_count = String(bv.count);
    writes.review_tier_b1 = bv.b1 === null ? '' : String(bv.b1);
    writes.review_tier_b2 = bv.b2 === null ? '' : String(bv.b2);
    for (let n = 1; n <= bv.count; n++) {
      const t = tiersIn[n] || tiersIn[String(n)];
      if (!t || typeof t !== 'object') return { ok: false, error: 'tier_missing', tier: n };
      const enabled = t.enabled === true || t.enabled === 'true';
      const cu = validateCouponUrl_(t.coupon_url);
      if (!cu.ok) return { ok: false, error: cu.error, tier: n };
      if (enabled || String(t.subject || '') !== '' || String(t.body || '') !== '') {
        const tv = validateMailText_(t.subject, t.body);
        if (!tv.ok) return { ok: false, error: `tier${n}_${tv.error}`, tier: n };
      }
      writes[`tier${n}_enabled`] = enabled ? 'true' : 'false';
      writes[`tier${n}_subject`] = String(t.subject || '');
      writes[`tier${n}_body`] = String(t.body || '');
      writes[`tier${n}_coupon_url`] = cu.value;
      [t.subject, t.body].forEach(s => findUnknownTierPlaceholders_(String(s || '')).forEach(u => warnings.push(`不明な変数 ${u}（段階${n}）`)));
      if (cu.value !== String(before[`tier${n}_coupon_url`] || '')) couponUrlsTouched = true;
    }
    // 使われなくなった段階（count 未満の外）の値は触らない＝保持（送信にも使わない）

    // 段階ごとに異なるクーポン設定の判定（有効な段階のURL＝空欄も含めて2種類以上）
    const used = [];
    for (let n = 1; n <= bv.count; n++) if (writes[`tier${n}_enabled`] === 'true') used.push(writes[`tier${n}_coupon_url`]);
    const differs = used.length > 1 && used.some(u => u !== used[0]);
    const anyCoupon = Object.keys(writes).some(k => /^tier\d_coupon_url$/.test(k) && writes[k] !== '');

    if (anyCoupon && couponUrlsTouched && !hasAgreedCouponTerms_(tenantId)) return { ok: false, error: 'terms_required' };   // v1.3 未同意は API 直叩きでも保存不可
    if (differs) {
      const agreedAt = String(before.tier_coupon_diff_agreed_at || '');
      if (!agreedAt) {
        if (payload.confirm_diff_coupon !== true) return { ok: false, error: 'confirm_required' };
        if (!hasAgreedCouponTerms_(tenantId)) return { ok: false, error: 'terms_required' };
        writes.tier_coupon_diff_agreed_at = tierNowJst_();
        writes.tier_coupon_diff_agreed_by = savedBy;
      }
    }
  }

  // --- 書き込み ---
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    Object.keys(writes).forEach(k => {
      const r = setTenantSettingValueAdmin_(tenantId, k, writes[k]);
      if (!r.ok) throw new Error('write_failed:' + k);
    });
    if (followTpl) {
      const r = setTenantTemplate_(tenantId, 'follow_v1', followTpl.subject, followTpl.body);
      if (!r.ok) throw new Error('write_failed:follow_v1');
    }
    const after = snapshotStoreSettings_(tenantId);
    invalidateTenantConfigCache_(tenantId);
    const b = {}, a = {};
    Object.keys(after).forEach(k => { if (String(after[k]) !== String(before[k])) { b[k] = before[k]; a[k] = after[k]; } });
    if (writes.follow_delay_days !== undefined && String(beforeDelay) !== writes.follow_delay_days) { b.follow_delay_days = beforeDelay; a.follow_delay_days = writes.follow_delay_days; }
    const historyId = Object.keys(a).length ? appendSettingsHistory_(tenantId, savedBy, 'save', b, a) : '';
    return { ok: true, warnings: warnings, history_id: historyId };
  } catch (e) {
    return { ok: false, error: 'internal_error' };
  } finally { lock.releaseLock(); }
}

/** 設定の取得（店舗画面用）。使われない段階の値も含める（画面でグレー表示） */
function getStoreSettings_(tenantId) {
  const m = settingMap_(tenantId);
  const f = getTenantTemplateRaw_(tenantId, 'follow_v1');
  const tiers = {};
  for (let n = 1; n <= TIER_MAX_; n++) {
    tiers[n] = { enabled: isTrueStr_(m[`tier${n}_enabled`]), subject: m[`tier${n}_subject`] || '', body: m[`tier${n}_body`] || '', coupon_url: m[`tier${n}_coupon_url`] || '' };
  }
  const cfg = getReviewTierConfig_(tenantId);
  return {
    ok: true,
    follow: { delay_days: Number(currentFollowDelay_(tenantId)) || null, subject: f ? f.subject : '', body: f ? f.body : '' },
    review: { configured: !!cfg, tier_count: cfg ? cfg.count : 2, b1: cfg ? cfg.b1 : 3, b2: cfg ? cfg.b2 : null, tiers: tiers },
    variables: TIER_MAIL_VARIABLES_,
    terms: { current: TERMS_VERSION, agreed: latestTermsVersionFor_(tenantId), coupon_ok: hasAgreedCouponTerms_(tenantId) },
    diff_coupon_agreed_at: m.tier_coupon_diff_agreed_at || '',
  };
}

// ===== プレビュー・テスト送信 =====

function sampleMailVars_(tenantId) {
  let shop = '', sig = '';
  try { const c = getRmsCredentials(tenantId); shop = c.shop_name; sig = c.shop_signature; } catch (e) { shop = 'サンプルショップ'; sig = ''; }
  return { buyer_name: 'テスト太郎', shop_name: shop, ship_date: formatShipDateJa_(new Date()), shop_signature: sig, review_url: buildReviewUrl_('000000-00000000-0000000000') };
}

/** 保存済みの設定でサンプル文面を組み立てる（編集中の未保存内容は payload.draft で上書き可。保存はしない） */
function buildStoreMail_(tenantId, type, tierNo, draft) {
  const vars = sampleMailVars_(tenantId);
  if (type === 'follow') {
    const f = draft || getTenantTemplateRaw_(tenantId, 'follow_v1');
    if (!f) return { ok: false, error: 'template_missing' };
    return { ok: true, subject: renderTemplate_(normalizeTierText_(f.subject), vars), body: renderTemplate_(normalizeTierText_(f.body), vars) };
  }
  if (type === 'review') {
    const n = Number(tierNo);
    if (!Number.isInteger(n) || n < 1 || n > TIER_MAX_) return { ok: false, error: 'bad_tier' };
    const cfg = getReviewTierConfig_(tenantId);
    let t = draft ? { subject: String(draft.subject || ''), body: String(draft.body || ''), coupon_url: String(draft.coupon_url || '') } : (cfg && cfg.tiers[n]);
    if (!t) return { ok: false, error: 'tier_not_configured' };
    const cu = validateCouponUrl_(t.coupon_url);
    if (!cu.ok) return { ok: false, error: cu.error };
    const range = cfg ? cfg.ranges.find(x => x.tier === n) : null;
    const sampleRating = range ? range.from : 5;
    const out = renderTierMail_({ subject: t.subject, body: t.body, coupon_url: cu.value }, vars, sampleRating);
    return { ok: true, subject: out.subject, body: out.body };
  }
  return { ok: false, error: 'bad_type' };
}

function previewStoreMail(tenantId, type, tierNo, draft) { return buildStoreMail_(tenantId, type, tierNo, draft); }

/** テスト送信。宛先は常に店舗の登録メール（creds.from_email）固定。記録タイプは follow_test_{runId} / review_thanks_test_{runId} */
function sendStoreTestMail(tenantId, type, tierNo, draft) {
  let st = '';
  try { const t = listAllTenants_().find(x => x.tenant_id === tenantId); st = t ? t.status : ''; } catch (e) { st = ''; }
  if (st !== 'setup' && st !== 'active') return { ok: false, error: 'tenant_not_sendable' };
  const mail = buildStoreMail_(tenantId, type, tierNo, draft);
  if (!mail.ok) return mail;
  const creds = getRmsCredentials(tenantId);
  const to = creds.from_email;
  const subject = '[テスト送信] ' + mail.subject;
  if (isTenantDryRun_(tenantId)) {
    Logger.log(`[DRY_RUN] sendStoreTestMail: 実送信せず tenant=${tenantId} to=${to} subject=${subject}`);
    return { ok: true, dry_run: true, to: to, subject: subject };
  }
  const runId = Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  const recordType = (type === 'follow' ? 'follow_test_' : 'review_thanks_test_') + runId;
  try {
    sendViaBridge_(tenantId, to, creds.from_email, creds.from_name, subject, mail.body, '', creds.reply_to, '');
    const sends = getTenantSpreadsheet(tenantId).getSheetByName('sends');
    if (sends) recordSendWithExtras_(sends, `test-${runId}`, '', recordType, type === 'follow' ? 'follow_v1' : `review_tier${Number(tierNo)}`, 'sent', type === 'review' ? { tier_no: Number(tierNo) } : {});
    return { ok: true, dry_run: false, to: to };
  } catch (e) { return { ok: false, error: 'send_failed' }; }
}

// ===== sends への記録（ヘッダー名基準。tier_no / rating は末尾に追記） =====

function ensureSendsTierColumns_(sheet) {
  const hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  ['tier_no', 'rating'].forEach(c => {
    if (hdr.indexOf(c) < 0) { sheet.getRange(1, hdr.length + 1).setValue(c); hdr.push(c); }
  });
  return hdr;
}

/** sends へ1行。extras は { tier_no, rating }。既存列は並び替えず、ヘッダー名で値を置く */
function recordSendWithExtras_(sendsSheet, orderNumber, buyerKey, type, templateId, result, extras) {
  const hdr = ensureSendsTierColumns_(sendsSheet);
  const row = Array(hdr.length).fill('');
  const put = (name, v) => { const i = hdr.indexOf(name); if (i >= 0) row[i] = v; };
  put('send_id', Utilities.getUuid()); put('order_number', orderNumber); put('buyer_key', buyerKey); put('type', type);
  put('sent_at', tierNowJst_()); put('template_id', templateId); put('result', result);
  if (extras && extras.tier_no !== undefined) put('tier_no', extras.tier_no);
  if (extras && extras.rating !== undefined) put('rating', extras.rating);
  sendsSheet.appendRow(row);
}

// ===== 管理用: 送る予定の内容（送信しない） =====

/**
 * 直近 days 日に投稿されたレビューについて、★・段階・件名と送る/送らない理由を返す。送信は一切しない。
 * 注文との突合・送信済み判定は collectPendingReviewThanks_ の結果を使う。
 */
function dryRunReviewTiers(tenantId, days) {
  const n = Math.max(1, Math.min(365, Math.floor(Number(days)) || 30));
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const from = addDaysStr_(today, -n);
  const cfg = getReviewTierConfig_(tenantId);
  const since = getReviewThanksSince_(tenantId);
  const pending = collectPendingReviewThanks_(tenantId);
  const willSend = {};
  pending.targets.forEach(t => { willSend[t.order_number] = t; });
  const out = { ok: true, tenant_id: tenantId, days: n, mode: pending.mode || (cfg ? 'tiers' : 'unconfigured'), disabled: pending.disabled || '', items: [] };
  const sheet = getTenantSpreadsheet(tenantId).getSheetByName('reviews');
  if (!sheet) return out;
  const data = sheet.getDataRange().getValues();
  const hdr = data[0].map(String);
  const ix = c => hdr.indexOf(c);
  const vars = sampleMailVars_(tenantId);
  data.slice(1).forEach(r => {
    const posted = toJstDateString_(r[ix('posted_at')]) || '';
    if (!posted || posted < from) return;
    const rating = Number(r[ix('rating')]);
    const orderNumber = String(r[ix('order_number')] || '');
    const tier = cfg ? resolveReviewTier_({ review_tier_count: cfg.count, review_tier_b1: cfg.b1, review_tier_b2: cfg.b2 }, rating) : null;
    const t = willSend[orderNumber];
    let subject = '', reason = '';
    if (t) {
      if (t.tier_no && cfg) subject = renderTierMail_(cfg.tiers[t.tier_no], vars, rating).subject;
      else { const tpl = getTenantTemplateRaw_(tenantId, 'review_thanks_v1'); subject = tpl ? renderTemplate_(tpl.subject, vars) : ''; }
    } else {
      const found = Object.keys(pending.skipped).find(k => pending.skipped[k].indexOf(orderNumber) >= 0);
      reason = found || (orderNumber ? 'not_in_orders' : 'no_order_number');
      if (!found && since && posted < since) reason = 'review_before_since';
    }
    out.items.push({ review_id: String(r[ix('review_id')] || ''), rating: isNaN(rating) ? null : rating, posted_at: posted, tier_no: t && t.tier_no ? t.tier_no : tier, will_send: !!t, reason: reason, subject: subject });
  });
  return out;
}

function addDaysStr_(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  d.setTime(d.getTime() + delta * 86400000);
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

// ===== 復元・移行・バックアップ（GAS エディタ用） =====

/** settings_history の1行（historyRowId）の before を書き戻す。書き戻しも新しい履歴（kind=restore）として残す */
function restoreSettingsFromHistory(tenantId, historyRowId) {
  const sh = getSettingsHistorySheet_(tenantId);
  const data = sh.getDataRange().getValues();
  const row = data.slice(1).find(r => String(r[0]) === String(historyRowId));
  if (!row) throw new Error('history_not_found');
  const b = JSON.parse(String(row[4] || '{}'));
  const current = snapshotStoreSettings_(tenantId);
  const cb = {}, ca = {};
  Object.keys(b).forEach(k => {
    if (k === 'follow_subject' || k === 'follow_body') return;
    if (String(current[k]) !== String(b[k])) { cb[k] = current[k]; ca[k] = b[k]; }
    setTenantSettingValueAdmin_(tenantId, k, b[k]);
  });
  if (b.follow_subject !== undefined || b.follow_body !== undefined) {
    const f = getTenantTemplateRaw_(tenantId, 'follow_v1') || { subject: '', body: '' };
    const subj = b.follow_subject !== undefined ? b.follow_subject : f.subject, body = b.follow_body !== undefined ? b.follow_body : f.body;
    if (subj !== f.subject) { cb.follow_subject = f.subject; ca.follow_subject = subj; }
    if (body !== f.body) { cb.follow_body = f.body; ca.follow_body = body; }
    setTenantTemplate_(tenantId, 'follow_v1', subj, body);
  }
  invalidateTenantConfigCache_(tenantId);
  const id = appendSettingsHistory_(tenantId, 'restore', 'restore', cb, ca);
  Logger.log(`restoreSettingsFromHistory: ${tenantId} ← ${historyRowId} 新しい履歴=${id}`);
  return { ok: true, history_id: id };
}

/**
 * tokyoflower を段階設定へ移行する（今の動きを変えない）。冪等: 2回目は何も書かず履歴も増やさない。
 * tier1(★5〜3)=現行のレビューお礼テンプレート・enabled、tier2(★2〜1)=disabled、クーポンURLは全段階で空。follow_delay_days=現在値。
 * GAS エディタから人が実行する（引数なし）。
 */
function migrateTokyoflowerTiers() { return migrateTenantTiers_('tokyoflower'); }

function migrateTenantTiers_(tenantId) {
  ensureTenantSettingsKeys_(tenantId);
  const before = snapshotStoreSettings_(tenantId);
  const beforeDelay = currentFollowDelay_(tenantId);
  const tpl = getTenantTemplateRaw_(tenantId, 'review_thanks_v1');
  if (!tpl) throw new Error('review_thanks_v1 が見つかりません');
  const minRating = getReviewThanksMinRating_(tenantId);
  const b1 = minRating >= 2 && minRating <= 5 ? minRating : 3;
  const want = {
    review_tier_count: '2', review_tier_b1: String(b1), review_tier_b2: '',
    tier1_enabled: 'true', tier1_subject: tpl.subject, tier1_body: tpl.body, tier1_coupon_url: '',
    tier2_enabled: 'false', tier2_subject: before.tier2_subject || '', tier2_body: before.tier2_body || '', tier2_coupon_url: '',
    tier3_enabled: 'false', tier3_subject: before.tier3_subject || '', tier3_body: before.tier3_body || '', tier3_coupon_url: before.tier3_coupon_url || '',
    follow_delay_days: String(beforeDelay),
  };
  const b = {}, a = {};
  Object.keys(want).forEach(k => {
    const cur = k === 'follow_delay_days' ? '' : String(before[k] === undefined ? '' : before[k]);
    const curReal = k === 'follow_delay_days' ? (settingMap_(tenantId).follow_delay_days || '') : cur;
    if (String(curReal) !== String(want[k])) { b[k] = curReal; a[k] = want[k]; setTenantSettingValueAdmin_(tenantId, k, want[k]); }
  });
  invalidateTenantConfigCache_(tenantId);
  const changed = Object.keys(a).length;
  const id = changed ? appendSettingsHistory_(tenantId, 'migrate', 'migrate', b, a) : '';
  Logger.log(`migrateTenantTiers_(${tenantId}): 変更=${changed}キー 履歴=${id || '（変更なし）'} tier_count=2 b1=${b1}`);
  return { ok: true, changed: changed, history_id: id };
}

/** 反映前バックアップ（マスターシートと tokyoflower シートを Drive 上で複製し、複製IDをログに出す）。GAS エディタから人が実行（ゲートH1） */
function backupBeforeReviewTiers() {
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  const out = {};
  const masterId = PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID');
  if (!masterId) throw new Error('TENANT_MASTER_SHEET_ID 未設定');
  out.master = DriveApp.getFileById(masterId).makeCopy(`step-samurai_master_backup_reviewtiers_${stamp}`).getId();
  const t = listAllTenants_().find(x => x.tenant_id === 'tokyoflower');
  if (!t) throw new Error('tokyoflower が見つかりません');
  out.tokyoflower = DriveApp.getFileById(t.spreadsheet_id).makeCopy(`step-samurai_tokyoflower_backup_reviewtiers_${stamp}`).getId();
  Logger.log(`backupBeforeReviewTiers 完了: マスター複製ID=${out.master} / tokyoflower複製ID=${out.tokyoflower}`);
  return out;
}

function tierNowJst_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'); }
