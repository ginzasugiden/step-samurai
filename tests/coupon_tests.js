// node tests/coupon_tests.js — クーポン発行リクエストXML（bububa/rakuten-go issue.go と照合）と fail-closed ゲート。実発行はしない（UrlFetchApp はモック）
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const props = { TENANT_MASTER_SHEET_ID: 'MASTER' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) };
const fmtJst = (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0');
  const date = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`, time = `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`;
  if (fmt === 'yyyy-MM-dd') return date; if (fmt === 'yyyy/MM/dd') return date.replace(/-/g, '/'); if (fmt.includes("'T'")) return `${date}T${time}+09:00`; return `${date} ${time}`; };
const Utilities = { getUuid: () => 'u' + Math.random().toString(36).slice(2), formatDate: fmtJst };
const logs = []; const Logger = { log: m => logs.push(String(m)) };
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return { getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } }
class SS { constructor(sh) { this.sheets = sh; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }

const HDR = ['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email', 'plan', 'billing_provider', 'billing_status', 'trial_start', 'trial_end', 'fincode_customer_id', 'fincode_subscription_id', 'billing_updated_at', 'billing_note'];
const master = new Sheet([HDR,
  ['tokyoflower', 'T', 'S_TF', 'active', 'a@x.jp', '', 'standard', 'manual', 'active', '', '', '', '', '', ''],
  ['couponon', 'C', 'S_ON', 'active', 'b@x.jp', '', 'standard', 'manual', 'active', '', '', '', '', '', ''],
  ['cancelon', 'X', 'S_CN', 'active', 'c@x.jp', '', 'standard', 'manual', 'canceled', '', '', '', '', '', '']]);
const rules = JSON.stringify([{ rule_id: 'first_purchase', discount: 300, enabled: true }]);
const tenantBook = (enabledRow) => new SS({
  settings: new Sheet([['key', 'value', 'description', 'editable_by_tenant'], ['coupon_rules', rules, '', 'FALSE'], ['coupon_valid_days', '30', '', 'TRUE'], ...(enabledRow ? [enabledRow] : [])]),
  coupons: new Sheet([['coupon_id', 'buyer_key', 'rule_id', 'issued_at', 'valid_until', 'api_result']]),
  sends: new Sheet([['send_id', 'order_number', 'buyer_key', 'type', 'sent_at', 'template_id', 'result']]) });
const books = { MASTER: new SS({ tenants: master }), S_TF: tenantBook(null), S_ON: tenantBook(['coupon_enabled', 'true', '', 'FALSE']), S_CN: tenantBook(['coupon_enabled', 'true', '', 'FALSE']) };
let fetchCalls = []; let scripted = null;   // scripted: 呼び出し順のレスポンス本文（null なら常に成功）
const OKBODY = '<result><systemStatus>OK</systemStatus><coupon><couponCode>TESTCODE1</couponCode><pcGetUrl>https://x/</pcGetUrl></coupon></result>';
const NGBODY = '<result><status><systemStatus>NG</systemStatus><message>Request data is wrong format</message></status></result>';
const ctx = { PropertiesService, Utilities, Logger, console, SpreadsheetApp: { openById: id => books[id] }, hash_equals_: (a, b) => a === b,
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) }, isDryRun_: () => false,
  UrlFetchApp: { fetch: (url, o) => { fetchCalls.push({ url, o }); const body = scripted ? scripted[Math.min(fetchCalls.length - 1, scripted.length - 1)] : OKBODY; return { getResponseCode: () => 200, getContentText: () => body }; } } };
vm.createContext(ctx);
['tenant.gs', 'config.gs', 'billing.gs', 'coupon_engine.gs', 'rakuten_api.gs', 'coupon_test.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
ctx.getRmsAuthHeader_ = () => ({ Authorization: 'ESA dummy' });
vm.runInContext('function getRmsAuthHeader_() { return { Authorization: "ESA dummy" }; }', ctx);
vm.runInContext('function billingToday_() { return "2026-09-29"; }', ctx);

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const D = ms => vm.runInContext(`new Date(${ms})`, ctx);   // vm 内の Date（instanceof 判定のため）
const now = D(Date.parse('2026-09-29T03:00:00Z'));
const base = () => ({ name: 'テスト', caption: 'cap', start: D(now.getTime() + 65 * 60000), end: D(now.getTime() + 3 * 86400000), issueCount: 1, discountType: 1, discountFactor: 100, memberAvailMaxCount: 1, now });
const tagsOf = xml => [...xml.matchAll(/<([A-Za-z]+)>/g)].map(m => m[1]);

console.log('XML（issue.go の CouponToIssue と照合）');
t('タグ構成・順序・itemType=4・入れ子（purchaseHistoryCond>type 等）', () => {
  const r = ctx.buildCouponIssueXml_(base()); assert.equal(r.ok, true);
  assert.equal(tagsOf(r.xml).join(','), ['request', 'couponIssueRequest', 'coupon', 'couponName', 'couponCaption', 'couponStartDate', 'couponEndDate', 'issueCount', 'itemType', 'discountType', 'discountFactor', 'memberAvailMaxCount',
    'purchaseHistoryCond', 'type', 'multiRankCond', 'rankCond', 'ageRangeCond', 'lowerBound', 'upperBound', 'birthmonthCond', 'multiPrefectureCond', 'prefectureCond', 'combineFlag', 'displayFlag'].join(','));
  assert.ok(r.xml.includes('<itemType>4</itemType>')); assert.ok(r.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><request>'));
  assert.ok(/<couponStartDate>2026-09-29T13:05:00\+09:00<\/couponStartDate>/.test(r.xml)); assert.ok(r.xml.includes('<issueCount>1</issueCount>')); assert.ok(r.xml.includes('<memberAvailMaxCount>1</memberAvailMaxCount>')); });
t('XML特殊文字はエスケープされる', () => { const r = ctx.buildCouponIssueXml_(Object.assign(base(), { name: 'A&B<C>' })); assert.ok(r.xml.includes('A&amp;B&lt;C&gt;')); });
t('開始が now+60分未満なら弾く / ちょうど60分は通る', () => {
  const bad = ctx.buildCouponIssueXml_(Object.assign(base(), { start: D(now.getTime() + 59 * 60000) })); assert.equal(bad.ok, false); assert.ok(bad.errors.some(e => e.includes('60分')));
  assert.equal(ctx.buildCouponIssueXml_(Object.assign(base(), { start: D(now.getTime() + 60 * 60000) })).ok, true); });
t('必須・数値・範囲の検証', () => {
  [{ name: '' }, { caption: '' }, { end: D(now.getTime()) }, { issueCount: 0 }, { discountType: 4 }, { discountFactor: 0 }, { discountType: 2, discountFactor: 100 }, { memberAvailMaxCount: -1 }, { discountFactor: 1.5 }]
    .forEach(o => assert.equal(ctx.buildCouponIssueXml_(Object.assign(base(), o)).ok, false, JSON.stringify(o))); });

console.log('ゲート（fail-closed）');
const target = { order_number: 'o1', buyer_key: 'b1', rule_id: 'first_purchase' };
t('coupon_enabled 未設定（tokyoflower）は発行関数に到達せず HTTP も呼ばない', () => {
  fetchCalls = []; assert.equal(ctx.issueCoupon('tokyoflower', target), null); assert.equal(fetchCalls.length, 0); assert.ok(logs.some(l => l.includes('tokyoflower') && l.includes('coupon_enabled'))); assert.equal(books.S_TF.sheets.coupons.rows.length, 1); });
t('coupon_enabled=false でも発行しない', () => { books.S_ON.sheets.settings.rows.find(r => r[0] === 'coupon_enabled')[1] = 'false'; fetchCalls = []; assert.equal(ctx.issueCoupon('couponon', target), null); assert.equal(fetchCalls.length, 0); });
t('billing が canceled なら coupon_enabled=true でも発行しない', () => { fetchCalls = []; assert.equal(ctx.issueCoupon('cancelon', target), null); assert.equal(fetchCalls.length, 0); assert.ok(logs.some(l => l.includes('cancelon') && l.includes('billing'))); });
t('coupon_enabled=true かつ billing 許可なら 1 回だけ /es/1.0/coupon/issue へ POST し couponCode を返す', () => {
  books.S_ON.sheets.settings.rows.find(r => r[0] === 'coupon_enabled')[1] = 'true'; fetchCalls = [];
  const r = ctx.issueCoupon('couponon', target); assert.equal(r.coupon_id, 'TESTCODE1'); assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.rms.rakuten.co.jp/es/1.0/coupon/issue'); assert.equal(fetchCalls[0].o.method, 'post'); assert.ok(fetchCalls[0].o.payload.includes('<itemType>4</itemType>'));
  assert.equal(books.S_ON.sheets.coupons.rows[1][0], 'TESTCODE1'); });
t('tokyoflower の settings に coupon_enabled は入っていない', () => assert.ok(!books.S_TF.sheets.settings.rows.some(r => r[0] === 'coupon_enabled')));


console.log('variant（実発行テスト用の形式）');
const TAGS_MIN = ['request', 'couponIssueRequest', 'coupon', 'couponName', 'couponCaption', 'couponStartDate', 'couponEndDate', 'issueCount', 'itemType', 'discountType', 'discountFactor', 'memberAvailMaxCount', 'multiRankCond', 'rankCond', 'combineFlag', 'displayFlag'];
t('minimal: 動作実績のある最小構成（ageRangeCond / multiPrefectureCond / birthmonthCond / purchaseHistoryCond を含まない）', () => {
  const r = ctx.buildCouponIssueXml_(Object.assign(base(), { variant: 'minimal' })); assert.equal(r.ok, true); assert.equal(tagsOf(r.xml).join(','), TAGS_MIN.join(','));
  assert.ok(!/ageRangeCond|multiPrefectureCond|prefectureCond|birthmonthCond/.test(r.xml)); assert.ok(r.xml.includes('<itemType>4</itemType>')); });
t('go_model: purchaseHistoryCond>type と birthmonthCond を追加、ageRange/prefecture は含まない', () => {
  const r = ctx.buildCouponIssueXml_(Object.assign(base(), { variant: 'go_model' })); assert.equal(r.ok, true);
  assert.ok(r.xml.includes('<purchaseHistoryCond><type>0</type></purchaseHistoryCond>') && r.xml.includes('<birthmonthCond>0</birthmonthCond>')); assert.ok(!/ageRangeCond|multiPrefectureCond/.test(r.xml)); });
t('variant 省略（本番パイプライン）は従来形 legacy のまま', () => { const r = ctx.buildCouponIssueXml_(base()); assert.ok(r.xml.includes('<multiPrefectureCond>') && r.xml.includes('<ageRangeCond>')); });

console.log('force（テスト専用）と sends 記録');
const TP = () => ({ name: 'n', caption: 'c', start: D(Date.now() + 26 * 3600e3), end: D(Date.now() + 74 * 3600e3), issueCount: 1, discountType: 1, discountFactor: 100, memberAvailMaxCount: 1, variant: 'minimal' });
t('force なし・coupon_enabled 未設定は発行しない / force=true ならそのゲートだけ通り HTTP 1 回', () => {
  fetchCalls = []; scripted = null;
  assert.equal(ctx.issueCoupon('tokyoflower', target, { params: TP(), testRunId: 'R0' }), null); assert.equal(fetchCalls.length, 0);
  const out = {}; const r = ctx.issueCoupon('tokyoflower', target, { force: true, params: TP(), testRunId: 'R1', out }); assert.equal(r.coupon_id, 'TESTCODE1'); assert.equal(fetchCalls.length, 1);
  const row = books.S_TF.sheets.sends.rows[1]; assert.equal(row[0], 'coupon_test_R1'); assert.equal(row[3], 'coupon_test'); assert.ok(row[6].includes('couponCode=TESTCODE1')); assert.equal(books.S_TF.sheets.coupons.rows.length, 1);
  assert.ok(!books.S_TF.sheets.settings.rows.some(x => x[0] === 'coupon_enabled'), 'settings は変更されない'); });
t('force でも課金ガード(canceled)は通らない', () => { fetchCalls = []; assert.equal(ctx.issueCoupon('cancelon', target, { force: true, params: TP() }), null); assert.equal(fetchCalls.length, 0); });

console.log('runCouponTestTokyoflower（最大3試行・1件のみ）');
const setDry = v => { const rows = books.S_TF.sheets.settings.rows; const r = rows.find(x => x[0] === 'dry_run'); if (r) r[1] = v; else rows.push(['dry_run', v, '', 'FALSE']); };
t('dry_run=true なら発行しない', () => { setDry('true'); fetchCalls = []; scripted = null; assert.equal(ctx.runCouponTestTokyoflower(), null); assert.equal(fetchCalls.length, 0); });
t('テスト用パラメータ: 100円・上限1・1人1回・開始=翌日10:00JST・2日・itemType=4', () => {
  const p = ctx.couponTestParams_(D(Date.parse('2026-09-29T03:00:00Z')), 'minimal'); p.now = D(Date.parse('2026-09-29T03:00:00Z'));
  const b = ctx.buildCouponIssueXml_(p); assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.ok(b.xml.includes('<couponStartDate>2026-09-30T10:00:00+09:00</couponStartDate>') && b.xml.includes('<couponEndDate>2026-10-02T10:00:00+09:00</couponEndDate>'));
  assert.ok(b.xml.includes('<issueCount>1</issueCount>') && b.xml.includes('<discountFactor>100</discountFactor>') && b.xml.includes('<discountType>1</discountType>') && b.xml.includes('<memberAvailMaxCount>1</memberAvailMaxCount>') && b.xml.includes('<itemType>4</itemType>')); });
t('1回目 wrong format → 2回目成功で停止（発行は1件）。sends に試行ごとの記録', () => {
  setDry('false'); books.S_TF.sheets.sends.rows.length = 1; fetchCalls = []; scripted = [NGBODY, OKBODY];
  const r = ctx.runCouponTestTokyoflower(); assert.equal(r.ok, true); assert.equal(r.variant, 'go_model'); assert.equal(fetchCalls.length, 2);
  const rows = books.S_TF.sheets.sends.rows.slice(1); assert.equal(rows.length, 2); assert.ok(rows[0][6].startsWith('ERROR [minimal]')); assert.ok(rows[1][6].includes('TESTCODE1'));
  assert.ok(fetchCalls[0].o.payload.includes('<multiRankCond>') && !fetchCalls[0].o.payload.includes('ageRangeCond')); });
t('3回すべて wrong format なら停止（発行0件・最大3回）', () => { books.S_TF.sheets.sends.rows.length = 1; fetchCalls = []; scripted = [NGBODY]; const r = ctx.runCouponTestTokyoflower(); assert.equal(r.ok, false); assert.equal(fetchCalls.length, 3); });
t('形式以外のエラー（権限など）は再試行しない', () => { fetchCalls = []; scripted = ['<result><status><systemStatus>NG</systemStatus><message>Authentication failed</message></status></result>']; assert.equal(ctx.runCouponTestTokyoflower().ok, false); assert.equal(fetchCalls.length, 1); });
t('テスト後も tokyoflower に coupon_enabled は入らない', () => assert.ok(!books.S_TF.sheets.settings.rows.some(r => r[0] === 'coupon_enabled')));

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
