/* 設定値（URL・上限・定数）。仕様変更はここ1か所で吸収する。リモートコードは読み込まない。 */
(function (root, name, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var req = function (n) { return isNode ? require('./' + n) : root.SSX[n]; };
  var api = factory(req);
  if (isNode) module.exports = api; else { root.SSX = root.SSX || {}; root.SSX[name] = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, 'config', function () {
  var RMS_HOST = 'review.rms.rakuten.co.jp';
  var RMS_ORIGIN = 'https://' + RMS_HOST;
  var RMS_CSV_PATH = '/search/csv/';

  /** RMS レビューチェックツール CSV の URL を組み立てる（数値はゼロ埋めなし）。from / to = {y,m,d,h,i} */
  function buildCsvUrl(from, to) {
    var q = [
      ['sy', from.y], ['sm', from.m], ['sd', from.d], ['sh', from.h], ['si', from.i],
      ['ey', to.y], ['em', to.m], ['ed', to.d], ['eh', to.h], ['ei', to.i],
      ['ev', 0], ['tc', 0], ['kw', ''], ['ao', 'A'], ['st', 1],
    ];
    return RMS_ORIGIN + RMS_CSV_PATH + '?' + q.map(function (p) { return p[0] + '=' + p[1]; }).join('&');
  }

  function makeError(code) { var e = new Error(code); e.code = code; return e; }

  return {
    GAS_URL: 'https://script.google.com/macros/s/AKfycbwYsGkYmSfstE4Ay_mrvlZa1qHv5ImZe1EUtC8oXGpFRwZ67vJSC8vL4BQySoomPqI_7w/exec',
    PRIVACY_URL: 'https://step-samurai.ginzasugiden.com/privacy.html',   // CNAME のドメイン + /privacy.html
    RMS_HOST: RMS_HOST,
    RMS_ORIGIN: RMS_ORIGIN,
    RMS_MATCH: RMS_ORIGIN + '/*',
    buildCsvUrl: buildCsvUrl,
    makeError: makeError,
    CSV_CAP: 3000,              // 1回の取得上限（これと同数なら期間を分割）
    CHUNK_SIZE: 500,            // GAS への1回の送信上限
    RETRY_DELAYS_MS: [1000, 3000, 9000],
    OVERLAP_MS: 2 * 24 * 3600 * 1000,   // 前回同期の2日前から
    STALE_MS: 3 * 24 * 3600 * 1000,     // 3日超でバッジ「!」
    SYNC_TIMEOUT_MS: 10 * 60 * 1000,    // 同期中フラグの有効時間
    FALLBACK_INITIAL_DAYS: 30,
    COLUMNS: {                          // ヘッダ名で列を特定する
      review_type: 'レビュータイプ',
      review_id: 'レビュー詳細URL',
      rating: '評価',
      posted_at: '投稿時間',
      order_number: '注文番号',
    },
  };
});
