/**
 * exttest.gs — Chrome 拡張（レビュー取込 ext_ingest_reviews）の疎通確認用テスト店舗 'exttest' の作成・撤去
 *
 * GAS エディタから人が実行する想定（本番での実行は運営が判断する。コードを置くだけでは何も作られない）。
 *   setupExtTestTenant()    … tenant_id=exttest を作り、レビュー取込用トークンを発行して実行ログに平文を1回だけ出す
 *   teardownExtTestTenant() … トークン失効 → disabled → purge → 最終削除（PURGED シートと複製をゴミ箱へ）を一度に行う
 *
 * 設計（実在店舗に影響しないこと・送信系に絶対に乗らないこと）:
 *  - tenant_id は定数 'exttest' 固定。引数は取らない。他の tenant_id では動かない。
 *  - status=setup のまま（active にしない）。毎時パイプライン・日次チェック等は listActiveTenants() / status=active 判定で
 *    exttest を対象にしない。active への変更は activationBlockers_（RMS・SMTP 未登録）で拒否される。
 *  - settings.dry_run=true、RMS・SMTP 認証情報は登録しない（送信経路が仮に動いても送れない）。
 *  - billing は ext_ingest_reviews の受け口（status が active/setup かつ billingDecision_ が allowed）を通す最小設定:
 *    billing_provider=manual / billing_status=active / plan=exttest。trial にしない理由は、trial だと checkBillingDaily の
 *    trial 期限メール（運営宛ての一覧）の対象になり、期限切れ記録も付くため。fincode の ID は入れない（課金は発生しない）。
 *  - 二重作成しない。2回目以降はトークンを再表示しない（再発行は管理画面で失効→再発行）。
 */

const EXTTEST_TENANT_ID_ = 'exttest';
const EXTTEST_SHOP_NAME_ = 'exttest（拡張機能の疎通確認用・架空店舗）';
const EXTTEST_SHOP_EMAIL_ = 'exttest@example.invalid';   // 存在しないドメイン。送信経路は通らない

/** exttest 用の ext_review 行（失効済みを含む）が tenant_auth に1行でもあるか */
function exttestHasAnyExtTokenRow_() {
  const data = ensureAuthColumns_().getDataRange().getValues();
  const header = data[0].map(String);
  const iT = header.indexOf('tenant_id'), iK = header.indexOf('kind');
  if (iT < 0 || iK < 0) return false;
  return data.slice(1).some(r => String(r[iT]) === EXTTEST_TENANT_ID_ && String(r[iK]) === EXT_TOKEN_KIND_);
}

/**
 * 作成の本体。戻り値: { ok, created, token_issued, token?, reason? }
 * token は新規発行したときだけ入る（呼び出し側が Logger.log に1回出す）。
 */
function setupExtTestTenant_() {
  const id = EXTTEST_TENANT_ID_;
  const existing = listAllTenants_().find(t => t.tenant_id === id);
  let created = false;

  if (!existing) {
    createTenant(EXTTEST_SHOP_NAME_, id, EXTTEST_SHOP_EMAIL_, '');   // status=setup / settings.dry_run=true / billing は trial 待機
    created = true;
    // 受け口だけ通す最小の billing（manual / active。fincode なし）
    writeBillingFields_(id, { plan: 'exttest', billing_provider: 'manual', billing_status: 'active', trial_start: '', trial_end: '',
      billing_note: 'exttest: 拡張機能の疎通確認用（請求なし）' });
    appendBillingEvent_(id, 'manual', 'exttest_setup', 'trial', 'active', '拡張機能の疎通確認用テナントを作成（status=setup・dry_run=true・認証情報なし）');
    // dry_run は createTenant の初期値(true)に任せず、明示的に true を確認する（fail-closed）
    if (String(getTenantSettingValue_(id, 'dry_run')).toLowerCase() !== 'true') setTenantSettingValueAdmin_(id, 'dry_run', 'true');
  } else if (existing.status === 'disabled') {
    return { ok: false, created: false, token_issued: false, reason: 'tenant_disabled' };
  }

  // トークンは一度も発行されていないときだけ発行する（失効済み含め行があれば再表示・再発行しない）
  if (exttestHasAnyExtTokenRow_()) return { ok: true, created: created, token_issued: false, reason: 'token_exists' };
  return { ok: true, created: created, token_issued: true, token: issueExtToken_(id) };
}

/** GAS エディタから実行: exttest テナントを作り、レビュー取込用トークンを発行する（平文は実行ログに1回だけ） */
function setupExtTestTenant() {
  const r = setupExtTestTenant_();
  if (!r.ok) {
    Logger.log(`[exttest] 作成できません: ${r.reason}（無効化済みの exttest が残っています。teardownExtTestTenant() で撤去してください）`);
    return { ok: false, reason: r.reason };
  }
  Logger.log(`[exttest] テナント: ${r.created ? '新規作成しました' : '既に存在します（作成スキップ）'} / status=setup / dry_run=true / billing=manual・active`);
  if (r.token_issued) {
    Logger.log('[exttest] ===== レビュー取込用トークン（この1回のみ表示。控えてください）=====');
    Logger.log(r.token);
    Logger.log('[exttest] ===== ここまで =====');
  } else {
    Logger.log('[exttest] 拡張用トークンは既に存在します（再表示しません）。再発行したい場合は管理画面（admin.html）で失効→再発行してください。');
  }
  return { ok: true, created: r.created, token_issued: r.token_issued };
}

/**
 * 撤去の本体。戻り値: { ok, existed, ... }。exttest が無ければ { ok:true, existed:false }。
 * 既存の revoke / purge_tenant / final_delete_tenant の内部関数をそのまま使う（確認用 ID は定数を自分で渡す）。
 */
function teardownExtTestTenant_() {
  const id = EXTTEST_TENANT_ID_;
  const t = listAllTenants_().find(x => x.tenant_id === id);
  if (!t) return { ok: true, existed: false };
  if (t.status === 'active') return { ok: false, existed: true, error: 'exttest_is_active' };   // 想定外（誤操作防止）

  const revoked = { ext: revokeExtToken_(id), token: revokeTenantToken_(id) };
  if (t.status !== 'disabled') {
    const s = setTenantStatus_(id, 'disabled');
    if (!s.ok) return { ok: false, existed: true, error: s.error, revoked: revoked };
  }
  const purge = adminPurgeTenant_({ tenant_id: id, confirm_tenant_id: id });
  if (!purge.ok) return { ok: false, existed: true, step: 'purge', error: purge.error, revoked: revoked };
  const fin = adminFinalDeleteTenant_({ tenant_id: id, confirm_tenant_id: id });
  if (!fin.ok) return { ok: false, existed: true, step: 'final_delete', error: fin.error, revoked: revoked, purged: true };
  return { ok: true, existed: true, revoked: revoked, purged: true, trashed: fin.trashed, skipped: fin.skipped };
}

/** GAS エディタから実行: exttest を撤去する（トークン失効 → disabled → purge → 最終削除）。exttest 以外には作用しない */
function teardownExtTestTenant() {
  const r = teardownExtTestTenant_();
  if (!r.existed) { Logger.log('[exttest] テナントが存在しないため何もしません'); return r; }
  if (!r.ok) {
    Logger.log(`[exttest] 撤去を中断しました: ${r.step || 'prepare'} error=${r.error}（原因を直して再実行できます。各ステップは冪等です）`);
    return r;
  }
  Logger.log(`[exttest] 撤去完了: トークン失効 ext=${r.revoked.ext} / disabled → purge 済み / 最終削除でゴミ箱へ ${r.trashed} 件 skipped=${JSON.stringify(r.skipped)}`);
  return r;
}
