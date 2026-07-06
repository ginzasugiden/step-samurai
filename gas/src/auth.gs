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

  getTenantAuthSheet_().appendRow([tenantId, hash, now, 'active']);
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

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[idx('status')] !== 'active') continue;
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

  for (let i = 1; i < data.length; i++) {
    if (data[i][idx('tenant_id')] === tenantId && data[i][idx('status')] === 'active') {
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
