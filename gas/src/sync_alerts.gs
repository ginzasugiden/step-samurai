/**
 * sync_alerts.gs — Chrome 拡張（レビュー自動取り込み）の状態監視と警告メール
 *
 * 状態（拡張が成功時・失敗時とも送ってくる）:
 *   ok            … 取り込み成功（新しいレビューが0件でも正常）
 *   not_logged_in … RMS のセッション切れ
 *   failed        … それ以外（通信・CSV 形式・GAS の受信エラー）
 * 保存先（テナントの settings タブ）: last_review_sync_at / ext_status / ext_status_at / ext_version / ext_problem_since
 * 送信記録: マスターの sync_alerts タブ（tenant_id, episode_since, stage, sent_at ... で同じ段階の重複送信を防ぐ）
 *
 * メール段階（要対応が続く間）: 初回 → 24時間 → 48時間（店舗＋運営）→ 以降は1日1回。正常に戻ったら段階をリセットする。
 * 判定は毎時の runHourlyFollowPipeline の最後に processSyncAlerts_ を try/catch 付きで呼ぶ（既存の流れは変えない）。
 */

const SYNC_BANNER_HOURS_ = 6;      // 店舗画面に赤い帯を出す（最終成功からの経過時間）
const SYNC_STALE_HOURS_ = 48;      // 拡張のアイコンの「48h」・運営通知の基準
const SYNC_NEVER_REPORTED_HOURS_ = 24;
const SYNC_ALERTS_SHEET_ = 'sync_alerts';
const SYNC_ALERTS_HEADER_ = ['id', 'tenant_id', 'episode_since', 'stage', 'sent_at', 'cause', 'elapsed_hours', 'to'];
const EXT_STATUSES_ = ['ok', 'not_logged_in', 'failed'];
const SYNC_CAUSE_LABEL_ = { not_logged_in: 'RMSにログインしていない（未ログイン）', failed: '取り込みの失敗（通信・形式・受信エラー）', stale: '拡張機能からの取り込みが長時間ない', never: '拡張機能がまだ一度も動いていない（未インストールの可能性）' };

function parseJstMs_(s) {
  if (!s) return NaN;
  if (s instanceof Date) return s.getTime();
  return new Date(String(s).trim().replace(' ', 'T') + '+09:00').getTime();
}
function fmtJstFromMs_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'); }

// ===== 段階判定（純粋関数） =====

/**
 * 次に送るメール段階を返す。sent は既に送った段階の配列（'first' '24h' '48h' 'daily:YYYY-MM-DD'）、today は JST の日付。
 * 一度に送るのは最大1通。上位の段階が該当するときは下位の未送信段階を飛ばす（まとめて何通も送らない）。
 * 戻り値: { stage, skipped:[...] } | null
 */
function nextAlertStage_(elapsedHours, sent, today) {
  const has = s => sent.indexOf(s) >= 0;
  const elig = [];
  elig.push('first');
  if (elapsedHours >= 24) elig.push('24h');
  if (elapsedHours >= 48) elig.push('48h');
  const unsent = elig.filter(s => !has(s));
  if (unsent.length) return { stage: unsent[unsent.length - 1], skipped: unsent.slice(0, -1) };
  // 48h を送った日は 'daily:<その日>' も送信済みとして記録するので、同じ日に重ねて送らない
  if (has('48h') && !has('daily:' + today)) return { stage: 'daily:' + today, skipped: [] };
  return null;
}

// ===== 状態の記録 =====

function getSyncAlertsSheet_() {
  const ss = getMasterWorkbook_();
  let sh = ss.getSheetByName(SYNC_ALERTS_SHEET_);
  if (!sh) { sh = ss.insertSheet(SYNC_ALERTS_SHEET_); sh.appendRow(SYNC_ALERTS_HEADER_); }
  return sh;
}

/**
 * 拡張から届いた状態を記録する。status は ok / not_logged_in / failed のみ。version は短い文字列のみ受け付ける。
 * ok → last_review_sync_at を更新し、要対応の起点（ext_problem_since）を消す（段階リセット）。
 * それ以外 → ext_problem_since が空なら今を起点にする。
 */
function recordExtStatus_(tenantId, report) {
  report = report || {};
  const status = String(report.status || '');
  if (EXT_STATUSES_.indexOf(status) < 0) return { ok: false, error: 'invalid_payload' };
  const version = /^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$/.test(String(report.version || '')) ? String(report.version) : '';
  const now = tierNowJst_();
  const m = settingMap_(tenantId);
  setTenantSettingValueAdmin_(tenantId, 'ext_status', status);
  setTenantSettingValueAdmin_(tenantId, 'ext_status_at', now);
  if (version) setTenantSettingValueAdmin_(tenantId, 'ext_version', version);
  if (status === 'ok') {
    setTenantSettingValueAdmin_(tenantId, 'last_review_sync_at', now);
    if (m.ext_problem_since) {
      logSyncAlert_(tenantId, m.ext_problem_since, 'recovered', '', 0, '');
      setTenantSettingValueAdmin_(tenantId, 'ext_problem_since', '');
    }
  } else if (!m.ext_problem_since) {
    setTenantSettingValueAdmin_(tenantId, 'ext_problem_since', now);
  }
  return { ok: true };
}

function logSyncAlert_(tenantId, episodeSince, stage, cause, elapsedHours, to) {
  getSyncAlertsSheet_().appendRow([Utilities.getUuid(), tenantId, episodeSince, stage, tierNowJst_(), cause, Math.round(elapsedHours * 10) / 10, to]);
}

// ===== 店舗画面・管理画面向けの状態 =====

/** 状態のまとめ。nowMs はテスト用に注入できる。banner は店舗画面の赤い帯を出すか */
function getSyncStatus_(tenantId, nowMs, extTokenIssuedAt) {
  nowMs = nowMs || Date.now();
  const m = settingMap_(tenantId);
  const lastMs = parseJstMs_(m.last_review_sync_at);
  const reportedMs = parseJstMs_(m.ext_status_at);
  const ageH = isNaN(lastMs) ? null : (nowMs - lastMs) / 3600000;
  const status = m.ext_status || '';
  let state = 'ok', cause = '';
  if (status === 'not_logged_in' || status === 'failed') { state = 'action'; cause = status; }
  else if (ageH !== null && ageH > SYNC_STALE_HOURS_) { state = 'action'; cause = 'stale'; }
  const tokenMs = parseJstMs_(extTokenIssuedAt);
  const never = isNaN(reportedMs) && isNaN(lastMs) && !isNaN(tokenMs) && (nowMs - tokenMs) / 3600000 >= SYNC_NEVER_REPORTED_HOURS_;
  if (never) { state = 'action'; cause = 'never'; }
  const bannerStale = ageH !== null && ageH > SYNC_BANNER_HOURS_;
  return {
    state: state, cause: cause, status: status, version: m.ext_version || '',
    last_review_sync_at: m.last_review_sync_at || '', ext_status_at: m.ext_status_at || '',
    age_hours: ageH === null ? null : Math.round(ageH * 10) / 10,
    over_48h: ageH !== null && ageH > SYNC_STALE_HOURS_,
    banner: state === 'action' || bannerStale,
    problem_since: m.ext_problem_since || '',
  };
}

function activeExtTokenIssuedMap_() {
  const out = {};
  try {
    const s = extTokenSummaryByTenant_(getTenantAuthSheet_().getDataRange().getValues());
    Object.keys(s).forEach(k => { out[k] = s[k].issued_at; });
  } catch (e) { /* 読めなければ空 */ }
  return out;
}

/** 管理画面向け: 要対応の店舗を経過時間の長い順に返す（読み取りのみ） */
function listSyncProblems_(nowMs) {
  nowMs = nowMs || Date.now();
  const issued = activeExtTokenIssuedMap_();
  const out = [];
  listAllTenants_().forEach(t => {
    if (t.status !== 'active' || !issued[t.tenant_id]) return;
    let s;
    try { s = getSyncStatus_(t.tenant_id, nowMs, issued[t.tenant_id]); } catch (e) { return; }
    if (s.state !== 'action') return;
    let elapsed = 0;
    const since = parseJstMs_(s.problem_since);
    if (!isNaN(since)) elapsed = (nowMs - since) / 3600000;
    else if (s.age_hours !== null) elapsed = s.age_hours;
    else { const im = parseJstMs_(issued[t.tenant_id]); elapsed = isNaN(im) ? 0 : (nowMs - im) / 3600000; }
    out.push({ tenant_id: t.tenant_id, shop_name: t.shop_name, cause: s.cause, status: s.status, last_review_sync_at: s.last_review_sync_at, elapsed_hours: Math.round(elapsed * 10) / 10, over_48h: elapsed >= SYNC_STALE_HOURS_ });
  });
  out.sort((a, b) => b.elapsed_hours - a.elapsed_hours);
  return out;
}

// ===== メール =====

function buildSyncAlertMail_(tenant, stage, cause, elapsedHours) {
  const hours = Math.floor(elapsedHours);
  const lines = [
    `${tenant.shop_name} 様`,
    '',
    'ステップ侍のレビュー自動取り込みが止まっています。',
    '',
    `■ 経過時間: 約${hours}時間`,
    `■ 原因: ${SYNC_CAUSE_LABEL_[cause] || cause}`,
    '',
    '■ 対処手順',
    '1. パソコンの Chrome を起動します。',
    '2. 楽天 RMS（https://review.rms.rakuten.co.jp/ ）にログインします。',
    '3. Chrome の右上の拡張機能アイコン「ステップ侍 レビュー取込」を開き、「今すぐ取り込む」を押します。',
    '',
    'ログインすると、その後は自動で再開します。',
    '解決しない場合は、このメールに返信してください。',
  ];
  if (cause === 'never') lines.splice(4, 0, 'ご案内した Chrome 拡張機能「ステップ侍 レビュー取込」のインストールと、店舗トークンの設定がお済みでないようです。インストールのご案内を再度ご確認ください。', '');
  return { subject: `【要対応】ステップ侍：レビューの自動取り込みが止まっています（${tenant.shop_name}）`, body: lines.join('\n') };
}

function sendSyncAlertMail_(to, mail) { MailApp.sendEmail(to, mail.subject, mail.body); }

/** その日（JST）の daily 段階が送信済みか、など送信記録の読み出し: { stages:[...] }（episode_since 一致のものだけ） */
function sentStagesFor_(tenantId, episodeSince) {
  const data = getSyncAlertsSheet_().getDataRange().getValues();
  const stages = [];
  data.slice(1).forEach(r => {
    if (String(r[1]) === tenantId && String(r[2]) === String(episodeSince)) stages.push(String(r[3]));
  });
  return stages;
}

/**
 * 毎時の判定。要対応の店舗にメール段階を進める。1店舗1回の実行で最大1通（店舗宛て）。48時間段階は運営にも送る。
 * nowMs はテスト用に注入できる。戻り値: 送った { tenant_id, stage }[]
 */
function processSyncAlerts_(nowMs) {
  nowMs = nowMs || Date.now();
  const done = [];
  const issued = activeExtTokenIssuedMap_();
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  const today = Utilities.formatDate(new Date(nowMs), 'Asia/Tokyo', 'yyyy-MM-dd');
  listAllTenants_().forEach(t => {
    if (t.status !== 'active' || !issued[t.tenant_id]) return;   // 拡張を使う active 店舗のみ（ECOS 経路の店舗などは対象外）
    try {
      const s = getSyncStatus_(t.tenant_id, nowMs, issued[t.tenant_id]);
      if (s.state === 'ok') {
        if (s.problem_since) {   // 念のため: 状態が ok なのに起点が残っていれば消す（段階リセット）
          logSyncAlert_(t.tenant_id, s.problem_since, 'recovered', '', 0, '');
          setTenantSettingValueAdmin_(t.tenant_id, 'ext_problem_since', '');
        }
        return;
      }
      // 起点（エピソード）の決定
      let sinceStr = s.problem_since;
      if (!sinceStr) {
        if (s.cause === 'never') sinceStr = fmtJstFromMs_(parseJstMs_(issued[t.tenant_id]));
        else if (s.cause === 'stale') sinceStr = fmtJstFromMs_(parseJstMs_(s.last_review_sync_at));
        else sinceStr = fmtJstFromMs_(nowMs);
        setTenantSettingValueAdmin_(t.tenant_id, 'ext_problem_since', sinceStr);
      }
      const elapsed = (nowMs - parseJstMs_(sinceStr)) / 3600000;
      if (isNaN(elapsed)) return;
      const sent = sentStagesFor_(t.tenant_id, sinceStr);
      let next;
      if (s.cause === 'never') {
        // 未インストール案内は1通だけ（24時間経過後）。以降は店舗画面の帯のみ
        if (sent.indexOf('never') >= 0) return;
        next = { stage: 'never', skipped: [] };
      } else {
        next = nextAlertStage_(elapsed, sent, today);
      }
      if (!next) return;
      const mail = buildSyncAlertMail_(t, next.stage, s.cause, elapsed);
      const targets = [];
      if (t.shop_email) targets.push(t.shop_email);
      if (next.stage === '48h' && adminEmail) targets.push(adminEmail);   // 48時間経過は店舗と運営の両方
      if (!targets.length) { Logger.log(`processSyncAlerts_: 宛先なし tenant=${t.tenant_id}`); return; }
      targets.forEach(to => sendSyncAlertMail_(to, mail));
      next.skipped.forEach(k => logSyncAlert_(t.tenant_id, sinceStr, k, s.cause, elapsed, 'skipped'));
      logSyncAlert_(t.tenant_id, sinceStr, next.stage, s.cause, elapsed, targets.length + '件');
      if (next.stage === '48h') logSyncAlert_(t.tenant_id, sinceStr, 'daily:' + today, s.cause, elapsed, 'covered');
      done.push({ tenant_id: t.tenant_id, stage: next.stage });
    } catch (e) {
      Logger.log(`processSyncAlerts_ error [${t.tenant_id}]: ${e.message}`);
    }
  });
  return done;
}
