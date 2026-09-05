// step-samurai 店舗分析 — バニラJS + Chart.js（CDN）
// APIのURL・トークンはモジュールスコープの変数にのみ保持し、ブラウザには保存しない（app.js と同方針）。

const state = { apiUrl: '', token: '', from: '', to: '', data: null, charts: {} };

async function callApi(action, payload) {
  const res = await fetch(state.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: state.token, action, payload: payload || {} }),
  });
  if (!res.ok) throw new Error(`HTTPエラー: ${res.status}`);
  return res.json();
}

// ===== 日付ユーティリティ（JST） =====
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function presetRange(name) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (name) {
    case 'this_month': return [ymd(new Date(y, m, 1)), ymd(now)];
    case 'last_month': return [ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))];
    case 'last_30':    { const d = new Date(now); d.setDate(d.getDate() - 29); return [ymd(d), ymd(now)]; }
    case 'last_13m':   return [ymd(new Date(y, m - 12, 1)), ymd(now)];
    default:           return [`${y}-01-01`, ymd(now)];
  }
}

// ===== ログイン =====
const loginScreen = document.getElementById('login-screen');
const appScreen   = document.getElementById('app-screen');
const loginError  = document.getElementById('login-error');

document.getElementById('login-btn').addEventListener('click', async () => {
  const apiUrl = document.getElementById('api-url').value.trim();
  const token  = document.getElementById('api-token').value.trim();
  loginError.hidden = true;
  if (!apiUrl || !token) { showLoginError('APIのURLとトークンの両方を入力してください。'); return; }
  state.apiUrl = apiUrl; state.token = token;
  [state.from, state.to] = presetRange('this_year');
  document.getElementById('date-from').value = state.from;
  document.getElementById('date-to').value   = state.to;
  try {
    const ok = await load();
    if (!ok) return;
    loginScreen.hidden = true; appScreen.hidden = false;
  } catch (e) {
    showLoginError('通信エラー: ' + e.message + '（APIのURLが正しいか確認してください）');
    state.token = '';
  }
});

function showLoginError(msg) { loginError.textContent = msg; loginError.hidden = false; }

document.getElementById('logout-btn').addEventListener('click', () => {
  state.apiUrl = ''; state.token = ''; state.data = null;
  document.getElementById('api-url').value = '';
  document.getElementById('api-token').value = '';
  appScreen.hidden = true; loginScreen.hidden = false;
});

// ===== 期間 =====
document.querySelectorAll('.preset-btn').forEach(btn => btn.addEventListener('click', async () => {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  [state.from, state.to] = presetRange(btn.dataset.preset);
  document.getElementById('date-from').value = state.from;
  document.getElementById('date-to').value   = state.to;
  await load();
}));

document.getElementById('apply-btn').addEventListener('click', async () => {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  state.from = document.getElementById('date-from').value;
  state.to   = document.getElementById('date-to').value;
  await load();
});

// ===== 読み込み =====
async function load() {
  const status = document.getElementById('status-line');
  status.textContent = '集計中...';
  let res;
  try {
    res = await callApi('get_analytics', { from: state.from, to: state.to });
  } catch (e) {
    status.textContent = '通信エラー: ' + e.message;
    if (loginScreen.hidden === false) showLoginError('通信エラー: ' + e.message);
    return false;
  }
  if (!res.ok) {
    const msg = { unauthorized: 'ログインに失敗しました（トークンが違います）', invalid_period: '期間が不正です', period_too_long: '期間が長すぎます（最大400日）' }[res.error] || ('エラー: ' + res.error);
    status.textContent = msg;
    if (loginScreen.hidden === false) showLoginError(msg);
    return false;
  }
  state.data = res;
  status.textContent = `${res.period.from} 〜 ${res.period.to}（集計時刻 ${res.generated_at}）`;
  render(res);
  return true;
}

// ===== 描画 =====
const yen = n => '¥' + Math.round(Number(n) || 0).toLocaleString('ja-JP');
const num = n => (Number(n) || 0).toLocaleString('ja-JP');

function render(d) {
  const s = d.summary;
  const warn = document.getElementById('warnings');
  warn.hidden = !(d.warnings && d.warnings.length);
  warn.innerHTML = '';
  (d.warnings || []).forEach(w => { const p = document.createElement('div'); p.textContent = '⚠ ' + w; warn.appendChild(p); });

  const kpis = [
    ['受注件数', num(s.orders), `キャンセル除外 ${num(s.cancelled_excluded)}件`],
    ['売上（商品代金・RMS準拠）', yen(s.goods_sales), `店舗負担クーポン控除後 ${yen(s.goods_sales_net)}`],
    ['請求総額（送料・ラッピング込）', yen(s.sales), `客単価 ${yen(s.avg_order)}`],
    ['新規 / リピート', `${num(s.new)} / ${num(s.repeat)}`, `リピート率 ${s.repeat_rate}%　不明 ${num(s.unknown)}`],
    ['フォローメール送信率', `${s.follow_rate}%`, `${num(s.follow_sent)} / 発送済 ${num(s.shipped)}`],
    ['レビュー率', `${s.review_rate}%`, `${num(s.reviewed_orders)}件　平均 ★${s.avg_rating}`],
    ['クーポン利用率', `${s.coupon_use_rate}%`, `発行 ${num(s.coupons_issued)}　利用 ${num(s.coupons_used)}`],
  ];
  const grid = document.getElementById('kpi-grid');
  grid.innerHTML = '';
  kpis.forEach(([label, value, sub]) => {
    const card = document.createElement('div'); card.className = 'kpi-card';
    const l = document.createElement('div'); l.className = 'kpi-label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'kpi-value'; v.textContent = value;
    const t = document.createElement('div'); t.className = 'kpi-sub'; t.textContent = sub;
    card.append(l, v, t); grid.appendChild(card);
  });

  const hours = Array.from({ length: 24 }, (_, i) => `${i}時`);
  chart('c-daily', {
    type: 'bar',
    data: { labels: d.daily.map(x => x.date.slice(5)), datasets: [
      { label: '受注件数', data: d.daily.map(x => x.orders), yAxisID: 'y', backgroundColor: '#2f6fed' },
      { label: '売上（商品代金）', data: d.daily.map(x => x.goods_sales), yAxisID: 'y1', type: 'line', borderColor: '#e67e22', tension: 0.2, pointRadius: 2 },
    ] },
    options: { scales: { y: { beginAtZero: true, position: 'left' }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } },
  });
  chart('c-hourly', { type: 'bar', data: { labels: hours, datasets: [{ label: '受注件数', data: d.hourly_orders, backgroundColor: '#2f6fed' }] }, options: { plugins: { legend: { display: false } } } });
  chart('c-weekday', { type: 'bar', data: { labels: ['日', '月', '火', '水', '木', '金', '土'], datasets: [{ label: '受注件数', data: d.weekday_orders, backgroundColor: '#2f6fed' }] }, options: { plugins: { legend: { display: false } } } });
  chart('c-customer', { type: 'doughnut', data: { labels: ['新規', 'リピート', '不明'], datasets: [{ data: [s.new, s.repeat, s.unknown], backgroundColor: ['#2f6fed', '#27ae60', '#bdc3c7'] }] } });
  chart('c-stars', { type: 'bar', data: { labels: ['★1', '★2', '★3', '★4', '★5'], datasets: [{ label: '件数', data: d.star_dist, backgroundColor: ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2f6fed'] }] }, options: { plugins: { legend: { display: false } } } });
  chart('c-lead', { type: 'bar', data: { labels: d.review_lead.map(b => b.label), datasets: [{ label: '件数', data: d.review_lead.map(b => b.count), backgroundColor: '#27ae60' }] }, options: { plugins: { legend: { display: false } } } });

  const hrNote = document.getElementById('hourly-reviews-note');
  const hrCanvas = document.getElementById('c-hourly-reviews');
  if (d.hourly_reviews) {
    hrCanvas.hidden = false; hrNote.hidden = true;
    chart('c-hourly-reviews', { type: 'bar', data: { labels: hours, datasets: [{ label: 'レビュー件数', data: d.hourly_reviews, backgroundColor: '#27ae60' }] }, options: { plugins: { legend: { display: false } } } });
  } else {
    hrCanvas.hidden = true; hrNote.hidden = false;
    hrNote.textContent = `レビュー投稿日時に時刻が含まれている割合が ${d.review_time_rate}% のため、時間帯別レビューは表示していません（日単位の「投稿までの日数」を参照してください）。`;
  }

  chart('c-monthly', {
    type: 'bar',
    data: { labels: d.monthly.map(m => m.ym), datasets: [
      { label: '新規', data: d.monthly.map(m => m.new), stack: 'o', backgroundColor: '#2f6fed' },
      { label: 'リピート', data: d.monthly.map(m => m.repeat), stack: 'o', backgroundColor: '#27ae60' },
      { label: '不明', data: d.monthly.map(m => m.unknown), stack: 'o', backgroundColor: '#bdc3c7' },
      { label: 'レビュー', data: d.monthly.map(m => m.reviews), type: 'line', borderColor: '#e67e22', tension: 0.2 },
    ] },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
  });

  fillTable('t-items', d.top_items.map(i => [i.name, num(i.orders), yen(i.sales)]));
  fillTable('t-prefs', d.top_prefectures.map(p => [p.name, num(p.orders)]));
  fillTable('t-monthly', d.monthly.map(m => [m.ym, num(m.orders), yen(m.goods_sales), yen(m.sales), num(m.new), num(m.repeat), num(m.unknown), num(m.reviews), num(m.follow_sent)]));
}

function chart(id, config) {
  if (state.charts[id]) { state.charts[id].destroy(); }
  const ctx = document.getElementById(id).getContext('2d');
  config.options = Object.assign({ responsive: true, maintainAspectRatio: false }, config.options || {});
  state.charts[id] = new Chart(ctx, config);
}

function fillTable(id, rows) {
  const tbody = document.querySelector(`#${id} tbody`);
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    r.forEach(c => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
}

// ===== CSV（BOM付きUTF-8） =====
document.getElementById('csv-btn').addEventListener('click', () => {
  const d = state.data; if (!d) return;
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [];
  lines.push(['期間', d.period.from, d.period.to].map(esc).join(','));
  lines.push('');
  lines.push(['サマリー', '値'].map(esc).join(','));
  Object.entries(d.summary).forEach(([k, v]) => lines.push([k, v].map(esc).join(',')));
  lines.push('');
  lines.push(['日付', '受注', '売上(商品代金)', '請求総額', '新規', 'リピート', '不明'].map(esc).join(','));
  d.daily.forEach(x => lines.push([x.date, x.orders, x.goods_sales, x.sales, x.new, x.repeat, x.unknown].map(esc).join(',')));
  lines.push('');
  lines.push(['時間帯', '受注件数', '売上'].map(esc).join(','));
  d.hourly_orders.forEach((v, i) => lines.push([i, v, d.hourly_sales[i]].map(esc).join(',')));
  lines.push('');
  lines.push(['月', '受注', '売上(商品代金)', '請求総額', '新規', 'リピート', '不明', 'レビュー', 'フォロー送信'].map(esc).join(','));
  d.monthly.forEach(m => lines.push([m.ym, m.orders, m.goods_sales, m.sales, m.new, m.repeat, m.unknown, m.reviews, m.follow_sent].map(esc).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `analytics_${d.period.from}_${d.period.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
