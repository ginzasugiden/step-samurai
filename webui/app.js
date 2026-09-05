// step-samurai 管理画面 — バニラJS（ビルド工程なし）
// APIのURL・トークンはこのモジュールスコープの変数にのみ保持する。
// localStorage/sessionStorage/cookie等への保存は行わない（ページを閉じると消える）。

const state = {
  apiUrl: '',
  token: '',
  settings: [],
  templates: [],
};

// ===== API呼び出し =====
// GAS WebAppはCORSプリフライト(OPTIONS)に応答できないため、
// Content-Type: text/plain で送りプリフライトを発生させない。
async function callApi(action, payload) {
  const res = await fetch(state.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: state.token, action, payload: payload || {} }),
  });
  if (!res.ok) {
    throw new Error(`HTTPエラー: ${res.status}`);
  }
  return res.json();
}

// ===== ログイン =====

const loginScreen = document.getElementById('login-screen');
const appScreen   = document.getElementById('app-screen');
const loginError  = document.getElementById('login-error');

document.getElementById('login-btn').addEventListener('click', async () => {
  const apiUrl = document.getElementById('api-url').value.trim();
  const token  = document.getElementById('api-token').value.trim();
  loginError.hidden = true;

  if (!apiUrl || !token) {
    showLoginError('APIのURLとトークンの両方を入力してください。');
    return;
  }

  state.apiUrl = apiUrl;
  state.token  = token;

  try {
    const res = await callApi('get_settings', {});
    if (!res.ok) {
      showLoginError('ログインに失敗しました: ' + (res.error || '不明なエラー'));
      state.token = '';
      return;
    }
    state.settings = res.settings || [];
    await loadAll();
    loginScreen.hidden = true;
    appScreen.hidden = false;
  } catch (e) {
    showLoginError('通信エラー: ' + e.message + '（APIのURLが正しいか確認してください）');
    state.token = '';
  }
});

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

document.getElementById('logout-btn').addEventListener('click', () => {
  state.apiUrl = '';
  state.token = '';
  state.settings = [];
  state.templates = [];
  document.getElementById('api-url').value = '';
  document.getElementById('api-token').value = '';
  appScreen.hidden = true;
  loginScreen.hidden = false;
});

// ===== タブ切り替え =====

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ===== データ読み込み =====

async function loadAll() {
  renderSettings(state.settings);

  try {
    const tplRes = await callApi('get_templates', {});
    if (tplRes.ok) {
      state.templates = tplRes.templates || [];
      renderTemplates(state.templates);
    }
  } catch (e) { /* 文面タブ表示は失敗してもログイン自体は継続させる */ }

  try {
    const cs = await callApi('get_credentials_status', {});
    document.getElementById('cred-status').textContent = cs.ok
      ? `楽天API: ${cs.rms.registered ? '登録済（店舗ID ' + (cs.rms.sid || '-') + '、期限 ' + (cs.rms.expiry || '未設定') + '、更新 ' + cs.rms.updated_at + '）' : (cs.rms.legacy ? '運営者側で登録済' : '未登録')}\nSMTP: ${cs.smtp.registered ? '登録済（ID ' + cs.smtp.smtp_user_masked + '、更新 ' + cs.smtp.updated_at + '）' : '未登録（運営者側の設定を使用）'}`
      : '取得できませんでした';
  } catch (e) { /* 認証情報表示は失敗してもログイン自体は継続させる */ }

  try {
    const histRes = await callApi('get_history', {});
    if (histRes.ok) {
      renderHistory(histRes.history);
    }
  } catch (e) { /* 履歴タブ表示は失敗してもログイン自体は継続させる */ }
}

// ===== 設定タブ =====

function renderSettings(settings) {
  const container = document.getElementById('settings-list');
  container.innerHTML = '';

  settings.forEach(s => {
    const card = document.createElement('div');
    card.className = 'setting-card';

    const keyLine = document.createElement('div');
    keyLine.className = 'key';
    keyLine.textContent = s.key;
    if (!s.editable_by_tenant) {
      const badge = document.createElement('span');
      badge.className = 'readonly-badge';
      badge.textContent = '編集不可';
      keyLine.appendChild(badge);
    }
    card.appendChild(keyLine);

    if (s.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = s.description;
      card.appendChild(desc);
    }

    const row = document.createElement('div');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.value;
    input.disabled = !s.editable_by_tenant;
    row.appendChild(input);

    if (s.editable_by_tenant) {
      const saveBtn = document.createElement('button');
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', async () => {
        saveBtn.textContent = '保存中...';
        saveBtn.disabled = true;
        try {
          const res = await callApi('update_setting', { key: s.key, value: input.value });
          saveBtn.disabled = false;
          saveBtn.textContent = res.ok ? '保存しました' : ('失敗: ' + res.error);
          setTimeout(() => { saveBtn.textContent = '保存'; }, 2000);
        } catch (e) {
          saveBtn.disabled = false;
          saveBtn.textContent = '通信エラー';
        }
      });
      row.appendChild(saveBtn);
    }

    card.appendChild(row);
    container.appendChild(card);
  });
}

// ===== 文面タブ =====

function renderTemplates(templates) {
  const container = document.getElementById('templates-list');
  container.innerHTML = '';

  templates.forEach(t => {
    const card = document.createElement('div');
    card.className = 'template-card';

    const title = document.createElement('h3');
    title.textContent = t.template_id + (t.updated_at ? `（最終更新: ${t.updated_at}）` : '');
    card.appendChild(title);

    const subjectLabel = document.createElement('div');
    subjectLabel.className = 'field-label';
    subjectLabel.textContent = '件名';
    card.appendChild(subjectLabel);

    const subjectInput = document.createElement('input');
    subjectInput.type = 'text';
    subjectInput.value = t.subject;
    card.appendChild(subjectInput);

    const bodyLabel = document.createElement('div');
    bodyLabel.className = 'field-label';
    bodyLabel.textContent = '本文';
    card.appendChild(bodyLabel);

    const bodyTextarea = document.createElement('textarea');
    bodyTextarea.className = 'body-field';
    bodyTextarea.value = t.body;
    card.appendChild(bodyTextarea);

    const msgBox = document.createElement('div');
    card.appendChild(msgBox);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', async () => {
      msgBox.innerHTML = '';
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
      try {
        const res = await callApi('update_template', {
          template_id: t.template_id,
          subject: subjectInput.value,
          body: bodyTextarea.value,
        });
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        if (!res.ok) {
          const err = document.createElement('div');
          err.className = 'warning';
          err.textContent = '保存失敗: ' + res.error;
          msgBox.appendChild(err);
          return;
        }
        const ok = document.createElement('div');
        ok.className = 'saved-msg';
        ok.textContent = '保存しました';
        msgBox.appendChild(ok);
        if (res.warnings && res.warnings.length > 0) {
          const warn = document.createElement('div');
          warn.className = 'warning';
          warn.textContent = '未知のプレースホルダが含まれています: ' + res.warnings.map(w => `{{${w}}}`).join(', ');
          msgBox.appendChild(warn);
        }
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        const err = document.createElement('div');
        err.className = 'warning';
        err.textContent = '通信エラー: ' + e.message;
        msgBox.appendChild(err);
      }
    });
    card.appendChild(saveBtn);

    container.appendChild(card);
  });
}

// ===== テスト送信タブ =====

document.getElementById('send-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('send-test-btn');
  const resultBox = document.getElementById('test-result');
  btn.disabled = true;
  btn.textContent = '送信中...';
  resultBox.hidden = false;
  resultBox.textContent = '...';

  try {
    const res = await callApi('send_test_mail', {});
    resultBox.textContent = JSON.stringify(res, null, 2);
  } catch (e) {
    resultBox.textContent = '通信エラー: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'フォローメールのテスト送信を実行';
  }
});

// ===== 履歴タブ =====

function renderHistory(history) {
  renderTable('sends-table', history.sends || []);
  renderTable('coupons-table', history.coupons || []);
}

function renderTable(tableId, rows) {
  const table = document.getElementById(tableId);
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td>データがありません</td></tr>';
    return;
  }

  const columns = Object.keys(rows[0]);
  const headRow = document.createElement('tr');
  columns.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  rows.forEach(row => {
    const tr = document.createElement('tr');
    columns.forEach(c => {
      const td = document.createElement('td');
      td.textContent = row[c] === undefined || row[c] === null ? '' : String(row[c]);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}


// ===== レビュー取込タブ =====

let reviewCsvText = '';

function readFileAsText(file, encoding) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('ファイルを読めませんでした'));
    r.readAsText(file, encoding);
  });
}

// RMS の CSV は Shift_JIS のことが多い。まず UTF-8 で読み、置換文字(U+FFFD)が多ければ Shift_JIS で読み直す
async function readCsvSmart(file) {
  const utf8 = await readFileAsText(file, 'utf-8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad > utf8.length / 200) return readFileAsText(file, 'shift_jis');
  return utf8;
}

document.getElementById('review-preview-btn').addEventListener('click', async () => {
  const file = document.getElementById('review-file').files[0];
  const box = document.getElementById('review-result');
  const importBtn = document.getElementById('review-import-btn');
  importBtn.disabled = true;
  if (!file) { box.hidden = false; box.textContent = 'CSVファイルを選択してください。'; return; }
  box.hidden = false; box.textContent = '解析中...';
  try {
    reviewCsvText = await readCsvSmart(file);
    const res = await callApi('import_reviews_preview', { csv: reviewCsvText });
    if (!res.ok) { box.textContent = '解析できませんでした: ' + res.error + (res.missing ? '（見つからない列: ' + res.missing.join(', ') + '）' : '') + (res.header ? '\n先頭行: ' + res.header.join(' | ') : ''); return; }
    box.textContent = `読み取り ${res.parsed_rows}行 / 取込対象 ${res.valid_rows}件\n列の対応: ${JSON.stringify(res.column_map)}\n先頭:\n` + res.sample.map(s => `  ${s.order_number}  ★${s.rating}  ${s.posted_at}`).join('\n');
    importBtn.disabled = res.valid_rows === 0;
  } catch (e) { box.textContent = '通信エラー: ' + e.message; }
});

document.getElementById('review-import-btn').addEventListener('click', async () => {
  const box = document.getElementById('review-result');
  const btn = document.getElementById('review-import-btn');
  btn.disabled = true; btn.textContent = '取込中...';
  try {
    const res = await callApi('import_reviews', { csv: reviewCsvText });
    box.textContent = res.ok ? `取込完了: 追加 ${res.inserted}件 / 更新 ${res.updated}件（注文との紐づけ ${res.linked ? '更新済' : '未更新'}）` : '取込失敗: ' + res.error;
  } catch (e) { box.textContent = '通信エラー: ' + e.message; }
  finally { btn.textContent = '取り込む'; }
});


// ===== 認証情報タブ =====

document.getElementById('cred-update-btn').addEventListener('click', async () => {
  const box = document.getElementById('cred-result'); box.hidden = false; box.textContent = '楽天に接続テスト中...';
  try {
    const res = await callApi('update_credentials', { service_secret: document.getElementById('cred-secret').value.trim(), license_key: document.getElementById('cred-license').value.trim(), license_expiry: document.getElementById('cred-expiry').value });
    box.textContent = res.ok ? `更新しました（期限 ${res.expiry || '未設定'}）` : (res.error === 'rms_auth_failed' ? `楽天への接続に失敗しました（HTTP ${res.http_code} ${res.rms_message || ''}）。保存していません。` : '失敗: ' + res.error);
    if (res.ok) { document.getElementById('cred-secret').value = ''; document.getElementById('cred-license').value = ''; }
  } catch (e) { box.textContent = '通信エラー: ' + e.message; }
});

document.getElementById('smtp-update-btn').addEventListener('click', async () => {
  const box = document.getElementById('cred-result'); box.hidden = false; box.textContent = '更新中...';
  try {
    const res = await callApi('update_smtp', { smtp_user: document.getElementById('smtp-user').value.trim(), smtp_pass: document.getElementById('smtp-pass').value });
    box.textContent = res.ok ? `更新しました（ID ${res.smtp_user_masked}）` : '失敗: ' + res.error;
    if (res.ok) document.getElementById('smtp-pass').value = '';
  } catch (e) { box.textContent = '通信エラー: ' + e.message; }
});
