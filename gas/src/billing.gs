/**
 * billing.gs — 課金レイヤー（manual 運用 + fincode 二段構え）
 *
 * マスター管理シート tenants タブの末尾に追記する列（既存列は変更・並び替えしない）:
 *   plan | billing_provider(manual|fincode) | billing_status(trial|active|past_due|canceled) |
 *   trial_start | trial_end | fincode_customer_id | fincode_subscription_id | billing_updated_at | billing_note
 * マスターシート settings タブ（グローバル設定）: plan_price_monthly=9800 / setup_fee=0 / trial_days=30 / fincode_payment_url=''
 * マスターシート billing_events タブ: 状態変更・Webhook の監査ログ（fincode_event_id で冪等）
 *
 * 稼働ガード billingAllows_(tenantId):
 *   billing_status=active → 許可 / trial かつ 今日(JST) <= trial_end → 許可 / それ以外（未設定含む）→ 拒否。
 *   未設定テナントを通すフォールバックは持たない（fail-closed）。既存稼働店は seedBillingTokyoflower() 等で明示セットする。
 *
 * fincode Webhook（審査完了まで無効）: lolipop/fincode_webhook.php が Fincode-Signature を検証し、
 *   共有秘密 BRIDGE_TOKEN 付きで doPost action=fincode_webhook へ転送する。
 *   Script Properties BRIDGE_TOKEN / FINCODE_WEBHOOK_SECRET のどちらかが未設定なら受信を拒否する。
 */

const BILLING_COLUMNS_ = ['plan', 'billing_provider', 'billing_status', 'trial_start', 'trial_end',
  'fincode_customer_id', 'fincode_subscription_id', 'billing_updated_at', 'billing_note'];
const BILLING_STATUSES_  = ['trial', 'active', 'past_due', 'canceled'];
const BILLING_PROVIDERS_ = ['manual', 'fincode'];
const BILLING_EVENTS_SHEET_ = 'billing_events';
const BILLING_EVENT_HEADER_ = ['event_id', 'fincode_event_id', 'tenant_id', 'source', 'event_type', 'from_status', 'to_status', 'note', 'at'];
const GLOBAL_SETTINGS_SHEET_ = 'settings';
const GLOBAL_SETTING_DEFS_ = [
  { key: 'plan_price_monthly', value: '9800', description: '月額料金（円・税込表記はLPで別途）' },
  { key: 'setup_fee',          value: '0',    description: '初期費用（円）' },
  { key: 'trial_days',         value: '30',   description: '無料トライアル日数（上限30。超過値は30に丸める）' },
  { key: 'fincode_payment_url', value: '',    description: 'fincode 決済リンク（審査完了後に設定。空なら請求書払い案内）' },
];
const TRIAL_DAYS_MAX_ = 30;

function billingNowStr_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'); }
function billingToday_()  { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }

function getMasterWorkbook_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID'));
}

// ===== スキーマ（冪等・追記のみ） =====

/** tenants タブ末尾に不足する billing 列を追記し、追加した列名を返す（既存列は触らない） */
function ensureBillingColumns_() {
  const sheet  = getMasterSheet_();
  const header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String);
  const added  = [];
  BILLING_COLUMNS_.forEach(col => {
    if (header.indexOf(col) >= 0) return;
    sheet.getRange(1, header.length + 1).setValue(col);
    header.push(col); added.push(col);
  });
  if (added.length) _masterRowsCache = null;
  return added;
}

function getBillingEventsSheet_() {
  const ss = getMasterWorkbook_();
  let sh = ss.getSheetByName(BILLING_EVENTS_SHEET_);
  if (!sh) { sh = ss.insertSheet(BILLING_EVENTS_SHEET_); sh.appendRow(BILLING_EVENT_HEADER_); }
  return sh;
}

/** グローバル settings タブに不足キーを既定値で追記（既存値は変更しない） */
function ensureGlobalSettings_() {
  const ss = getMasterWorkbook_();
  let sh = ss.getSheetByName(GLOBAL_SETTINGS_SHEET_);
  if (!sh) { sh = ss.insertSheet(GLOBAL_SETTINGS_SHEET_); sh.appendRow(['key', 'value', 'description']); }
  const data = sh.getDataRange().getValues();
  const have = new Set(data.slice(1).map(r => String(r[0])));
  const added = [];
  GLOBAL_SETTING_DEFS_.forEach(d => { if (!have.has(d.key)) { sh.appendRow([d.key, d.value, d.description]); added.push(d.key); } });
  return added;
}

function ensureBillingSchema_() {
  return { columns_added: ensureBillingColumns_(), settings_added: ensureGlobalSettings_(), events_sheet: !!getBillingEventsSheet_() };
}

function getGlobalSetting_(key, fallback) {
  const sh = getMasterWorkbook_().getSheetByName(GLOBAL_SETTINGS_SHEET_);
  if (!sh) return fallback;
  const row = sh.getDataRange().getValues().slice(1).find(r => String(r[0]) === key);
  return row ? String(row[1]) : fallback;
}

/** trial_days（既定30・上限30に丸める。不正値は既定30） */
function getTrialDays_() {
  const n = Number(getGlobalSetting_('trial_days', '30'));
  if (isNaN(n) || n < 0) return TRIAL_DAYS_MAX_;
  return Math.min(Math.floor(n), TRIAL_DAYS_MAX_);
}

function addDaysStr_(dateStr, days) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ===== 読み書き =====

/** tenants タブから billing 情報を毎回読み直す（キャッシュしない）。行が無ければ null */
function readBillingRow_(tenantId) {
  const data = getMasterSheet_().getDataRange().getValues();
  const header = data[0].map(String);
  const idIdx = header.indexOf('tenant_id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) !== tenantId) continue;
    const out = { row: i + 1 };
    BILLING_COLUMNS_.forEach(c => {
      const ci = header.indexOf(c); const v = ci >= 0 ? data[i][ci] : '';
      out[c] = (c === 'trial_start' || c === 'trial_end') ? (toJstDateString_(v) || '') : (v instanceof Date ? billingNowStr_() : String(v === undefined || v === null ? '' : v));
    });
    return out;
  }
  return null;
}

/** billing 列を更新する（列が無ければ何もせず false）。updated_at は自動 */
function writeBillingFields_(tenantId, fields) {
  ensureBillingColumns_();
  const sheet = getMasterSheet_();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const cur = readBillingRow_(tenantId);
  if (!cur) return false;
  const f = Object.assign({}, fields, { billing_updated_at: billingNowStr_() });
  Object.keys(f).forEach(k => { const c = header.indexOf(k); if (c >= 0 && BILLING_COLUMNS_.indexOf(k) >= 0) sheet.getRange(cur.row, c + 1).setValue(f[k]); });
  _masterRowsCache = null;
  return true;
}

function appendBillingEvent_(tenantId, source, eventType, from, to, note, fincodeEventId) {
  getBillingEventsSheet_().appendRow([Utilities.getUuid(), fincodeEventId || '', tenantId, source, eventType, from || '', to || '', String(note || '').substring(0, 300), billingNowStr_()]);
}

// ===== 稼働ガード =====

/** 稼働可否。判定理由つき: { allowed, reason } */
function billingDecision_(tenantId) {
  let b;
  try { b = readBillingRow_(tenantId); } catch (e) { return { allowed: false, reason: 'billing_unreadable' }; }
  if (!b) return { allowed: false, reason: 'tenant_row_not_found' };
  const st = b.billing_status;
  if (st === 'active') return { allowed: true, reason: 'active' };
  if (st === 'trial') {
    if (b.trial_end && billingToday_() <= b.trial_end) return { allowed: true, reason: 'trial' };
    return { allowed: false, reason: 'trial_expired' };
  }
  return { allowed: false, reason: st ? `status_${st}` : 'billing_unset' };
}

/** true なら稼働可。拒否時は理由をログに残す（呼び出し側は skip する） */
function billingAllows_(tenantId) {
  const d = billingDecision_(tenantId);
  if (!d.allowed) Logger.log(`[${tenantId}] billing skip: ${d.reason}`);
  return d.allowed;
}

// ===== テナント作成時 / 手動切替 =====

/** 新規テナント: trial 開始（作成日〜作成日+trial_days）。createTenant から呼ぶ */
function initTrialBilling_(tenantId) {
  ensureBillingSchema_();
  const today = billingToday_(), end = addDaysStr_(today, getTrialDays_());
  writeBillingFields_(tenantId, { plan: 'standard', billing_provider: 'manual', billing_status: 'trial', trial_start: today, trial_end: end });
  appendBillingEvent_(tenantId, 'system', 'trial_start', '', 'trial', `trial_end=${end}`);
  return { trial_start: today, trial_end: end };
}

/** 管理者の手動切替（manual 運用）。billing_events に手動記録 */
function adminSetBilling_(tenantId, p) {
  const cur = readBillingRow_(tenantId);
  if (!cur) return { ok: false, error: 'billing_columns_missing' };
  const fields = {};
  if (p.billing_status !== undefined && p.billing_status !== '') {
    if (BILLING_STATUSES_.indexOf(String(p.billing_status)) < 0) return { ok: false, error: 'invalid_billing_status' };
    fields.billing_status = String(p.billing_status);
  }
  if (p.billing_provider !== undefined && p.billing_provider !== '') {
    if (BILLING_PROVIDERS_.indexOf(String(p.billing_provider)) < 0) return { ok: false, error: 'invalid_billing_provider' };
    fields.billing_provider = String(p.billing_provider);
  }
  let note = String(p.billing_note || '').trim();
  if (p.freee_invoiced) {   // freee 連携は無し。日付と請求書番号を note に残すだけ
    const date = toJstDateString_(p.freee_date) || billingToday_();
    note = `${note ? note + ' / ' : ''}freee請求済 ${date} 請求書番号:${String(p.freee_invoice_no || '').trim() || '未入力'}`;
  }
  if (note) fields.billing_note = cur.billing_note ? `${cur.billing_note} | ${note}` : note;
  if (!Object.keys(fields).length) return { ok: false, error: 'nothing_to_update' };
  writeBillingFields_(tenantId, fields);
  appendBillingEvent_(tenantId, 'manual', 'manual_update', cur.billing_status, fields.billing_status || cur.billing_status, note || 'status change');
  return { ok: true, billing: readBillingRow_(tenantId) };
}

/** tokyoflower を manual / active で明示セット（冪等）。GAS エディタから1回実行 */
function seedBillingTokyoflower() { return seedBillingActive_('tokyoflower'); }

function seedBillingActive_(tenantId) {
  ensureBillingSchema_();
  const cur = readBillingRow_(tenantId);
  if (!cur) return { ok: false, error: 'tenant_not_found' };
  if (cur.billing_provider === 'manual' && cur.billing_status === 'active') return { ok: true, unchanged: true };
  writeBillingFields_(tenantId, { plan: cur.plan || 'standard', billing_provider: 'manual', billing_status: 'active', billing_note: cur.billing_note || '既存稼働店（明示セット）' });
  appendBillingEvent_(tenantId, 'system', 'seed_active', cur.billing_status, 'active', 'explicit seed');
  return { ok: true };
}

/**
 * 初回リリース用の一括シード（冪等・GAS エディタから1回実行）。
 *  - tokyoflower: manual / active（seedBillingTokyoflower と同じ値）
 *  - それ以外で billing_status が空の全行（demo 等）: canceled / billing_note="not in service"
 *  既に billing_status がある行は変更しない。billing_events に手動シードを記録する。
 */
function seedBillingInitial() {
  ensureBillingSchema_();
  const out = { active: [], canceled: [] };
  if (seedBillingActive_('tokyoflower').ok) out.active.push('tokyoflower');
  listAllTenants_().forEach(t => {
    if (t.tenant_id === 'tokyoflower') return;
    const b = readBillingRow_(t.tenant_id);
    if (!b || b.billing_status) return;
    writeBillingFields_(t.tenant_id, { plan: b.plan || 'standard', billing_provider: 'manual', billing_status: 'canceled', billing_note: 'not in service' });
    appendBillingEvent_(t.tenant_id, 'manual', 'seed_canceled', '', 'canceled', 'initial seed (not in service)');
    out.canceled.push(t.tenant_id);
  });
  Logger.log(`seedBillingInitial: ${JSON.stringify(out)}`);
  return out;
}

// ===== 日次チェック（トリガー登録は人間ゲート） =====

/** trial_end 超過を検知して billing_note に「trial期限切れ」を記録する。ステータスは自動変更しない */
function checkBillingDaily() {
  const today = billingToday_(), flagged = [];
  listAllTenants_().forEach(t => {
    const b = readBillingRow_(t.tenant_id);
    if (!b || b.billing_status !== 'trial' || !b.trial_end || b.trial_end >= today) return;
    if (b.billing_note.indexOf('trial期限切れ') >= 0) return;
    writeBillingFields_(t.tenant_id, { billing_note: `${b.billing_note ? b.billing_note + ' | ' : ''}trial期限切れ(${b.trial_end})` });
    appendBillingEvent_(t.tenant_id, 'system', 'trial_expired_flag', 'trial', 'trial', `trial_end=${b.trial_end}`);
    flagged.push(t.tenant_id);
  });
  Logger.log(`checkBillingDaily: ${flagged.length}件に trial期限切れ を記録 ${JSON.stringify(flagged)}`);
  return flagged;
}

// ===== fincode Webhook（doPost action=fincode_webhook） =====

/**
 * イベント → ステータス対応（fincode 公式 Webhook_通知仕様に基づく）:
 *  payments.card.exec / capture で status=CAPTURED     … 課金成功 → active
 *  payments.card.* で status=FAILED（または error_code あり）… 課金失敗 → past_due
 *  subscription.(card|directdebit).delete, または .update で status=CANCELED … 解約 → canceled
 * それ以外のイベントは無視（ok:true, ignored）。戻り値は to（新ステータス）か null。
 */
function fincodeEventToStatus_(ev) {
  const e = String(ev.event || ''), st = String(ev.status || '');
  if (/^subscription\.(card|directdebit)\.(delete|update)$/.test(e) && (e.endsWith('.delete') || st === 'CANCELED')) return 'canceled';
  if (/^payments\.(card|directdebit)\./.test(e)) {
    if (st === 'FAILED' || (ev.error_code && String(ev.error_code) !== '')) return 'past_due';
    if (/\.(exec|capture|complete)$/.test(e) && (st === 'CAPTURED')) return 'active';
  }
  return null;
}

function findTenantByFincodeIds_(customerId, subscriptionId) {
  const data = getMasterSheet_().getDataRange().getValues();
  const header = data[0].map(String);
  const idI = header.indexOf('tenant_id'), cI = header.indexOf('fincode_customer_id'), sI = header.indexOf('fincode_subscription_id');
  if (idI < 0 || (cI < 0 && sI < 0)) return null;
  for (let i = 1; i < data.length; i++) {
    if (subscriptionId && sI >= 0 && String(data[i][sI]) === subscriptionId) return String(data[i][idI]);
    if (customerId && cI >= 0 && String(data[i][cI]) === customerId) return String(data[i][idI]);
  }
  return null;
}

function handleFincodeWebhook_(payload) {
  const props = PropertiesService.getScriptProperties();
  const bridge = props.getProperty('BRIDGE_TOKEN'), secret = props.getProperty('FINCODE_WEBHOOK_SECRET');
  if (!bridge || !secret) return { ok: false, error: 'not_configured' };                       // fail-closed
  if (!payload || !hash_equals_(String(payload.bridge_token || ''), bridge)) return { ok: false, error: 'unauthorized' };
  const ev = payload.event_payload || {};
  const eventId = String(payload.fincode_event_id || '');
  if (!eventId) return { ok: false, error: 'event_id_required' };

  // 冪等: 既に処理済みの fincode_event_id は無視
  const sh = getBillingEventsSheet_();
  const seen = sh.getDataRange().getValues().slice(1).some(r => String(r[1]) === eventId);
  if (seen) return { ok: true, duplicate: true };

  const to = fincodeEventToStatus_(ev);
  const tenantId = findTenantByFincodeIds_(String(ev.customer_id || ''), String(ev.subscription_id || ''));
  if (!tenantId) { appendBillingEvent_('', 'fincode', String(ev.event || ''), '', '', 'tenant_not_matched', eventId); return { ok: true, ignored: 'tenant_not_matched' }; }
  if (!to) { appendBillingEvent_(tenantId, 'fincode', String(ev.event || ''), '', '', 'ignored_event', eventId); return { ok: true, ignored: 'event' }; }
  const cur = readBillingRow_(tenantId);
  writeBillingFields_(tenantId, { billing_status: to, billing_provider: 'fincode' });
  appendBillingEvent_(tenantId, 'fincode', String(ev.event || ''), cur ? cur.billing_status : '', to, `status=${ev.status || ''}`, eventId);
  return { ok: true, tenant_id: tenantId, billing_status: to };
}
