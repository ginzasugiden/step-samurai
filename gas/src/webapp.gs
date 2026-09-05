/**
 * webapp.gs — テナント別管理UI向け JSON API
 *
 * doPost のみを実データ用に使う。GAS WebAppはCORSプリフライト(OPTIONS)に応答できないため、
 * フロントエンドは Content-Type: text/plain でPOSTする前提（doPost側もContent-Typeで弾かない）。
 * doGet は「ここはAPI」という案内テキストのみを返す。
 *
 * リクエスト形式: { token, action, payload }
 * - token: テナント用アクションは verifyTenantToken_ で検証するテナントトークン(平文)。
 *          管理者用アクションは ADMIN_TOKEN（平文）。
 * - action/payload: 下記 handleTenantAction_ / handleAdminAction_ 参照。
 *
 * 安全設計:
 *  - 全テナント用アクションは verifyTenantToken_(token) で解決した tenant_id のみを使い、
 *    payload に tenant_id を含めても一切信用しない（自分のスプレッドシート以外に触れさせない）。
 *  - 例外は必ず {ok:false, error:"..."} という安全な文字列で返し、スタックトレースは返さない。
 *  - send_test_mail の宛先は常にテナント自身の shop_email 固定。payloadでの宛先指定は不可。
 *  - DRY_RUN=true の間は send_test_mail も含めて実送信は一切行われない（isDryRun_()を必ず通す）。
 */

function doGet(e) {
  return ContentService
    .createTextOutput('このURLはstep-samurai管理APIのエンドポイントです。POSTリクエストで利用してください。')
    .setMimeType(ContentService.MimeType.TEXT);
}

// 管理者用アクションの一覧と実装は admin_api.gs（ADMIN_ACTIONS_ / handleAdminAction_）


function doPost(e) {
  try {
    const req    = JSON.parse(e.postData.contents);
    const action = req.action;

    if (action === 'onboard_check')  return jsonResponse_(onboardCheck_(req.payload || {}));   // 招待コードで認証（onboarding.gs）
    if (action === 'onboard_submit') return jsonResponse_(onboardSubmit_(req.payload || {}));
    if (ADMIN_ACTIONS_.includes(action)) {
      return handleAdminAction_(req);
    }
    return handleTenantAction_(req);
  } catch (err) {
    // JSON.parse失敗などの想定外エラー。スタックトレースは返さない。
    return jsonResponse_({ ok: false, error: 'internal_error' });
  }
}

// ===== テナント用アクション（テナントトークン認証） =====

function handleTenantAction_(req) {
  const tenantId = verifyTenantToken_(req.token);
  if (!tenantId) return jsonResponse_({ ok: false, error: 'unauthorized' });

  const payload = req.payload || {};

  try {
    switch (req.action) {
      case 'get_settings':
        return jsonResponse_({ ok: true, settings: getTenantSettingsRaw_(tenantId) || [] });

      case 'update_setting':
        return handleUpdateSetting_(tenantId, payload);

      case 'get_templates':
        return jsonResponse_({
          ok: true,
          templates: KNOWN_TEMPLATE_IDS_.map(id => getTenantTemplateRaw_(tenantId, id)).filter(Boolean),
        });

      case 'update_template':
        return handleUpdateTemplate_(tenantId, payload);

      case 'send_test_mail':
        return handleSendTestMail_(tenantId);

      case 'get_history':
        return jsonResponse_({ ok: true, history: getTenantHistory_(tenantId) });

      case 'get_analytics':
        // 読み取り専用。期間は payload.from/to（yyyy-MM-dd）。個人情報は含まない集計値のみ返す。
        return jsonResponse_(getAnalytics_(tenantId, payload));

      case 'get_credentials_status':
        return jsonResponse_(credentialsStatus_(tenantId));

      case 'update_credentials':
        // ライセンスキー更新（年次）。RMS 接続テスト成功時のみ暗号化保存
        return jsonResponse_(updateCredentials_(tenantId, payload));

      case 'update_smtp':
        return jsonResponse_(updateSmtp_(tenantId, payload));

      case 'import_reviews_preview':
        // レビューCSV（RMSレビューチェックツールのダウンロード）を解析して件数と先頭数行を返す。書き込まない
        return jsonResponse_(importReviewsFromCsv_(tenantId, String(payload.csv || ''), true));

      case 'import_reviews':
        // 解析して reviews タブへ upsert し、orders との紐づけを更新する
        return jsonResponse_(importReviewsFromCsv_(tenantId, String(payload.csv || ''), false));

      default:
        return jsonResponse_({ ok: false, error: 'unknown_action' });
    }
  } catch (e) {
    return jsonResponse_({ ok: false, error: 'internal_error' });
  }
}

function handleUpdateSetting_(tenantId, payload) {
  if (!payload.key || payload.value === undefined || payload.value === null) {
    return jsonResponse_({ ok: false, error: 'key_and_value_required' });
  }
  const result = setTenantSettingValue_(tenantId, String(payload.key), String(payload.value));
  if (!result.ok) return jsonResponse_(result);
  return jsonResponse_({ ok: true, key: payload.key, value: payload.value });
}

function handleUpdateTemplate_(tenantId, payload) {
  const templateId = payload.template_id;
  if (!KNOWN_TEMPLATE_IDS_.includes(templateId)) {
    return jsonResponse_({ ok: false, error: 'unknown_template_id' });
  }
  if (typeof payload.subject !== 'string' || typeof payload.body !== 'string') {
    return jsonResponse_({ ok: false, error: 'subject_and_body_required' });
  }

  const warnings = [...new Set([
    ...findUnknownPlaceholders_(payload.subject),
    ...findUnknownPlaceholders_(payload.body),
  ])];

  const result = setTenantTemplate_(tenantId, templateId, payload.subject, payload.body);
  if (!result.ok) return jsonResponse_(result);
  return jsonResponse_({ ok: true, warnings: warnings });
}

/**
 * テスト送信。宛先は常にそのテナントの shop_email 固定（payloadでの宛先指定は受け付けない）。
 * DRY_RUN=true の間は実送信されず、内容をログ出力するのみ。
 */
function handleSendTestMail_(tenantId) {
  const creds = getRmsCredentials(tenantId);
  const tpl   = getTenantTemplateRaw_(tenantId, 'follow_v1');
  if (!tpl) return jsonResponse_({ ok: false, error: 'template_missing' });

  const vars = {
    buyer_name:     'テスト太郎',
    shop_name:      creds.shop_name,
    ship_date:      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    shop_signature: creds.shop_signature,
  };
  const subject = '[テスト送信] ' + renderTemplate_(tpl.subject, vars);
  const body    = renderTemplate_(tpl.body, vars);
  const to      = creds.from_email;

  if (isTenantDryRun_(tenantId)) {
    Logger.log(`[DRY_RUN] send_test_mail: 実送信せず内容のみログ出力 tenant=${tenantId} to=${to} subject=${subject}`);
    return jsonResponse_({ ok: true, dry_run: true, to: to, subject: subject });
  }

  try {
    sendViaBridge_(tenantId, to, creds.from_email, creds.from_name, subject, body, '', creds.reply_to, '');
    return jsonResponse_({ ok: true, dry_run: false, to: to });
  } catch (e) {
    return jsonResponse_({ ok: false, error: 'send_failed' });
  }
}

function getTenantHistory_(tenantId) {
  const ss          = getTenantSpreadsheet(tenantId);
  const sendsSheet   = ss.getSheetByName('sends');
  const couponsSheet = ss.getSheetByName('coupons');

  const lastRows = (sheet, n) => {
    if (!sheet) return [];
    const data   = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    const header = data[0];
    return data.slice(1).slice(-n).reverse().map(row =>
      header.reduce((obj, h, i) => { obj[h] = row[i]; return obj; }, {})
    );
  };

  return {
    sends:   lastRows(sendsSheet, 50),
    coupons: lastRows(couponsSheet, 50),
  };
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
