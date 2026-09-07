// ===== 全画面オーバーレイ（処理中表示）=====
function showOverlay(msg) {
  let el = document.getElementById('ss-overlay');
  if (!el) {
    el = document.createElement('div'); el.id = 'ss-overlay';
    const sp = document.createElement('div'); sp.className = 'big-spinner';
    const tx = document.createElement('div'); tx.className = 'overlay-text';
    el.append(sp, tx); document.body.appendChild(el);
  }
  el.querySelector('.overlay-text').textContent = msg || '処理中...';
  el.hidden = false;
}
function hideOverlay() { const el = document.getElementById('ss-overlay'); if (el) el.hidden = true; }
// ブラウザのパスワード自動入力を無効化（同一ドメインに保存された別画面の値が入る事故を防ぐ）
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[type="password"]').forEach(i => { i.setAttribute('autocomplete', 'new-password'); i.setAttribute('data-lpignore', 'true'); i.value = ''; });
});

// 店舗セルフ登録ページ。招待コード・入力値はメモリ上のみ。送信は HTTPS の GAS WebApp へ。
const $ = id => document.getElementById(id);
const state = { apiUrl: '', invite: '' };

async function call(action, payload) {
  const res = await fetch(state.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, payload }) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// URL フラグメント #invite=xxx&api=yyy で事前入力（フラグメントはサーバへ送られない）
(function prefill() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('invite')) $('invite').value = h.get('invite');
  if (h.get('api')) $('api-url').value = h.get('api');
})();

$('check-btn').addEventListener('click', async () => {
  const typed = $('api-url').value.trim(); const conf = String(window.STEP_SAMURAI_API || '');
  state.apiUrl = typed || (conf.startsWith('https://') ? conf : ''); state.invite = $('invite').value.trim();
  if (!state.apiUrl) { $('check-result').textContent = 'API のURLが設定されていません。'; return; }
  $('check-result').textContent = '確認中...';
  try {
    const r = await call('onboard_check', { invite: state.invite });
    if (!r.ok) { $('check-result').textContent = '招待コードが無効か期限切れです。運営者にご確認ください。'; return; }
    $('check-result').textContent = `店舗: ${r.shop_name}（${r.tenant_id}）`;
    $('shop_name').value = r.shop_name || ''; $('shop_email').value = r.shop_email || ''; $('tenant-id-label').textContent = r.tenant_id; state.tenantId = r.tenant_id;
    $('step2').hidden = false;
  } catch (e) { $('check-result').textContent = '通信エラー: ' + e.message; }
});

$('agree').addEventListener('change', () => { $('submit-btn').disabled = !$('agree').checked; });

$('check-btn').addEventListener('click', () => { $('check-btn').classList.add('is-busy'); $('check-btn').disabled = true; setTimeout(() => { $('check-btn').classList.remove('is-busy'); $('check-btn').disabled = false; }, 1500); });
$('submit-btn').addEventListener('click', async () => {
  $('submit-btn').classList.add('is-busy'); showOverlay('楽天に接続テストして登録しています...');
  const keys = ['shop_name', 'sid', 'shop_email', 'cc_email', 'service_secret', 'license_key', 'license_expiry', 'smtp_user', 'smtp_pass', 'follow_days', 'go_live_date'];
  const p = { invite: state.invite }; keys.forEach(k => { p[k] = $(k).value.trim(); });
  const pw = $('login_password').value, pw2 = $('login_password2').value;
  if (pw.length < 8) { $('submit-result').hidden = false; $('submit-result').textContent = 'パスワードは8文字以上にしてください。'; return; }
  if (pw !== pw2) { $('submit-result').hidden = false; $('submit-result').textContent = 'パスワード（確認）が一致しません。'; return; }
  p.login_password = pw;
  $('submit-btn').disabled = true; $('submit-result').hidden = false; $('submit-result').textContent = '楽天に接続テスト中...';
  try {
    const r = await call('onboard_submit', p);
    if (!r.ok) {
      const msg = { validation: '入力に不足があります: ' + (r.fields || []).join('、'), rms_auth_failed: `楽天への接続に失敗しました（HTTP ${r.http_code} ${r.rms_message || ''}）。serviceSecret / licenseKey と、楽天ペイ受注API の利用申請が完了しているかをご確認ください。`, invalid_invite: '招待コードが無効です。' }[r.error] || ('エラー: ' + r.error);
      $('submit-result').textContent = msg; $('submit-btn').disabled = false; return;
    }
    keys.forEach(k => { $(k).value = ''; }); $('login_password').value = ''; $('login_password2').value = '';
    $('step2').hidden = true; $('step3').hidden = false; $('token-box').textContent = r.token; $('done-tenant-id').textContent = r.tenant_id;
  } catch (e) { $('submit-result').textContent = '通信エラー: ' + e.message; $('submit-btn').disabled = false; }
  finally { $('submit-btn').classList.remove('is-busy'); hideOverlay(); }
});
