/**
 * tenant.gs — テナント管理（api_key参照 + マスターシート店舗別メール設定版）
 *
 * 設計：
 *  - RMS資格情報（serviceSecret/licenseKey）・失効日・店舗名・sid
 *      → 既存 api_key シートから取得（BASE64デコード）
 *  - 差出人/控えメールアドレス（shop_email/cc_email）
 *      → ステップ侍のマスター管理シート（tenants タブ）から取得
 *  - テナント識別は id 列（= tenant_id）
 *
 * マスター管理シート tenants タブの列：
 *  tenant_id | shop_name | spreadsheet_id | status | shop_email | cc_email
 *
 * Script Properties（最小限）：
 *  TENANT_MASTER_SHEET_ID / API_KEY_SHEET_ID / ADMIN_EMAIL / ADMIN_TOKEN
 */

// ===== マスター管理シート =====

function getMasterSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID');
  const ss = SpreadsheetApp.openById(id);
  return ss.getSheetByName('tenants') || ss.getSheets()[0];
}

let _masterRowsCache = null;

function getMasterRow_(tenantId) {
  if (!_masterRowsCache) {
    const sheet = getMasterSheet_();
    const data  = sheet.getDataRange().getValues();
    _masterRowsCache = { header: data[0], rows: data.slice(1) };
  }
  const { header, rows } = _masterRowsCache;
  const idIdx = header.indexOf('tenant_id');
  const row   = rows.find(r => r[idIdx] === tenantId);
  if (!row) return null;
  const get = col => {
    const i = header.indexOf(col);
    return i >= 0 ? row[i] : '';
  };
  return { get };
}

function listActiveTenants() {
  const sheet = getMasterSheet_();
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0];
  const idx    = col => header.indexOf(col);
  return data.slice(1)
    .filter(row => row[idx('tenant_id')] && row[idx('status')] === 'active')
    .map(row => ({
      tenant_id:      row[idx('tenant_id')],
      shop_name:      row[idx('shop_name')],
      spreadsheet_id: row[idx('spreadsheet_id')],
    }));
}

// ===== 既存 api_key シートからRMS資格情報を取得 =====

function decodeApiValue_(value) {
  if (!value) return '';
  const str = String(value);
  if (str.startsWith('BASE64:')) {
    const encoded = str.substring('BASE64:'.length);
    const bytes   = Utilities.base64Decode(encoded);
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
  return str;
}

let _apiKeyRowsCache = null;

function getApiKeyRow_(tenantId) {
  if (!_apiKeyRowsCache) {
    const sheetId = PropertiesService.getScriptProperties().getProperty('API_KEY_SHEET_ID');
    const ss      = SpreadsheetApp.openById(sheetId);
    const sheet   = ss.getSheetByName('api_key') || ss.getSheets()[0];
    const data    = sheet.getDataRange().getValues();
    _apiKeyRowsCache = { header: data[0], rows: data.slice(1) };
  }
  const { header, rows } = _apiKeyRowsCache;
  const idIdx = header.indexOf('id');
  const row   = rows.find(r => r[idIdx] === tenantId);
  if (!row) throw new Error(`api_key シートに id=${tenantId} が見つかりません`);
  const get = col => {
    const i = header.indexOf(col);
    return i >= 0 ? row[i] : '';
  };
  return { get };
}

/**
 * RMS資格情報 + 店舗メール設定を統合して返す
 *  - キー・失効日・店舗名・sid : api_key シート
 *  - 差出人/控えアドレス       : マスター管理シート（shop_email/cc_email）
 */
function getRmsCredentials(tenantId) {
  const api    = getApiKeyRow_(tenantId);
  const master = getMasterRow_(tenantId);

  const sid   = api.get('sid');
  const sname = api.get('sname');

  // 差出人：マスターシート shop_email（必須）
  const shopEmail = master ? master.get('shop_email') : '';
  if (!shopEmail) {
    throw new Error(`マスター管理シートに ${tenantId} の shop_email が未設定です`);
  }
  // 控え：マスターシート cc_email（任意・カンマ区切り可）
  const ccEmail = master ? master.get('cc_email') : '';

  return {
    service_secret: decodeApiValue_(api.get('serviceSecret')),
    license_key:    decodeApiValue_(api.get('licenseKey')),
    expiry:         api.get('expiry'),
    shop_name:      sname,
    sid:            sid,
    from_email:     shopEmail,
    from_name:      sname,
    reply_to:       shopEmail,
    cc_email:       ccEmail,
    inquiry_url:    `https://inquiry.my.rakuten.co.jp/shop/${sid}`,
    shop_signature: buildSignature_(sname, sid),
  };
}

function buildSignature_(sname, sid) {
  const override = PropertiesService.getScriptProperties()
    .getProperty('SHOP_SIGNATURE__OVERRIDE');
  if (override) return override;
  return [
    sname,
    '',
    '【ショップへのお問い合わせ】',
    `https://inquiry.my.rakuten.co.jp/shop/${sid}`,
  ].join('\n');
}

// ===== テナント専用スプレッドシート =====

function createTenant(shopName, tenantId, shopEmail, ccEmail) {
  const ss = SpreadsheetApp.create(`step-samurai_${tenantId}`);

  const orders = ss.getSheets()[0];
  orders.setName('orders');
  orders.appendRow([
    'order_number','order_date','buyer_key','masked_email',
    'buyer_name','item_code','item_name','amount','purchase_count',
    'prefecture','ship_date','status','review_linked'
  ]);

  const reviews = ss.insertSheet('reviews');
  reviews.appendRow([
    'review_id','order_number','buyer_key','item_code','rating','posted_at','body'
  ]);

  const sends = ss.insertSheet('sends');
  sends.appendRow([
    'send_id','order_number','buyer_key','type','sent_at','template_id','result'
  ]);

  const coupons = ss.insertSheet('coupons');
  coupons.appendRow([
    'coupon_id','buyer_key','rule_id','issued_at','valid_until','api_result'
  ]);

  // マスター管理シートに追加（shop_email/cc_email 含む）
  const master = getMasterSheet_();
  master.appendRow([
    tenantId, shopName, ss.getId(), 'active',
    shopEmail || '', ccEmail || ''
  ]);

  Logger.log(`テナント作成完了: ${tenantId} / シートID: ${ss.getId()}`);
  return ss.getId();
}

function getTenantSpreadsheet(tenantId) {
  const tenant = listActiveTenants().find(t => t.tenant_id === tenantId);
  if (!tenant) throw new Error(`稼働テナントが見つかりません: ${tenantId}`);
  return SpreadsheetApp.openById(tenant.spreadsheet_id);
}

// ===== ライセンス失効チェック =====

function checkLicenseExpiry() {
  const tenants = listActiveTenants();
  const today   = new Date();

  tenants.forEach(t => {
    let expiryStr;
    try {
      expiryStr = getApiKeyRow_(t.tenant_id).get('expiry');
    } catch(e) {
      Logger.log(`失効チェックスキップ [${t.tenant_id}]: ${e.message}`);
      return;
    }
    if (!expiryStr) return;

    const diffDays = Math.floor((new Date(expiryStr) - today) / (1000 * 60 * 60 * 24));
    if (diffDays <= 30 && diffDays >= 0) {
      notifyAdmin_(`【step-samurai】${t.shop_name}（${t.tenant_id}）のRMSライセンスが${diffDays}日後（${expiryStr}）に失効します。`);
    } else if (diffDays < 0) {
      notifyAdmin_(`【step-samurai】${t.shop_name}（${t.tenant_id}）のRMSライセンスは失効済みです（${expiryStr}）。`);
    }
  });
}
