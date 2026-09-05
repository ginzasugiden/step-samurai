/**
 * onboarding.gs — 店舗がブラウザから自分で認証情報を登録する経路
 *
 * 流れ:
 *  1. 運営者が admin.html で招待を発行（create_invite）→ 招待コード（平文は一度だけ表示）を店舗へ渡す
 *  2. 店舗が webui/onboard.html を開き、招待コード＋店舗情報＋RMSキー＋SMTP認証を入力
 *  3. GAS が招待を検証 → RMS へ接続テスト（成功しないと保存しない）→ 暗号化保存 → 店舗トークンを発行して返す
 *  4. 店舗はそのトークンで index.html / analytics.html にログインできる。運営者はトークンも平文キーも見ない
 *
 * 招待コードはマスターシート `invites` タブに SHA-256 ハッシュのみ保存。有効期限7日・一回限り。
 * onboard_* は認証なしで到達できる公開アクションなので、招待コードの検証を最初に行い、失敗時は同じエラーを返す。
 */

const INVITES_SHEET_ = 'invites';
const INVITE_TTL_DAYS_ = 7;

function getInvitesSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID');
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName(INVITES_SHEET_);
  if (!sheet) { sheet = ss.insertSheet(INVITES_SHEET_); sheet.appendRow(['tenant_id', 'invite_hash', 'created_at', 'expires_at', 'used_at']); }
  return sheet;
}

/** 管理者: テナントを setup で作成（未作成なら）し、招待コードを発行する */
function createInvite_(tenantId) {
  const code = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  const now  = new Date(), exp = new Date(now.getTime() + INVITE_TTL_DAYS_ * 86400000);
  const fmt  = d => Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  getInvitesSheet_().appendRow([tenantId, hashToken_(code), fmt(now), fmt(exp), '']);
  return { invite: code, expires_at: fmt(exp) };
}

/** 招待コードを検証し tenant_id を返す。無効なら null。consume=true なら使用済みにする */
function verifyInvite_(code, consume) {
  if (!code) return null;
  const sheet = getInvitesSheet_();
  const data  = sheet.getDataRange().getValues();
  const hash  = hashToken_(String(code).trim());
  const now   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  for (let i = 1; i < data.length; i++) {
    if (!hash_equals_(String(data[i][1]), hash)) continue;
    if (data[i][4]) return null;                                   // 使用済み
    if (String(data[i][3]) < now) return null;                     // 期限切れ
    if (consume) sheet.getRange(i + 1, 5).setValue(now);
    return String(data[i][0]);
  }
  return null;
}

/** 招待コードを渡すと、フォームに表示する店舗名などを返す（秘密情報は含めない） */
function onboardCheck_(payload) {
  const tenantId = verifyInvite_(payload.invite, false);
  if (!tenantId) return { ok: false, error: 'invalid_invite' };
  const t = listAllTenants_().find(x => x.tenant_id === tenantId);
  if (!t) return { ok: false, error: 'invalid_invite' };
  return { ok: true, tenant_id: tenantId, shop_name: t.shop_name, shop_email: t.shop_email, status: t.status,
           rms_registered: !!getTenantSecretMeta_(tenantId, 'rms'), smtp_registered: !!getTenantSecretMeta_(tenantId, 'smtp') };
}

/**
 * 店舗からの登録。RMS 接続テストに成功した場合のみ保存し、店舗トークンを発行して返す。
 * payload: invite, sid, shop_name, shop_email, cc_email, service_secret, license_key, license_expiry(yyyy-MM-dd),
 *          smtp_user, smtp_pass, follow_days(任意), go_live_date(任意・希望日)
 */
function onboardSubmit_(payload) {
  const tenantId = verifyInvite_(payload.invite, false);
  if (!tenantId) return { ok: false, error: 'invalid_invite' };

  const p = k => String(payload[k] || '').trim();
  const errors = [];
  if (!/^\d{4,}$/.test(p('sid')))                errors.push('店舗ID(sid) は数字');
  if (!p('shop_name'))                           errors.push('店舗名');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p('shop_email'))) errors.push('店舗メールアドレス');
  if (!p('service_secret') || !p('license_key')) errors.push('serviceSecret / licenseKey');
  if (p('license_expiry') && !toJstDateString_(p('license_expiry'))) errors.push('ライセンス有効期限の形式');
  if (!p('smtp_user') || !p('smtp_pass'))        errors.push('あんしんメルアド SMTP ID / パスワード');
  if (errors.length) return { ok: false, error: 'validation', fields: errors };

  // RMS 接続テスト（保存前・読み取りのみ）
  const test = testRmsCredentials_(p('service_secret'), p('license_key'));
  if (!test.ok) return { ok: false, error: 'rms_auth_failed', http_code: test.http_code, rms_message: test.rms_message };

  // 暗号化保存
  putTenantSecret_(tenantId, 'rms',  { service_secret: p('service_secret'), license_key: p('license_key') },
                   { sid: p('sid'), sname: p('shop_name'), expiry: toJstDateString_(p('license_expiry')) || '' });
  putTenantSecret_(tenantId, 'smtp', { smtp_user: p('smtp_user'), smtp_pass: p('smtp_pass') },
                   { smtp_user_masked: maskUser_(p('smtp_user')) });

  // マスターシートの店舗名・メールを更新
  updateMasterTenantFields_(tenantId, { shop_name: p('shop_name'), shop_email: p('shop_email'), cc_email: p('cc_email') });

  // settings（店舗が編集できる項目のみ反映。go_live_date は希望日として保存するが最終判断は運営者）
  try {
    setupTenantConfigSheets_(tenantId);
    if (p('follow_days') && !isNaN(Number(p('follow_days')))) setTenantSettingValueAdmin_(tenantId, 'follow_days_after_ship', String(Number(p('follow_days'))));
    if (p('go_live_date') && toJstDateString_(p('go_live_date'))) setTenantSettingValueAdmin_(tenantId, 'go_live_date', toJstDateString_(p('go_live_date')));
  } catch (e) { Logger.log(`onboardSubmit_ settings skip [${tenantId}]: ${e.message}`); }

  verifyInvite_(payload.invite, true); // 使用済みに
  const token = issueTenantToken_(tenantId);
  notifyAdmin_(`[step-samurai] 店舗 ${tenantId}（${p('shop_name')}）がセルフ登録を完了しました。admin.html で内容を確認し、遡及取得→稼働化へ進めてください。`);
  return { ok: true, tenant_id: tenantId, token: token, rms_shop: test.rms_message || 'OK' };
}

/** 平文キーで RMS 認証を試す（保存前検証）。読み取りのみ */
function testRmsCredentials_(serviceSecret, licenseKey) {
  const auth = { 'Authorization': `ESA ${Utilities.base64Encode(`${serviceSecret}:${licenseKey}`)}` };
  const to = new Date(), from = new Date(); from.setDate(from.getDate() - 1);
  const res = UrlFetchApp.fetch(`${RMS_BASE}/order/searchOrder/`, {
    method: 'post', contentType: 'application/json; charset=UTF-8', headers: auth,
    payload: JSON.stringify({ dateType: 1, startDatetime: formatRmsDate_(from), endDatetime: formatRmsDate_(to),
      orderProgressList: [100, 200, 300, 400, 500, 600, 700], PaginationRequestModel: { requestRecordsAmount: 1, requestPage: 1 } }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let msg = '';
  try { const j = JSON.parse(res.getContentText()); msg = (j.MessageModelList || []).map(m => `${m.messageType}:${m.messageCode}`).join(', '); } catch (e) {}
  return { ok: code === 200, http_code: code, rms_message: msg };
}

function updateMasterTenantFields_(tenantId, fields) {
  const sheet  = getMasterSheet_();
  const data   = sheet.getDataRange().getValues();
  const header = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][header.indexOf('tenant_id')]) !== tenantId) continue;
    Object.keys(fields).forEach(k => { const c = header.indexOf(k); if (c >= 0 && fields[k] !== undefined) sheet.getRange(i + 1, c + 1).setValue(fields[k]); });
    _masterRowsCache = null;
    return true;
  }
  return false;
}

// ===== 店舗自身による更新（テナントトークン認証） =====

/** 現在の登録状況（秘密は返さない） */
function credentialsStatus_(tenantId) {
  const rms = getTenantSecretMeta_(tenantId, 'rms'), smtp = getTenantSecretMeta_(tenantId, 'smtp');
  return { ok: true,
    rms:  rms  ? { registered: true, sid: rms.meta.sid, expiry: rms.meta.expiry, updated_at: rms.updated_at } : { registered: false, legacy: hasLegacyApiKeyRow_(tenantId) },
    smtp: smtp ? { registered: true, smtp_user_masked: smtp.meta.smtp_user_masked, updated_at: smtp.updated_at } : { registered: false } };
}

function hasLegacyApiKeyRow_(tenantId) { try { getApiKeyRow_(tenantId); return true; } catch (e) { return false; } }

/** ライセンスキー更新（年次）。接続テスト成功時のみ保存 */
function updateCredentials_(tenantId, payload) {
  const ss = String(payload.service_secret || '').trim(), lk = String(payload.license_key || '').trim();
  const exp = String(payload.license_expiry || '').trim();
  if (!ss || !lk) return { ok: false, error: 'service_secret_and_license_key_required' };
  if (exp && !toJstDateString_(exp)) return { ok: false, error: 'invalid_expiry' };
  const test = testRmsCredentials_(ss, lk);
  if (!test.ok) return { ok: false, error: 'rms_auth_failed', http_code: test.http_code, rms_message: test.rms_message };
  const prev = getTenantSecretMeta_(tenantId, 'rms');
  const meta = Object.assign({}, prev ? prev.meta : {}, { expiry: toJstDateString_(exp) || (prev ? prev.meta.expiry : '') });
  putTenantSecret_(tenantId, 'rms', { service_secret: ss, license_key: lk }, meta);
  return { ok: true, expiry: meta.expiry };
}

function updateSmtp_(tenantId, payload) {
  const u = String(payload.smtp_user || '').trim(), pw = String(payload.smtp_pass || '');
  if (!u || !pw) return { ok: false, error: 'smtp_user_and_pass_required' };
  putTenantSecret_(tenantId, 'smtp', { smtp_user: u, smtp_pass: pw }, { smtp_user_masked: maskUser_(u) });
  return { ok: true, smtp_user_masked: maskUser_(u) };
}
