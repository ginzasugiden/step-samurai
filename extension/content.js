/* RMS レビューチェックツールのページ上で動く薄い層。同一オリジンの fetch で CSV を取得し、5項目だけを service worker に渡す。
 * ID・パスワード・Cookie は読まない・送らない・保存しない。 */
(function () {
  'use strict';
  if (window.__ssxLoaded) return;
  window.__ssxLoaded = true;

  var SSX = globalThis.SSX;
  var busy = false;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function collect(fromMs, toMs) {
    if (busy) return;
    busy = true;
    try {
      var r = await SSX.fetcher.collectReviews({ fromMs: fromMs, toMs: toMs }, {
        fetchFn: function (url, opts) { return fetch(url, opts); },
        decode: SSX.csv.decodeShiftJis,
        sleep: sleep,
      });
      await chrome.runtime.sendMessage({ type: 'collected', reviews: r.reviews, skippedNoOrder: r.skippedNoOrder });
    } catch (e) {
      var code = e && typeof e.code === 'string' ? e.code : 'fetch_failed';
      try { await chrome.runtime.sendMessage({ type: 'collect_failed', error: code }); } catch (e2) { /* service worker 側は同期中フラグのタイムアウトで復帰する */ }
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;
    if (msg && msg.type === 'collect' && isFinite(msg.from) && isFinite(msg.to)) {
      collect(Number(msg.from), Number(msg.to));
      sendResponse({ started: true });
    }
  });

  // ページ読み込み時に自動同期の可否を問い合わせる（1日1回までは service worker が判定）
  chrome.runtime.sendMessage({ type: 'auto_check' }).then(function (r) {
    if (r && r.run && isFinite(r.from) && isFinite(r.to)) collect(Number(r.from), Number(r.to));
  }).catch(function () { /* service worker 起動失敗時は何もしない */ });
})();
