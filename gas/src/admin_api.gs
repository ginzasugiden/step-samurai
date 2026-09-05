/**
 * admin_api.gs — 管理者（サービス運営者）用 JSON API
 *
 * すべて ADMIN_TOKEN（Script Properties）で認証する。テナントトークンでは呼べない。
 * webapp.gs の doPost から ADMIN_ACTIONS_ に含まれる action だけがここへ来る。
 *
 * 目的: 2店舗目以降の搭載を GASエディタを開かずに、管理者UI（webui/admin.html）から
 *       「テナント作成 → 設定 → 認証情報チェック → 遡及取得 → トークン発行 → 有効化」まで行えるようにする。
 *
 * 安全設計:
 *  - 秘密情報（serviceSecret / licenseKey / トークン平文 / ハッシュ）は list_tenants の応答に含めない
 *  - トークン平文は issue_tenant_token の応答に一度だけ含まれる（シートにはハッシュのみ）
 *  - set_tenant_status で active にするには、認証情報・go_live_date・follow_days が揃っている必要がある（fail-closed）
 *  - 破壊的操作（テナント削除・シート削除）は提供しない。無効化は status=disabled のみ
 */

const ADMIN_ACTIONS_ = [
  'list_tenants', 'create_tenant', 'setup_config_sheets', 'set_tenant_status',
  'issue_tenant_token', 'revoke_tenant_token',
  'get_tenant_settings', 'set_tenant_setting',
  'check_credentials', 'probe_tenant', 'ensure_columns',
  'backfill_start', 'backfill_status', 'backfill_reset',
  'bridge_config_hint', 'system_status',
];

const TENANT_ID_PATTERN_ = /^[a-z0-9][a-z0-9_-]{2,29}$/;

function handleAdminAction_(req) {
  try {
    requireAdmin_(req.token);
  } catch (e) {
    return jsonResponse_({ ok: false, error: 'unauthorized' });
  }
  const payload  = req.payload || {};
  const tenantId = String(payload.tenant_id || '');

  try {
    switch (req.action) {
      case 'list_tenants':        return jsonResponse_({ ok: true, tenants: adminListTenants_() });
      case 'create_tenant':       return jsonResponse_(adminCreateTenant_(payload));
      case 'setup_config_sheets': return withTenant_(tenantId, () => ({ ok: true, result: setupTenantConfigSheets_(tenantId) }));
      case 'set_tenant_status':   return withTenant_(tenantId, () => adminSetStatus_(tenantId, String(payload.status || '')));
      case 'issue_tenant_token':  return withTenant_(tenantId, () => ({ ok: true, tenant_id: tenantId, token: issueTenantToken_(tenantId) }));
      case 'revoke_tenant_token': return withTenant_(tenantId, () => ({ ok: true, revoked: revokeTenantToken_(tenantId) }));
      case 'get_tenant_settings': return withTenant_(tenantId, () => ({ ok: true, settings: getTenantSettingsRaw_(tenantId) || [] }));
      case 'set_tenant_setting':  return withTenant_(tenantId, () => adminSetSetting_(tenantId, payload));
      case 'check_credentials':   return withTenant_(tenantId, () => adminCheckCredentials_(tenantId));
      case 'probe_tenant':        return withTenant_(tenantId, () => ({ ok: true, rows: probeAnalytics_(tenantId) }));
      case 'ensure_columns':      return withTenant_(tenantId, () => ({ ok: true, added: ensureAnalyticsColumns_(tenantId) }));
      case 'backfill_start':      return withTenant_(tenantId, () => ({ ok: true, result: startBackfill_(tenantId) }));
      case 'backfill_status':     return withTenant_(tenantId, () => ({ ok: true, cursor: PropertiesService.getScriptProperties().getProperty(backfillCursorKey_(tenantId)) || null, pending: listBackfillPendingTenants_() }));
      case 'backfill_reset':      return withTenant_(tenantId, () => { PropertiesService.getScriptProperties().deleteProperty(backfillCursorKey_(tenantId)); return { ok: true }; });
      case 'bridge_config_hint':  return withTenant_(tenantId, () => adminBridgeHint_(tenantId));
      case 'system_status':       return jsonResponse_({ ok: true, status: adminSystemStatus_() });
      default:                    return jsonResponse_({ ok: false, error: 'unknown_action' });
    }
  } catch (e) {
    Logger.log(`handleAdminAction_ error [${req.action}]: ${e.message}`);
    return jsonResponse_({ ok: false, error: 'internal_error', detail: String(e.message).substring(0, 200) });
  }
}

/** tenant_id の存在確認をしてから fn を実行する */
function withTenant_(tenantId, fn) {
  if (!tenantId) return jsonResponse_({ ok: false, error: 'tenant_id_required' });
  const t = listAllTenants_().find(x => x.tenant_id === tenantId);
  if (!t) return jsonResponse_({ ok: false, error: 'tenant_not_found' });
  return jsonResponse_(fn(t));
}

// ===== 一覧 =====

function adminListTenants_() {
  const tenants   = listAllTenants_();
  const authRows  = getTenantAuthSheet_().getDataRange().getValues().slice(1);
  const pending   = listBackfillPendingTenants_();
  return tenants.map(t => {
    const out = {
      tenant_id: t.tenant_id, shop_name: t.shop_name, status: t.status,
      shop_email: t.shop_email, cc_email: t.cc_email, spreadsheet_id: t.spreadsheet_id,
      active_tokens: authRows.filter(r => String(r[0]) === t.tenant_id && r[3] === 'active').length,
      has_credentials: false, credentials_expiry: '',
      backfill_cursor: (pending.find(p => p.tenantId === t.tenant_id) || {}).cursor || null,
      settings: {},
    };
    try {
      const api = getApiKeyRow_(t.tenant_id);
      out.has_credentials = !!(api.get('serviceSecret') && api.get('licenseKey'));
      out.credentials_expiry = String(api.get('expiry') || '');
    } catch (e) { /* api_key 行なし */ }
    if (t.status !== 'disabled') {
      try {
        ['go_live_date', 'dry_run', 'follow_days_after_ship'].forEach(k => { out.settings[k] = getTenantSettingValue_(t.tenant_id, k); });
      } catch (e) { out.settings_error = 'sheet_unreadable'; }
    }
    return out;
  });
}

// ===== 作成 =====

function adminCreateTenant_(p) {
  const tenantId  = String(p.tenant_id || '').trim();
  const shopName  = String(p.shop_name || '').trim();
  const shopEmail = String(p.shop_email || '').trim();
  const ccEmail   = String(p.cc_email || '').trim();
  if (!TENANT_ID_PATTERN_.test(tenantId)) return { ok: false, error: 'invalid_tenant_id', hint: '英小文字・数字・_・- で3〜30文字' };
  if (!shopName) return { ok: false, error: 'shop_name_required' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(shopEmail)) return { ok: false, error: 'invalid_shop_email' };
  if (listAllTenants_().some(t => t.tenant_id === tenantId)) return { ok: false, error: 'tenant_exists' };
  const spreadsheetId = createTenant(shopName, tenantId, shopEmail, ccEmail);
  return { ok: true, tenant_id: tenantId, spreadsheet_id: spreadsheetId, status: 'setup' };
}

// ===== ステータス =====

/** active にするための前提を列挙する。空配列なら有効化可 */
function activationBlockers_(tenantId) {
  const blockers = [];
  try {
    const api = getApiKeyRow_(tenantId);
    if (!api.get('serviceSecret') || !api.get('licenseKey')) blockers.push('api_key シートに serviceSecret / licenseKey が未登録');
  } catch (e) { blockers.push('api_key シートに行がない'); }
  const t = listAllTenants_().find(x => x.tenant_id === tenantId);
  if (!t || !t.shop_email) blockers.push('マスターシートの shop_email が未設定');
  if (!getTenantGoLiveDate_(tenantId)) blockers.push('settings.go_live_date が未設定');
  if (getFollowDaysAfterShip_(tenantId) === null) blockers.push('settings.follow_days_after_ship が未設定/不正');
  if (!getTenantTemplateRaw_(tenantId, 'follow_v1')) blockers.push('templates.follow_v1 が無い');
  return blockers;
}

function adminSetStatus_(tenantId, status) {
  if (status === 'active') {
    const blockers = activationBlockers_(tenantId);
    if (blockers.length) return { ok: false, error: 'activation_requirements_not_met', blockers: blockers };
  }
  return setTenantStatus_(tenantId, status);
}

// ===== 設定 =====

function adminSetSetting_(tenantId, p) {
  if (!p.key || p.value === undefined || p.value === null) return { ok: false, error: 'key_and_value_required' };
  const key = String(p.key), value = String(p.value);
  if (key === 'go_live_date' && value && !toJstDateString_(value)) return { ok: false, error: 'invalid_date' };
  if (key === 'dry_run' && !['true', 'false'].includes(value.toLowerCase())) return { ok: false, error: 'dry_run_must_be_true_or_false' };
  if (key === 'follow_days_after_ship' && (isNaN(Number(value)) || Number(value) < 0)) return { ok: false, error: 'invalid_number' };
  const r = setTenantSettingValueAdmin_(tenantId, key, value);
  return r.ok ? { ok: true, key: key, value: value } : r;
}

// ===== 認証情報チェック（読み取り専用・RMS へ最小の検索を1回投げる） =====

function adminCheckCredentials_(tenantId) {
  let creds;
  try { creds = getRmsCredentials(tenantId); }
  catch (e) { return { ok: false, error: 'credentials_missing', detail: String(e.message).substring(0, 200) }; }

  const to = new Date(), from = new Date(); from.setDate(from.getDate() - 1);
  const res = UrlFetchApp.fetch(`${RMS_BASE}/order/searchOrder/`, {
    method: 'post', contentType: 'application/json; charset=UTF-8',
    headers: getRmsAuthHeader_(tenantId),
    payload: JSON.stringify({ dateType: 1, startDatetime: formatRmsDate_(from), endDatetime: formatRmsDate_(to),
      orderProgressList: [100, 200, 300, 400, 500, 600, 700], PaginationRequestModel: { requestRecordsAmount: 1, requestPage: 1 } }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let msg = '';
  try { const j = JSON.parse(res.getContentText()); msg = (j.MessageModelList || []).map(m => `${m.messageType}:${m.messageCode}`).join(', '); } catch (e) {}
  return { ok: code === 200, http_code: code, rms_message: msg, shop_name: creds.shop_name, sid: creds.sid,
           expiry: creds.expiry, from_email: creds.from_email };
}

// ===== ブリッジ設定のヒント =====

function adminBridgeHint_(tenantId) {
  const t = listAllTenants_().find(x => x.tenant_id === tenantId);
  return {
    ok: true,
    note: 'smtp_bridge の config.php に以下を追記し WinSCP でアップロードする。SMTP ID/パスワードは店舗の RMS「あんしんメルアドサービス」設定画面で発行されたもの',
    snippet: [
      `// tenants[] に追加`,
      `'${tenantId}' => [`,
      `  'smtp_user' => '<<店舗のあんしんメルアド SMTP ID>>',`,
      `  'smtp_pass' => '<<店舗のあんしんメルアド SMTP パスワード>>',`,
      `  'from_email' => '${t.shop_email}',`,
      `],`,
      `// allowed_sender_emails / allowed_recipient_emails に追加`,
      `'${t.shop_email}',`,
    ].join('\n'),
  };
}

// ===== システム状態（読み取り専用） =====

function adminSystemStatus_() {
  const props = PropertiesService.getScriptProperties();
  return {
    dry_run_global: isDryRun_(),
    test_mail_to_set: !!props.getProperty('TEST_MAIL_TO'),
    triggers: ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()),
    backfill_pending: listBackfillPendingTenants_(),
    tenants_active: listActiveTenants().map(t => t.tenant_id),
  };
}
