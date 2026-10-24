// node tests/review_ext_tests.js — 店舗配布用 Chrome 拡張のレビュー取込（action=ext_ingest_reviews）/ 拡張用トークン / 受信途絶チェック /
//   import_reviews の既存列保持 / レビュー本文が空でもお礼メール対象になること。値はすべて架空。
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

// ---- GAS mock ----
const toSigned = b => (b > 127 ? b - 256 : b);
let fakeNow = new Date('2026-10-12T10:00:00+09:00');
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', SECRETS_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_TOKEN: 'adm', ADMIN_EMAIL: 'admin@example.jp' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) };
const fmt = (d, f) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return f === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
const Utilities = {
  computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(toSigned),
  getUuid: () => crypto.randomUUID(), formatDate: (d, tz, f) => fmt(d, f), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
  base64Encode: x => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => b & 255))).toString('base64'),
  base64Decode: b64 => [...Buffer.from(b64, 'base64')].map(toSigned),
  newBlob: x => typeof x === 'string' ? { getBytes: () => [...Buffer.from(x, 'utf8')].map(toSigned) } : { getDataAsString: () => Buffer.from(x.map(b => b & 255)).toString('utf8') },
  computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key.map(b => b & 255))).update(Buffer.from(data.map(b => b & 255))).digest()].map(toSigned),
};
const logs = []; const Logger = { log: m => logs.push(String(m)) };
let writeCalls = 0;   // setValues の呼び出し回数（まとめ書きの確認用）
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(1, ...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => { writeCalls++; v.forEach((row, i) => { while (s.rows.length < r + i) s.rows.push([]); row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }); },
    setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } deleteRow(i) { this.rows.splice(i - 1, 1); } }
class SS { constructor(sheets) { this.sheets = sheets; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } getSpreadsheetTimeZone() { return 'Asia/Tokyo'; } }
let lockOk = true;
const LockService = { getScriptLock: () => ({ tryLock: () => lockOk, releaseLock: () => {} }) };
const mails = [];
const MailApp = { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } };

const MASTER_HEADER = ['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email', 'plan', 'billing_provider', 'billing_status', 'trial_start', 'trial_end', 'fincode_customer_id', 'fincode_subscription_id', 'billing_updated_at', 'billing_note'];
const mrow = (id, name, ss, status, bst, trialEnd = '') => [id, name, ss, status, id + '@example.jp', '', 'standard', 'manual', bst, '', trialEnd, '', '', '', ''];
const master = new Sheet([MASTER_HEADER,
  mrow('tokyoflower', '東京', 'SS_TF', 'active', 'active'),
  mrow('shopa', 'A店', 'SS_A', 'active', 'active'),
  mrow('shopb', 'B店', 'SS_B', 'paused', 'active'),
  mrow('shopc', 'C店', 'SS_C', 'disabled', 'active'),
  mrow('shopd', 'D店', 'SS_D', 'setup', 'trial', '2026-11-01'),
  mrow('shope', 'E店', 'SS_E', 'active', 'canceled'),
  mrow('shopf', 'F店', 'SS_F', 'active', 'trial', '2026-10-01'),   // trial 終了済み
]);
const REV7 = ['review_id', 'order_number', 'buyer_key', 'item_code', 'rating', 'posted_at', 'body'];
const ORD_HDR = ['order_number', 'order_date', 'buyer_key', 'masked_email', 'buyer_name', 'item_code', 'item_name', 'amount', 'purchase_count', 'prefecture', 'ship_date', 'status', 'review_linked'];
const books = { MASTER: new SS({ tenants: master }) };
const mkBook = (settingRows = []) => new SS({
  settings: new Sheet([['key', 'value', 'description', 'editable_by_tenant'], ['go_live_date', '2026-08-22', '', 'FALSE'], ['follow_days_after_ship', '5', '', 'TRUE'], ['dry_run', 'false', '', 'FALSE'], ['exclude_orders', '', '', 'FALSE']].concat(settingRows)),
  reviews: new Sheet([REV7]),
  orders: new Sheet([ORD_HDR, ['111111-20260901-0000000001', '2026-09-01', 'b1', 'a@example.jp', '山田', '', '', 5000, 1, '', '2026-09-03', 'shipped', '']]),
  sends: new Sheet([['send_id', 'order_number', 'buyer_key', 'type', 'sent_at', 'template_id', 'result']]),
  templates: new Sheet([['template_id', 'subject', 'body', 'updated_at']]),
});
['SS_TF', 'SS_A', 'SS_B', 'SS_C', 'SS_D', 'SS_E', 'SS_F'].forEach(id => { books[id] = mkBook(); });
const SpreadsheetApp = { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; } };

const ctx = { PropertiesService, Utilities, Logger, SpreadsheetApp, LockService, MailApp, console, notifyAdmin_: () => {}, isDryRun_: () => false, RMS_BASE: 'x', formatRmsDate_: () => '',
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  Date: class extends Date { constructor(...a) { super(...(a.length ? a : [fakeNow.getTime()])); } static now() { return fakeNow.getTime(); } } };
vm.createContext(ctx);
['crypto_store.gs', 'auth.gs', 'tenant.gs', 'config.gs', 'billing.gs', 'onboarding.gs', 'admin_api.gs', 'purge.gs', 'analytics_backfill.gs', 'mailer.gs', 'reviews_import.gs', 'reviews_ingest.gs', 'reviews_ext.gs', 'review_thanks.gs', 'webapp.gs']
  .forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
const rapi = load('rakuten_api.gs'); const li = rapi.indexOf('function linkOrdersReviews('); vm.runInContext(rapi.substring(li, rapi.indexOf('\n}\n', li) + 3), ctx);
vm.runInContext('function jsonResponse_(o) { return o; }', ctx);

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const authSheet = () => books.MASTER.sheets.tenant_auth;
const events = id => books.MASTER.sheets.billing_events ? books.MASTER.sheets.billing_events.rows.slice(1).filter(r => r[2] === id).map(r => r[4]) : [];
const revSheet = id => books['SS_' + { tokyoflower: 'TF', shopa: 'A', shopb: 'B', shopc: 'C', shopd: 'D', shope: 'E', shopf: 'F' }[id]].sheets.reviews;
const setSetting = (bookId, key, value) => { const s = books[bookId].sheets.settings; const r = s.rows.find(x => x[0] === key); if (r) r[1] = value; else s.rows.push([key, value, '', 'FALSE']); };
const URL = n => `https://review.example.jp/item/1/shop_${n}/`;
const ORD = n => `111111-20260901-${String(n).padStart(10, '0')}`;
const good = (n, o = {}) => Object.assign({ review_id: URL(n), order_number: ORD(n), review_type: '商品レビュー', rating: 5, posted_at: '2026/9/1 9:05:03', title: 'SECRET-TITLE', body: 'SECRET-BODY', product_title: 'SECRET-PRODUCT', flag: 1, rakuten_item_id: 'X1' }, o);
const call = (token, reviews, extra = {}) => ctx.handleExtIngestReviews_(Object.assign({ token, reviews }, extra));

console.log('拡張用トークン（発行・失効・ハッシュ保存）');
let TA, TA_OLD;
t('発行: sse_ + 英数64文字。シートにはハッシュのみで平文は残らない', () => {
  TA = ctx.issueExtToken_('shopa');
  assert.ok(/^sse_[0-9a-f]{64}$/.test(TA), TA);
  const rows = authSheet().rows; const hdr = rows[0];
  assert.ok(hdr.includes('last_used_at'));
  const r = rows.find(x => x[hdr.indexOf('kind')] === 'ext_review');
  assert.equal(r[hdr.indexOf('status')], 'active'); assert.equal(r[hdr.indexOf('token_hash')], ctx.hashToken_(TA));
  assert.ok(!JSON.stringify(rows).includes(TA) && !JSON.stringify(rows).includes(TA.slice(4)), '平文がシートにある');
  assert.ok(!logs.join('\n').includes(TA), '平文がログにある');
});
t('再発行: 旧は revoked・新は active（有効は常に1つ）。旧は token_revoked、新は通る', () => {
  TA_OLD = TA; TA = ctx.issueExtToken_('shopa');
  const hdr = authSheet().rows[0]; const ext = authSheet().rows.slice(1).filter(x => x[hdr.indexOf('kind')] === 'ext_review' && x[0] === 'shopa');
  assert.equal(ext.length, 2); assert.equal(ext.filter(x => x[hdr.indexOf('status')] === 'active').length, 1);
  assert.equal(call(TA_OLD, []).error, 'token_revoked'); assert.equal(call(TA, [], { dry_run: true }).ok, true);
});
t('ext トークンは verifyTenantToken_ で解決されず、テナント用アクション（管理画面API）に使えない', () => {
  assert.equal(ctx.verifyTenantToken_(TA), null);
  ['get_settings', 'get_history', 'update_setting', 'import_reviews'].forEach(a => assert.deepEqual(ctx.handleTenantAction_({ token: TA, action: a, payload: { csv: 'x', key: 'dry_run', value: 'false' } }), { ok: false, error: 'unauthorized' }, a));
});
t('revokeTenantToken_ は ext_review を巻き込まず、revokeExtToken_ は kind=token を巻き込まない。active_tokens は kind=token のみ', () => {
  const plain = ctx.issueTenantToken_('shopa'); assert.equal(ctx.verifyTenantToken_(plain), 'shopa');
  assert.equal(ctx.revokeTenantToken_('shopa'), 1);
  assert.equal(ctx.verifyTenantToken_(plain), null); assert.equal(call(TA, [], { dry_run: true }).ok, true, 'ext は生きている');
  const plain2 = ctx.issueTenantToken_('shopa');
  const a = ctx.adminListTenants_().find(x => x.tenant_id === 'shopa'); assert.equal(a.active_tokens, 1);
  assert.equal(ctx.revokeExtToken_('shopa'), 1);
  assert.equal(ctx.verifyTenantToken_(plain2), 'shopa', 'kind=token は生きている'); assert.equal(call(TA, [], { dry_run: true }).error, 'token_revoked');
  TA = ctx.issueExtToken_('shopa');   // 以降のテスト用に再発行
});
t('rotateTokenTokyoflower 相当（revokeTenantToken_）でも他テナント・ext は影響を受けない', () => {
  const tfExt = ctx.issueExtToken_('tokyoflower'); ctx.revokeTenantToken_('tokyoflower');
  assert.equal(call(tfExt, [], { dry_run: true }).ok, true);
  ctx.revokeExtToken_('tokyoflower');   // tokyoflower に ext トークンを残さない
});
t('不明・空・非文字列のトークンは unauthorized（理由を区別しない）', () => {
  [undefined, null, '', 'sse_' + 'a'.repeat(64), 12345, {}, 'x'.repeat(500)].forEach(tk => assert.equal(call(tk, []).error, 'unauthorized', String(tk)));
  assert.equal(ctx.handleExtIngestReviews_(null).error, 'unauthorized');
});
t('通常のテナントトークン・管理者トークンでは ext_ingest_reviews は通らない', () => {
  const plain = ctx.issueTenantToken_('shopa'); assert.equal(call(plain, []).error, 'unauthorized'); assert.equal(call('adm', []).error, 'unauthorized');
});

console.log('拒否条件（dry_run でも同じ）');
t('テナント status: paused / disabled は tenant_not_active、setup は通る', () => {
  const tb = ctx.issueExtToken_('shopb'), tc = ctx.issueExtToken_('shopc'), td = ctx.issueExtToken_('shopd');
  [false, true].forEach(dry => { assert.equal(call(tb, [good(1)], { dry_run: dry }).error, 'tenant_not_active'); assert.equal(call(tc, [good(1)], { dry_run: dry }).error, 'tenant_not_active'); });
  assert.equal(call(td, [], { dry_run: true }).ok, true);
  assert.equal(revSheet('shopb').rows.length, 1);
});
t('課金NG（canceled / trial 終了）は billing_not_allowed', () => {
  const te = ctx.issueExtToken_('shope'), tf = ctx.issueExtToken_('shopf');
  [false, true].forEach(dry => { assert.equal(call(te, [], { dry_run: dry }).error, 'billing_not_allowed'); assert.equal(call(tf, [], { dry_run: dry }).error, 'billing_not_allowed'); });
});
t('課金NGの拒否は pipeline_log に副作用を残さない', () => { assert.ok(!books.MASTER.sheets.pipeline_log || books.MASTER.sheets.pipeline_log.rows.length <= 1); });
t('失効トークンは dry_run でも token_revoked', () => { assert.equal(call(TA_OLD, [], { dry_run: true }).error, 'token_revoked'); });
t('reviews が配列でない → invalid_payload / 501件 → too_many_rows / サイズ過大 → invalid_payload / メッセージは日本語', () => {
  ['x', null, undefined, {}, 5].forEach(v => assert.equal(call(TA, v).error, 'invalid_payload'));
  const many = Array.from({ length: 501 }, (_, i) => good(i + 1)); const r = call(TA, many); assert.equal(r.error, 'too_many_rows'); assert.ok(/[\u3040-\u9fff]/.test(r.message));
  assert.equal(call(TA, many, { dry_run: true }).error, 'too_many_rows');
  assert.equal(call(TA, [good(1, { review_type: 'x'.repeat(3 * 1024 * 1024) })]).error, 'invalid_payload');
  assert.equal(revSheet('shopa').rows.length, 1, '拒否時は何も書かない');
});
t('review_ingest_enabled が未設定でも通る（ECOS 経路専用の設定）', () => { assert.equal(call(TA, [], { dry_run: true }).ok, true); });

console.log('dry_run（何も書かない）');
t('dry_run: シート・列・認証シートの last_used_at を一切変えず、件数と initial_from を返す', () => {
  const snapRev = JSON.stringify(revSheet('shopa').rows), snapAuth = JSON.stringify(authSheet().rows), snapOrd = JSON.stringify(books.SS_A.sheets.orders.rows);
  const w0 = writeCalls;
  const r = call(TA, [good(1), good(2), good(3, { rating: 9 })], { dry_run: true });
  assert.equal(r.ok, true); assert.equal(r.dry_run, true); assert.equal(r.received, 3); assert.equal(r.valid, 2); assert.equal(r.rejected, 1);
  assert.equal(r.would_insert, 2); assert.equal(r.would_update, 0); assert.equal(r.inserted, 0); assert.equal(r.updated, 0);
  assert.equal(r.initial_from, '2026-09-12', '設定なしは JST 30日前');
  assert.equal(JSON.stringify(revSheet('shopa').rows), snapRev); assert.equal(JSON.stringify(authSheet().rows), snapAuth); assert.equal(JSON.stringify(books.SS_A.sheets.orders.rows), snapOrd);
  assert.equal(writeCalls, w0, 'setValues が呼ばれていない'); assert.equal(revSheet('shopa').rows[0].length, 7, 'ensure 系の列追加もしない');
});
t('dry_run の指定が true / "true" / 不明な値のときは書かない（fail-closed）。false / "false" / 未指定は実行', () => {
  const snap = JSON.stringify(revSheet('shopa').rows);
  [true, 'true', 1, 'yes'].forEach(v => assert.equal(call(TA, [good(1)], { dry_run: v }).dry_run, true, String(v)));
  assert.equal(JSON.stringify(revSheet('shopa').rows), snap);
});
t('dry_run は既存行を数えて would_update にする', () => {
  call(TA, [good(1)]);
  const r = call(TA, [good(1), good(2)], { dry_run: true }); assert.equal(r.would_update, 1); assert.equal(r.would_insert, 1);
});

console.log('取込（5項目・冪等・既存列保持）');
t('新規: 5項目だけを書き、source=chrome_ext・body/product_title は空。title/body/product_title/flag はシートにもログにも出ない', () => {
  const sh = revSheet('shopa'); const hdr = sh.rows[0]; const h = c => hdr.indexOf(c);
  assert.deepEqual(hdr.slice(0, 7), REV7); assert.deepEqual(hdr.slice(7), ['review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at', 'matched']);
  const row = sh.rows.find(r => r[h('review_id')] === URL(1));
  assert.equal(row[h('order_number')], ORD(1)); assert.equal(row[h('rating')], 5); assert.equal(row[h('posted_at')], '2026-09-01 09:05:03'); assert.equal(row[h('review_type')], '商品レビュー');
  assert.equal(row[h('source')], 'chrome_ext'); assert.equal(row[h('body')], ''); assert.equal(row[h('product_title')], ''); assert.equal(row[h('rakuten_item_id')], ''); assert.equal(row[h('buyer_key')], ''); assert.equal(row[h('deleted_at')], '');
  assert.equal(row[h('updated_at')], '2026-10-12 10:00:00');
  const dump = JSON.stringify(books.SS_A.sheets) + logs.join('\n') + JSON.stringify(authSheet().rows);
  ['SECRET-TITLE', 'SECRET-BODY', 'SECRET-PRODUCT', 'X1'].forEach(s => assert.ok(!dump.includes(s), s));
});
t('冪等: 同じデータを2回送っても1件（inserted=0 / updated=件数）。行数不変', () => {
  const n = revSheet('shopa').rows.length;
  const r = call(TA, [good(1), good(2)]); assert.equal(r.inserted, 1); assert.equal(r.updated, 1);
  const r2 = call(TA, [good(1), good(2)]); assert.equal(r2.inserted, 0); assert.equal(r2.updated, 2); assert.equal(revSheet('shopa').rows.length, n + 1);
  assert.equal(new Set(revSheet('shopa').rows.slice(1).map(r => r[0])).size, revSheet('shopa').rows.length - 1);
});
t('ログにはテナントIDと件数のみ（トークン・URL・注文番号を出さない）', () => {
  const ext = logs.filter(l => l.includes('ext_ingest_reviews')); assert.ok(ext.length > 0);
  ext.forEach(l => { assert.ok(/^\[[a-z]+\] /.test(l)); assert.ok(!l.includes('http') && !l.includes('111111-') && !l.includes('sse_')); });
});
t('既存行（ECOS 由来）の更新は order_number/rating/posted_at/review_type/updated_at のみ。body・buyer_key・item_code・product_title・deleted_at・matched・source は不変', () => {
  const sh = revSheet('shopa'); const hdr = sh.rows[0]; const h = c => hdr.indexOf(c);
  const row = Array(hdr.length).fill(''); const set = (c, v) => { row[h(c)] = v; };
  set('review_id', URL(50)); set('order_number', 'OLD-ORDER'); set('buyer_key', 'bk-keep'); set('item_code', 'item-keep'); set('rating', 2); set('posted_at', '2020-01-01 00:00:00'); set('body', '【t】\nkeep-body');
  set('review_type', 'OLDTYPE'); set('product_title', 'keep-product'); set('rakuten_item_id', 'keep-id'); set('source', 'ecos_webhook'); set('updated_at', '2020-01-02 00:00:00'); set('deleted_at', '2026-01-01 00:00:00'); set('matched', 'TRUE');
  sh.rows.push(row);
  const keepOthers = () => JSON.stringify(sh.rows.filter(x => ![URL(50), URL(1), URL(2)].includes(x[h('review_id')])));
  const others = keepOthers();
  const r = call(TA, [good(50, { rating: 4, order_number: ORD(50), review_type: 'ショップレビュー' })]); assert.equal(r.updated, 1);
  const after = sh.rows.find(x => x[h('review_id')] === URL(50));
  assert.equal(after[h('order_number')], ORD(50)); assert.equal(after[h('rating')], 4); assert.equal(after[h('posted_at')], '2026-09-01 09:05:03'); assert.equal(after[h('review_type')], 'ショップレビュー'); assert.equal(after[h('updated_at')], '2026-10-12 10:00:00');
  assert.equal(after[h('body')], '【t】\nkeep-body'); assert.equal(after[h('buyer_key')], 'bk-keep'); assert.equal(after[h('item_code')], 'item-keep'); assert.equal(after[h('product_title')], 'keep-product');
  assert.equal(after[h('source')], 'ecos_webhook'); assert.equal(after[h('deleted_at')], '2026-01-01 00:00:00'); assert.equal(after[h('rakuten_item_id')], 'keep-id');
  assert.equal(after[h('matched')], 'FALSE', 'matched は markReviewOrderMatches_ が突合結果で更新する（注文が無いので FALSE）');
  assert.equal(keepOthers(), others, '対象外の行は不変');
});
t('review_type が空のときは既存の review_type を空で上書きしない', () => {
  const sh = revSheet('shopa'); const hdr = sh.rows[0]; const h = c => hdr.indexOf(c);
  call(TA, [good(50, { review_type: '' })]); assert.equal(sh.rows.find(x => x[h('review_id')] === URL(50))[h('review_type')], 'ショップレビュー');
});
t('不正行は書かずに rejected（理由コード別の件数。値は返さない）', () => {
  const sh = revSheet('shopa'); const n = sh.rows.length;
  const bad = [
    good(101, { review_id: 'ftp://x/1' }), good(102, { review_id: 'https://' + 'a'.repeat(500) }), good(103, { review_id: '' }),
    good(104, { rating: 0 }), good(105, { rating: 6 }), good(106, { rating: 2.5 }), good(107, { rating: 'x' }), good(108, { rating: true }),
    good(109, { posted_at: 'abc' }), good(110, { posted_at: '2026/13/40' }), good(111, { posted_at: '2026/9/1 25:00:00' }), good(112, { posted_at: '' }), good(113, { posted_at: 'x 2026/9/1' }),
    good(114, { order_number: 'ABC-1' }), good(115, { order_number: '12 34' }), good(116, { order_number: '1'.repeat(65) }), good(117, { order_number: '' }), good(118, { order_number: 123456 }),
    good(119, { review_type: '=cmd' }), good(120, { review_type: 'x'.repeat(31) }),
    null, 'str', 5, [],
  ];
  const r = call(TA, bad); assert.equal(r.ok, true); assert.equal(r.received, bad.length); assert.equal(r.valid, 0); assert.equal(r.rejected, bad.length); assert.equal(r.inserted + r.updated, 0);
  assert.equal(sh.rows.length, n);
  assert.deepEqual(r.rejected_reasons, { review_id: 3, rating: 5, posted_at: 5, order_number: 5, review_type: 2, not_object: 4 });
  const s = JSON.stringify(r); assert.ok(!s.includes('http') && !s.includes('111111-'), '値を返さない');
});
t('正常な形式のゆれは受ける: 時が1桁・秒なし・日付のみ・rating が数字文字列・review_type 省略', () => {
  const r = call(TA, [good(201, { posted_at: '2026/9/1 9:05' }), good(202, { posted_at: '2026-09-01' }), good(203, { rating: '3' }), good(204, { review_type: undefined }), good(205, { posted_at: '2026/09/01 09:05:03' })]);
  assert.equal(r.valid, 5); assert.equal(r.rejected, 0);
  const sh = revSheet('shopa'); const h = c => sh.rows[0].indexOf(c); const get = n => sh.rows.find(x => x[0] === URL(n));
  assert.equal(get(201)[h('posted_at')], '2026-09-01 09:05:00'); assert.equal(get(202)[h('posted_at')], '2026-09-01'); assert.equal(get(203)[h('rating')], 3); assert.equal(get(204)[h('review_type')], '');
});
t('同一リクエスト内の重複 review_id は後勝ちで1件', () => {
  const r = call(TA, [good(301, { rating: 1 }), good(301, { rating: 4 })]); assert.equal(r.valid, 2); assert.equal(r.inserted, 1); assert.equal(r.duplicates, 1);
  const sh = revSheet('shopa'); const rows = sh.rows.filter(x => x[0] === URL(301)); assert.equal(rows.length, 1); assert.equal(rows[0][sh.rows[0].indexOf('rating')], 4);
});
t('本文の tenant_id は読まない（別テナント tokyoflower を指定しても shopa のシートにだけ書く）', () => {
  const tf = JSON.stringify(books.SS_TF.sheets); call(TA, [good(401)], { tenant_id: 'tokyoflower' });
  assert.equal(JSON.stringify(books.SS_TF.sheets), tf); assert.ok(revSheet('shopa').rows.some(x => x[0] === URL(401)));
});
t('書き込み後に orders との突合: review_linked と matched が更新される', () => {
  call(TA, [good(1, { order_number: '111111-20260901-0000000001' })]);
  const h = c => revSheet('shopa').rows[0].indexOf(c);
  assert.equal(books.SS_A.sheets.orders.rows[1][12], 'true');
  assert.equal(revSheet('shopa').rows.find(x => x[0] === URL(1))[h('matched')], 'TRUE');
});
t('500件の取込・再取込でも setValues はまとめ書き（1行ずつではない）', () => {
  const rows = Array.from({ length: 500 }, (_, i) => good(1000 + i));
  let w = writeCalls; const r1 = call(TA, rows); const first = writeCalls - w;
  assert.equal(r1.ok, true); assert.equal(r1.inserted, 500);
  w = writeCalls; const r2 = call(TA, rows); const second = writeCalls - w;
  assert.equal(r2.updated, 500); assert.equal(r2.inserted, 0); assert.ok(first <= 12 && second <= 20, `setValues ${first}/${second} 回`);
});
t('ロックが取れなければ busy で何も書かない（last_used_at も更新しない）', () => {
  lockOk = false; const snap = JSON.stringify(revSheet('shopa').rows), a = JSON.stringify(authSheet().rows);
  assert.equal(call(TA, [good(9999)]).error, 'busy'); lockOk = true;
  assert.equal(JSON.stringify(revSheet('shopa').rows), snap); assert.equal(JSON.stringify(authSheet().rows), a);
});

console.log('last_used_at / initial_from');
t('実書き込みで ext_review 行の last_used_at に JST 日時が入る（kind=token の行には入らない）', () => {
  const hdr = authSheet().rows[0]; const lu = hdr.indexOf('last_used_at');
  const row = authSheet().rows.find(r => r[hdr.indexOf('kind')] === 'ext_review' && r[hdr.indexOf('status')] === 'active' && r[0] === 'shopa');
  assert.equal(row[lu], '2026-10-12 10:00:00');
  authSheet().rows.slice(1).filter(r => r[hdr.indexOf('kind')] !== 'ext_review').forEach(r => assert.ok(!r[lu]));
});
t('reviews が空配列でも last_used_at が更新される（同期完了の心拍）。dry_run では更新されない', () => {
  const hdr = authSheet().rows[0]; const lu = hdr.indexOf('last_used_at');
  const get = () => authSheet().rows.find(r => r[hdr.indexOf('kind')] === 'ext_review' && r[hdr.indexOf('status')] === 'active' && r[0] === 'shopa')[lu];
  fakeNow = new Date('2026-10-13T08:00:00+09:00');
  call(TA, [], { dry_run: true }); assert.equal(get(), '2026-10-12 10:00:00');
  const r = call(TA, []); assert.equal(r.ok, true); assert.equal(r.received, 0); assert.equal(r.inserted + r.updated, 0); assert.equal(get(), '2026-10-13 08:00:00');
  assert.equal(call(TA, [good(1, { rating: 9 })]).valid, 0);   // 全行不正でも書き込み処理自体は成功
});
t('initial_from: review_thanks_since があればその日付、無ければ JST の30日前（dry_run・通常とも常に返す）', () => {
  assert.equal(call(TA, [], { dry_run: true }).initial_from, '2026-09-13'); assert.equal(call(TA, []).initial_from, '2026-09-13');
  setSetting('SS_A', 'review_thanks_since', '2026-09-20');
  assert.equal(call(TA, [], { dry_run: true }).initial_from, '2026-09-20'); assert.equal(call(TA, []).initial_from, '2026-09-20');
  setSetting('SS_A', 'review_thanks_since', '');
});

console.log('doPost 経由 / 管理者アクション');
t('doPost: action=ext_ingest_reviews で payload.token により取り込める。テナント用アクションの分岐には落ちない', () => {
  const post = o => ctx.doPost({ postData: { contents: JSON.stringify(o) } });
  const r = post({ action: 'ext_ingest_reviews', payload: { token: TA, dry_run: true, reviews: [good(1)] } }); assert.equal(r.ok, true); assert.equal(r.would_update, 1);
  assert.equal(post({ action: 'ext_ingest_reviews', payload: { token: 'bad', reviews: [] } }).error, 'unauthorized');
  assert.equal(post({ action: 'ext_ingest_reviews', token: TA, payload: { reviews: [] } }).error, 'unauthorized', 'トップレベル token は見ない');
  assert.ok(!vm.runInContext('ADMIN_ACTIONS_', ctx).includes('ext_ingest_reviews'));
});
t('管理者アクション: issue_ext_token / revoke_ext_token は ADMIN_TOKEN 必須。発行の平文は応答に一度だけ', () => {
  const A = vm.runInContext('ADMIN_ACTIONS_', ctx); ['issue_ext_token', 'revoke_ext_token', 'final_delete_tenant'].forEach(a => assert.ok(A.includes(a), a));
  assert.equal(ctx.handleAdminAction_({ token: 'wrong', action: 'issue_ext_token', payload: { tenant_id: 'shopa' } }).error, 'unauthorized');
  assert.equal(ctx.handleAdminAction_({ token: TA, action: 'issue_ext_token', payload: { tenant_id: 'shopa' } }).error, 'unauthorized', 'ext トークンでは管理者アクション不可');
  assert.equal(ctx.handleAdminAction_({ token: 'adm', action: 'issue_ext_token', payload: { tenant_id: 'ghost' } }).error, 'tenant_not_found');
  const r = ctx.handleAdminAction_({ token: 'adm', action: 'issue_ext_token', payload: { tenant_id: 'shopa' } }); assert.equal(r.ok, true); assert.ok(/^sse_/.test(r.token));
  assert.equal(call(TA, []).error, 'token_revoked'); TA = r.token; assert.equal(call(TA, []).ok, true);
});
t('list_tenants: ext_token_active / issued_at / last_received_at を返し、平文・ハッシュを含まない', () => {
  const l = ctx.adminListTenants_(); const a = l.find(x => x.tenant_id === 'shopa'), tf = l.find(x => x.tenant_id === 'tokyoflower');
  assert.equal(a.ext_token_active, true); assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(a.ext_token_issued_at)); assert.ok(a.ext_last_received_at);
  assert.equal(tf.ext_token_active, false); assert.equal(tf.ext_token_issued_at, ''); assert.equal(tf.ext_last_received_at, '');
  const dump = JSON.stringify(l); assert.ok(!dump.includes(TA) && !dump.includes(ctx.hashToken_(TA)));
  assert.equal(ctx.handleAdminAction_({ token: 'adm', action: 'revoke_ext_token', payload: { tenant_id: 'shopa' } }).revoked, 1);
  assert.equal(ctx.adminListTenants_().find(x => x.tenant_id === 'shopa').ext_token_active, false);
  TA = ctx.issueExtToken_('shopa');
});

console.log('受信途絶の日次チェック（checkExtStale_）');
const setLastUsed = (tid, v) => { const hdr = authSheet().rows[0]; const r = authSheet().rows.find(x => x[0] === tid && x[hdr.indexOf('kind')] === 'ext_review' && x[hdr.indexOf('status')] === 'active'); r[hdr.indexOf('last_used_at')] = v; };
t('ちょうど3日は通知しない / 4日で通知（本文は tenant_id と日数のみ）', () => {
  mails.length = 0; setLastUsed('shopa', '2026-10-10 12:00:00');
  fakeNow = new Date('2026-10-13T09:00:00+09:00'); assert.deepEqual(ctx.checkExtStale_(), []); assert.equal(mails.length, 0);
  fakeNow = new Date('2026-10-14T09:00:00+09:00'); assert.deepEqual(ctx.checkExtStale_(), ['shopa']); assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'admin@example.jp'); assert.ok(mails[0].body.includes('shopa') && mails[0].body.includes('4 日'));
  const all = mails[0].subject + mails[0].body; ['A店', 'http', 'example.jp/', 'sse_'].forEach(s => assert.ok(!all.includes(s), s));
  assert.ok(events('shopa').includes('ext_stale_notified'));
});
t('同日2回目は通知しない / 翌日は再通知', () => {
  assert.deepEqual(ctx.checkExtStale_(), []); assert.equal(mails.length, 1);
  fakeNow = new Date('2026-10-15T09:00:00+09:00'); assert.deepEqual(ctx.checkExtStale_(), ['shopa']); assert.equal(mails.length, 2);
});
t('last_used_at が Date 型（Sheets が変換）でも判定できる', () => {
  mails.length = 0; fakeNow = new Date('2026-10-20T09:00:00+09:00'); setLastUsed('shopa', new Date('2026-10-12T00:00:00+09:00')); // 8日前
  assert.deepEqual(ctx.checkExtStale_(), ['shopa']); assert.ok(mails[0].body.includes('8 日'));
});
t('対象外: token 無し(tokyoflower)・未受信(last_used_at 無し)・paused・失効トークン・受信が新しい', () => {
  mails.length = 0; fakeNow = new Date('2026-10-30T09:00:00+09:00');
  ctx.issueExtToken_('tokyoflower'); /* last_used なし */ const tb = ctx.issueExtToken_('shopb'); setLastUsed('shopb', '2026-10-01 00:00:00');   // paused
  const td = ctx.issueExtToken_('shopd'); setLastUsed('shopd', '2026-10-01 00:00:00');   // setup（active のみ対象）
  setLastUsed('shopa', '2026-10-29 00:00:00');
  assert.deepEqual(ctx.checkExtStale_(), []); assert.equal(mails.length, 0);
  ctx.revokeExtToken_('tokyoflower'); ctx.revokeExtToken_('shopb'); ctx.revokeExtToken_('shopd');
  setLastUsed('shopa', '2026-10-01 00:00:00'); ctx.revokeExtToken_('shopa'); assert.deepEqual(ctx.checkExtStale_(), []);   // 失効済み
  TA = ctx.issueExtToken_('shopa');
});
t('ADMIN_EMAIL 未設定: メールを送らず記録もしない（設定後に再試行できる）', () => {
  mails.length = 0; setLastUsed('shopa', '2026-10-01 00:00:00'); const before = events('shopa').filter(e => e === 'ext_stale_notified').length;
  delete props.ADMIN_EMAIL; assert.deepEqual(ctx.checkExtStale_(), []); assert.equal(mails.length, 0); assert.equal(events('shopa').filter(e => e === 'ext_stale_notified').length, before);
  props.ADMIN_EMAIL = 'admin@example.jp'; assert.deepEqual(ctx.checkExtStale_(), ['shopa']); assert.equal(mails.length, 1);
});
t('checkBillingDaily から呼ばれる（例外が出ても他のチェックを止めない）', () => {
  mails.length = 0; fakeNow = new Date('2026-11-05T09:00:00+09:00'); setLastUsed('shopa', '2026-10-30 00:00:00');
  ctx.checkBillingDaily(); assert.ok(mails.some(m => m.subject.includes('レビュー取込') && m.body.includes('shopa')));
  const orig = ctx.checkExtStale_;
  vm.runInContext('checkExtStale_ = () => { throw new Error("boom"); }', ctx); assert.doesNotThrow(() => ctx.checkBillingDaily());
  ctx.checkExtStale_ = orig;
});

console.log('import_reviews（CSV）の既存列保持');
const IMP_HDR = REV7.concat(['review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at', 'matched']);
t('既存行の更新で ECOS / 拡張由来の追加列（review_type〜matched）を空で上書きしない。CSV が空の buyer_key/item_code/body は既存値を残す', () => {
  const sh = new Sheet([IMP_HDR, [URL(1), 'OLD', 'bk-keep', 'item-keep', 2, '2020-01-01 00:00:00', 'keep-body', '商品レビュー', 'keep-product', 'keep-id', 'ecos_webhook', '2026-10-01 00:00:00', '2026-09-30 00:00:00', 'TRUE']]);
  books.SS_A.sheets.reviews = sh;
  const csv = `レビュー詳細URL,注文番号,総合評価,投稿日時\n${URL(1)},${ORD(1)},4,2026/9/2 8:00:00\n${URL(2)},${ORD(2)},5,2026/9/3 8:00:00\n`;
  const r = ctx.importReviewsFromCsv_('shopa', csv, false); assert.equal(r.ok, true); assert.equal(r.updated, 1); assert.equal(r.inserted, 1);
  const h = c => IMP_HDR.indexOf(c); const row = sh.rows[1];
  assert.equal(row[h('order_number')], ORD(1)); assert.equal(row[h('rating')], 4); assert.equal(row[h('posted_at')], '2026-09-02 08:00:00');
  ['review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at', 'matched', 'buyer_key', 'item_code', 'body'].forEach(c => assert.notEqual(row[h(c)], '', c + ' が消えている'));
  assert.equal(row[h('review_type')], '商品レビュー'); assert.equal(row[h('deleted_at')], '2026-09-30 00:00:00'); assert.equal(row[h('matched')], 'TRUE'); assert.equal(row[h('buyer_key')], 'bk-keep'); assert.equal(row[h('item_code')], 'item-keep'); assert.equal(row[h('body')], 'keep-body');
  const nw = sh.rows[2]; assert.equal(nw[h('review_id')], URL(2)); ['review_type', 'product_title', 'source', 'matched', 'deleted_at', 'buyer_key', 'item_code', 'body'].forEach(c => assert.equal(nw[h(c)], '', '新規行は従来どおり空: ' + c));
});
t('CSV に値がある buyer_key / item_code / body は既存行でも更新する', () => {
  const sh = books.SS_A.sheets.reviews; const h = c => IMP_HDR.indexOf(c);
  const csv = `レビュー詳細URL,注文番号,商品管理番号,総合評価,投稿日時,購入者,レビュー内容\n${URL(1)},${ORD(1)},NEWITEM,3,2026/9/4 8:00:00,NEWBUYER,新しい本文\n`;
  ctx.importReviewsFromCsv_('shopa', csv, false); const row = sh.rows[1];
  assert.equal(row[h('item_code')], 'NEWITEM'); assert.equal(row[h('buyer_key')], 'NEWBUYER'); assert.equal(row[h('body')], '新しい本文'); assert.equal(row[h('rating')], 3);
  assert.equal(row[h('review_type')], '商品レビュー'); assert.equal(row[h('matched')], 'TRUE');
});

console.log('お礼メール: 本文・タイトル・商品名が空のレビューでも対象になる');
t('テンプレート変数は buyer_name/shop_name/ship_date/shop_signature/review_url のみ。既定テンプレートは本文・タイトル・商品名を使わない', () => {
  const vars = ctx.buildReviewThanksMailVars_({ buyer_name: '山田', ship_date: '2026-09-03', order_number: ORD(1) }, { shop_name: 'S', shop_signature: 'sig' });
  assert.deepEqual(Object.keys(vars).sort(), ['buyer_name', 'review_url', 'ship_date', 'shop_name', 'shop_signature']);
  const known = vm.runInContext('KNOWN_TEMPLATE_PLACEHOLDERS_', ctx); ['body', 'title', 'product_title', 'review_body', 'review_title'].forEach(k => assert.ok(!known.includes(k), k));
  const subj = vm.runInContext('REVIEW_THANKS_V1_SUBJECT_DEFAULT_', ctx), body = vm.runInContext('REVIEW_THANKS_V1_BODY_DEFAULT_', ctx);
  assert.deepEqual([...ctx.findUnknownPlaceholders_(subj + body)], []);
  assert.ok(!/\{\{\s*(body|title|product_title)/.test(subj + body));
  const rendered = ctx.renderTemplate_(subj + body, vars); assert.ok(!/\{\{/.test(rendered));
});
t('ext 取込（body/product_title が空）のレビューが collectReviewsByOrder_ / collectPendingReviewThanks_ の対象になる', () => {
  books.SS_A.sheets.reviews = new Sheet([REV7]);
  setSetting('SS_A', 'review_thanks_since', '2026-09-01'); setSetting('SS_A', 'review_thanks_min_rating', '3');
  const r = call(TA, [good(1, { order_number: '111111-20260901-0000000001', posted_at: '2026/9/10 9:05:03' })]); assert.equal(r.inserted, 1);
  const sh = books.SS_A.sheets.reviews; const h = c => sh.rows[0].indexOf(c); assert.equal(sh.rows[1][h('body')], ''); assert.equal(sh.rows[1][h('product_title')], '');
  const m = ctx.collectReviewsByOrder_('shopa'); assert.ok(m['111111-20260901-0000000001']); assert.equal(m['111111-20260901-0000000001'].rating, 5);
  const p = ctx.collectPendingReviewThanks_('shopa'); assert.equal(p.targets.length, 1, JSON.stringify(p.skipped)); assert.equal(p.targets[0].order_number, '111111-20260901-0000000001');
});
t('低評価(<3)は ext 経由でも従来どおり対象外', () => {
  call(TA, [good(1, { order_number: '111111-20260901-0000000001', rating: 2, posted_at: '2026/9/10 9:05:03' })]);
  const p = ctx.collectPendingReviewThanks_('shopa'); assert.equal(p.targets.length, 0); assert.deepEqual(p.skipped.low_rating, ['111111-20260901-0000000001']);
});

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
