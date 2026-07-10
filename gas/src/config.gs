/**
 * config.gs — テナント別 settings / templates シート管理
 *
 * 設計方針：
 *  - テナントの spreadsheet 内に settings / templates タブを持たせ、
 *    Script Properties ではなくテナント自身のシートで運用値・文面を管理できるようにする。
 *  - 読み取りは CacheService で5分キャッシュ（毎時トリガー等での読み過多防止）。
 *  - settings/templates タブが無い、または値が不正なテナントは fail-closed
 *    （既定値で動かさず、送信・発行をスキップして警告ログを出す）。
 *    例外：coupon_valid_days のような「無くても安全に既定値で継続してよい」数値パラメータのみ、
 *    明示的にコード内既定値へフォールバックする（下記の各関数コメント参照）。
 *  - テンプレート文字列は {{key}} 形式のプレースホルダを正規表現で置換するのみで、
 *    テンプレートリテラルとして評価（eval）しない。ユーザー編集文字列を実行しない安全設計。
 */

const CONFIG_CACHE_TTL_SEC = 300; // 5分

// ===== 日付比較（GO_LIVE_DATE境界のタイムゾーンバグ対策） =====

/**
 * Date型/文字列いずれで入っていても、Asia/Tokyoのカレンダー日付として
 * 'yyyy-MM-dd' 文字列に正規化する。
 *
 * 背景: new Date("yyyy-MM-dd") はUTC 0時として解釈されるため、Asia/Tokyo(UTC+9)の
 * シートDate値（JST 0時）と直接比較すると9時間分のズレが生じ、GO_LIVE_DATE当日発送の
 * 注文が誤って除外されるバグがあった。日付同士は必ずこの文字列表現に正規化してから
 * 比較すること（文字列の辞書順 = 日付順になるため、比較は単純な文字列比較でよい）。
 *
 * 既に 'yyyy-MM-dd' で始まる文字列はタイムゾーン変換せずそのまま使う
 * （= それ自体がカレンダー日付そのものであり、UTC/JSTどちらの深夜として解釈すべきかという
 * 曖昧さを持ち込まないため）。それ以外の文字列やDate型はAsia/Tokyoのカレンダー日付に変換する。
 */
function toJstDateString_(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  const str = String(value).trim();
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return null;
  return Utilities.formatDate(parsed, 'Asia/Tokyo', 'yyyy-MM-dd');
}

/**
 * 発送日(shipDate: Date型/文字列いずれも可)が GO_LIVE_DATE（'yyyy-MM-dd'文字列）以降かどうかを
 * 正規化した日付文字列同士の比較で判定する（境界＝GO_LIVE_DATE当日は「含む」）。
 * mailer.gs sendPendingMails / coupon_engine.gs evaluateCoupons の両方がこの1関数を共用する。
 * shipDateが不正/空、またはgoLiveDateStrが不正な場合は false（fail-closed=対象外）。
 */
function isOnOrAfterGoLiveDate_(shipDate, goLiveDateStr) {
  const shipStr = toJstDateString_(shipDate);
  if (!shipStr || !goLiveDateStr) return false;
  return shipStr >= goLiveDateStr;
}

// ===== プレースホルダ置換 =====

// メール文面で使用を許可する既知のプレースホルダ一覧。
// update_template 保存時、これに無い変数名は「未知」として警告する。
const KNOWN_TEMPLATE_PLACEHOLDERS_ = [
  'buyer_name', 'shop_name', 'ship_date', 'discount',
  'coupon_valid_until', 'coupon_get_url', 'shop_signature',
];

/**
 * {{key}} 形式のプレースホルダを vars[key] で置換する。
 * テンプレートリテラル評価(eval)は一切行わない単純な正規表現置換。
 * vars に無いキーはそのまま `{{key}}` の文字列として残す（サイレントに消さない）。
 */
function renderTemplate_(str, vars) {
  return String(str).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return (v === null || v === undefined) ? '' : String(v);
    }
    return match;
  });
}

/** 文面内の {{...}} のうち KNOWN_TEMPLATE_PLACEHOLDERS_ に無いものを列挙する（保存時の警告用） */
function findUnknownPlaceholders_(str) {
  const found = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(str))) !== null) {
    if (!KNOWN_TEMPLATE_PLACEHOLDERS_.includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

// ===== settings タブ =====

/**
 * settings タブの全行を返す（キャッシュあり）。
 * タブ自体が無ければ null（呼び出し側は fail-closed で扱うこと）。
 */
function getTenantSettingsRaw_(tenantId) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = `settings__${tenantId}`;
  const cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('settings');
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0];
  const idx    = col => header.indexOf(col);

  const rows = data.slice(1)
    .filter(r => r[idx('key')])
    .map(r => ({
      key:                String(r[idx('key')]),
      value:              String(r[idx('value')]),
      description:        String(r[idx('description')] || ''),
      editable_by_tenant: String(r[idx('editable_by_tenant')]).toUpperCase() === 'TRUE',
    }));

  cache.put(cacheKey, JSON.stringify(rows), CONFIG_CACHE_TTL_SEC);
  return rows;
}

/** 指定キーの value（文字列）を返す。settings タブが無い/キーが無ければ null */
function getTenantSettingValue_(tenantId, key) {
  const rows = getTenantSettingsRaw_(tenantId);
  if (!rows) return null;
  const row = rows.find(r => r.key === key);
  return row ? row.value : null;
}

/**
 * settings タブの1行を更新する（WebAPI update_setting から呼ばれる）。
 * editable_by_tenant=TRUE の行のみ書き込み可。
 */
function setTenantSettingValue_(tenantId, key, value) {
  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('settings');
  if (!sheet) return { ok: false, error: 'settings_sheet_missing' };

  const data   = sheet.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);
  const keyIdx      = idx('key');
  const valueIdx    = idx('value');
  const editableIdx = idx('editable_by_tenant');

  for (let i = 1; i < data.length; i++) {
    if (data[i][keyIdx] === key) {
      const editable = String(data[i][editableIdx]).toUpperCase() === 'TRUE';
      if (!editable) return { ok: false, error: 'not_editable' };
      sheet.getRange(i + 1, valueIdx + 1).setValue(value);
      invalidateTenantConfigCache_(tenantId);
      return { ok: true };
    }
  }
  return { ok: false, error: 'unknown_key' };
}

/**
 * フォローメールを送るまでの発送後経過日数。
 * settings タブ自体が無い/値が不正な場合は null を返し、呼び出し側で全スキップ（fail-closed）させる。
 * mailer.gs sendPendingMails / coupon_engine.gs evaluateCoupons の両方がこの関数を共通参照する。
 */
function getFollowDaysAfterShip_(tenantId) {
  const raw = getTenantSettingValue_(tenantId, 'follow_days_after_ship');
  const n   = Number(raw);
  if (raw === null || raw === '' || isNaN(n) || n < 0) return null;
  return n;
}

/**
 * クーポン有効期間（日数）。
 * これは送信可否を左右する安全ゲートではなく単なる有効期限の長さなので、
 * settings が無い/不正な場合は既存挙動と同じ既定値30日にフォールバックする
 * （fail-closedにはしない。coupon issue自体はDRY_RUN側の安全ゲートで別途守られている）。
 */
function getCouponValidDays_(tenantId) {
  const raw = getTenantSettingValue_(tenantId, 'coupon_valid_days');
  const n   = Number(raw);
  if (raw === null || raw === '' || isNaN(n) || n <= 0) return 30;
  return n;
}

// ===== templates タブ =====

/**
 * templates タブから1テンプレートを返す（キャッシュあり）。
 * タブ自体が無い、または template_id の行が無ければ null。
 */
function getTenantTemplateRaw_(tenantId, templateId) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = `template__${tenantId}__${templateId}`;
  const cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('templates');
  if (!sheet) return null;

  const data   = sheet.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);
  const row    = data.slice(1).find(r => r[idx('template_id')] === templateId);
  if (!row) return null;

  const tpl = {
    template_id: templateId,
    subject:     String(row[idx('subject')] || ''),
    body:        String(row[idx('body')] || ''),
    updated_at:  row[idx('updated_at')] || '',
  };

  cache.put(cacheKey, JSON.stringify(tpl), CONFIG_CACHE_TTL_SEC);
  return tpl;
}

const KNOWN_TEMPLATE_IDS_ = ['follow_v1', 'coupon_v1'];

/**
 * templates タブの1行を更新する（WebAPI update_template から呼ばれる）。
 * 未知のプレースホルダは呼び出し側（webapp.gs）が警告として拾うため、ここでは保存のみ行う。
 */
function setTenantTemplate_(tenantId, templateId, subject, body) {
  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('templates');
  if (!sheet) return { ok: false, error: 'templates_sheet_missing' };

  const data   = sheet.getDataRange().getValues();
  const header = data[0];
  const idx    = col => header.indexOf(col);
  const idIdx  = idx('template_id');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idIdx] === templateId) {
      const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
      sheet.getRange(i + 1, idx('subject') + 1).setValue(subject);
      sheet.getRange(i + 1, idx('body') + 1).setValue(body);
      sheet.getRange(i + 1, idx('updated_at') + 1).setValue(now);
      invalidateTenantConfigCache_(tenantId);
      return { ok: true };
    }
  }
  return { ok: false, error: 'unknown_template_id' };
}

function invalidateTenantConfigCache_(tenantId) {
  const cache = CacheService.getScriptCache();
  cache.remove(`settings__${tenantId}`);
  KNOWN_TEMPLATE_IDS_.forEach(id => cache.remove(`template__${tenantId}__${id}`));
}

// ===== 初期文面（setupTenantConfigSheets_ が templates タブへ投入する既定値） =====

const FOLLOW_V1_SUBJECT_DEFAULT_ = '【{{shop_name}}】お花はお手元に届きましたでしょうか';

const FOLLOW_V1_BODY_DEFAULT_ =
`{{buyer_name}} 様

このたびは「{{shop_name}}」をご利用いただき、誠にありがとうございます。
ご注文の商品は{{ship_date}}に発送いたしました。
商品の状態やお届けの状況に、何か気になる点はございませんでしたか。

【お花を長くお楽しみいただくために】
・水は毎日取り替え、茎先を少し切り戻すと長持ちします
・直射日光とエアコンの風が当たる場所は避けてください
ご贈答でお送りいただいた場合は、お届け先様にもお伝えいただけますと幸いです。

もしよろしければ、レビューにてご感想をお聞かせください。
今後の商品づくり・店づくりの参考にさせていただきます。
レビューをご投稿いただいた方には、次回のご注文でお使いいただける
クーポンを後日メールにてお届けしております。

＜レビューの書き方＞
【楽天にログイン】→【購入履歴】→ 対象商品の【商品レビューを書く】→【投稿する】

※万一、お花の傷みや配送の不備がございましたら、レビューの前に
　下記よりご連絡ください。すぐに対応いたします。

本メールの配信停止をご希望の場合は、下記お問い合わせ先までお知らせください。
---
{{shop_signature}}`;

const COUPON_V1_SUBJECT_DEFAULT_ = '【{{shop_name}}】レビューご投稿ありがとうございます｜クーポンをお届けします';

const COUPON_V1_BODY_DEFAULT_ =
`{{buyer_name}} 様

このたびはレビューをご投稿いただき、誠にありがとうございます。
スタッフ一同、大変励みになります。

ささやかですが、次回のご注文でお使いいただけるクーポンをご用意しました。

━━━━━━━━━━━━━━━━━━
　割引金額：{{discount}}円OFF
　有効期限：{{coupon_valid_until}}
━━━━━━━━━━━━━━━━━━

クーポンは下記URLから「獲得」いただくことでご利用いただけます。
{{coupon_get_url}}

またのご利用を心よりお待ちしております。

---
{{shop_signature}}`;

/**
 * テナントの settings / templates タブを新設する（初回セットアップ用・手動実行）。
 * 既に存在する場合はスキップする（既存データを壊さない）。
 */
function setupTenantConfigSheets_(tenantId) {
  const ss = getTenantSpreadsheet(tenantId);
  const result = { tenantId, settingsCreated: false, templatesCreated: false };

  let settings = ss.getSheetByName('settings');
  if (!settings) {
    settings = ss.insertSheet('settings');
    settings.appendRow(['key', 'value', 'description', 'editable_by_tenant']);
    settings.appendRow(['follow_days_after_ship', '5', 'フォローメールを送る発送後の経過日数', 'TRUE']);
    settings.appendRow(['coupon_valid_days', '30', 'クーポンの有効期間（発行開始からの日数）', 'TRUE']);
    settings.appendRow([
      'coupon_rules',
      JSON.stringify([
        { rule_id: 'first_purchase',  discount: 300, enabled: true },
        { rule_id: 'repeat_purchase', discount: 300, enabled: true },
      ]),
      'クーポンルール(JSON配列)。rule_id/discount/enabledのみ編集可能。購入回数レンジ等の構造はコード側(coupon_engine.gs)で固定',
      'FALSE',
    ]);
    result.settingsCreated = true;
    Logger.log(`[${tenantId}] settings タブを新規作成しました`);
  } else {
    Logger.log(`[${tenantId}] settings タブは既に存在します（作成スキップ）`);
  }

  let templates = ss.getSheetByName('templates');
  if (!templates) {
    templates = ss.insertSheet('templates');
    templates.appendRow(['template_id', 'subject', 'body', 'updated_at']);
    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    templates.appendRow(['follow_v1', FOLLOW_V1_SUBJECT_DEFAULT_, FOLLOW_V1_BODY_DEFAULT_, now]);
    templates.appendRow(['coupon_v1', COUPON_V1_SUBJECT_DEFAULT_, COUPON_V1_BODY_DEFAULT_, now]);
    result.templatesCreated = true;
    Logger.log(`[${tenantId}] templates タブを新規作成し、初期文面(follow_v1/coupon_v1)を投入しました`);
  } else {
    Logger.log(`[${tenantId}] templates タブは既に存在します（作成スキップ）`);
  }

  invalidateTenantConfigCache_(tenantId);
  Logger.log(`setupTenantConfigSheets_ 完了: ${JSON.stringify(result)}`);
  return result;
}
