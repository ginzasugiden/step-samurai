/**
 * crypto_store.gs — テナントの秘密情報（RMSキー・SMTP認証）の暗号化保管
 *
 * 保管先: マスター管理シート `tenant_secrets` タブ
 *   tenant_id | kind | ciphertext | updated_at | meta_json
 *   kind = 'rms'  … { service_secret, license_key }        meta = { sid, sname, expiry }
 *   kind = 'smtp' … { smtp_user, smtp_pass }               meta = { smtp_user_masked }
 *
 * 暗号: HMAC-SHA256 を PRF とする CTR モード（keystream = HMAC(K, nonce||counter)）＋ encrypt-then-MAC（HMAC タグ）。
 *   GAS の Utilities に AES が無いため、標準関数だけで構成できる認証付き暗号を採用。
 *   鍵 K は Script Properties の SECRETS_KEY（Base64・32バイト）。generateSecretsKey() で一度だけ生成し、管理者が登録する。
 *
 * 前提（正直に）: サービスが RMS を呼ぶために GAS は復号できる。運営者が「通常の操作で平文を目にしない」
 *   （シート・管理画面・実行ログに平文を出さない）ことを保証する設計であり、ゼロ知識ではない。
 *   鍵の流出＝全店舗の秘密の流出なので、SECRETS_KEY はログ・レポート・チャットに絶対に出さない。
 */

const SECRETS_SHEET_ = 'tenant_secrets';

function secretsKeyBytes_() {
  const b64 = PropertiesService.getScriptProperties().getProperty('SECRETS_KEY');
  if (!b64) throw new Error('SECRETS_KEY 未設定（generateSecretsKey を実行して Script Properties に登録）');
  const bytes = Utilities.base64Decode(b64);
  if (bytes.length < 32) throw new Error('SECRETS_KEY が短すぎます');
  return bytes;
}

/** 管理者が一度だけ実行。ログに出た値を Script Properties SECRETS_KEY に登録する（ログはその後クリア） */
function generateSecretsKey() {
  const hex = (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 64);
  const bytes = []; for (let i = 0; i < 64; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  Logger.log('SECRETS_KEY=' + Utilities.base64Encode(bytes));
  Logger.log('↑ Script Properties に SECRETS_KEY として登録し、この実行ログは閉じてください。既に登録済みなら上書きしないこと（復号できなくなります）');
}

function u8_(b) { return b < 0 ? b + 256 : b; }
function hmac_(keyBytes, dataBytes) { return Utilities.computeHmacSha256Signature(dataBytes, keyBytes).map(u8_); }
function strToBytes_(s) { return Utilities.newBlob(s).getBytes().map(u8_); }
function bytesToStr_(bytes) { return Utilities.newBlob(bytes.map(b => (b > 127 ? b - 256 : b))).getDataAsString('UTF-8'); }

function keystream_(key, nonce, length) {
  const out = [];
  for (let counter = 0; out.length < length; counter++) {
    const block = hmac_(key, nonce.concat([(counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]));
    for (let i = 0; i < block.length && out.length < length; i++) out.push(block[i]);
  }
  return out;
}

function encryptString_(plaintext) {
  const key   = secretsKeyBytes_().map(u8_);
  const hex   = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 32);
  const nonce = []; for (let i = 0; i < 32; i += 2) nonce.push(parseInt(hex.substr(i, 2), 16));
  const pt    = strToBytes_(plaintext);
  const ks    = keystream_(key, nonce, pt.length);
  const ct    = pt.map((b, i) => b ^ ks[i]);
  const tag   = hmac_(key, strToBytes_('tag').concat(nonce, ct));
  return Utilities.base64Encode(nonce.concat(ct, tag).map(b => (b > 127 ? b - 256 : b)));
}

function decryptString_(b64) {
  const key = secretsKeyBytes_().map(u8_);
  const all = Utilities.base64Decode(b64).map(u8_);
  if (all.length < 16 + 32) throw new Error('ciphertext too short');
  const nonce = all.slice(0, 16), ct = all.slice(16, all.length - 32), tag = all.slice(all.length - 32);
  const expect = hmac_(key, strToBytes_('tag').concat(nonce, ct));
  let diff = 0; for (let i = 0; i < 32; i++) diff |= expect[i] ^ tag[i];
  if (diff !== 0) throw new Error('ciphertext tampered or wrong key');
  const ks = keystream_(key, nonce, ct.length);
  return bytesToStr_(ct.map((b, i) => b ^ ks[i]));
}

// ===== tenant_secrets タブ =====

function getSecretsSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID');
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName(SECRETS_SHEET_);
  if (!sheet) { sheet = ss.insertSheet(SECRETS_SHEET_); sheet.appendRow(['tenant_id', 'kind', 'ciphertext', 'updated_at', 'meta_json']); }
  return sheet;
}

/** 秘密情報を暗号化して保存（同じ tenant_id + kind は上書き）。meta は非秘密の付随情報 */
function putTenantSecret_(tenantId, kind, secretObj, meta) {
  const sheet = getSecretsSheet_();
  const ct    = encryptString_(JSON.stringify(secretObj));
  const now   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === tenantId && String(data[i][1]) === kind) {
      sheet.getRange(i + 1, 3, 1, 3).setValues([[ct, now, JSON.stringify(meta || {})]]);
      return { updated: true };
    }
  }
  sheet.appendRow([tenantId, kind, ct, now, JSON.stringify(meta || {})]);
  return { inserted: true };
}

/** 復号して返す。無ければ null。meta は復号不要で読める */
function getTenantSecret_(tenantId, kind) {
  const data = getSecretsSheet_().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === tenantId && String(data[i][1]) === kind) {
      let meta = {}; try { meta = JSON.parse(String(data[i][4] || '{}')); } catch (e) {}
      return { secret: JSON.parse(decryptString_(String(data[i][2]))), meta: meta, updated_at: String(data[i][3] || '') };
    }
  }
  return null;
}

/** 復号せずに meta だけ返す（管理画面の一覧用） */
function getTenantSecretMeta_(tenantId, kind) {
  const data = getSecretsSheet_().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === tenantId && String(data[i][1]) === kind) {
      let meta = {}; try { meta = JSON.parse(String(data[i][4] || '{}')); } catch (e) {}
      return { meta: meta, updated_at: String(data[i][3] || '') };
    }
  }
  return null;
}

function deleteTenantSecrets_(tenantId) {
  const sheet = getSecretsSheet_();
  const data  = sheet.getDataRange().getValues();
  let n = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === tenantId) { sheet.deleteRow(i + 1); n++; }
  }
  return n;
}

function maskUser_(s) { s = String(s || ''); return s.length <= 4 ? '****' : s.substring(0, 2) + '****' + s.substring(s.length - 2); }
