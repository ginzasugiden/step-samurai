/* JST 基準の時刻ユーティリティ */
(function (root, name, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var req = function (n) { return isNode ? require('./' + n) : root.SSX[n]; };
  var api = factory(req);
  if (isNode) module.exports = api; else { root.SSX = root.SSX || {}; root.SSX[name] = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, 'time', function (req) {
  var config = req('config');
  var JST = 9 * 3600 * 1000, MIN = 60 * 1000;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  function jstParts(ms) {
    var d = new Date(ms + JST);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), i: d.getUTCMinutes() };
  }
  function jstDay(ms) { var p = jstParts(ms); return p.y + '-' + pad(p.m) + '-' + pad(p.d); }
  function formatJst(ms) { var p = jstParts(ms); return p.y + '/' + p.m + '/' + p.d + ' ' + p.h + ':' + pad(p.i); }
  function floorMinute(ms) { return Math.floor(ms / MIN) * MIN; }
  /** 'yyyy-MM-dd' の JST 00:00 → epoch ms。不正なら NaN */
  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s.trim() : '');
    if (!m) return NaN;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST;
    return jstDay(ms) === m[0] ? ms : NaN;
  }

  /**
   * 取得期間 { fromMs, toMs }。
   * 通常: 前回成功同期の開始時刻の2日前〜現在。初回: initialFrom(yyyy-MM-dd) の 00:00〜現在。
   * initialFrom が不正なら現在の30日前。
   */
  function computePeriod(o) {
    var now = o.now;
    var from;
    if (o.lastSyncAt) from = o.lastSyncAt - config.OVERLAP_MS;
    else {
      from = parseDay(o.initialFrom);
      if (!isFinite(from)) from = now - config.FALLBACK_INITIAL_DAYS * 24 * 3600 * 1000;
    }
    var to = floorMinute(now);
    from = floorMinute(from);
    if (from >= to) from = to - MIN;
    return { fromMs: from, toMs: to };
  }

  function csvUrlFor(fromMs, toMs) { return config.buildCsvUrl(jstParts(fromMs), jstParts(toMs)); }

  return { JST: JST, MIN: MIN, jstParts: jstParts, jstDay: jstDay, formatJst: formatJst, floorMinute: floorMinute, parseDay: parseDay, computePeriod: computePeriod, csvUrlFor: csvUrlFor };
});
