// node tests/review_thanks_tests.js — RMS実CSV形式の取込 / レビューお礼メールの対象判定と送信
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- GAS mock（multitenant_tests.js と同等） ----
let props = { TENANT_MASTER_SHEET_ID: 'MASTER', DRY_RUN: 'false' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) };
const cacheStore = {};
const CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) };
const Utilities = { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
  formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0');
    const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; } };
const logs = []; const Logger = { log: m => logs.push(String(m)) };
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); }
  getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => v.forEach((row, i) => { while (s.rows.length < r + i) s.rows.push([]); row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }),
    setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
}
class SS { constructor(sheets) { this.sheets = sheets; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } getSpreadsheetTimeZone() { return 'Asia/Tokyo'; } }

const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email'], ['tokyoflower','東京フラワー','SS_TF','active','info@tokyoflower.jp','']]);
const settings = new Sheet([['key','value','description','editable_by_tenant'],
  ['follow_days_after_ship','5','','TRUE'], ['go_live_date','2026-08-22','','FALSE'], ['dry_run','false','','FALSE'], ['exclude_orders','','','FALSE']]);
const templates = new Sheet([['template_id','subject','body','updated_at']]);
const reviews = new Sheet([['review_id','order_number','buyer_key','item_code','rating','posted_at','body']]);
const orders = new Sheet([['order_number','order_date','buyer_key','masked_email','buyer_name','item_code','item_name','amount','purchase_count','prefecture','ship_date','status','review_linked'],
  ['240364-20260830-0747401112','2026-08-30','b1','a@pc.fw.rakuten.ne.jp','山田','','',5000,1,'','2026-09-01','shipped',''],
  ['240364-20260807-0615846903','2026-08-07','b2','b@pc.fw.rakuten.ne.jp','佐藤','','',4000,1,'','2026-08-25','shipped',''],
  ['240364-20260827-0689400977','2026-08-27','b3','c@pc.fw.rakuten.ne.jp','鈴木','','',6000,1,'','2026-08-28','shipped',''],
  ['240364-20260720-0569341814','2026-07-20','b4','d@pc.fw.rakuten.ne.jp','高橋','','',15000,1,'','2026-07-21','shipped',''],
  ['240364-20260827-0309500953','2026-08-27','bt','test@pc.fw.rakuten.ne.jp','テスト','','',100,1,'','2026-08-27','cancelled',''],
]);
const sends = new Sheet([['send_id','order_number','buyer_key','type','sent_at','template_id','result']]);
const books = { MASTER: new SS({ tenants: master }), SS_TF: new SS({ settings, templates, reviews, orders, sends }) };
const SpreadsheetApp = { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } };

const ctx = { PropertiesService, CacheService, Utilities, Logger, SpreadsheetApp, console, isDryRun_: () => props.DRY_RUN === 'true' };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'reviews_import.gs', 'mailer.gs', 'review_thanks.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
const rapi = load('rakuten_api.gs'); const li = rapi.indexOf('function linkOrdersReviews('); vm.runInContext(rapi.substring(li, rapi.indexOf('\n}\n', li) + 3), ctx);
// 外部依存をスタブ
const sentMails = [];
vm.runInContext(`
  getRmsCredentials = () => ({ shop_name: '東京フラワー', from_email: 'info@tokyoflower.jp', from_name: '東京フラワー', reply_to: 'info@tokyoflower.jp', cc_email: '', shop_signature: '署名' });
  sendViaBridge_ = (tenantId, to, fromEmail, fromName, subject, body) => { __sent.push({ to, subject, body }); return { ok: true }; };
`, ctx); ctx.__sent = sentMails;

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const clearCache = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);

console.log('RMS レビューチェックツール CSV（実ヘッダ）');
const rmsCsv = [
  'レビュータイプ,商品名,レビュー詳細URL,評価,投稿時間,タイトル,レビュー本文,フラグ,注文番号,未対応フラグ',
  '商品レビュー,アレンジ LL,https://review.rakuten.co.jp/item/1/240364_10000415/ccl6-i9fiv-iizjj0_1_4299087924/,5,2026/09/05 8:12:37,,恩師の退職記念に送りました。,0,240364-20260830-0747401112,',
  'ショップレビュー,,https://review.rakuten.co.jp/shop/4/240364_240364/ccl6-i9fiv-iizjj0_1_1/,5,2026/09/05 8:12:37,,"こんなに早く届くとは…\r\n丁寧な対応",0,240364-20260830-0747401112,0',
  'ショップレビュー,,https://review.rakuten.co.jp/shop/4/240364_240364/ccl6-i9fie-gdqs5k_1_1/,1,2026/08/14 21:13:49,,画像配信が来ませんでした,0,240364-20260807-0615846903,0',
  '商品レビュー,カサブランカ,https://review.rakuten.co.jp/item/1/240364_10007431/x/,2,2026/09/01 11:15:37,残念,2本は立派でした,0,240364-20260827-0689400977,',
  '商品レビュー,スタンド花,https://review.rakuten.co.jp/item/1/240364_10010946/y/,5,2026/08/03 17:56:34,,イメージ通り,0,240364-20260720-0569341814,',
  '商品レビュー,テスト商品,https://review.rakuten.co.jp/item/1/240364_test/z/,5,2026/09/07 12:00:00,,検証,0,240364-20260827-0309500953,',
].join('\r\n') + '\r\n';
t('列判定: 投稿時間 / 注文番号 / 評価 / レビュー本文 / URL / タイトル', () => { const r = ctx.importReviewsFromCsv_('tokyoflower', rmsCsv, true); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.column_map.posted_at, '投稿時間'); assert.equal(r.column_map.body, 'レビュー本文'); assert.equal(r.column_map.review_url, 'レビュー詳細URL'); assert.equal(r.valid_rows, 6); });
t('review_id はURL由来（商品/ショップが同一注文・同時刻でも衝突しない）', () => { const r = ctx.importReviewsFromCsv_('tokyoflower', rmsCsv, false); assert.equal(r.inserted, 6); assert.equal(reviews.rows.length, 7); assert.equal(reviews.rows.filter(x => x[1] === '240364-20260830-0747401112').length, 2); });
t('冪等: 再取込は updated のみ', () => { const r = ctx.importReviewsFromCsv_('tokyoflower', rmsCsv, false); assert.equal(r.inserted, 0); assert.equal(r.updated, 6); assert.equal(reviews.rows.length, 7); });
t('タイトルは本文の先頭に【】で合流、投稿時間は正規化', () => { const row = reviews.rows.find(x => x[1] === '240364-20260827-0689400977'); assert.equal(row[6], '【残念】\n2本は立派でした'); assert.equal(row[5], '2026-09-01 11:15:37'); });
t('review_linked が更新される', () => { assert.equal(orders.rows[1][12], 'true'); assert.equal(orders.rows[4][12], 'true'); });
t('列が足りない旧形式でも review_id フォールバック生成', () => { const r = ctx.importReviewsFromCsv_('tokyoflower', 'レビュータイプ,注文番号,評価,投稿日\r\nショップレビュー,D-1,4,2026/08/07\r\n', true); assert.equal(r.sample[0].review_id, 'csv_ショップレビュー_D-1_20260807'); });

console.log('レビューお礼メール 判定');
t('review_thanks_since 未設定 → 全スキップ(fail-closed)', () => { clearCache(); const p = ctx.collectPendingReviewThanks_('tokyoflower'); assert.equal(p.disabled, 'review_thanks_since_unset'); assert.equal(p.targets.length, 0); });
t('ensureTenantSettingsKeys_ / ensureTenantTemplateRows_ が新キー・新テンプレを追記', () => { clearCache(); const k = ctx.ensureTenantSettingsKeys_('tokyoflower'); assert.ok(k.includes('review_thanks_since') && k.includes('review_thanks_min_rating')); const tp = ctx.ensureTenantTemplateRows_('tokyoflower'); assert.deepEqual(tp.sort(), ['coupon_v1','follow_v1','review_thanks_v1']); assert.equal(ctx.ensureTenantTemplateRows_('tokyoflower').length, 0); });
t('since=2026-09-01: 投稿日下限・go_live前・低評価・キャンセルを除外し 1件のみ対象', () => {
  ctx.setTenantSettingValueAdmin_('tokyoflower', 'review_thanks_since', '2026-09-01'); clearCache();
  const p = ctx.collectPendingReviewThanks_('tokyoflower');
  assert.deepEqual(p.targets.map(x => x.order_number), ['240364-20260830-0747401112']);
  assert.deepEqual(p.skipped.low_rating, ['240364-20260827-0689400977']);          // rating 2 < 3
  assert.deepEqual(p.skipped.review_before_since, ['240364-20260807-0615846903']);
  assert.deepEqual(p.skipped.before_go_live, ['240364-20260720-0569341814']);         // 発送 7/21 < go_live 8/22
  assert.deepEqual(p.skipped.cancelled, ['240364-20260827-0309500953']);
});
t('min_rating=1 にすると低評価も対象になる', () => { ctx.setTenantSettingValueAdmin_('tokyoflower', 'review_thanks_min_rating', '1'); clearCache(); const p = ctx.collectPendingReviewThanks_('tokyoflower'); assert.equal(p.targets.length, 2); ctx.setTenantSettingValueAdmin_('tokyoflower', 'review_thanks_min_rating', '3'); clearCache(); });
t('exclude_orders で除外できる', () => { ctx.setTenantSettingValueAdmin_('tokyoflower', 'exclude_orders', '240364-20260830-0747401112'); clearCache(); const p = ctx.collectPendingReviewThanks_('tokyoflower'); assert.equal(p.targets.length, 0); assert.deepEqual(p.skipped.excluded, ['240364-20260830-0747401112']); ctx.setTenantSettingValueAdmin_('tokyoflower', 'exclude_orders', ''); clearCache(); });

console.log('レビューお礼メール 送信');
t('dry_run=true は送らずログのみ', () => { ctx.setTenantSettingValueAdmin_('tokyoflower', 'dry_run', 'true'); clearCache(); const n = ctx.sendPendingReviewThanks('tokyoflower'); assert.equal(n, 1); assert.equal(sentMails.length, 0); assert.equal(sends.rows.length, 1); ctx.setTenantSettingValueAdmin_('tokyoflower', 'dry_run', 'false'); clearCache(); });
t('本送信: 1通送られ sends に review_thanks/sent が記録される', () => { const n = ctx.sendPendingReviewThanks('tokyoflower'); assert.equal(n, 1); assert.equal(sentMails.length, 1); assert.equal(sentMails[0].to, 'a@pc.fw.rakuten.ne.jp'); assert.ok(sentMails[0].subject.includes('レビューご投稿ありがとうございます')); assert.ok(sentMails[0].body.startsWith('山田 様')); assert.equal(sends.rows[1][3], 'review_thanks'); assert.equal(sends.rows[1][6], 'sent'); });
t('二重送信しない', () => { clearCache(); const n = ctx.sendPendingReviewThanks('tokyoflower'); assert.equal(n, 0); assert.equal(sentMails.length, 1); });
t('検証用 recordType=review_thanks_test は本番判定に影響せず、キャンセル注文にも直接送れる', () => {
  const testOrder = ctx.findOrderByNumber_ ? null : { order_number: '240364-20260827-0309500953', masked_email: 'test@pc.fw.rakuten.ne.jp', buyer_key: 'bt', buyer_name: 'テスト', ship_date: '2026-08-27', status: 'cancelled' };
  const r = ctx.sendReviewThanksMail('tokyoflower', testOrder, { recordType: 'review_thanks_test' });
  assert.equal(r.sent, true); assert.equal(sentMails[1].to, 'test@pc.fw.rakuten.ne.jp');
  assert.equal(sends.rows[2][3], 'review_thanks_test');
  assert.equal(ctx.alreadySent_(sends, '240364-20260827-0309500953', 'review_thanks'), false);
});
t('sendCouponMail の recordType オプション（coupon_test）', () => {
  ctx.templates_dummy = 1;
  const testOrder = { order_number: '240364-20260827-0309500953', masked_email: 'test@pc.fw.rakuten.ne.jp', buyer_key: 'bt', buyer_name: 'テスト', ship_date: '2026-08-27', status: 'cancelled' };
  ctx.sendCouponMail('tokyoflower', testOrder, { coupon_id: 'DUMMY', discount: 300, valid_until: '2026/10/07', get_url: 'https://example' }, { recordType: 'coupon_test' });
  assert.equal(sentMails[2].to, 'test@pc.fw.rakuten.ne.jp'); assert.ok(sentMails[2].body.includes('300円OFF'));
  assert.equal(sends.rows[3][3], 'coupon_test'); assert.equal(ctx.alreadySent_(sends, '240364-20260827-0309500953', 'coupon'), false);
});
t('TEST_MAIL_TO が空なら宛先は差し替えられない', () => assert.equal(ctx.resolveRecipient_('x@pc.fw.rakuten.ne.jp'), 'x@pc.fw.rakuten.ne.jp'));

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
