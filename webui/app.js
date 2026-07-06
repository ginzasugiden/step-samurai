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
