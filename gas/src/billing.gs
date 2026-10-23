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
    if (!b.trial_end) return { allowed: false, reason: 'trial_not_started' };   // 申込完了前（期間は申込完了時に起算）
    if (b.trial_end && billingToday_() <= b.trial_end) return { allowed: true, reason: 'trial' };
    return { allowed: false, reason: 'trial_expired' };
  }
  return { allowed: false, reason: st ? `status_${st}` : 'billing_unset' };
}

/** true なら稼働可。拒否時は理由をログに残す（呼び出し側は skip する） */
function billingAllows_(tenantId) {
  const d = billingDecision_(tenantId);
  if (!d.allowed) {
    Logger.log(`[${tenantId}] billing skip: ${d.reason}`);
    pipelineLog_(tenantId, 'billing_skip', d.reason);
  }
  return d.allowed;
}

// ===== pipeline_log（監視用。マスターシート pipeline_log タブ。14日・上限5,000行で保持。整理は checkBillingDaily 内で1日1回） =====
const PIPELINE_LOG_SHEET_ = 'pipeline_log';
const PIPELINE_LOG_RETAIN_DAYS_ = 14;
const PIPELINE_LOG_HARD_MAX_ROWS_ = 5000;
const PIPELINE_LOG_BACKUP_SHEET_ = 'pipeline_log_bak_20261016';
const PIPELINE_LOG_PRUNED_KEY_ = 'PIPELINE_LOG_PRUNED_DATE';

/** console.error を安全に呼ぶ（console が無い環境・失敗でも例外を出さない） */
function consoleError_(msg) {
  try { if (typeof console !== 'undefined' && console.error) console.error(msg); } catch (e) { /* ignore */ }
}

/**
 * 実行ログをシートにも残す。失敗しても本処理へは例外を出さない（Logger.log と console.error に残す）。
 * 戻り値: 書き込み成功なら true、失敗なら false。
 */
function pipelineLog_(tenantId, event, detail) {
  try {
    const ss = getMasterWorkbook_();
    let sh = ss.getSheetByName(PIPELINE_LOG_SHEET_);
    if (!sh) { sh = ss.insertSheet(PIPELINE_LOG_SHEET_); sh.appendRow(['tenant_id', 'event', 'detail', 'at']); }
    sh.appendRow([tenantId, event, String(detail || '').substring(0, 200), billingNowStr_()]);
    return true;
  } catch (e) {
    Logger.log(`pipelineLog_ skip: ${e.message}`);
    consoleError_(`pipelineLog_ failed (${tenantId}/${event}): ${e.message}`);
    return false;
  }
}

/**
 * pipeline_log のうち tenant_id='_hourly'（実行全体の記録）の行を古い順に返す。
 * 失敗時は例外を投げる（呼び出し側が検知をスキップして続行する）。タブが無ければ空配列。
 * at はシート側で Date に変換されている場合もあるため、生の値のまま返す。
 */
function readHourlyLogRows_() {
  const sh = getMasterWorkbook_().getSheetByName(PIPELINE_LOG_SHEET_);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1)
    .filter(r => String(r[0]) === '_hourly')
    .map(r => ({ event: String(r[1]), detail: String(r[2]), at: r[3] }));
}

/** pipeline_log の at（'yyyy-MM-dd HH:mm:ss' JST の文字列、またはシートが変換した Date）をミリ秒に。解釈できなければ NaN */
function pipelineAtMs_(v) {
  if (v instanceof Date) return v.getTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(v || ''));
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`) : NaN;
}

function pipelineAtStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : String(v);
}

// ===== tenant_warn（テナント単位の警告。処理は止めない。同じ run・テナント・stage は1行にまとめる） =====
let TENANT_WARN_RUN_ = '';
let TENANT_WARN_SEEN_ = {};

/** runHourlyFollowPipeline の開始時に呼ぶ（現在の run ID を設定し、記録済みキーをリセット） */
function tenantWarnReset_(runId) { TENANT_WARN_RUN_ = String(runId || ''); TENANT_WARN_SEEN_ = {}; }

/** pipeline_log に tenant_warn を1行。例外は握りつぶす（console.error）。戻り値: 書き込めたら true */
function tenantWarn_(tenantId, stage, msg) {
  try {
    const key = `${TENANT_WARN_RUN_}|${tenantId}|${stage}`;
    if (TENANT_WARN_SEEN_[key]) return false;
    TENANT_WARN_SEEN_[key] = true;
    return pipelineLog_(tenantId, 'tenant_warn', `run=${TENANT_WARN_RUN_ || '-'} stage=${stage} msg=${msg}`);
  } catch (e) {
    consoleError_(`tenantWarn_ failed (${tenantId}/${stage}): ${e.message}`);
    return false;
  }
}

// ===== 毎時処理の外部チェック（checkBillingDaily から1日1回） =====
/** 最新の hourly_start がこの分数以上前なら「停止」とみなす */
const HOURLY_HEALTH_STALE_MIN_ = 180;
const HOURLY_HEALTH_EVENT_ = 'hourly_health_alert';

/** pipeline_log の全行を古い順に返す（失敗時は例外。タブが無ければ空配列） */
function readPipelineLogAll_() {
  const sh = getMasterWorkbook_().getSheetByName(PIPELINE_LOG_SHEET_);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1).map(r => ({ tenant: String(r[0]), event: String(r[1]), detail: String(r[2]), at: r[3] }));
}

/**
 * 毎時処理が止まっているかの判定（純粋関数）。rows は readPipelineLogAll_ 形式。
 * stale: 最新の _hourly/hourly_start が 180分以上前、または hourly_start が無い。
 */
function judgeHourlyHealth_(rows, nowMs, todayStr) {
  const out = { stale: false, noStart: false, lastStart: '', minAgo: null, lastError: '', incomplete: 0, gap: 0, alertedToday: false };
  let lastMs = NaN;
  rows.forEach(r => {
    const ms = pipelineAtMs_(r.at), hourly = r.tenant === '_hourly';
    if (hourly && r.event === 'hourly_start' && !isNaN(ms) && (isNaN(lastMs) || ms > lastMs)) { lastMs = ms; out.lastStart = pipelineAtStr_(r.at); }
    if (r.event === 'hourly_error') out.lastError = r.detail;
    if (hourly && r.event === 'hourly_incomplete') out.incomplete++;
    if (hourly && r.event === 'hourly_gap') out.gap++;
    if (hourly && r.event === HOURLY_HEALTH_EVENT_ && !isNaN(ms) && Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'yyyy-MM-dd') === todayStr) out.alertedToday = true;
  });
  if (isNaN(lastMs)) { out.stale = true; out.noStart = true; return out; }
  out.minAgo = Math.round((nowMs - lastMs) / 60000);
  out.stale = out.minAgo >= HOURLY_HEALTH_STALE_MIN_;
  return out;
}

/**
 * 日次の外部チェック。毎時処理が止まっていれば ADMIN_EMAIL に通知（同日重複なし）。
 * 戻り値: 'ok' | 'stale_no_admin_email' | 'duplicate' | 'sent' | 'send_failed'
 */
function checkHourlyHealth_() {
  const nowMs = pipelineAtMs_(billingNowStr_());
  const today = Utilities.formatDate(new Date(nowMs), 'Asia/Tokyo', 'yyyy-MM-dd');
  const j = judgeHourlyHealth_(readPipelineLogAll_(), nowMs, today);
  if (!j.stale) return 'ok';
  const body = [
    j.noStart ? '毎時処理の開始記録（hourly_start）が pipeline_log に1件もありません。停止しているものとして通知します。'
      : `最終 hourly_start: ${j.lastStart}（${j.minAgo}分前。${HOURLY_HEALTH_STALE_MIN_}分以上で通知）`,
    `直近の hourly_error: ${j.lastError || '(なし)'}`,
    `hourly_incomplete 件数: ${j.incomplete}（pipeline_log に残っている範囲）`,
    `hourly_gap 件数: ${j.gap}（pipeline_log に残っている範囲）`,
    '', 'マスターシートの pipeline_log タブと、GAS のトリガー（runHourlyFollowPipeline）を確認してください。'].join('\n');
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (!adminEmail) { Logger.log(`checkHourlyHealth_: ADMIN_EMAIL 未設定のため通知せず。内容:\n${body}`); return 'stale_no_admin_email'; }
  if (j.alertedToday) { Logger.log('checkHourlyHealth_: 本日分は通知済みのためスキップ'); return 'duplicate'; }
  try { MailApp.sendEmail(adminEmail, '[step-samurai] 毎時処理が止まっています', body); }
  catch (e) { Logger.log(`checkHourlyHealth_ send failed: ${e.message}`); consoleError_(`checkHourlyHealth_ send failed: ${e.message}`); return 'send_failed'; }
  pipelineLog_('_hourly', HOURLY_HEALTH_EVENT_, j.noStart ? 'no_hourly_start' : `last_start=${j.lastStart} min_ago=${j.minAgo}`);
  return 'sent';
}

/**
 * pipeline_log の整理（checkBillingDaily から。1日1回）。
 * (a) バックアップタブ作成（失敗したら一切削除しない） (b) 14日より前の先頭連続ブロックを削除
 * (c) 5,000行超過分を古い順に削除（バックアップを今回新規作成した「初回」は行わない）。結果はログのみ。
 */
function prunePipelineLog_() {
  const props = PropertiesService.getScriptProperties();
  const nowMs = pipelineAtMs_(billingNowStr_());
  const today = Utilities.formatDate(new Date(nowMs), 'Asia/Tokyo', 'yyyy-MM-dd');
  if (props.getProperty(PIPELINE_LOG_PRUNED_KEY_) === today) return { skipped: 'already_today' };
  const ss = getMasterWorkbook_(), sh = ss.getSheetByName(PIPELINE_LOG_SHEET_);
  if (!sh) return { skipped: 'no_sheet' };
  let created = false;
  if (!ss.getSheetByName(PIPELINE_LOG_BACKUP_SHEET_)) {
    let copy = null;
    try { copy = sh.copyTo(ss); copy.setName(PIPELINE_LOG_BACKUP_SHEET_); created = true; }
    catch (e) {
      try { if (copy) ss.deleteSheet(copy); } catch (e2) { /* ignore */ }
      Logger.log(`prunePipelineLog_: バックアップ作成に失敗したため整理しない: ${e.message}`);
      consoleError_(`prunePipelineLog_ backup failed: ${e.message}`);
      return { skipped: 'backup_failed' };
    }
  }
  const cutoff = nowMs - PIPELINE_LOG_RETAIN_DAYS_ * 86400000;
  const data = sh.getDataRange().getValues();
  let old = 0;
  for (let i = 1; i < data.length; i++) { const ms = pipelineAtMs_(data[i][3]); if (!isNaN(ms) && ms < cutoff) old++; else break; }
  if (old > 0) sh.deleteRows(2, old);
  let over = 0;
  if (!created) { over = Math.max(0, sh.getLastRow() - 1 - PIPELINE_LOG_HARD_MAX_ROWS_); if (over > 0) sh.deleteRows(2, over); }
  props.setProperty(PIPELINE_LOG_PRUNED_KEY_, today);
  Logger.log(`prunePipelineLog_: 期間外 ${old}件・上限超過 ${over}件を削除（バックアップ ${created ? '新規作成' : '既存'}: ${PIPELINE_LOG_BACKUP_SHEET_}）`);
  return { backup_created: created, deleted_old: old, deleted_over: over };
}

// ===== テナント作成時 / 手動切替 =====

/** テナント作成時: trial 待機（期間は未設定）。起算は申込完了時の startTrialIfPending_ で行う */
function initPendingTrialBilling_(tenantId) {
  ensureBillingSchema_();
  writeBillingFields_(tenantId, { plan: 'standard', billing_provider: 'manual', billing_status: 'trial', trial_start: '', trial_end: '' });
  appendBillingEvent_(tenantId, 'system', 'tenant_created', '', 'trial', 'trial 起算は申込完了時');
  return { trial_start: '', trial_end: '' };
}

/**
 * 申込完了（RMS 接続テスト成功）時に trial を起算する。billing_status=trial かつ trial_start が空のときだけ。
 * 既存テナント（active や、既に起算済みの trial）の値は変えない。冪等。
 */
function startTrialIfPending_(tenantId) {
  const b = readBillingRow_(tenantId);
  if (!b || b.billing_status !== 'trial' || b.trial_start) return { started: false };
  const r = initTrialBilling_(tenantId);
  return { started: true, trial_start: r.trial_start, trial_end: r.trial_end };
}

/** trial を起算する（今日〜今日+trial_days）。通常は startTrialIfPending_ 経由で使う */
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
  if (p.start_trial) {   // 運営がセルフ登録を経ずに認証情報を入れた店舗などの trial を、今日から起算する（起算済みなら何もしない）
    const s = startTrialIfPending_(tenantId);
    if (!s.started && !p.billing_status && !p.billing_provider && !p.billing_note && !p.freee_invoiced) return { ok: true, started: false, billing: readBillingRow_(tenantId) };
  }
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
  if (!Object.keys(fields).length) return p.start_trial ? { ok: true, started: true, billing: readBillingRow_(tenantId) } : { ok: false, error: 'nothing_to_update' };
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
  // sid 根本修正: tokyoflower の tenant_secrets(rms) meta に sid が無ければ 240364 を追記（meta のみ・暗号文は不変・冪等）
  const m = getTenantSecretMeta_('tokyoflower', 'rms');
  if (!m) out.sid = 'no_rms_row';
  else if (m.meta.sid) out.sid = 'already';
  else { mergeTenantSecretMeta_('tokyoflower', 'rms', { sid: '240364' }); out.sid = 'set'; }
  Logger.log(`billing: tokyoflower=active, ${out.canceled.length ? out.canceled.join(',') + '=canceled' : 'canceled=(変更なし)'} / sid: ${out.sid}`);
  Logger.log(`seedBillingInitial: ${JSON.stringify(out)}`);
  return out;
}

// ===== 日次チェック（トリガー登録は人間ゲート） =====

/**
 * trial_end 超過を検知して billing_note に「trial期限切れ」を記録する。ステータスは自動変更しない。
 * あわせて ADMIN_EMAIL 宛てに、期限7日前・当日・期限切れ（今回初めて検知）の一覧を1通にまとめて送る。
 */
function checkBillingDaily() {
  const today = billingToday_(), flagged = [], digest = { before7: [], today: [], expired: [] };
  const in7 = addDaysStr_(today, 7);
  listAllTenants_().forEach(t => {
    const b = readBillingRow_(t.tenant_id);
    if (!b || b.billing_status !== 'trial' || !b.trial_end) return;
    const item = { tenant_id: t.tenant_id, shop_name: t.shop_name, trial_end: b.trial_end };
    if (b.trial_end === in7) digest.before7.push(item);
    if (b.trial_end === today) digest.today.push(item);
    if (b.trial_end >= today) return;
    if (b.billing_note.indexOf('trial期限切れ') >= 0) return;
    writeBillingFields_(t.tenant_id, { billing_note: `${b.billing_note ? b.billing_note + ' | ' : ''}trial期限切れ(${b.trial_end})` });
    appendBillingEvent_(t.tenant_id, 'system', 'trial_expired_flag', 'trial', 'trial', `trial_end=${b.trial_end}`);
    flagged.push(t.tenant_id);
    digest.expired.push(item);
  });
  Logger.log(`checkBillingDaily: ${flagged.length}件に trial期限切れ を記録 ${JSON.stringify(flagged)}`);
  try { sendTrialDigest_(today, digest); } catch (e) { Logger.log(`checkBillingDaily digest error: ${e.message}`); }
  try { checkHourlyHealth_(); } catch (e) { Logger.log(`checkBillingDaily hourly health error: ${e.message}`); consoleError_(`checkHourlyHealth_ failed: ${e.message}`); }
  try { checkPurgeReminders_(); } catch (e) { Logger.log(`checkBillingDaily purge reminder error: ${e.message}`); consoleError_(`checkPurgeReminders_ failed: ${e.message}`); }
  try { prunePipelineLog_(); } catch (e) { Logger.log(`checkBillingDaily prune error: ${e.message}`); consoleError_(`prunePipelineLog_ failed: ${e.message}`); }
  return flagged;
}

const TRIAL_DIGEST_EVENT_ = 'trial_digest_sent';

/**
 * trial 期限の一覧メール。対象が無ければ何もしない。同じ日に2回目は送らない（billing_events の trial_digest_sent で判定）。
 * ADMIN_EMAIL が未設定なら送らず、内容をログに出すだけ（記録もしない）。戻り値: 'sent' | 'none' | 'duplicate' | 'no_admin_email'
 */
function sendTrialDigest_(today, digest) {
  const total = digest.before7.length + digest.today.length + digest.expired.length;
  if (!total) return 'none';
  const lines = [];
  const section = (title, items) => { if (!items.length) return; lines.push(`■ ${title}（${items.length}件）`); items.forEach(i => lines.push(`  ・${i.tenant_id}（${i.shop_name}）trial_end=${i.trial_end}`)); lines.push(''); };
  section('無料期間が7日後に終わります', digest.before7);
  section('無料期間が今日で終わります（明日から送信停止）', digest.today);
  section('無料期間が終了し、送信を停止しています', digest.expired);
  lines.push('対応: 請求書を発行し、入金確認後に admin.html で billing_status を active にしてください。');
  const body = lines.join('\n');
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (!adminEmail) { Logger.log(`sendTrialDigest_: ADMIN_EMAIL 未設定のためメール送信せず。内容:\n${body}`); return 'no_admin_email'; }
  const seen = getBillingEventsSheet_().getDataRange().getValues().slice(1).some(r => String(r[4]) === TRIAL_DIGEST_EVENT_ && String(r[7]).indexOf(today) === 0);
  if (seen) { Logger.log('sendTrialDigest_: 本日分は送信済みのためスキップ'); return 'duplicate'; }
  MailApp.sendEmail(adminEmail, `[step-samurai] 無料トライアルの期限のお知らせ（${total}件）`, body);
  appendBillingEvent_('', 'system', TRIAL_DIGEST_EVENT_, '', '', `${today} 7日前=${digest.before7.length} 当日=${digest.today.length} 期限切れ=${digest.expired.length}`);
  return 'sent';
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
