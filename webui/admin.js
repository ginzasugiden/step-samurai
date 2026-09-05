// step-samurai 運営管理画面 — ADMIN_TOKEN 専用。URL・トークンはメモリ上のみ。
const state = { apiUrl: '', token: '', tenants: [], current: null };

async function callApi(action, payload) {
  const res = await fetch(state.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: state.token, action, payload: payload || {} }) });
  if (!res.ok) throw new Error(`HTTPエラー: ${res.status}`);
  return res.json();
}
const $ = id => document.getElementById(id);
const show = (id, obj) => { const el = $(id); el.hidden = false; el.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); };
const esc = s => String(s ?? '');

// ---- login ----
$('login-btn').addEventListener('click', async () => {
  state.apiUrl = $('api-url').value.trim(); state.token = $('api-token').value.trim();
  $('login-error').hidden = true;
  try {
    const r = await callApi('list_tenants');
    if (!r.ok) { $('login-error').textContent = 'ログイン失敗: ' + r.error; $('login-error').hidden = false; state.token = ''; return; }
    state.tenants = r.tenants; renderTenants(); loadSystem();
    $('login-screen').hidden = true; $('app-screen').hidden = false;
  } catch (e) { $('login-error').textContent = '通信エラー: ' + e.message; $('login-error').hidden = false; }
});
$('logout-btn').addEventListener('click', () => { state.apiUrl = state.token = ''; state.tenants = []; $('api-token').value = ''; $('app-screen').hidden = true; $('login-screen').hidden = false; });
$('reload-btn').addEventListener('click', reloadTenants);

async function reloadTenants() {
  const r = await callApi('list_tenants'); if (r.ok) { state.tenants = r.tenants; renderTenants(); }
  loadSystem();
  if (state.current) selectTenant(state.current.tenant_id);
}
async function loadSystem() {
  try { const r = await callApi('system_status'); if (r.ok) {
    const s = r.status;
    $('system-status').textContent = `グローバル DRY_RUN: ${s.dry_run_global}   TEST_MAIL_TO: ${s.test_mail_to_set ? '設定あり（本番では空に）' : 'なし'}\nトリガー: ${s.triggers.join(', ') || 'なし'}\n稼働テナント: ${s.tenants_active.join(', ') || 'なし'}\n遡及取得中: ${s.backfill_pending.map(p => `${p.tenantId}@${p.cursor}`).join(', ') || 'なし'}`;
  } } catch (e) { $('system-status').textContent = '取得失敗: ' + e.message; }
}

// ---- list ----
function renderTenants() {
  const tbody = document.querySelector('#tenant-table tbody'); tbody.innerHTML = '';
  state.tenants.forEach(t => {
    const tr = document.createElement('tr');
    const cells = [t.tenant_id, t.shop_name, `<span class="badge ${esc(t.status)}">${esc(t.status)}</span>`,
      t.has_credentials ? `<span class="ok">${t.credentials_source === 'self' ? '店舗登録' : '運営登録'}</span> ${esc(t.credentials_expiry)}` : '<span class="ng">なし</span>',
      t.has_smtp ? '<span class="ok">店舗登録</span>' : (t.tenant_id === 'tokyoflower' ? 'config.php' : '<span class="ng">なし</span>'),
      esc(t.settings.go_live_date || '<span class="ng">未設定</span>'), esc(t.settings.dry_run ?? '-'), `${t.active_tokens}件`, t.backfill_cursor ? `実行中 ${esc(t.backfill_cursor)}` : '-'];
    cells.forEach(c => { const td = document.createElement('td'); td.innerHTML = c; tr.appendChild(td); });
    const td = document.createElement('td'); const b = document.createElement('button'); b.textContent = '開く'; b.className = 'secondary';
    b.addEventListener('click', () => selectTenant(t.tenant_id)); td.appendChild(b); tr.appendChild(td);
    tbody.appendChild(tr);
  });
}

// ---- create ----
$('create-btn').addEventListener('click', async () => {
  const p = { tenant_id: $('new-id').value.trim(), shop_name: $('new-name').value.trim(), shop_email: $('new-email').value.trim(), cc_email: $('new-cc').value.trim() };
  if (!confirm(`テナント「${p.tenant_id}」を作成します。専用スプレッドシートが新規作成されます。よろしいですか？`)) return;
  $('create-btn').disabled = true;
  try { const r = await callApi('create_tenant', p); show('create-result', r); if (r.ok) await reloadTenants(); }
  catch (e) { show('create-result', '通信エラー: ' + e.message); } finally { $('create-btn').disabled = false; }
});

$('invite-btn').addEventListener('click', async () => {
  const p = { tenant_id: $('new-id').value.trim(), shop_name: $('new-name').value.trim(), shop_email: $('new-email').value.trim(), cc_email: $('new-cc').value.trim() };
  if (!confirm(`テナント「${p.tenant_id}」を作成（未作成なら）して招待コードを発行します。`)) return;
  $('invite-btn').disabled = true;
  try {
    const r = await callApi('create_invite', p);
    if (r.ok) show('create-result', `招待コード（一度しか表示されません）:\n${r.invite}\n有効期限: ${r.expires_at}\n\n店舗へ渡すURL（コードを含む）:\n${r.onboard_url}#invite=${r.invite}&api=${encodeURIComponent(state.apiUrl)}\n\n※ URL はフラグメント(#)で渡すためサーバのログには残りません。メール本文に直接書かず、安全な経路で渡してください。`);
    else show('create-result', r);
    await reloadTenants();
  } catch (e) { show('create-result', '通信エラー: ' + e.message); } finally { $('invite-btn').disabled = false; }
});

// ---- detail ----
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active'); $('tab-' + btn.dataset.tab).classList.add('active');
}));

async function selectTenant(id) {
  const t = state.tenants.find(x => x.tenant_id === id); if (!t) return;
  state.current = t; $('detail-id').textContent = `${t.tenant_id}（${t.shop_name}）`; $('detail-card').hidden = false;
  $('status-select').value = t.status;
  ['cred-result','backfill-result','token-result','status-result','bridge-result','misc-result'].forEach(i => { $(i).hidden = true; });
  document.querySelector('#probe-table tbody').innerHTML = '';
  renderChecklist(t);
  try { const r = await callApi('get_tenant_settings', { tenant_id: id }); if (r.ok) renderSettings(r.settings); } catch (e) {}
  $('detail-card').scrollIntoView({ behavior: 'smooth' });
}

function renderChecklist(t) {
  const items = [
    ['店舗から情報を受領（docs/ONBOARDING.md の依頼シート）', true, '手動'],
    ['招待コードを発行し店舗へ渡す → 店舗が onboard.html で RMSキー・SMTP を登録', t.has_credentials && t.has_smtp, '「作成して招待コードを発行」'],
    ['RMS 接続チェックが 200', null, '「操作」→ RMS 接続チェック'],
    ['settings.go_live_date を設定', !!t.settings.go_live_date, '「設定」タブ'],
    ['遡及取得（13ヶ月）を開始し完了', t.backfill_cursor ? false : null, '「操作」→ 遡及取得'],
    ['店舗トークンを発行し店舗へ渡す（analytics.html / index.html で確認してもらう）', t.active_tokens > 0, '「操作」→ 店舗トークン'],
    ['テスト送信（index.html のテスト送信、宛先は店舗メール固定）で文面確認', null, '店舗側'],
    ['dry_run を false にし、状態を active に変更', t.status === 'active', '「設定」→「操作」'],
  ];
  $('checklist').innerHTML = '';
  items.forEach(([label, done, how]) => {
    const li = document.createElement('li'); li.className = done === true ? 'done' : done === false ? 'todo' : '';
    li.textContent = `${done === true ? '✔ ' : done === false ? '✘ ' : '・ '}${label}　（${how}）`; $('checklist').appendChild(li);
  });
}

function renderSettings(settings) {
  const c = $('settings-list'); c.innerHTML = '';
  settings.forEach(s => {
    const card = document.createElement('div'); card.className = 'setting-card';
    const k = document.createElement('div'); k.className = 'key'; k.textContent = s.key + (s.editable_by_tenant ? '' : '　[店舗は編集不可]'); card.appendChild(k);
    if (s.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = s.description; card.appendChild(d); }
    const row = document.createElement('div'); row.className = 'row';
    const input = document.createElement('input'); input.type = 'text'; input.value = s.value; row.appendChild(input);
    const btn = document.createElement('button'); btn.textContent = '保存';
    btn.addEventListener('click', async () => {
      if ((s.key === 'dry_run' && input.value === 'false') && !confirm('dry_run=false にすると、この店舗のフォローメールが実際のお客様へ送信されます。よろしいですか？')) return;
      btn.disabled = true;
      try { const r = await callApi('set_tenant_setting', { tenant_id: state.current.tenant_id, key: s.key, value: input.value }); btn.textContent = r.ok ? '保存しました' : '失敗: ' + r.error; }
      catch (e) { btn.textContent = '通信エラー'; }
      btn.disabled = false; setTimeout(() => { btn.textContent = '保存'; }, 2500);
    });
    row.appendChild(btn); card.appendChild(row); c.appendChild(card);
  });
}

// ---- ops ----
const tid = () => ({ tenant_id: state.current.tenant_id });
const op = (btnId, action, resultId, extra, confirmMsg) => $(btnId).addEventListener('click', async () => {
  if (confirmMsg && !confirm(confirmMsg)) return;
  $(btnId).disabled = true;
  try { const r = await callApi(action, Object.assign(tid(), extra ? extra() : {})); show(resultId, r.snippet ? r.note + '\n\n' + r.snippet : r); if (['set_tenant_status', 'issue_tenant_token', 'revoke_tenant_token', 'backfill_start', 'backfill_reset'].includes(action)) await reloadTenants(); }
  catch (e) { show(resultId, '通信エラー: ' + e.message); } finally { $(btnId).disabled = false; }
});
op('cred-btn', 'check_credentials', 'cred-result');
op('backfill-btn', 'backfill_start', 'backfill-result', null, '13ヶ月分の受注を取り込みます（約30分、2分ごとに自動継続）。よろしいですか？');
op('backfill-status-btn', 'backfill_status', 'backfill-result');
op('backfill-reset-btn', 'backfill_reset', 'backfill-result', null, '遡及取得の進捗カーソルを削除します。次回は13ヶ月前からやり直しになります。');
op('token-btn', 'issue_tenant_token', 'token-result', null, '新しい店舗トークンを発行します（既存のトークンはそのまま有効）。');
op('revoke-btn', 'revoke_tenant_token', 'token-result', null, 'この店舗の有効トークンをすべて失効させます。店舗は再ログインできなくなります。');
op('status-btn', 'set_tenant_status', 'status-result', () => ({ status: $('status-select').value }), 'テナントの状態を変更します。active にすると毎時パイプラインの対象になります。');
op('bridge-btn', 'bridge_config_hint', 'bridge-result');
op('setup-sheets-btn', 'setup_config_sheets', 'misc-result');
op('columns-btn', 'ensure_columns', 'misc-result');
$('probe-btn').addEventListener('click', async () => {
  $('probe-btn').disabled = true; const tb = document.querySelector('#probe-table tbody'); tb.innerHTML = '<tr><td>実行中...</td></tr>';
  try { const r = await callApi('probe_tenant', tid()); tb.innerHTML = '';
    (r.rows || [[ 'error', r.error ]]).forEach(([k, v]) => { const tr = document.createElement('tr'); [k, v].forEach(x => { const td = document.createElement('td'); td.textContent = String(x); tr.appendChild(td); }); tb.appendChild(tr); });
  } catch (e) { tb.innerHTML = `<tr><td>通信エラー: ${e.message}</td></tr>`; } finally { $('probe-btn').disabled = false; }
});
