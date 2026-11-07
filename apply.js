// モニター応募ページ。送信は webui/onboard.js と同じ方式（text/plain の JSON）で既存 WebApp（webui/config.js の STEP_SAMURAI_API）へ。
// サーバー側（gas/src/apply.gs）が最終的な検証を行う。ここは入力の案内用。
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('apply-form'), btn = $('submit-btn'), alertBox = $('form-alert');
  var token = '';

  var LIMITS = { shop_name: 100, shop_code: 300, contact_name: 50, email: 254, expectation: 1000 };
  var LABEL = { shop_name: '店舗名', shop_url: '店舗URL（店舗コード）', contact_name: 'ご担当者名', email: 'メールアドレス', monthly_orders: '月の注文数の目安', follow_mail: '現在のフォローメール', rms_api: 'RMS WEB SERVICE（API）の利用状況', browser: '管理作業に使うブラウザ', expectation: '期待していること・困っていること', case_publish: '導入事例としての店舗名の掲載', consent: '同意' };

  // 締切（JST の日付で判定。data-deadline の日の 23:59 まで受付）
  function jstToday() { var d = new Date(Date.now() + 9 * 3600e3); return d.toISOString().slice(0, 10); }
  if (jstToday() > form.getAttribute('data-deadline')) { form.hidden = true; $('closed').hidden = false; return; }

  window.onTurnstileOk = function (t) { token = t; btn.disabled = false; };
  window.onTurnstileGone = function () { token = ''; btn.disabled = true; };

  // 店舗コードの取り出し（URL を丸ごと貼った場合も可）。サーバー（apply.gs）と同じ規則
  function extractCode(v) {
    var s = String(v || '').replace(/[\r\n\t]+/g, ' ').trim().toLowerCase();
    var m = /^https:\/\/(?:www|item)\.rakuten\.co\.jp\/([^\/?#\s]+)/.exec(s);
    if (m) return m[1];
    return s.replace(/\/+$/, '').trim();
  }
  var CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  var codeEl = $('shop_code');
  function showConfirm() {
    var c = extractCode(codeEl.value), box = $('code-confirm-body');
    if (!CODE_RE.test(c)) { box.textContent = '（店舗コードを入力すると表示されます）'; return; }
    var url = 'https://www.rakuten.co.jp/' + c + '/';
    box.textContent = '';
    var a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url;
    box.appendChild(a);
  }
  codeEl.addEventListener('input', showConfirm);
  codeEl.addEventListener('blur', function () { codeEl.value = extractCode(codeEl.value); showConfirm(); });

  function val(name) { var el = form.elements[name]; if (!el) return ''; if (el.type === 'checkbox') return el.checked; if (el.length !== undefined && !el.tagName) { for (var i = 0; i < el.length; i++) if (el[i].checked) return el[i].value; return ''; } return el.value.trim(); }
  function clearErrors() { alertBox.style.display = 'none'; form.querySelectorAll('.fld.err').forEach(function (f) { f.classList.remove('err'); }); }
  function mark(name, text) {
    var f = form.querySelector('.fld[data-f="' + name + '"]'); if (!f) return;
    f.classList.add('err'); f.querySelector('.msg').textContent = text;
  }
  function showAlert(t) { alertBox.textContent = t; alertBox.style.display = 'block'; alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

  function check() {
    var bad = [];
    ['shop_name', 'contact_name'].forEach(function (k) { var v = val(k); if (!v) bad.push([k, LABEL[k] + 'を入力してください。']); else if (v.length > LIMITS[k]) bad.push([k, LABEL[k] + 'は' + LIMITS[k] + '字以内で入力してください。']); });
    if (!CODE_RE.test(extractCode(codeEl.value))) bad.push(['shop_url', '店舗コードを入力してください（英小文字・数字・ - ・ _ のみ、64字以内。例: tokyoflower）。']);
    var e = val('email');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > LIMITS.email) bad.push(['email', 'メールアドレスの形式が正しくありません。']);
    ['monthly_orders', 'follow_mail', 'rms_api'].forEach(function (k) { if (!val(k)) bad.push([k, LABEL[k] + 'を選択してください。']); });
    if (val('expectation').length > LIMITS.expectation) bad.push(['expectation', '1000字以内で入力してください。']);
    if (!val('consent')) bad.push(['consent', '同意にチェックしてください。']);
    return bad;
  }

  var SERVER_MSG = {
    closed: '募集は終了しました。',
    not_ready: '現在、応募の受付準備中です。しばらくしてからもう一度お試しください。',
    verify_failed: '確認（ロボット判定）に失敗しました。もう一度お試しください。',
    rate_limited: '短時間に応募が集中しています。しばらくしてからもう一度お試しください（同じメールアドレスからは10分に1回まで）。',
    internal_error: '送信に失敗しました。しばらくしてからもう一度お試しください。'
  };

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    clearErrors();
    codeEl.value = extractCode(codeEl.value);
    var bad = check();
    if (bad.length) { bad.forEach(function (b) { mark(b[0], b[1]); }); showAlert('入力内容をご確認ください（' + bad.map(function (b) { return LABEL[b[0]]; }).join('、') + '）。'); return; }
    if (!token) { showAlert('確認（ロボット判定）が完了していません。'); return; }
    btn.disabled = true; btn.textContent = '送信中...';
    var payload = {
      shop_name: val('shop_name'), shop_code: extractCode(codeEl.value), contact_name: val('contact_name'), email: val('email'),
      monthly_orders: val('monthly_orders'), follow_mail: val('follow_mail'), rms_api: val('rms_api'), browser: val('browser'),
      expectation: val('expectation'), case_publish: val('case_publish'), consent: !!val('consent'),
      website: $('website').value, turnstile_token: token
    };
    fetch(window.STEP_SAMURAI_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'monitor_apply', payload: payload }) })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (r) {
        if (r && r.ok) { form.hidden = true; $('thanks').hidden = false; $('thanks').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        var err = (r && r.error) || 'internal_error';
        if (err === 'invalid' && r.fields) { r.fields.forEach(function (f) { mark(f, LABEL[f] ? LABEL[f] + 'の入力内容をご確認ください。' : '入力内容をご確認ください。'); }); showAlert('入力内容をご確認ください（' + r.fields.map(function (f) { return LABEL[f] || f; }).join('、') + '）。'); }
        else showAlert(SERVER_MSG[err] || SERVER_MSG.internal_error);
        if (err === 'closed') { form.hidden = true; $('closed').hidden = false; }
        resetTurnstile();
      })
      .catch(function () { showAlert('通信に失敗しました。しばらくしてからもう一度お試しください。'); resetTurnstile(); });
  });

  function resetTurnstile() {
    token = ''; btn.disabled = true; btn.textContent = '応募する';
    try { if (window.turnstile) window.turnstile.reset(); } catch (e) { /* 無視 */ }
  }
})();
