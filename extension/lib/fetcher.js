/* RMS からの CSV 取得（期間の再帰分割・重複排除・ログイン/形式判定）。fetch・デコーダ・待機は注入する。 */
(function (root, name, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var req = function (n) { return isNode ? require('./' + n) : root.SSX[n]; };
  var api = factory(req);
  if (isNode) module.exports = api; else { root.SSX = root.SSX || {}; root.SSX[name] = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, 'fetcher', function (req) {
  var config = req('config'), time = req('time'), csv = req('csv');

  function looksLikeHtml(text) {
    var head = text.slice(0, 1024).replace(/^﻿/, '').trim().toLowerCase();
    return head.charAt(0) === '<' || head.indexOf('<html') >= 0 || head.indexOf('<!doctype') >= 0;
  }
  function hasPasswordInput(text) { return /<input[^>]*type\s*=\s*["']?password/i.test(text); }

  /** 最終 URL がレビューのホスト配下か（ログイン画面へ飛ばされていないか） */
  function isRmsReviewUrl(u) {
    try {
      var url = new URL(u);
      return url.protocol === 'https:' && url.hostname === config.RMS_HOST && !/login|logon|signin/i.test(url.pathname);
    } catch (e) { return false; }
  }

  /** 1期間ぶんの取得 → extractReviews の結果。login_required / csv_format / fetch_failed を投げる */
  async function fetchRange(fromMs, toMs, deps) {
    var url = time.csvUrlFor(fromMs, toMs);
    var res;
    try { res = await deps.fetchFn(url, { credentials: 'include' }); }
    catch (e) { throw config.makeError('fetch_failed'); }
    if (!res || (res.url && !isRmsReviewUrl(res.url))) throw config.makeError('login_required');
    if (res.status === 401 || res.status === 403) throw config.makeError('login_required');
    if (!res.ok) throw config.makeError('fetch_failed');
    var text;
    try { text = deps.decode(await res.arrayBuffer()); }
    catch (e) { throw config.makeError('fetch_failed'); }
    if (looksLikeHtml(text)) throw config.makeError(hasPasswordInput(text) ? 'login_required' : 'csv_format');
    return csv.extractReviews(text);
  }

  /**
   * 期間を取得する。結果がちょうど CSV_CAP 件なら時刻の中点で二分割して再帰（review_id で重複排除）。
   * 1分以下の幅でも CSV_CAP 件なら cap_unsplittable。
   * deps: { fetchFn, decode, sleep? }。戻り値: { reviews, skippedNoOrder, skippedNoId, requests }
   */
  async function collectReviews(period, deps) {
    var byId = new Map(), st = { skippedNoOrder: 0, skippedNoId: 0, requests: 0 };
    async function walk(fromMs, toMs) {
      if (st.requests > 0 && deps.sleep) await deps.sleep(300);
      st.requests++;
      var r = await fetchRange(fromMs, toMs, deps);
      if (r.total >= config.CSV_CAP) {
        var mid = time.floorMinute(fromMs + Math.floor((toMs - fromMs) / 2));
        if (toMs - fromMs <= time.MIN || mid <= fromMs || mid >= toMs) throw config.makeError('cap_unsplittable');
        await walk(fromMs, mid);
        await walk(mid, toMs);
        return;
      }
      st.skippedNoOrder += r.skippedNoOrder; st.skippedNoId += r.skippedNoId;
      r.reviews.forEach(function (x) { byId.set(x.review_id, x); });
    }
    await walk(time.floorMinute(period.fromMs), time.floorMinute(period.toMs));
    return { reviews: Array.from(byId.values()), skippedNoOrder: st.skippedNoOrder, skippedNoId: st.skippedNoId, requests: st.requests };
  }

  return { looksLikeHtml: looksLikeHtml, isRmsReviewUrl: isRmsReviewUrl, fetchRange: fetchRange, collectReviews: collectReviews };
});
