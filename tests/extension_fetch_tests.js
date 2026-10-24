// node tests/extension_fetch_tests.js — 拡張の取得処理（ログイン判定・形式判定・3,000件での期間分割・重複排除・cap_unsplittable）。値はすべて架空。
const assert = require('assert'), path = require('path');
const L = p => require(path.join(__dirname, '..', 'extension', 'lib', p));
const fetcher = L('fetcher'), time = L('time');

const tests = []; const t = (n, f) => tests.push([n, f]);
const HEADER = 'レビュータイプ,商品名,レビュー詳細URL,評価,投稿時間,タイトル,レビュー本文,フラグ,注文番号,未対応フラグ';
const rowOf = n => `商品レビュー,架空の商品,https://example.invalid/review/detail/${n},5,2026/10/1 0:00:00,架空題,架空本文,0,111111-20261001-${String(n).padStart(10, '0')},0`;
const csvOf = ids => [HEADER, ...ids.map(rowOf)].join('\r\n') + '\r\n';
const jst = (y, m, d, h = 0, i = 0) => Date.UTC(y, m - 1, d, h, i) - 9 * 3600e3;
const decode = s => s;   // テストでは「バッファ」自体を文字列として扱う
const mkRes = (text, o = {}) => ({ ok: o.ok !== false, status: o.status || 200, url: o.url || 'https://review.rms.rakuten.co.jp/search/csv/?x', arrayBuffer: async () => text });
const deps = fetchFn => ({ fetchFn, decode });

t('ログイン画面へのリダイレクト（review.rms 配下でない URL）は login_required', async () => {
  const fn = async () => mkRes('<html></html>', { url: 'https://glogin.rms.rakuten.co.jp/?sp_id=1' });
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(fn)), e => e.code === 'login_required');
});
t('HTML にパスワード入力があれば login_required、無ければ csv_format', async () => {
  const login = async () => mkRes('<!DOCTYPE html><html><body><form><input type="password" name="p"></form></body></html>');
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(login)), e => e.code === 'login_required');
  const other = async () => mkRes('<html><body>メンテナンス中</body></html>');
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(other)), e => e.code === 'csv_format');
});
t('401/403 は login_required、その他の HTTP エラー・例外は fetch_failed', async () => {
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(async () => mkRes('', { ok: false, status: 403 }))), e => e.code === 'login_required');
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(async () => mkRes('', { ok: false, status: 500 }))), e => e.code === 'fetch_failed');
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(async () => { throw new Error('net'); })), e => e.code === 'fetch_failed');
});
t('ヘッダ欠落の CSV は csv_format（何も返さない）', async () => {
  const fn = async () => mkRes('商品名,評価\r\nx,5\r\n');
  await assert.rejects(fetcher.collectReviews({ fromMs: 0, toMs: 600e3 }, deps(fn)), e => e.code === 'csv_format');
});
t('3,000件未満は1回で取得。fetch には credentials:include と組み立てた URL を渡す', async () => {
  const calls = [];
  const fn = async (u, o) => { calls.push([u, o]); return mkRes(csvOf([1, 2, 3])); };
  const r = await fetcher.collectReviews({ fromMs: jst(2026, 10, 1), toMs: jst(2026, 10, 2) }, deps(fn));
  assert.equal(r.reviews.length, 3); assert.equal(calls.length, 1); assert.equal(calls[0][1].credentials, 'include');
  assert.equal(calls[0][0], time.csvUrlFor(jst(2026, 10, 1), jst(2026, 10, 2)));
});
t('ちょうど3,000件なら期間を中点で二分割して取り直し、重複を review_id で排除', async () => {
  const from = jst(2026, 10, 1), to = jst(2026, 10, 3), mid = from + (to - from) / 2;
  const urls = [];
  const fn = async u => {
    urls.push(u);
    if (urls.length === 1) return mkRes(csvOf(Array.from({ length: 3000 }, (_, i) => i + 1)));   // 全期間 = 上限ぴったり
    if (urls.length === 2) return mkRes(csvOf([1, 2, 3, 4]));          // 前半
    return mkRes(csvOf([4, 5, 6]));                                     // 後半（4 が両半に出る）
  };
  const r = await fetcher.collectReviews({ fromMs: from, toMs: to }, deps(fn));
  assert.deepEqual(urls, [time.csvUrlFor(from, to), time.csvUrlFor(from, mid), time.csvUrlFor(mid, to)]);
  assert.deepEqual(r.reviews.map(x => x.review_id.split('/').pop()).sort(), ['1', '2', '3', '4', '5', '6']);
});
t('スキップ件数（注文番号なし）を集計する', async () => {
  const noOrder = `商品レビュー,x,https://example.invalid/review/detail/99,5,2026/10/1 0:00:00,t,b,0,,0`;
  const fn = async () => mkRes([HEADER, rowOf(1), noOrder].join('\r\n'));
  const r = await fetcher.collectReviews({ fromMs: 0, toMs: 3600e3 }, deps(fn));
  assert.equal(r.reviews.length, 1); assert.equal(r.skippedNoOrder, 1);
});
t('最小幅（1分）でも3,000件なら cap_unsplittable', async () => {
  const fn = async () => mkRes(csvOf(Array.from({ length: 3000 }, (_, i) => i + 1)));
  await assert.rejects(fetcher.collectReviews({ fromMs: jst(2026, 10, 1, 0, 0), toMs: jst(2026, 10, 1, 0, 1) }, deps(fn)), e => e.code === 'cap_unsplittable');
});
t('常に3,000件の応答でも、分割を繰り返して最小幅で cap_unsplittable になり無限ループしない', async () => {
  let n = 0;
  const fn = async () => { n++; return mkRes(csvOf(Array.from({ length: 3000 }, (_, i) => i + 1))); };
  await assert.rejects(fetcher.collectReviews({ fromMs: jst(2026, 10, 1), toMs: jst(2026, 10, 1, 0, 8) }, deps(fn)), e => e.code === 'cap_unsplittable');
  assert.ok(n < 20, 'requests=' + n);
});

(async () => {
  let pass = 0;
  for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } }
  console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
})();
