/* RMS レビューチェックツールのページ上で動く薄い層。取り込みが止まっている（未ログイン・失敗・48時間超）ときだけ、
 * ページ最上部に固定の帯を出す。ページの機能・入力欄・Cookie・ID・パスワードには一切触れない（読まない・送らない・保存しない）。
 * 帯は閉じられるが、次にページを開いたときはまた出る。 */
(function () {
  'use strict';
  if (window.__ssxLoaded) return;
  window.__ssxLoaded = true;
  if (window.top !== window) return;   // iframe には出さない

  function show() {
    if (document.getElementById('ssx-banner-host')) return;
    var host = document.createElement('div');
    host.id = 'ssx-banner-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;';
    var root = host.attachShadow({ mode: 'closed' });   // RMS のスタイルと干渉させない
    var bar = document.createElement('div');
    bar.style.cssText = 'pointer-events:auto;display:flex;align-items:center;gap:12px;background:#b91c1c;color:#fff;font:14px/1.5 sans-serif;padding:8px 14px;box-shadow:0 2px 6px rgba(0,0,0,.3);';
    var text = document.createElement('span');
    text.style.cssText = 'flex:1;';
    text.textContent = 'ステップ侍：レビューの自動取り込みが止まっています。ログインすると自動で再開します';
    var close = document.createElement('button');
    close.type = 'button'; close.textContent = '閉じる';
    close.style.cssText = 'background:#fff;color:#b91c1c;border:0;border-radius:4px;padding:3px 10px;cursor:pointer;font:inherit;';
    close.addEventListener('click', function () { host.remove(); });
    bar.appendChild(text); bar.appendChild(close); root.appendChild(bar);
    (document.body || document.documentElement).appendChild(host);
  }

  try {
    chrome.runtime.sendMessage({ type: 'get_banner' }).then(function (r) { if (r && r.show) show(); }).catch(function () { /* 何もしない */ });
  } catch (e) { /* 何もしない */ }
})();
