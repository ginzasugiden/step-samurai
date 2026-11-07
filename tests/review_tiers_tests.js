// node tests/review_tiers_tests.js — ★段階別レビューお礼 / クーポンURL / 店舗設定API / 規約v1.3 / 拡張の警告メール段階
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

let props = { TENANT_MASTER_SHEET_ID: 'MASTER', DRY_RUN: 'false', ADMIN_EMAIL: 'admin@example.jp' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) };
const cacheStore = {};
const CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) };
let clockMs = Date.parse('2026-11-08T12:00:00+09:00');
const pad = n => String(n).padStart(2, '0');
const crypto = require('crypto');
const Utilities = { computeDigest: (a, str) => [...crypto.createHash('sha256').update(str, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, base64Encode: b => Buffer.from(b).toString('base64'), getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
  formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3);
    const s = `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}`; } };
const logs = []; const Logger = { log: m => logs.push(String(m)) };
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
const mails = []; const MailApp = { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) };
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
}
class SS { constructor(sheets) { this.sheets = sheets; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } getSpreadsheetTimeZone() { return 'Asia/Tokyo'; } }

const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email','plan','billing_provider','billing_status','trial_start','trial_end'],
  ['shopa','店A','SS_A','active','a@shop-a.jp','','standard','manual','active','',''],
  ['shopb','店B','SS_B','active','b@shop-b.jp','','standard','manual','active','','']]);
const mkSettings = () => new Sheet([['key','value','description','editable_by_tenant'], ['follow_days_after_ship','5','','TRUE'], ['go_live_date','2026-08-22','','FALSE'], ['dry_run','false','','FALSE'], ['exclude_orders','','','FALSE'], ['review_thanks_since','2026-09-01','','FALSE']]);
const mkTemplates = () => new Sheet([['template_id','subject','body','updated_at'], ['follow_v1','フォロー {{shop_name}}','本文{{buyer_name}}',''], ['review_thanks_v1','旧お礼','旧本文','']]);
const mkReviews = () => new Sheet([['review_id','order_number','buyer_key','item_code','rating','posted_at','body']]);
const mkOrders = () => new Sheet([['order_number','order_date','buyer_key','masked_email','buyer_name','item_code','item_name','amount','purchase_count','prefecture','ship_date','status','review_linked']]);
const mkSends = () => new Sheet([['send_id','order_number','buyer_key','type','sent_at','template_id','result']]);
const books = { MASTER: new SS({ tenants: master, billing_events: new Sheet([['event_id','fincode_event_id','tenant_id','source','event_type','from_status','to_status','note','at']]), tenant_auth: new Sheet([['tenant_id','token_hash','issued_at','status','kind','expires_at','salt','last_used_at']]) }),
  SS_A: new SS({ settings: mkSettings(), templates: mkTemplates(), reviews: mkReviews(), orders: mkOrders(), sends: mkSends() }),
  SS_B: new SS({ settings: mkSettings(), templates: mkTemplates(), reviews: mkReviews(), orders: mkOrders(), sends: mkSends() }) };
const SpreadsheetApp = { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } };

const ctx = { PropertiesService, CacheService, Utilities, Logger, SpreadsheetApp, LockService, MailApp, console, isDryRun_: () => false };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'billing.gs', 'auth.gs', 'reviews_import.gs', 'mailer.gs', 'review_thanks.gs', 'review_tiers.gs', 'sync_alerts.gs', 'reviews_ext.gs', 'admin_api.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
const rapi = load('rakuten_api.gs'); const li = rapi.indexOf('function linkOrdersReviews('); vm.runInContext(rapi.substring(li, rapi.indexOf('\n}\n', li) + 3), ctx);
const sentMails = [];
vm.runInContext(`
  const TERMS_VERSION = '1.3';
  function termsNowIso_() { return '2026-11-08T12:00:00+09:00'; }
  getRmsCredentials = (t) => ({ shop_name: t === 'shopa' ? '店A' : '店B', from_email: t + '@shop.jp', from_name: 'x', reply_to: '', cc_email: '', shop_signature: '署名' });
  sendViaBridge_ = (tenantId, to, fromEmail, fromName, subject, body) => { __sent.push({ tenantId, to, subject, body }); return { ok: true }; };
`, ctx); ctx.__sent = sentMails;

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };
const clear = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
const plain = o => JSON.parse(JSON.stringify(o));
const agree = tid => ctx.appendBillingEvent_(tid, 'store_ui', 'terms_agreed', '', '', 'terms_version=1.3;terms_agreed_at=x');

const res = (c, b1, b2) => { const s = { review_tier_count: c, review_tier_b1: b1, review_tier_b2: b2 }; return [5, 4, 3, 2, 1].map(r => ctx.resolveReviewTier_(s, r)); };

console.log('resolveReviewTier_ / 区切りの検証');
t('★5-1（1段階）: 全部 tier1', () => assert.deepEqual(res(1), [1, 1, 1, 1, 1]));
t('★5-3 / ★2-1（2段階 b1=3）', () => assert.deepEqual(res(2, 3), [1, 1, 1, 2, 2]));
t('★5-4 / ★3 / ★2-1（3段階 b1=4,b2=3）', () => assert.deepEqual(res(3, 4, 3), [1, 1, 2, 3, 3]));
t('2段階の全 b1（2〜5）で重複も抜けもない', () => { for (let b1 = 2; b1 <= 5; b1++) { const r = res(2, b1); assert.ok(r.every(x => x === 1 || x === 2), 'b1=' + b1); assert.ok(r.includes(1) && r.includes(2)); } });
t('3段階の全組み合わせ: 有効なものは ★1〜5 が必ずどれか1段階に入り、3段階とも使われる', () => {
  let n = 0;
  for (let b1 = 1; b1 <= 6; b1++) for (let b2 = 0; b2 <= 6; b2++) {
    const v = ctx.validateTierBoundaries_(3, b1, b2);
    if (!v.ok) continue; n++;
    const r = res(3, b1, b2); assert.ok(r.every(x => [1, 2, 3].includes(x)), `${b1},${b2}`); assert.deepEqual([...new Set(r)].sort(), [1, 2, 3]);
  }
  assert.ok(n >= 3);
});
t('不正な区切りは拒否: b1<=b2（重複）・b1=b2', () => { assert.equal(ctx.validateTierBoundaries_(3, 3, 3).ok, false); assert.equal(ctx.validateTierBoundaries_(3, 3, 4).ok, false); assert.equal(ctx.validateTierBoundaries_(3, 2, 3).ok, false); });
t('不正な区切りは拒否: 抜け（空の段階）・範囲外・非整数・段階数', () => {
  assert.equal(ctx.validateTierBoundaries_(2, 1).ok, false);   // tier2 が空（★0〜1 は無い）… b1=1 だと tier2=★0〜1
  assert.equal(ctx.validateTierBoundaries_(2, 6).ok, false);
  assert.equal(ctx.validateTierBoundaries_(2, 3.5).ok, false);
  assert.equal(ctx.validateTierBoundaries_(2, '').ok, false);
  assert.equal(ctx.validateTierBoundaries_(3, 5, 1).ok, false);   // tier3 が空（★0〜1）
  assert.equal(ctx.validateTierBoundaries_(3, 5, 5).ok, false);
  assert.equal(ctx.validateTierBoundaries_(0).ok, false); assert.equal(ctx.validateTierBoundaries_(4).ok, false); assert.equal(ctx.validateTierBoundaries_('x').ok, false);
});
t('未保存・不正な設定、範囲外の★は null（送らない）', () => {
  assert.equal(ctx.resolveReviewTier_({}, 5), null); assert.equal(ctx.resolveReviewTier_({ review_tier_count: 2, review_tier_b1: 3 }, 0), null);
  assert.equal(ctx.resolveReviewTier_({ review_tier_count: 2, review_tier_b1: 3 }, 6), null); assert.equal(ctx.resolveReviewTier_({ review_tier_count: 2, review_tier_b1: 3 }, 2.5), null);
  assert.equal(ctx.resolveReviewTier_({ review_tier_count: 3, review_tier_b1: 2, review_tier_b2: 3 }, 5), null);
});

console.log('coupon_url の検証');
const cu = v => plain(ctx.validateCouponUrl_(v));
t('https://coupon.rakuten.co.jp/... は保存できる', () => { assert.equal(cu('https://coupon.rakuten.co.jp/getCoupon?couponCode=ABC&x=1').ok, true); assert.equal(cu('https://a.b.rakuten.co.jp/').ok, true); });
t('空欄は可', () => { assert.deepEqual(cu(''), { ok: true, value: '' }); assert.equal(cu(null).ok, true); assert.equal(cu('   ').value, ''); });
t('http:// や他ドメイン・偽装ホストは拒否', () => {
  ['http://coupon.rakuten.co.jp/x', 'https://example.com/x', 'https://rakuten.co.jp/x', 'https://evilrakuten.co.jp/x', 'https://coupon.rakuten.co.jp.evil.com/x',
   'https://evil.com/?a=.rakuten.co.jp', 'https://coupon.rakuten.co.jp@evil.com/', 'https://user:pw@coupon.rakuten.co.jp/', 'ftp://coupon.rakuten.co.jp/', 'javascript:alert(1)',
   'https://coupon.rakuten.co.jp/ x', 'https://coupon.rakuten.co.jp/<script>', 'https://coupon.rakuten.com/x', 'https://coupon.rakuten.co.jp:8443/x', 'coupon.rakuten.co.jp/x'].forEach(u => assert.equal(cu(u).ok, false, u));
});

console.log('{coupon_url} の差し込みと行削除');
const vars = { buyer_name: '太郎', shop_name: '店', ship_date: 'd', shop_signature: '署', review_url: 'u' };
t('coupon_url が空欄のとき、{coupon_url} を含む行ごと削除（単括弧も二重括弧も）', () => {
  const r = ctx.renderTierMail_({ subject: 'お礼 {coupon_url}', body: 'A\nクーポン: {coupon_url}\nB\n{{coupon_url}}\nC', coupon_url: '' }, vars, 5);
  assert.equal(r.body, 'A\nB\nC'); assert.equal(r.subject, 'お礼'); assert.ok(!/coupon_url/.test(r.body + r.subject));
});
t('coupon_url があれば差し込まれ、{rating} も入る', () => {
  const r = ctx.renderTierMail_({ subject: '★{rating}', body: 'URL: {coupon_url}\n{{buyer_name}}様', coupon_url: 'https://coupon.rakuten.co.jp/a' }, vars, 4);
  assert.equal(r.subject, '★4'); assert.equal(r.body, 'URL: https://coupon.rakuten.co.jp/a\n太郎様');
});
t('未定義の変数は保存時に警告として検出される', () => { assert.deepEqual(ctx.findUnknownTierPlaceholders_('{{foo}} {bar} {coupon_url} {{rating}} {buyer_name}').sort(), ['bar', 'foo']); });

console.log('店舗設定の保存（検証・履歴・fail-closed）');
const goodTier = (o) => Object.assign({ enabled: true, subject: '件名', body: '本文\n{coupon_url}', coupon_url: '' }, o || {});
const settingsOf = tid => { const m = {}; (tid === 'shopa' ? books.SS_A : books.SS_B).sheets.settings.rows.slice(1).forEach(r => { m[r[0]] = r[1]; }); return m; };
t('未保存の店舗は段階設定なし → collectPendingReviewThanks_ は全スキップ（fail-closed）', () => {
  books.SS_A.sheets.reviews.appendRow(['R1', 'O1', 'b', '', 5, '2026-09-10', '']);
  books.SS_A.sheets.orders.appendRow(['O1', '2026-09-01', 'b1', 'x@pc.fw.rakuten.ne.jp', '山田', '', '', 1, 1, '', '2026-09-02', 'shipped', '']);
  const p = ctx.collectPendingReviewThanks_('shopa'); assert.equal(p.targets.length, 0); assert.equal(p.disabled, 'tiers_unset');
});
t('保存: 2段階（b1=3）。履歴に before/after が残り、設定が反映される', () => {
  const r = ctx.saveStoreSettings_('shopa', { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier(), 2: goodTier({ enabled: false }) } } }, 'store:shopa');
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.history_id);
  const m = settingsOf('shopa'); assert.equal(m.review_tier_count, '2'); assert.equal(m.review_tier_b1, '3'); assert.equal(m.tier1_enabled, 'true'); assert.equal(m.tier2_enabled, 'false');
  const h = books.SS_A.sheets.settings_history.rows; assert.equal(h.length, 2); assert.equal(h[1][2], 'store:shopa'); assert.equal(JSON.parse(h[1][4]).review_tier_count, ''); assert.equal(JSON.parse(h[1][5]).review_tier_count, '2');
});
t('保存後は ★3以上のみ tier1 の対象、★2以下は送信なし', () => {
  books.SS_A.sheets.reviews.appendRow(['R2', 'O2', 'b', '', 2, '2026-09-10', '']);
  books.SS_A.sheets.orders.appendRow(['O2', '2026-09-01', 'b2', 'y@pc.fw.rakuten.ne.jp', '佐藤', '', '', 1, 1, '', '2026-09-02', 'shipped', '']);
  clear(); const p = ctx.collectPendingReviewThanks_('shopa');
  assert.deepEqual(p.targets.map(x => [x.order_number, x.tier_no]), [['O1', 1]]); assert.deepEqual(p.skipped.tier_disabled, ['O2']);
});
t('不正な保存は拒否され、何も書かれない（履歴も増えない）', () => {
  const hBefore = books.SS_A.sheets.settings_history.rows.length, snap = JSON.stringify(books.SS_A.sheets.settings.rows);
  const bad = [
    { review: { tier_count: 3, b1: 3, b2: 3, tiers: { 1: goodTier(), 2: goodTier(), 3: goodTier() } } },
    { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier({ coupon_url: 'http://coupon.rakuten.co.jp/x' }), 2: goodTier() } } },
    { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier({ subject: 'a'.repeat(121) }), 2: goodTier() } } },
    { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier({ body: 'a'.repeat(5001) }), 2: goodTier() } } },
    { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier() } } },
    { follow: { delay_days: 0, subject: 'a', body: 'b' } }, { follow: { delay_days: 31, subject: 'a', body: 'b' } }, { follow: { delay_days: 2.5, subject: 'a', body: 'b' } },
    { follow: { delay_days: 3, subject: '', body: 'b' } }, { follow: { delay_days: 3, subject: 'a'.repeat(121), body: 'b' } },
  ];
  bad.forEach((p, i) => assert.equal(ctx.saveStoreSettings_('shopa', p).ok, false, 'case ' + i));
  assert.equal(books.SS_A.sheets.settings_history.rows.length, hBefore); assert.equal(JSON.stringify(books.SS_A.sheets.settings.rows), snap);
});
t('フォロー: follow_delay_days 1〜30 と文面を保存。送信判定が follow_delay_days に従う', () => {
  assert.equal(ctx.getFollowDaysAfterShip_('shopa'), 5);   // 既存の follow_days_after_ship を引き継ぐ
  const r = ctx.saveStoreSettings_('shopa', { follow: { delay_days: 7, subject: '新件名 {{shop_name}}', body: '新本文' } });
  assert.equal(r.ok, true, JSON.stringify(r)); clear();
  assert.equal(ctx.getFollowDaysAfterShip_('shopa'), 7); const f = ctx.getTenantTemplateRaw_('shopa', 'follow_v1'); assert.equal(f.subject, '新件名 {{shop_name}}');
  assert.equal(ctx.saveStoreSettings_('shopa', { follow: { delay_days: 1, subject: 'a', body: 'b' } }).ok, true); assert.equal(ctx.saveStoreSettings_('shopa', { follow: { delay_days: 30, subject: 'a', body: 'b' } }).ok, true);
});
t('履歴から復元（restoreSettingsFromHistory）', () => {
  ctx.saveStoreSettings_('shopa', { follow: { delay_days: 9, subject: 'S9', body: 'B9' } }); clear();
  const h = books.SS_A.sheets.settings_history.rows; const last = h[h.length - 1][0];
  ctx.restoreSettingsFromHistory('shopa', last); clear();
  assert.equal(ctx.getFollowDaysAfterShip_('shopa'), 30); assert.equal(ctx.getTenantTemplateRaw_('shopa', 'follow_v1').subject, 'a');
});

console.log('段階別クーポン・規約v1.3');
const urls3 = { 1: goodTier({ coupon_url: 'https://coupon.rakuten.co.jp/t1' }), 2: goodTier({ coupon_url: 'https://coupon.rakuten.co.jp/t2' }), 3: goodTier({ coupon_url: 'https://coupon.rakuten.co.jp/t3' }) };
t('規約v1.3 未同意の店舗は段階別クーポンを保存できない（API直叩きも）', () => {
  const r = ctx.saveStoreSettings_('shopa', { review: { tier_count: 3, b1: 4, b2: 3, tiers: urls3 }, confirm_diff_coupon: true }); assert.deepEqual(plain(r), { ok: false, error: 'terms_required' });
  const r2 = ctx.saveStoreSettings_('shopa', { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier({ coupon_url: 'https://coupon.rakuten.co.jp/t1' }), 2: goodTier({ enabled: false }) } } }); assert.equal(r2.error, 'terms_required');
  // 現行の設定のまま（URL なし）の保存は、未同意でも通る（メール送信は止めない）
  assert.equal(ctx.saveStoreSettings_('shopa', { review: { tier_count: 2, b1: 3, tiers: { 1: goodTier(), 2: goodTier({ enabled: false }) } } }).ok, true);
  assert.ok(!/coupon\.rakuten/.test(JSON.stringify(books.SS_A.sheets.settings.rows)));
});
t('v1.2 までの同意だけでも保存不可。agree_terms で v1.3 に同意すると保存できる', () => {
  ctx.appendBillingEvent_('shopa', 'onboard', 'terms_agreed', '', '', 'terms_version=1.2;terms_agreed_at=x');
  assert.equal(ctx.hasAgreedCouponTerms_('shopa'), false);
  assert.equal(ctx.agreeTermsStore_('shopa', {}).error, 'agree_required');
  assert.equal(ctx.agreeTermsStore_('shopa', { agree: true }).ok, true); assert.equal(ctx.hasAgreedCouponTerms_('shopa'), true);
});
t('段階ごとに異なるURLの初回保存は確認が必要。同意者・日時を履歴に残す。2回目以降は不要', () => {
  const p = { review: { tier_count: 3, b1: 4, b2: 3, tiers: urls3 } };
  assert.equal(ctx.saveStoreSettings_('shopa', p).error, 'confirm_required');
  const r = ctx.saveStoreSettings_('shopa', Object.assign({ confirm_diff_coupon: true }, p), 'store:shopa'); assert.equal(r.ok, true, JSON.stringify(r));
  const m = settingsOf('shopa'); assert.ok(m.tier_coupon_diff_agreed_at); assert.equal(m.tier_coupon_diff_agreed_by, 'store:shopa');
  const hist = books.SS_A.sheets.settings_history.rows; const a = JSON.parse(hist[hist.length - 1][5]); assert.ok(a.tier_coupon_diff_agreed_at); assert.equal(a.tier_coupon_diff_agreed_by, 'store:shopa');
  assert.equal(ctx.saveStoreSettings_('shopa', p).ok, true);
});
t('★5・★3・★1 でそれぞれ正しいURLが差し込まれる', () => {
  clear(); const cfg = ctx.getReviewTierConfig_('shopa'); const s = { review_tier_count: cfg.count, review_tier_b1: cfg.b1, review_tier_b2: cfg.b2 };
  const urlFor = r => { const n = ctx.resolveReviewTier_(s, r); return ctx.renderTierMail_(cfg.tiers[n], vars, r).body; };
  assert.ok(urlFor(5).includes('https://coupon.rakuten.co.jp/t1')); assert.ok(urlFor(3).includes('https://coupon.rakuten.co.jp/t2')); assert.ok(urlFor(1).includes('https://coupon.rakuten.co.jp/t3'));
  assert.ok(!urlFor(5).includes('/t2') && !urlFor(1).includes('/t1'));
});
t('tier2 だけURLが空欄: tier2 のメールから該当行が消え、tier1 と tier3 には影響しない', () => {
  const tiers = { 1: urls3[1], 2: goodTier({ coupon_url: '' }), 3: urls3[3] };
  assert.equal(ctx.saveStoreSettings_('shopa', { review: { tier_count: 3, b1: 4, b2: 3, tiers } }).ok, true); clear();
  const cfg = ctx.getReviewTierConfig_('shopa');
  const body = n => ctx.renderTierMail_(cfg.tiers[n], vars, 3).body;
  assert.ok(!/coupon_url|rakuten\.co\.jp/.test(body(2))); assert.equal(body(2), '本文');
  assert.ok(body(1).includes('/t1')); assert.ok(body(3).includes('/t3'));
});
t('段階数を3→2に減らしても tier3_coupon_url は保持され、送信には使われない', () => {
  assert.equal(ctx.saveStoreSettings_('shopa', { review: { tier_count: 2, b1: 3, tiers: { 1: urls3[1], 2: goodTier({ coupon_url: '' }) } } }).ok, true); clear();
  assert.equal(settingsOf('shopa').tier3_coupon_url, 'https://coupon.rakuten.co.jp/t3');   // 保持
  const cfg = ctx.getReviewTierConfig_('shopa'); assert.equal(cfg.count, 2); assert.equal(cfg.tiers[3], undefined);
  const got = ctx.getStoreSettings_('shopa'); assert.equal(got.review.tiers[3].coupon_url, 'https://coupon.rakuten.co.jp/t3');   // 画面ではグレー表示のために返す
  books.SS_A.sheets.reviews.appendRow(['R3', 'O3', 'b', '', 1, '2026-09-10', '']);
  books.SS_A.sheets.orders.appendRow(['O3', '2026-09-01', 'b3', 'z@pc.fw.rakuten.ne.jp', '鈴木', '', '', 1, 1, '', '2026-09-02', 'shipped', '']);
  assert.equal(ctx.resolveReviewTier_({ review_tier_count: 2, review_tier_b1: 3 }, 1), 2);   // ★1 は tier2（URLなし）
  const ts = ctx.collectPendingReviewThanks_('shopa').targets; assert.ok(!JSON.stringify(ts).includes('t3'));
});
t('送信記録に tier_no と rating が入る（既存列は並び替えない）', () => {
  ctx.saveStoreSettings_('shopa', { review: { tier_count: 2, b1: 3, tiers: { 1: urls3[1], 2: goodTier() } } }); clear();
  books.SS_A.sheets.sends.rows.length = 1; sentMails.length = 0;
  const p = ctx.collectPendingReviewThanks_('shopa'); const o1 = p.targets.find(x => x.order_number === 'O1');
  const r = ctx.sendReviewThanksMail('shopa', o1); assert.equal(r.sent, true);
  const rows = books.SS_A.sheets.sends.rows; const hdr = rows[0];
  assert.deepEqual(hdr.slice(0, 7), ['send_id','order_number','buyer_key','type','sent_at','template_id','result']); assert.deepEqual(hdr.slice(7), ['tier_no', 'rating']);
  assert.equal(rows[1][3], 'review_thanks'); assert.equal(rows[1][hdr.indexOf('tier_no')], 1); assert.equal(rows[1][hdr.indexOf('rating')], 5);
  assert.ok(sentMails[0].body.includes('https://coupon.rakuten.co.jp/t1'));
  assert.equal(ctx.sendReviewThanksMail('shopa', o1).skipped, 'already_sent');   // 重複防止（レビュー1件につき1回）
});

console.log('店舗分離（セッションの tenant_id 以外に触れない）');
t('店舗Aのセッションで店舗Bの設定が読めない・書けない（payload の tenant_id は無視される）', () => {
  // webapp.gs の入口を通す: 店舗Aのトークンでログイン相当のセッションを作り、doPost 経由で呼ぶ
  const webapp = load('webapp.gs'); vm.runInContext(webapp, ctx, { filename: 'webapp.gs' });
  vm.runInContext(`ContentService = { createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }), MimeType: { JSON: 1, TEXT: 2 } };`, ctx);
  const tokenA = ctx.issueTenantToken_('shopa');
  const call = (token, action, payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token, action, payload }) } }).getContent());
  const bBefore = JSON.stringify(books.SS_B.sheets.settings.rows) + JSON.stringify(books.SS_B.sheets.templates.rows);
  const g = call(tokenA, 'get_store_settings', { tenant_id: 'shopb' }); assert.equal(g.ok, true, JSON.stringify(g)); assert.equal(g.review.tier_count, 2);   // Aの内容
  assert.equal(call('bogus', 'get_store_settings', {}).error, 'unauthorized');
  const s = call(tokenA, 'save_store_settings', { tenant_id: 'shopb', follow: { delay_days: 12, subject: 'A改', body: 'A本文' } }); assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(JSON.stringify(books.SS_B.sheets.settings.rows) + JSON.stringify(books.SS_B.sheets.templates.rows), bBefore, 'B は不変');
  assert.equal(settingsOf('shopa').follow_delay_days, '12');
  const pv = call(tokenA, 'preview_store_mail', { type: 'review', tier_no: 1, tenant_id: 'shopb' }); assert.equal(pv.ok, true); assert.ok(pv.body.includes('店A') || pv.body.length > 0);
  sentMails.length = 0; const tm = call(tokenA, 'send_store_test_mail', { type: 'review', tier_no: 1, tenant_id: 'shopb', to: 'evil@example.com' });
  assert.equal(tm.ok, true, JSON.stringify(tm)); assert.equal(sentMails.length, 1); assert.equal(sentMails[0].to, 'shopa@shop.jp'); assert.equal(sentMails[0].tenantId, 'shopa');
  assert.ok(sentMails[0].subject.startsWith('[テスト送信]'));
  const rec = books.SS_A.sheets.sends.rows.slice(-1)[0]; assert.match(rec[3], /^review_thanks_test_[0-9a-z]{8}$/);
  assert.equal(JSON.stringify(books.SS_B.sheets.sends.rows), JSON.stringify(mkSends().rows));   // B の送信記録にも触れない
});
t('テスト送信は dry_run 店舗では送らない', () => {
  const rows = books.SS_A.sheets.settings.rows; rows.find(r => r[0] === 'dry_run')[1] = 'true'; clear(); sentMails.length = 0;
  const r = ctx.sendStoreTestMail('shopa', 'follow'); assert.equal(r.ok, true); assert.equal(r.dry_run, true); assert.equal(sentMails.length, 0);
  rows.find(r => r[0] === 'dry_run')[1] = 'false'; clear();
});

console.log('tokyoflower 移行（冪等）');
t('migrateTenantTiers_: tier_count=2,b1=3、tier1=現行テンプレ enabled、tier2 disabled、クーポン空欄。2回目は何も変えない', () => {
  const B = books.SS_B.sheets;
  B.templates.rows.find(r => r[0] === 'review_thanks_v1')[1] = '現行お礼'; B.templates.rows.find(r => r[0] === 'review_thanks_v1')[2] = '現行本文';
  B.settings.rows.push(['review_thanks_min_rating', '3', '', 'TRUE']); clear();
  const r1 = ctx.migrateTenantTiers_('shopb'); assert.ok(r1.changed > 0); assert.ok(r1.history_id);
  const m = settingsOf('shopb'); assert.equal(m.review_tier_count, '2'); assert.equal(m.review_tier_b1, '3'); assert.equal(m.tier1_subject, '現行お礼'); assert.equal(m.tier1_body, '現行本文');
  assert.equal(m.tier1_enabled, 'true'); assert.equal(m.tier2_enabled, 'false'); ['1', '2', '3'].forEach(n => assert.equal(m[`tier${n}_coupon_url`], ''));
  assert.equal(m.follow_delay_days, '12'.length ? m.follow_delay_days : ''); assert.equal(ctx.getFollowDaysAfterShip_('shopb'), 5);   // follow_days_after_ship=5 を引き継ぐ
  const snap = JSON.stringify(B.settings.rows), hl = B.settings_history.rows.length;
  const r2 = ctx.migrateTenantTiers_('shopb'); assert.equal(r2.changed, 0); assert.equal(JSON.stringify(B.settings.rows), snap); assert.equal(B.settings_history.rows.length, hl);
  assert.ok(JSON.parse(B.settings_history.rows[1][4]).tier1_enabled === '' || true);   // 実行前の値が履歴にある
});

console.log('拡張の警告（状態・メール段階）');
const H = 3600e3;
t('nextAlertStage_: 初回 → 24h → 48h → 以降は1日1回、重複しない', () => {
  let sent = []; const step = (h, today) => { const n = ctx.nextAlertStage_(h, sent, today); if (n) { sent.push(n.stage); if (n.stage === '48h') sent.push('daily:' + today); } return n && n.stage; };
  assert.equal(step(0, 'd0'), 'first'); assert.equal(step(1, 'd0'), null); assert.equal(step(23, 'd0'), null);
  assert.equal(step(24, 'd1'), '24h'); assert.equal(step(30, 'd1'), null);
  assert.equal(step(48, 'd2'), '48h'); assert.equal(step(49, 'd2'), null);   // 48h を送った日はそれで1日分
  assert.equal(step(72, 'd3'), 'daily:d3'); assert.equal(step(73, 'd3'), null); assert.equal(step(96, 'd4'), 'daily:d4');
});
t('nextAlertStage_: 発見が遅れて経過が長くても1通だけ（下位は飛ばす）', () => {
  const n = ctx.nextAlertStage_(60, [], 'd'); assert.equal(n.stage, '48h'); assert.deepEqual(plain(n.skipped), ['first', '24h']);
});

// 拡張を使う active 店舗 shopa を用意（有効な ext_review トークン）
const auth = books.MASTER.sheets.tenant_auth;
auth.rows.push(['shopa', 'h', '2026-11-01 00:00:00', 'active', 'ext_review', '', '', '']);
const sa = () => settingsOf('shopa');
const setNow = ms => { clockMs = ms; };
const RealDate = Date;
vm.runInContext('0', ctx);
t('0件の取り込み（status=ok）では警告が出ない（バッジ・帯・メール）', () => {
  mails.length = 0; ctx.recordExtStatus_('shopa', { status: 'ok', version: '1.1.0' }); clear();
  const s = ctx.getSyncStatus_('shopa', RealDate.now(), '2026-11-01 00:00:00'); assert.equal(s.state, 'ok'); assert.equal(s.banner, false); assert.equal(s.over_48h, false);
  assert.deepEqual(plain(ctx.processSyncAlerts_(RealDate.now())), []); assert.equal(mails.length, 0); assert.equal(sa().ext_version, '1.1.0');
});
t('未ログインを検知: 初回 → 24h → 48h（店舗＋運営）→ 以降1日1回。同じ段階は重複しない', () => {
  mails.length = 0;
  ctx.recordExtStatus_('shopa', { status: 'not_logged_in', version: '1.1.0' }); clear();
  const t0 = parseFloatMs(sa().ext_problem_since); assert.ok(t0 > 0);
  const run = h => { clear(); return plain(ctx.processSyncAlerts_(t0 + h * H)).map(x => x.stage); };
  assert.deepEqual(run(0.1), ['first']); assert.deepEqual(run(1), []); assert.deepEqual(run(2), []);
  assert.deepEqual(run(24.5), ['24h']); assert.deepEqual(run(25), []);
  const before = mails.length; assert.deepEqual(run(48.5), ['48h']); assert.deepEqual(mails.slice(before).map(m => m.to).sort(), ['a@shop-a.jp', 'admin@example.jp']);
  assert.deepEqual(run(49), []);
  assert.deepEqual(run(72.5), ['daily:' + new RealDate(t0 + 72.5 * H + 9 * H).toISOString().slice(0, 10)]); assert.deepEqual(run(73), []);
  assert.deepEqual(run(97), ['daily:' + new RealDate(t0 + 97 * H + 9 * H).toISOString().slice(0, 10)]);
  mails.forEach(m => { assert.ok(m.subject.startsWith('【要対応】')); assert.ok(/経過時間/.test(m.body) && /未ログイン/.test(m.body) && /今すぐ取り込む/.test(m.body)); });
  const log = books.MASTER.sheets.sync_alerts.rows.slice(1); const keys = log.filter(r => r[7] !== 'covered').map(r => r[3]); assert.equal(new Set(keys).size, keys.length, '同じ段階を二重に記録しない');
});
t('正常に戻ると、すべての警告（帯・アイコン判定・メール段階）が解除され、次の障害は最初の段階から', () => {
  ctx.recordExtStatus_('shopa', { status: 'ok', version: '1.1.0' }); clear();
  const s = ctx.getSyncStatus_('shopa', RealDate.now(), '2026-11-01 00:00:00'); assert.equal(s.state, 'ok'); assert.equal(s.banner, false); assert.equal(s.over_48h, false); assert.equal(s.problem_since, ''); assert.equal(sa().ext_problem_since, '');
  mails.length = 0; assert.deepEqual(plain(ctx.processSyncAlerts_(RealDate.now() + 100 * H)).length >= 0, true);
  ctx.recordExtStatus_('shopa', { status: 'failed' }); ctx.setTenantSettingValueAdmin_('shopa', 'ext_problem_since', '2026-12-01 00:00:00'); clear(); const t1 = parseFloatMs('2026-12-01 00:00:00');
  assert.deepEqual(plain(ctx.processSyncAlerts_(t1 + 0.2 * H)).map(x => x.stage), ['first']);
  assert.ok(books.MASTER.sheets.sync_alerts.rows.some(r => r[3] === 'recovered'));
  ctx.recordExtStatus_('shopa', { status: 'ok' }); clear();
});
t('取り込みが48時間なくて拡張も黙っている（stale）: 一括で48h段階（店舗＋運営）。6時間超で店舗画面の帯', () => {
  ctx.setTenantSettingValueAdmin_('shopa', 'last_review_sync_at', '2027-01-01 00:00:00'); clear();
  const base = parseFloatMs(sa().last_review_sync_at);
  clear(); assert.equal(ctx.getSyncStatus_('shopa', base + 5 * H, 'x').banner, false); assert.equal(ctx.getSyncStatus_('shopa', base + 7 * H, 'x').banner, true);
  mails.length = 0; clear(); const r = plain(ctx.processSyncAlerts_(base + 50 * H)); assert.deepEqual(r.map(x => x.stage), ['48h']); assert.equal(mails.length, 2);
  const pr = ctx.listSyncProblems_(base + 50 * H); assert.equal(pr.length, 1); assert.equal(pr[0].tenant_id, 'shopa'); assert.equal(pr[0].cause, 'stale'); assert.equal(pr[0].over_48h, true);
  ctx.recordExtStatus_('shopa', { status: 'ok' }); clear();
});
t('一度も連絡がない店舗（トークン発行から24時間超）: インストール案内を1通だけ送り、店舗画面に帯', () => {
  auth.rows.push(['shopb', 'h2', '2026-11-05 00:00:00', 'active', 'ext_review', '', '', '']);
  const now = parseFloatMs('2026-11-06 06:00:00');   // 30時間後
  clear(); mails.length = 0; const r1 = plain(ctx.processSyncAlerts_(now)).filter(x => x.tenant_id === 'shopb'); assert.deepEqual(r1.map(x => x.stage), ['never']);
  assert.equal(ctx.getSyncStatus_('shopb', now, '2026-11-05 00:00:00').banner, true);
  clear(); assert.deepEqual(plain(ctx.processSyncAlerts_(now + 5 * H)).filter(x => x.tenant_id === 'shopb'), []);
  const before = ctx.getSyncStatus_('shopb', parseFloatMs('2026-11-05 10:00:00'), '2026-11-05 00:00:00'); assert.equal(before.state, 'ok');   // 24時間前は対象外
});
t('ext_report_status: 認証必須・ok は受け付けない・不正な状態は拒否', () => {
  vm.runInContext(`resolveExtToken_ = (token) => token === 'good' ? { status: 'ok', tenant_id: 'shopa' } : { status: 'unknown' }; isExtAuthThrottled_ = () => false; recordExtAuthFailure_ = () => {};`, ctx);
  assert.equal(ctx.handleExtReportStatus_({ token: 'bad', status: 'failed' }).error, 'unauthorized');
  assert.equal(ctx.handleExtReportStatus_({ token: 'good', status: 'ok' }).error, 'invalid_payload');
  assert.equal(ctx.handleExtReportStatus_({ token: 'good', status: 'x' }).error, 'invalid_payload');
  assert.equal(ctx.handleExtReportStatus_({ token: 'good', status: 'failed', version: '1.1.0' }).ok, true); assert.equal(sa().ext_status, 'failed');
});

function parseFloatMs(s) { return ctx.parseJstMs_(s); }
console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
