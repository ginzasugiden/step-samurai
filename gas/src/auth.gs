/**
 * auth.gs — 認証・テナントトークン管理
 *
 * テナント用トークンは、マスター管理シートの tenant_auth タブに
 * SHA-256ハッシュのみを保存し、平文は issueTenantToken_ の戻り値として一度だけ返す
 * （シート上には平文を残さない）。
 */

function requireAdmin_(adminToken) {
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!stored || !hash_equals_(stored, adminToken)) {
    throw new Error('unauthorized');
  }
}

function hash_equals_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ===== tenant_auth タブ（マスター管理シート内） =====

function getTenantAuthSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID');
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName('tenant_auth');
  if (!sheet) {
    sheet = ss.insertSheet('tenant_auth');
    sheet.appendRow(['tenant_id', 'token_hash', 'issued_at', 'status']);
  }
  return sheet;
}

function hashToken_(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

/**
 * 管理者用：テナットのアクセストークンを新規発行する。
 * 平文トークンはこの戻り値にのみ含まれ、シートにはハッシュだけが保存される。
 * 呼び出し側（GASエディタの実行ログ、またはWebApi issue_tenant_token）で控えること。
 */
function issueTenantToken_(tenantId) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const hash  = hashToken_(token);
  const now   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  const sheet = ensureAuthColumns_();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const row = Array(header.length).fill('');
  row[header.indexOf('tenant_id')] = tenantId; row[header.indexOf('token_hash')] = hash;
  row[header.indexOf('issued_at')] = now; row[header.indexOf('status')] = 'active'; row[header.indexOf('kind')] = 'token';
  sheet.appendRow(row);
  Logger.log(`[管理者用] tenant_authトークンを発行しました tenant_id=${tenantId}（平文はログに残していません）`);
  return token;
}

/**
 * トークン(平文)から tenant_id を解決する。
 * status='active' の行のみ対象。一致しなければ null。
 * ハッシュ同士の比較は定数時間比較(hash_equals_)を用いる。
 */
function verifyTenantToken_(token) {
  if (!token) return null;
  const hash   = hashToken_(token);
  const data   = getTenantAuthSheet_().getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);

  const kindIdx = idx('kind'), expIdx = idx('expires_at');
  const now = kindIdx >= 0 ? Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : '';
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[idx('status')] !== 'active') continue;
    const kind = kindIdx >= 0 ? String(row[kindIdx] || 'token') : 'token';
    if (kind === 'password') continue; // パスワードハッシュはトークンとして使えない
    if (kind === 'session' && expIdx >= 0 && row[expIdx] && String(row[expIdx]) < now) continue; // 期限切れ
    if (hash_equals_(String(row[idx('token_hash')]), hash)) {
      return row[idx('tenant_id')];
    }
  }
  return null;
}

/** 管理者用：指定テナントの有効トークンを全て失効させる */
function revokeTenantToken_(tenantId) {
  const sheet  = getTenantAuthSheet_();
  const data   = sheet.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);
  let revoked  = 0;

  const kindIdx = idx('kind');
  for (let i = 1; i < data.length; i++) {
    if (data[i][idx('tenant_id')] === tenantId && data[i][idx('status')] === 'active' && (kindIdx < 0 || String(data[i][kindIdx] || 'token') !== 'password')) {
      sheet.getRange(i + 1, idx('status') + 1).setValue('revoked');
      revoked++;
    }
  }
  return revoked;
}

/**
 * トークンローテーション用ヘルパー（GASエディタのドロップダウンから手動実行する想定）。
 * tokyoflowerの既存有効トークンを全て失効させたうえで新しいトークンを1つ発行する。
 * 新トークンは実行ログにのみ出力される（シートにはハッシュのみ保存）。
 * 実行後はUI側の再ログインが必要になる（旧トークンはこの時点で無効になるため）。
 */
function rotateTokenTokyoflower() {
  const revoked = revokeTenantToken_('tokyoflower');
  const newToken = issueTenantToken_('tokyoflower');
  Logger.log(`rotateTokenTokyoflower: 旧トークン${revoked}件を失効し、新トークンを発行しました → ${newToken}`);
  return newToken;
}

// =========================================================
// 店舗ID＋パスワード ログイン（2026-09-07）
//
// tenant_auth タブに kind 列を追加して3種類を同居させる:
//   kind='token'    従来のアクセストークン（無期限・管理者発行）
//   kind='password' 店舗のログインパスワードのハッシュ（テナントにつき1行、salt 付き）
//   kind='session'  ログインで発行される12時間有効のセッショントークン
// verifyTenantToken_ は token/session を受け付け、expires_at を過ぎた session は無効。
// パスワードは平文を保存しない。運営者は「再設定（自動生成）」しかできず、既存の値は読めない。
// =========================================================

const SESSION_TTL_HOURS_ = 12;
const AUTH_HEADER_ = ['tenant_id', 'token_hash', 'issued_at', 'status', 'kind', 'expires_at', 'salt'];

/** tenant_auth のヘッダに kind/expires_at/salt が無ければ追加する（冪等） */
function ensureAuthColumns_() {
  const sheet  = getTenantAuthSheet_();
  const header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String);
  const missing = AUTH_HEADER_.filter(h => header.indexOf(h) < 0);
  if (missing.length) sheet.getRange(1, header.filter(Boolean).length + 1, 1, missing.length).setValues([missing]);
  return sheet;
}

function nowJst_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'); }

function hashPassword_(tenantId, password, salt) {
  return hashToken_(`pw:${tenantId}:${salt}:${password}`);
}

/** 自動生成パスワード（英数12文字・紛らわしい文字を除外） */
function generatePassword_() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[parseInt(hex.substr(i * 2, 2), 16) % chars.length];
  return out;
}

/**
 * パスワードを設定（既存の password 行は revoked にして新しい行を追加）。
 * 戻り値: 平文（自動生成時に一度だけ表示するため）
 */
function setTenantPassword_(tenantId, password) {
  const sheet  = ensureAuthColumns_();
  const pw     = password || generatePassword_();
  if (pw.length < 8) throw new Error('password_too_short');
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(String);
  const idx    = c => header.indexOf(c);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx('tenant_id')]) === tenantId && String(data[i][idx('kind')]) === 'password' && data[i][idx('status')] === 'active') {
      sheet.getRange(i + 1, idx('status') + 1).setValue('revoked');
    }
  }
  const salt = Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  const row  = Array(header.length).fill('');
  row[idx('tenant_id')] = tenantId; row[idx('token_hash')] = hashPassword_(tenantId, pw, salt);
  row[idx('issued_at')] = nowJst_(); row[idx('status')] = 'active'; row[idx('kind')] = 'password'; row[idx('salt')] = salt;
  sheet.appendRow(row);
  revokeSessions_(tenantId); // パスワード変更時は既存セッションを無効化
  return pw;
}

function hasTenantPassword_(tenantId) {
  const data = ensureAuthColumns_().getDataRange().getValues();
  const header = data[0].map(String); const idx = c => header.indexOf(c);
  return data.slice(1).some(r => String(r[idx('tenant_id')]) === tenantId && String(r[idx('kind')]) === 'password' && r[idx('status')] === 'active');
}

/** 店舗ID＋パスワードを検証してセッショントークンを発行。失敗は null（理由は返さない） */
function loginWithPassword_(tenantId, password) {
  if (!tenantId || !password) return null;
  const sheet  = ensureAuthColumns_();
  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(String);
  const idx    = c => header.indexOf(c);
  let ok = false;
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (String(r[idx('tenant_id')]) !== tenantId || String(r[idx('kind')]) !== 'password' || r[idx('status')] !== 'active') continue;
    if (hash_equals_(String(r[idx('token_hash')]), hashPassword_(tenantId, password, String(r[idx('salt')] || '')))) ok = true;
  }
  if (!ok) return null;
  // テナントが有効か（disabled はログイン不可）
  const t = listAllTenants_().find(x => x.tenant_id === tenantId);
  if (!t || !TENANT_ACCESSIBLE_STATUSES_.includes(t.status)) return null;

  purgeExpiredSessions_(sheet);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const exp   = new Date(Date.now() + SESSION_TTL_HOURS_ * 3600 * 1000);
  const row   = Array(header.length).fill('');
  row[idx('tenant_id')] = tenantId; row[idx('token_hash')] = hashToken_(token); row[idx('issued_at')] = nowJst_();
  row[idx('status')] = 'active'; row[idx('kind')] = 'session';
  row[idx('expires_at')] = Utilities.formatDate(exp, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow(row);
  return { token: token, expires_at: row[idx('expires_at')], tenant_id: tenantId, shop_name: t.shop_name };
}

function revokeSessions_(tenantId) {
  const sheet = ensureAuthColumns_(); const data = sheet.getDataRange().getValues();
  const header = data[0].map(String); const idx = c => header.indexOf(c);
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx('tenant_id')]) === tenantId && String(data[i][idx('kind')]) === 'session' && data[i][idx('status')] === 'active') {
      sheet.getRange(i + 1, idx('status') + 1).setValue('revoked'); n++;
    }
  }
  return n;
}

/** 期限切れセッション行を物理削除（シート肥大化防止。下から消す） */
function purgeExpiredSessions_(sheet) {
  const data = sheet.getDataRange().getValues();
  const header = data[0].map(String); const idx = c => header.indexOf(c);
  const now = nowJst_();
  for (let i = data.length - 1; i >= 1; i--) {
    const r = data[i];
    if (String(r[idx('kind')]) === 'session' && (r[idx('status')] !== 'active' || (r[idx('expires_at')] && String(r[idx('expires_at')]) < now))) {
      sheet.deleteRow(i + 1);
    }
  }
}
