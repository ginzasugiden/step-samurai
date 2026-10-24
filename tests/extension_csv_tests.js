// node tests/extension_csv_tests.js — 拡張の CSV 解析・5項目への絞り込み・Shift_JIS デコード・期間計算・URL 組み立て・チャンク分割。値はすべて架空。
const assert = require('assert'), path = require('path');
const L = p => require(path.join(__dirname, '..', 'extension', 'lib', p));
const csv = L('csv'), time = L('time'), config = L('config'), sender = L('sender');

const tests = []; const t = (n, f) => tests.push([n, f]);
const HEADER = 'レビュータイプ,商品名,レビュー詳細URL,評価,投稿時間,タイトル,レビュー本文,フラグ,注文番号,未対応フラグ';
const URL1 = 'https://example.invalid/review/detail/0001', URL2 = 'https://example.invalid/review/detail/0002', URL3 = 'https://example.invalid/review/detail/0003';
const SECRETS = ['架空の商品ゼロ', '架空のタイトルA', '架空の本文行1', '架空の本文行2', 'ひみつの商品', 'ひみつの題', 'ひみつの本文'];
const SAMPLE = [HEADER,
  `商品レビュー,架空の商品ゼロ,${URL1},5,2026/9/3 9:05:07,架空のタイトルA,"架空の本文行1\r\n架空の本文行2 ""引用"", カンマ入り",0,111111-20260901-0000000001,0`,
  `商品レビュー,ひみつの商品,${URL2},4,2026/10/12 18:30:00,ひみつの題,ひみつの本文,1,,1`,
  `ショップレビュー,,${URL3},3,2026/10/13 0:00:01,,,0,222222-20261001-0000000002,0`,
].join('\r\n') + '\r\n';

t('引用符・セル内改行・"" エスケープ・CRLF を解析し、ゼロ埋めなしの日付をそのまま通す', () => {
  const r = csv.extractReviews(SAMPLE);
  assert.equal(r.total, 3); assert.equal(r.reviews.length, 2);
  assert.deepEqual(r.reviews[0], { review_type: '商品レビュー', review_id: URL1, rating: 5, posted_at: '2026/9/3 9:05:07', order_number: '111111-20260901-0000000001' });
  assert.equal(r.reviews[1].posted_at, '2026/10/13 0:00:01');
});
t('出力は5項目だけ（商品名・タイトル・本文・フラグを含まない）', () => {
  const r = csv.extractReviews(SAMPLE);
  r.reviews.forEach(x => assert.deepEqual(Object.keys(x).sort(), ['order_number', 'posted_at', 'rating', 'review_id', 'review_type']));
  const json = JSON.stringify(r);
  SECRETS.forEach(s => assert.ok(!json.includes(s), s));
});
t('注文番号なしの行はスキップし件数だけ数える', () => {
  const r = csv.extractReviews(SAMPLE);
  assert.equal(r.skippedNoOrder, 1); assert.ok(!r.reviews.some(x => x.review_id === URL2));
});
t('BOM つき・列の並びが違うヘッダでも列名で特定する', () => {
  const h = '﻿注文番号,評価,レビュー詳細URL,投稿時間,レビュータイプ,その他';
  const r = csv.extractReviews(`${h}\n111-1-1,2,${URL1},2026/1/2 3:04:05,商品レビュー,x\n`);
  assert.deepEqual(r.reviews[0], { review_type: '商品レビュー', review_id: URL1, rating: 2, posted_at: '2026/1/2 3:04:05', order_number: '111-1-1' });
});
t('必要列が欠けると csv_format', () => {
  assert.throws(() => csv.extractReviews('レビュータイプ,商品名,評価,投稿時間\n商品レビュー,x,5,2026/1/1 0:00:00\n'), e => e.code === 'csv_format');
  assert.throws(() => csv.extractReviews(''), e => e.code === 'csv_format');
  assert.throws(() => csv.extractReviews(HEADER + '\n"閉じない引用符,1\n'), e => e.code === 'csv_format');
});
t('Shift_JIS デコード（0x82 0xA0 → あ）', () => {
  assert.equal(csv.decodeShiftJis(new Uint8Array([0x82, 0xA0]).buffer), 'あ');
});

const jst = (y, m, d, h = 0, i = 0) => Date.UTC(y, m - 1, d, h, i) - 9 * 3600e3;
t('期間: 通常は前回同期の2日前〜現在（JST・分単位）', () => {
  const now = jst(2026, 10, 24, 12, 34) + 30e3;
  const p = time.computePeriod({ now, lastSyncAt: jst(2026, 10, 20, 8, 15) + 5e3 });
  assert.equal(p.fromMs, jst(2026, 10, 18, 8, 15)); assert.equal(p.toMs, jst(2026, 10, 24, 12, 34));
});
t('期間: 初回は initial_from の 00:00（JST）〜現在。不正なら30日前', () => {
  const now = jst(2026, 10, 24, 12, 34);
  assert.equal(time.computePeriod({ now, lastSyncAt: null, initialFrom: '2026-09-24' }).fromMs, jst(2026, 9, 24, 0, 0));
  assert.equal(time.computePeriod({ now, lastSyncAt: null, initialFrom: 'あいう' }).fromMs, now - 30 * 24 * 3600e3);
  assert.ok(isNaN(time.parseDay('2026-02-30')));
});
t('CSV URL の組み立て（ゼロ埋めなし・固定パラメータ）', () => {
  const u = time.csvUrlFor(jst(2026, 9, 3, 0, 5), jst(2026, 10, 24, 9, 0));
  assert.equal(u, 'https://review.rms.rakuten.co.jp/search/csv/?sy=2026&sm=9&sd=3&sh=0&si=5&ey=2026&em=10&ed=24&eh=9&ei=0&ev=0&tc=0&kw=&ao=A&st=1');
});
t('JST 日付と表示', () => {
  assert.equal(time.jstDay(Date.parse('2026-10-24T15:30:00Z')), '2026-10-25');
  assert.equal(time.formatJst(jst(2026, 3, 4, 5, 6)), '2026/3/4 5:06');
});
t('500件チャンク分割（0件でも空1チャンク）', () => {
  assert.deepEqual(sender.chunk([]), [[]]);
  const a = Array.from({ length: 1201 }, (_, i) => i);
  assert.deepEqual(sender.chunk(a).map(c => c.length), [500, 500, 201]);
  assert.deepEqual(sender.chunk(a.slice(0, 500)).map(c => c.length), [500]);
});
t('設定値: GAS URL と プライバシーポリシー URL（CNAME のドメイン）', () => {
  assert.ok(config.GAS_URL.startsWith('https://script.google.com/macros/s/') && config.GAS_URL.endsWith('/exec'));
  const cname = require('fs').readFileSync(path.join(__dirname, '..', 'CNAME'), 'utf8').trim();
  assert.equal(config.PRIVACY_URL, `https://${cname}/privacy.html`);
});

(async () => {
  let pass = 0;
  for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } }
  console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
})();
