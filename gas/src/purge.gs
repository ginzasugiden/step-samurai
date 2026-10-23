/**
 * purge.gs — 解約済みテナントの削除（管理者のみ・ADMIN_ACTIONS_ の purge_tenant）
 *
 * 安全設計（すべて満たさないと何も削除しない）:
 *  - status=disabled のテナントだけ。active / paused / setup は拒否
 *  - 確認用に tenant_id をもう一度入力させ（confirm_tenant_id）、一致しなければ拒否
 *  - 旧グローバル設定を引き継ぐ LEGACY_GLOBAL_FALLBACK_TENANT_（tokyoflower）は常に拒否
 *  - 削除の前に、専用シートの複製とマスターの該当行（tenants 行・billing_events）の複製を Drive に作る。
 *    複製に失敗したら中止（何も消さない）
 *  - 実行の記録を billing_events に残す（開始・完了）
 *
 * 削除するもの: tenant_secrets（RMS / SMTP 暗号文）、tenant_auth（パスワード・トークン・セッション）、invites、
 *   Script Properties の REVIEW_INGEST_KEY__<id> と ANALYTICS_BACKFILL_CURSOR__<id>、マスター tenants の行（最後）
 * 削除しないもの: 専用シート本体（名前を PURGED_ に変えるだけ。譲渡または削除は人が行う）、複製、billing_events、pipeline_log
 * smtp_bridge の config.php（旧方式の SMTP 設定）は別サーバなので、必要なら人が消す。
 *
 * 途中で失敗した場合はマスター行を残したまま error を返すので、原因を直して同じ操作をやり直せる（各削除は冪等）。
 */

function adminPurgeTenant_(p) {
  const tenantId = String(p.tenant_id || '').trim();
  const confirmId = String(p.confirm_tenant_id || '').trim();
  if (!tenantId) return { ok: false, error: 'tenant_id_required' };
  if (confirmId !== tenantId) return { ok: false, error: 'confirm_mismatch' };
  if (tenantId === LEGACY_GLOBAL_FALLBACK_TENANT_) return { ok: false, error: 'protected_tenant' };
  const t = listAllTenants_().find(x => x.tenant_id === tenantId);
  if (!t) return { ok: false, error: 'tenant_not_found' };
  if (t.status !== 'disabled') return { ok: false, error: 'tenant_not_disabled' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');

    // 1) 複製（失敗したら何も消さずに中止）
    let sheetBackup, masterBackup, src;
    try {
      src = SpreadsheetApp.openById(t.spreadsheet_id);
      sheetBackup = src.copy(`purge_backup_${tenantId}_${ts}`);
      masterBackup = backupMasterRows_(tenantId, ts);
    } catch (e) {
      Logger.log(`purgeTenant backup failed [${tenantId}]: ${e.message}`);
      return { ok: false, error: 'backup_failed', detail: String(e.message).substring(0, 120) };
    }
    const backups = { sheet_backup_id: sheetBackup.getId(), master_backup_id: masterBackup.getId() };
    appendBillingEvent_(tenantId, 'manual', 'purge_started', 'disabled', 'disabled', `backup sheet=${backups.sheet_backup_id} master=${backups.master_backup_id}`);

    // 2) 削除（冪等。マスター行は最後）
    const result = { ok: true, tenant_id: tenantId, backups: backups, deleted: {} };
    result.deleted.tenant_secrets = deleteTenantSecrets_(tenantId);
    result.deleted.tenant_auth = deleteRowsByTenantId_(getTenantAuthSheet_(), tenantId);
    result.deleted.invites = deleteRowsByTenantId_(getInvitesSheet_(), tenantId);
    const props = PropertiesService.getScriptProperties();
    result.deleted.properties = [`REVIEW_INGEST_KEY__${tenantId}`, backfillCursorKey_(tenantId)].filter(k => {
      const had = props.getProperty(k) !== null; props.deleteProperty(k); return had;
    }).length;
    src.rename(`PURGED_${tenantId}_${ts}`);
    result.deleted.sheet_renamed = true;
    result.deleted.master_row = deleteRowsByTenantId_(getMasterSheet_(), tenantId);
    _masterRowsCache = null;
    appendBillingEvent_(tenantId, 'manual', 'purge_tenant', 'disabled', 'purged', `secrets=${result.deleted.tenant_secrets} auth=${result.deleted.tenant_auth} invites=${result.deleted.invites} props=${result.deleted.properties}`);
    Logger.log(`purgeTenant 完了 [${tenantId}]: ${JSON.stringify(result.deleted)}`);
    return result;
  } finally { lock.releaseLock(); }
}

/** シートの A 列（tenant_id）が一致する行を下から削除し、削除件数を返す */
function deleteRowsByTenantId_(sheet, tenantId) {
  const data = sheet.getDataRange().getValues();
  let n = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === tenantId) { sheet.deleteRow(i + 1); n++; }
  }
  return n;
}

/** マスターの該当行（tenants 行と billing_events）を別スプレッドシートに複製する。暗号文・パスワードのハッシュは含めない */
function backupMasterRows_(tenantId, ts) {
  const out = SpreadsheetApp.create(`purge_backup_master_${tenantId}_${ts}`);
  const put = (name, header, rows) => {
    const sh = out.getSheetByName(name) || out.insertSheet(name);
    const all = [header].concat(rows);
    sh.getRange(1, 1, all.length, header.length).setValues(all.map(r => { const c = r.slice(0, header.length); while (c.length < header.length) c.push(''); return c; }));
  };
  const master = getMasterSheet_().getDataRange().getValues();
  const idI = master[0].indexOf('tenant_id');
  put('tenants', master[0].map(String), master.slice(1).filter(r => String(r[idI]) === tenantId));
  const ev = getBillingEventsSheet_().getDataRange().getValues();
  put('billing_events', ev[0].map(String), ev.slice(1).filter(r => String(r[2]) === tenantId));
  return out;
}

// ===== 解約後の削除リマインド（checkBillingDaily から try/catch 付きで呼ぶ） =====
//
// 規約第8条: 解約日から30日以内に専用シート等を削除する。disabled にしてから23日以上経った未 purge のテナントを ADMIN_EMAIL に知らせる。
// 起点（disabled になった日）:
//   1) billing_events の status_disabled（setTenantStatus_ が disabled 化時に記録）の最新日
//   2) 記録が無い既存 disabled（demo 等）は、初回検知日に disabled_observed を追記して「この日」を起点にする。
//      その初回だけ「disabled日の記録なし（本日を起点に記録）」付きで通知し、以後は起点+23日以上で通知（demo は初回1通→23日後から再開）。
// purge 済みの判定: purge は tenants のマスター行を削除するので listAllTenants_ に出てこない。さらに起点以降の purge_tenant イベントがあれば対象外。
// 同一テナントへの通知は1日1回（billing_events の purge_reminder_sent。note 先頭に JST 日付）。ADMIN_EMAIL 未設定ならログのみ（記録しない）。
// status が disabled 以外（tokyoflower=active 等）は一切触れない。
const PURGE_REMINDER_DAYS_ = 23, PURGE_DEADLINE_DAYS_ = 30;

function daysBetweenStr_(from, to) {
  const f = from.split('-').map(Number), t = to.split('-').map(Number);
  return Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(f[0], f[1] - 1, f[2])) / 86400000);
}

/** 戻り値: 通知（または送信試行）したテナント ID の配列 */
function checkPurgeReminders_() {
  const today = billingToday_();
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  const done = [];
  listAllTenants_().forEach(t => {
    if (t.status !== 'disabled') return;
    try {
      const ev = getBillingEventsSheet_().getDataRange().getValues().slice(1).filter(r => String(r[2]) === t.tenant_id);
      const starts = ev.filter(r => r[4] === 'status_disabled' || r[4] === 'disabled_observed').map(r => toJstDateString_(r[8]) || '').filter(Boolean).sort();
      let start = starts.length ? starts[starts.length - 1] : '', unrecorded = false;
      if (!start) { start = today; unrecorded = true; }
      if (ev.some(r => r[4] === 'purge_tenant' && (toJstDateString_(r[8]) || '') >= start)) return;   // purge 完了
      if (!unrecorded && daysBetweenStr_(start, today) < PURGE_REMINDER_DAYS_) return;
      if (ev.some(r => r[4] === 'purge_reminder_sent' && String(r[7]).indexOf(today) === 0)) return;  // 同日2回目
      const deadline = addDaysStr_(start, PURGE_DEADLINE_DAYS_);
      const body = [
        `テナントID: ${t.tenant_id}（${t.shop_name}）`,
        `disabled になった日: ${start}${unrecorded ? '（disabled日の記録なし（本日を起点に記録））' : ''}`,
        `削除期限: ${deadline}（disabled 日 + ${PURGE_DEADLINE_DAYS_} 日。規約第8条）`,
        '',
        '管理画面から purge_tenant を実行してください（専用シート・複製・認証情報・トークンを削除します）。'
      ].join('\n');
      if (!adminEmail) { Logger.log(`checkPurgeReminders_: ADMIN_EMAIL 未設定のためメール送信せず。内容:\n${body}`); return; }
      if (unrecorded) appendBillingEvent_(t.tenant_id, 'system', 'disabled_observed', 'disabled', 'disabled', `初回検知日=${today}`);
      MailApp.sendEmail(adminEmail, `[step-samurai] 解約済みテナントの削除期限が近づいています（${t.tenant_id}）`, body);
      appendBillingEvent_(t.tenant_id, 'system', 'purge_reminder_sent', '', '', `${today} start=${start} deadline=${deadline}`);
      done.push(t.tenant_id);
    } catch (e) { Logger.log(`checkPurgeReminders_ error [${t.tenant_id}]: ${e.message}`); }
  });
  return done;
}
