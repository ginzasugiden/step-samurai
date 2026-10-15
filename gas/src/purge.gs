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
