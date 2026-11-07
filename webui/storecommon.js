// 店舗向け画面の共通処理（ログイン直後に ssStoreInit(callApi) を呼ぶ）
//  1. 拡張の取り込みが止まっているときの赤い帯（最終成功が6時間超／未ログイン／失敗／未インストール）
//  2. 利用規約 v1.3 への同意確認（未同意の店舗に次のログインで表示。同意するまでは段階別クーポンを保存できないだけで、メール送信は止めない）
// DOM は textContent / createElement だけで作る（HTML 文字列を組み立てない）。
(function () {
  var TERMS_VERSION = '1.3';
  var CAUSE_TEXT = {
    not_logged_in: 'RMS にログインしていないため、レビューの自動取り込みが止まっています。',
    failed: 'レビューの自動取り込みに失敗しています。',
    stale: 'レビューの自動取り込みが長時間行われていません。',
    never: '拡張機能からまだ一度も連絡がありません（インストールが完了していない可能性があります）。',
  };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function showSyncBanner(s) {
    var old = document.getElementById('ss-sync-banner'); if (old) old.remove();
    if (!s || !s.ok || !s.has_ext || !s.banner) return;
    var bar = el('div', 'ss-sync-banner'); bar.id = 'ss-sync-banner'; bar.setAttribute('role', 'alert');
    var msg = CAUSE_TEXT[s.cause] || 'レビューの自動取り込みから、しばらく連絡がありません。';
    var last = s.last_review_sync_at ? ('最後に成功した日時: ' + s.last_review_sync_at + '（日本時間）') : '最後に成功した日時: まだありません';
    bar.appendChild(el('strong', null, msg));
    bar.appendChild(document.createTextNode(' ' + last + ' '));
    var a = el('a', null, '対処方法を見る'); a.href = 'settings.html#sync'; a.setAttribute('data-ss-link', 'sync');
    bar.appendChild(a);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function termsModal(callApi, onDone) {
    var wrap = el('div', 'ss-modal'); wrap.id = 'ss-terms-modal'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    var box = el('div', 'ss-modal-box');
    box.appendChild(el('h2', null, '利用規約が改定されました（v' + TERMS_VERSION + '）'));
    box.appendChild(el('p', null, 'レビュー評価（★の数）に応じたメール文面・クーポン等の設定内容と、それが楽天市場の規約・ガイドラインに適合することについては、利用店舗が責任を負います。当社は設定内容の適否を保証しません（第5条）。'));
    var p = el('p'); var a = el('a', null, '利用規約（v' + TERMS_VERSION + '）を読む'); a.href = '../terms.html'; a.target = '_blank'; a.rel = 'noopener'; p.appendChild(a); box.appendChild(p);
    var lab = el('label', 'hint'); var cb = document.createElement('input'); cb.type = 'checkbox'; lab.appendChild(cb); lab.appendChild(document.createTextNode(' 利用規約（v' + TERMS_VERSION + '）に同意します'));
    box.appendChild(lab);
    var row = el('div', 'row');
    var ok = el('button', null, '同意する'); ok.disabled = true;
    var later = el('button', 'secondary', 'あとで');
    var err = el('p', 'error'); err.hidden = true;
    cb.addEventListener('change', function () { ok.disabled = !cb.checked; });
    later.addEventListener('click', function () { wrap.remove(); onDone(false); });
    ok.addEventListener('click', function () {
      ok.disabled = true;
      callApi('agree_terms', { agree: true }).then(function (r) {
        if (r && r.ok) { wrap.remove(); onDone(true); } else { err.textContent = '同意の記録に失敗しました。もう一度お試しください。'; err.hidden = false; ok.disabled = false; }
      }).catch(function () { err.textContent = '通信に失敗しました。'; err.hidden = false; ok.disabled = false; });
    });
    row.appendChild(ok); row.appendChild(later); box.appendChild(row); box.appendChild(err);
    wrap.appendChild(box); document.body.appendChild(wrap);
  }

  /** callApi(action, payload) → Promise<object>。ログイン成功後に呼ぶ。失敗しても画面の他の機能には影響させない */
  window.ssStoreInit = function (callApi, opts) {
    opts = opts || {};
    var tasks = [];
    tasks.push(callApi('get_sync_status', {}).then(showSyncBanner).catch(function () { /* 帯が出せなくても他に影響させない */ }));
    if (!opts.skipTerms) {
      tasks.push(callApi('get_store_settings', {}).then(function (r) {
        if (r && r.ok && r.terms && !r.terms.coupon_ok) termsModal(callApi, function (agreed) { if (opts.onTerms) opts.onTerms(agreed); });
      }).catch(function () { }));
    }
    return Promise.all(tasks);
  };
  window.ssShowSyncBanner = showSyncBanner;
})();
