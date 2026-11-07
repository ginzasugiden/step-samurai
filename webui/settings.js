// step-samurai メール設定（店舗向け）— バニラJS。
// API の URL・トークンはモジュールスコープの変数にのみ保持し、ブラウザには保存しない（app.js / analytics.js と同方針）。
// 画面に出す文字列はすべて textContent で入れる（HTML 文字列を組み立てない）。
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { apiUrl: '', token: '', data: null };

  var ERR = {
    bad_follow_delay: '送るまでの日数は1〜30の整数で入力してください。',
    follow_text_required: 'フォローメールの件名と本文を入力してください。',
    follow_subject_too_long: 'フォローメールの件名は120字以内にしてください。',
    follow_body_too_long: 'フォローメールの本文は5000字以内にしてください。',
    bad_tier_count: '段階の数が正しくありません。', bad_boundary: '段階の区切りが正しくありません（★1〜5が重複・抜けなく、どれか1つの段階に入る必要があります）。',
    bad_coupon_url: 'クーポンURLは https:// で始まる *.rakuten.co.jp のURLだけ登録できます。',
    terms_required: 'クーポンURLを保存するには、利用規約（v1.3）への同意が必要です。',
    confirm_required: '確認が必要です。', busy: '他の処理が実行中です。少し待ってからもう一度お試しください。',
    internal_error: '保存に失敗しました。時間をおいてもう一度お試しください。', unauthorized: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    tenant_not_sendable: '現在の店舗の状態ではテスト送信できません。', send_failed: 'テスト送信に失敗しました。', template_missing: 'フォローメールの文面が未登録です。',
  };
  function errText(r) {
    var e = r && r.error ? String(r.error) : 'internal_error';
    var m = /^tier(\d)_(text_required|subject_too_long|body_too_long)$/.exec(e);
    if (m) return '段階' + m[1] + 'の' + ({ text_required: '件名と本文を入力してください。', subject_too_long: '件名は120字以内にしてください。', body_too_long: '本文は5000字以内にしてください。' })[m[2]];
    return ERR[e] || ('エラー: ' + e);
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function setMsg(id, text, ok) { var m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); }

  async function callApi(action, payload) {
    var res = await fetch(state.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: state.token, action: action, payload: payload || {} }) });
    if (!res.ok) throw new Error('HTTPエラー: ' + res.status);
    return res.json();
  }

  // ===== ログイン（analytics.js と同じ方式） =====
  function resolveApiUrl() {
    var typed = ($('api-url').value || '').trim(); if (typed) return typed;
    var conf = String(window.STEP_SAMURAI_API || ''); return conf.indexOf('https://') === 0 ? conf : '';
  }
  function showLoginError(msg) { $('login-error').textContent = msg; $('login-error').hidden = false; }
  async function loginCommon(getToken) {
    var lb = $('login-btn'); lb.disabled = true; $('login-error').hidden = true;
    try {
      var apiUrl = resolveApiUrl(); if (!apiUrl) { showLoginError('API のURLが設定されていません（詳細設定で入力してください）。'); return; }
      state.apiUrl = apiUrl;
      var token = await getToken(apiUrl); if (!token) return;
      state.token = token;
      var res = await callApi('get_store_settings', {});
      if (!res.ok) { showLoginError('ログインに失敗しました: ' + (res.error || '不明なエラー')); state.token = ''; return; }
      state.data = res;
      $('login-screen').hidden = true; $('app-screen').hidden = false;
      renderAll();
      window.ssStoreInit(callApi, { onTerms: function (agreed) { if (agreed) refresh(); } });
      loadSync();
      if (location.hash === '#sync') selectTab('sync');
    } catch (e) {
      showLoginError('通信エラー: ' + e.message + '（APIのURLが正しいか確認してください）'); state.token = '';
    } finally { lb.disabled = false; }
  }
  $('login-btn').addEventListener('click', function () {
    loginCommon(async function (apiUrl) {
      var tenantId = $('tenant-id').value.trim().toLowerCase(), password = $('password').value;
      if (!tenantId || !password) { showLoginError('店舗IDとパスワードを入力してください。'); return null; }
      var res = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'login', payload: { tenant_id: tenantId, password: password } }) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var r = await res.json();
      if (!r.ok) { showLoginError('店舗IDまたはパスワードが違います。'); return null; }
      $('password').value = ''; return r.token;
    });
  });
  $('token-login-btn').addEventListener('click', function () {
    loginCommon(async function () { var t = $('api-token').value.trim(); if (!t) { showLoginError('トークンを入力してください。'); return null; } return t; });
  });
  $('logout-btn').addEventListener('click', function () {
    state.apiUrl = ''; state.token = ''; state.data = null; $('api-url').value = ''; $('api-token').value = ''; $('password').value = '';
    var b = document.getElementById('ss-sync-banner'); if (b) b.remove();
    $('app-screen').hidden = true; $('login-screen').hidden = false;
  });

  function selectTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
  }
  document.querySelectorAll('.tab-btn').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });

  async function refresh() { var r = await callApi('get_store_settings', {}); if (r.ok) { state.data = r; renderAll(); } }

  // ===== 変数一覧 =====
  function renderVars() {
    document.querySelectorAll('.vars-list').forEach(function (box) {
      box.textContent = '';
      (state.data.variables || []).forEach(function (v) { box.appendChild(el('code', null, '{{' + v + '}}')); });
    });
  }

  // ===== フォローメール =====
  function renderFollow() {
    var f = state.data.follow || {};
    $('f-delay').value = f.delay_days || '';
    $('f-subject').value = f.subject || ''; $('f-body').value = f.body || '';
  }
  function followPayload() {
    var d = Number($('f-delay').value);
    return { delay_days: d, subject: $('f-subject').value, body: $('f-body').value };
  }
  async function previewMail(type, tierNo, draft, boxId, msgId) {
    var r = await callApi('preview_store_mail', { type: type, tier_no: tierNo, draft: draft });
    var box = $(boxId) || boxId;
    if (!r.ok) { setMsg(msgId, errText(r), false); return; }
    box.textContent = '件名: ' + r.subject + '\n\n' + r.body; box.hidden = false; setMsg(msgId, 'サンプルデータで組み立てたプレビューです（未保存の入力内容で表示）。', true);
  }
  async function testMail(type, tierNo, draft, msgId) {
    var r = await callApi('send_store_test_mail', { type: type, tier_no: tierNo, draft: draft });
    if (!r.ok) { setMsg(msgId, errText(r), false); return; }
    setMsg(msgId, r.dry_run ? 'テスト送信の確認のみ行いました（この店舗は送信停止中のため、実際には送っていません）。' : (r.to + ' にテストメールを送りました。'), true);
  }
  $('f-preview').addEventListener('click', function () { var p = followPayload(); previewMail('follow', null, { subject: p.subject, body: p.body }, 'f-pv', 'f-msg').catch(netErr('f-msg')); });
  $('f-test').addEventListener('click', function () { var p = followPayload(); testMail('follow', null, { subject: p.subject, body: p.body }, 'f-msg').catch(netErr('f-msg')); });
  $('f-save').addEventListener('click', async function () {
    try {
      var r = await callApi('save_store_settings', { follow: followPayload() });
      if (!r.ok) { setMsg('f-msg', errText(r), false); return; }
      setMsg('f-msg', '保存しました。' + (r.warnings && r.warnings.length ? ' 注意: ' + r.warnings.join('、') : ''), true); refresh();
    } catch (e) { netErr('f-msg')(e); }
  });
  function netErr(id) { return function (e) { setMsg(id, '通信に失敗しました: ' + e.message, false); }; }

  // ===== レビューお礼 =====
  var review = { count: 2, b1: 3, b2: null, tiers: {} };   // 画面上の編集中の値

  function rangesOf(count, b1, b2) {
    if (count === 1) return [{ tier: 1, from: 5, to: 1 }];
    if (count === 2) return [{ tier: 1, from: 5, to: b1 }, { tier: 2, from: b1 - 1, to: 1 }];
    return [{ tier: 1, from: 5, to: b1 }, { tier: 2, from: b1 - 1, to: b2 }, { tier: 3, from: b2 - 1, to: 1 }];
  }
  function fillSelect(sel, from, to, cur, labelFn) {
    sel.textContent = '';
    for (var v = from; v <= to; v++) { var o = el('option', null, labelFn(v)); o.value = String(v); sel.appendChild(o); }
    if (cur >= from && cur <= to) sel.value = String(cur); else if (to >= from) sel.value = String(to >= 3 && from <= 3 ? 3 : from);
  }
  function syncBoundaryControls() {
    review.count = Number($('r-count').value);
    $('r-b1').parentNode.style.display = review.count >= 2 ? '' : 'none';
    $('r-b2-wrap').style.display = review.count === 3 ? '' : 'none';
    if (review.count === 2) fillSelect($('r-b1'), 2, 5, review.b1 || 3, function (v) { return '★5〜★' + v + (v === 5 ? '（★5だけ）' : ''); });
    if (review.count === 3) {
      fillSelect($('r-b1'), 3, 5, Math.max(3, review.b1 || 4), function (v) { return '★5〜★' + v; });
      var b1 = Number($('r-b1').value);
      fillSelect($('r-b2'), 2, b1 - 1, review.b2 || (b1 - 1), function (v) { return '★' + (b1 - 1) + '〜★' + v; });
    }
    review.b1 = review.count >= 2 ? Number($('r-b1').value) : null;
    review.b2 = review.count === 3 ? Number($('r-b2').value) : null;
  }
  function collectTierInputs() {
    [1, 2, 3].forEach(function (n) {
      var card = document.querySelector('.tier-card[data-tier="' + n + '"]'); if (!card) return;
      review.tiers[n] = { enabled: card.querySelector('.t-enabled').checked, subject: card.querySelector('.t-subject').value, body: card.querySelector('.t-body').value, coupon_url: card.querySelector('.t-coupon').value };
    });
  }
  function renderDiagram() {
    var box = $('r-diagram'); box.textContent = '';
    var rs = rangesOf(review.count, review.b1, review.b2);
    for (var star = 5; star >= 1; star--) {
      var r = rs.filter(function (x) { return star <= x.from && star >= x.to; })[0];
      var t = review.tiers[r.tier] || {};
      var row = el('div', 'dg-row t' + r.tier);
      row.appendChild(el('span', 'dg-star', '★'.repeat(star) + '☆'.repeat(5 - star)));
      row.appendChild(el('span', t.enabled ? '' : 'dg-send-off', '段階' + r.tier + (t.enabled ? '' : '（送らない）')));
      var has = !!(t.coupon_url && t.coupon_url.trim());
      row.appendChild(el('span', 'dg-coupon ' + (has ? 'has' : 'none'), t.enabled ? (has ? 'クーポンあり' : 'クーポンなし') : '—'));
      box.appendChild(row);
    }
  }
  function renderTiers() {
    var host = $('r-tiers'); host.textContent = '';
    var rs = rangesOf(review.count, review.b1, review.b2);
    var couponOk = state.data.terms && state.data.terms.coupon_ok;
    [1, 2, 3].forEach(function (n) {
      var used = n <= review.count; var t = review.tiers[n] || { enabled: false, subject: '', body: '', coupon_url: '' };
      var card = el('div', 'tier-card' + (used ? '' : ' unused')); card.setAttribute('data-tier', String(n));
      var rg = rs.filter(function (x) { return x.tier === n; })[0];
      card.appendChild(el('h3', null, '段階' + n + (rg ? '（★' + rg.from + (rg.from === rg.to ? '' : '〜★' + rg.to) + '）' : '（使用していません。入力内容は保持されます）')));
      var line = el('label', 'enabled-line'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 't-enabled'; cb.checked = !!t.enabled; cb.disabled = !used;
      line.appendChild(cb); line.appendChild(document.createTextNode(' この段階のお礼メールを送る')); card.appendChild(line);
      var l1 = el('label', null, '件名（120字以内）'); card.appendChild(l1);
      var sub = document.createElement('input'); sub.type = 'text'; sub.maxLength = 120; sub.className = 't-subject'; sub.value = t.subject; sub.disabled = !used; card.appendChild(sub);
      card.appendChild(el('label', null, '本文（5000字以内）'));
      var body = document.createElement('textarea'); body.rows = 9; body.maxLength = 5000; body.className = 't-body'; body.value = t.body; body.disabled = !used; card.appendChild(body);
      card.appendChild(el('div', 'coupon-note', '★の数によってクーポンの有無や内容を変えると、楽天市場のレビューガイドラインに抵触するおそれがあります。設定内容は店舗様の責任で管理してください。'));
      card.appendChild(el('label', null, 'クーポンURL（任意。https://…rakuten.co.jp のURLのみ。空欄ならクーポンの行は送りません）'));
      var cu = document.createElement('input'); cu.type = 'url'; cu.maxLength = 500; cu.className = 't-coupon'; cu.value = t.coupon_url; cu.disabled = !used || !couponOk; cu.placeholder = 'https://coupon.rakuten.co.jp/...'; card.appendChild(cu);
      if (used) {
        var row = el('div', 'row');
        var pv = el('button', 'secondary', 'プレビュー'), ts = el('button', 'secondary', 'テスト送信（店舗の登録メール宛て）');
        row.appendChild(pv); row.appendChild(ts); card.appendChild(row);
        var out = el('pre', 'pv'); out.hidden = true; card.appendChild(out);
        var msg = el('p', 'msg'); msg.setAttribute('role', 'status'); card.appendChild(msg);
        var setM = function (m) { return function (text, ok) { m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); }; }(msg);
        var draft = function () { collectTierInputs(); var x = review.tiers[n]; return { subject: x.subject, body: x.body, coupon_url: x.coupon_url }; };
        pv.addEventListener('click', function () {
          callApi('preview_store_mail', { type: 'review', tier_no: n, draft: draft() }).then(function (r) {
            if (!r.ok) { setM(errText(r), false); return; }
            out.textContent = '件名: ' + r.subject + '\n\n' + r.body; out.hidden = false; setM('サンプルデータ（★' + (rg ? rg.from : 5) + '）で組み立てたプレビューです。', true);
          }).catch(function (e) { setM('通信に失敗しました: ' + e.message, false); });
        });
        ts.addEventListener('click', function () {
          callApi('send_store_test_mail', { type: 'review', tier_no: n, draft: draft() }).then(function (r) {
            if (!r.ok) { setM(errText(r), false); return; }
            setM(r.dry_run ? 'テスト送信の確認のみ行いました（この店舗は送信停止中のため、実際には送っていません）。' : (r.to + ' にテストメールを送りました。'), true);
          }).catch(function (e) { setM('通信に失敗しました: ' + e.message, false); });
        });
      }
      card.querySelectorAll('input, textarea').forEach(function (i) { i.addEventListener('input', function () { collectTierInputs(); renderDiagram(); }); });
      host.appendChild(card);
    });
  }
  function renderReview() {
    var rv = state.data.review || {};
    review.count = rv.tier_count || 2; review.b1 = rv.b1 || 3; review.b2 = rv.b2 || null;
    review.tiers = {}; [1, 2, 3].forEach(function (n) { var t = (rv.tiers || {})[n] || {}; review.tiers[n] = { enabled: !!t.enabled, subject: t.subject || '', body: t.body || '', coupon_url: t.coupon_url || '' }; });
    $('r-count').value = String(review.count); syncBoundaryControls();
    $('unconfigured-note').hidden = !!rv.configured;
    $('terms-note').hidden = !!(state.data.terms && state.data.terms.coupon_ok);
    renderTiers(); renderDiagram();
  }
  $('r-count').addEventListener('change', function () { collectTierInputs(); syncBoundaryControls(); renderTiers(); renderDiagram(); });
  $('r-b1').addEventListener('change', function () { collectTierInputs(); review.b1 = Number($('r-b1').value); review.b2 = null; syncBoundaryControls(); renderTiers(); renderDiagram(); });
  $('r-b2').addEventListener('change', function () { collectTierInputs(); review.b2 = Number($('r-b2').value); renderTiers(); renderDiagram(); });
  $('terms-open').addEventListener('click', function () {
    window.ssStoreInit(callApi, { onTerms: function (agreed) { if (agreed) refresh(); } });
    // 既に同意済みのときは何も出ない。出なければ最新の状態を読み直す
    refresh();
  });

  async function saveReview(confirmed) {
    collectTierInputs(); syncBoundaryControls();
    var tiers = {};
    for (var n = 1; n <= review.count; n++) tiers[n] = review.tiers[n];
    var payload = { review: { tier_count: review.count, b1: review.b1, b2: review.b2, tiers: tiers } };
    if (confirmed) payload.confirm_diff_coupon = true;
    var r = await callApi('save_store_settings', payload);
    if (!r.ok && r.error === 'confirm_required') {
      if (window.confirm('段階（★の数）ごとにクーポンの有無や内容が異なる設定になっています。\n\n楽天市場のレビューガイドラインに抵触するおそれがあります。設定内容は店舗様の責任で管理していただくことに同意して、保存しますか？\n\n（同意した日時と同意した店舗が記録されます）')) return saveReview(true);
      setMsg('r-msg', '保存をキャンセルしました。', false); return;
    }
    if (!r.ok) { setMsg('r-msg', errText(r), false); return; }
    setMsg('r-msg', '保存しました。' + (r.warnings && r.warnings.length ? ' 注意（未定義の変数）: ' + r.warnings.join('、') : ''), true);
    refresh();
  }
  $('r-save').addEventListener('click', function () { saveReview(false).catch(netErr('r-msg')); });

  // ===== 取り込み状況 =====
  var CAUSE = { not_logged_in: 'RMS にログインしていません', failed: '取り込みに失敗しています', stale: '長時間、取り込みが行われていません', never: '拡張機能からまだ一度も連絡がありません' };
  async function loadSync() {
    try {
      var s = await callApi('get_sync_status', {});
      var card = $('sync-card'); card.textContent = '';
      if (!s.ok) { card.appendChild(el('p', null, '状態を取得できませんでした。')); return; }
      if (!s.has_ext) { card.className = 'sync-card'; card.appendChild(el('p', null, 'この店舗では、拡張機能によるレビュー自動取り込みは使われていません。')); return; }
      var bad = s.state === 'action';
      card.className = 'sync-card ' + (bad ? 'bad' : 'ok');
      card.appendChild(el('div', 'big', bad ? '要対応：' + (CAUSE[s.cause] || '取り込みが止まっています') : '正常に取り込めています'));
      card.appendChild(el('div', null, '最後に取り込めた日時: ' + (s.last_review_sync_at || 'まだありません') + '（日本時間）'));
      card.appendChild(el('div', null, '拡張機能のバージョン: ' + (s.version || '不明')));
      if (s.age_hours !== null && s.age_hours !== undefined) card.appendChild(el('div', null, '経過時間: 約' + Math.floor(s.age_hours) + '時間'));
      if (s.over_48h) card.appendChild(el('div', 'msg err', '警告：48時間を超えて取り込めていません。下の手順をお試しください。'));
    } catch (e) { /* 状態が出せなくても他は使える */ }
  }

  function renderAll() { renderVars(); renderFollow(); renderReview(); }
  if (location.hash === '#sync') { /* ログイン後に切り替える */ }
})();
