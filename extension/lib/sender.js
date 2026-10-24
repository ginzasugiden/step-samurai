/* GAS 受け口（ext_ingest_reviews）への送信。500件チャンク・再試行・エラー分類。fetch と待機は注入する。 */
(function (root, name, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var req = function (n) { return isNode ? require('./' + n) : root.SSX[n]; };
  var api = factory(req);
  if (isNode) module.exports = api; else { root.SSX = root.SSX || {}; root.SSX[name] = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, 'sender', function (req) {
  var config = req('config');

  var GAS_ERRORS = ['unauthorized', 'token_revoked', 'tenant_not_active', 'billing_not_allowed', 'invalid_payload', 'too_many_rows', 'busy', 'internal_error'];

  /** 0件でも空配列1チャンク（同期完了の心拍として1回は送る） */
  function chunk(arr, size) {
    size = size || config.CHUNK_SIZE;
    if (!arr.length) return [[]];
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /**
   * 1回の POST。通信失敗・5xx・JSON でない応答は 1s/3s/9s で最大3回再試行し、以降は { ok:false, error:'network' }。
   * GAS の ok:false は再試行しない。戻り値: { ok:true, data } | { ok:false, error }
   * deps: { fetchFn, sleep, gasUrl? }
   */
  async function callGas(payload, deps) {
    var body = JSON.stringify({ action: 'ext_ingest_reviews', payload: payload });
    var delays = config.RETRY_DELAYS_MS;
    for (var attempt = 0; ; attempt++) {
      var data = null;
      try {
        var res = await deps.fetchFn(deps.gasUrl || config.GAS_URL, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, credentials: 'omit',
        });
        if (res.status >= 500) data = null;
        else if (!res.ok) return { ok: false, error: 'internal_error' };
        else { try { data = await res.json(); } catch (e) { data = null; } }
      } catch (e) { data = null; }
      if (data && typeof data === 'object') {
        if (data.ok === true) return { ok: true, data: data };
        return { ok: false, error: GAS_ERRORS.indexOf(data.error) >= 0 ? data.error : 'internal_error' };
      }
      if (attempt >= delays.length) return { ok: false, error: 'network' };
      await deps.sleep(delays[attempt]);
    }
  }

  /** dry_run・空配列の呼び出し（トークン・テナント・課金の検証と initial_from の取得） */
  async function probe(token, deps) {
    var r = await callGas({ token: token, dry_run: true, reviews: [] }, deps);
    if (!r.ok) return r;
    return { ok: true, initialFrom: typeof r.data.initial_from === 'string' ? r.data.initial_from : '' };
  }

  /** 全チャンクを順に送る。途中で失敗したらそこで停止（以降は送らない） */
  async function sendAll(reviews, token, deps) {
    var chunks = chunk(reviews), inserted = 0, updated = 0;
    for (var i = 0; i < chunks.length; i++) {
      var r = await callGas({ token: token, dry_run: false, reviews: chunks[i] }, deps);
      if (!r.ok) return { ok: false, error: r.error, sentChunks: i, totalChunks: chunks.length };
      inserted += Number(r.data.inserted) || 0; updated += Number(r.data.updated) || 0;
    }
    return { ok: true, sentChunks: chunks.length, totalChunks: chunks.length, inserted: inserted, updated: updated };
  }

  return { GAS_ERRORS: GAS_ERRORS, chunk: chunk, callGas: callGas, probe: probe, sendAll: sendAll };
});
