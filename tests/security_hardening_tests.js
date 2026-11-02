// node tests/security_hardening_tests.js — 往復での数式復活の防止 / 店舗入力の設定・テンプレート / 拡張トークンの正規優先とキャッシュ /
//   login 回数制限 / 招待コードの形式・回数制限。値はすべて架空。モックは review_ext_tests.js と同じ構成。
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
let cacheRefuse = false;
const cacheStore = {};
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
  CacheService: { getScriptCache: () => ({ get: k => (cacheStore[k] === undefined ? null : cacheStore[k]), put: (k, v) => { if (cacheRefuse && k === 'ext_token_hashes') throw new Error('too large'); cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) },   // 有効期限は模擬しない（テスト内で clearCache で経過を表す）
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
const URL = n => `https://review.rakuten.co.jp/item/1/shop_${n}/`;
const ORD = n => `111111-20260901-${String(n).padStart(10, '0')}`;
const good = (n, o = {}) => Object.assign({ review_id: URL(n), order_number: ORD(n), review_type: '商品レビュー', rating: 5, posted_at: '2026/9/1 9:05:03', title: 'SECRET-TITLE', body: 'SECRET-BODY', product_title: 'SECRET-PRODUCT', flag: 1, rakuten_item_id: 'X1' }, o);
const call = (token, reviews, extra = {}) => ctx.handleExtIngestReviews_(Object.assign({ token, reviews }, extra));

const fmtDay = () => fmt(fakeNow, 'yyyy-MM-dd');

// ---- テスト用の補助 ----
const clearCache = () => Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
const clearProps = prefix => Object.keys(props).filter(k => k.indexOf(prefix) === 0).forEach(k => delete props[k]);
const countSheetOpens = fn => {   // fn 実行中に tenant_auth を開いた回数
  const orig = ctx.getTenantAuthSheet_; let n = 0;
  ctx.getTenantAuthSheet_ = () => { n++; return orig(); };
  try { fn(); } finally { ctx.getTenantAuthSheet_ = orig; }
  return n;
};
const TA = ctx.issueExtToken_('shopa');
const BAD = 'sse_' + 'f'.repeat(64);

console.log('(a) 往復で数式が復活しない（既存行の書き戻し）');
const REV_FULL = REV7.concat(['review_type', 'product_title', 'rakuten_item_id', 'source', 'updated_at', 'deleted_at', 'matched']);
const seedRow = (sh, id, over) => { const h = sh.rows[0]; const r = Array(h.length).fill(''); r[h.indexOf('review_id')] = id; r[h.indexOf('order_number')] = ORD(1); r[h.indexOf('rating')] = 4; Object.keys(over).forEach(k => { r[h.indexOf(k)] = over[k]; }); sh.rows.push(r); };
t('webhook(ingest) の既存行更新: 先頭 \' で保存済みの本文・buyer_key・product_title は更新後も \' 付きのまま（生の = で戻らない）', () => {
  books.SS_A.sheets.reviews = new Sheet([REV_FULL]);
  const sh = books.SS_A.sheets.reviews;
  seedRow(sh, URL(900), { body: "'=HYPERLINK(\"http://x\",\"a\")", buyer_key: "'+cmd", item_code: "'-1+1", rakuten_item_id: 'X' });
  props.REVIEW_INGEST_KEY__shopa = 'k-test'; setSetting('SS_A', 'review_ingest_enabled', 'true'); clearCache();
  const r = ctx.handleIngestReviews_({ tenant_id: 'shopa', api_key: 'k-test', reviews: [{ review_id: URL(900), order_number: ORD(1), rating: 5, posted_at: '2026/9/1 9:05:03', body: 'new body', review_type: '商品レビュー' }] });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.updated, 1);
  const h = c => sh.rows[0].indexOf(c); const row = sh.rows.find(x => x[h('review_id')] === URL(900));
  assert.equal(row[h('buyer_key')], "'+cmd"); assert.equal(row[h('item_code')], "'-1+1");
  sh.rows.forEach(x => x.forEach(c => assert.ok(!/^[=+\-@\t\r]/.test(String(c)), String(c))));
});
t('webhook(ingest): getValues が \' 無しの生文字列を返す実シート相当でも、書き戻しで \' が付く', () => {
  const sh = books.SS_A.sheets.reviews; const h = c => sh.rows[0].indexOf(c);
  const row = sh.rows.find(x => x[h('review_id')] === URL(900)); row[h('buyer_key')] = '=EVIL()'; row[h('item_code')] = '-9';   // 実シートでは \' が消えて返る
  ctx.handleIngestReviews_({ tenant_id: 'shopa', api_key: 'k-test', reviews: [{ review_id: URL(900), order_number: ORD(1), rating: 5, posted_at: '2026/9/1 9:05:03', body: 'again' }] });
  assert.equal(row[h('buyer_key')], "'=EVIL()"); assert.equal(row[h('item_code')], "'-9");
});
t('CSV 取込(import_reviews) の既存行更新: CSV が空で残される buyer_key / item_code / body も無害化して書き戻す', () => {
  const sh = books.SS_A.sheets.reviews; const h = c => sh.rows[0].indexOf(c);
  sh.rows.length = 1; seedRow(sh, URL(901), { body: '=IMPORTXML("x","y")', buyer_key: '=bk', item_code: '+ic' });   // 生で戻ってきた状態
  const csv = 'レビュー詳細URL,注文番号,評価,投稿日時\n' + URL(901) + ',' + ORD(1) + ',5,2026/9/1 9:05:03\n';
  const r = ctx.importReviewsFromCsv_('shopa', csv, false); assert.equal(r.ok, true, JSON.stringify(r));
  const row = sh.rows.find(x => x[h('review_id')] === URL(901));
  assert.equal(row[h('body')], "'=IMPORTXML(\"x\",\"y\")"); assert.equal(row[h('buyer_key')], "'=bk"); assert.equal(row[h('item_code')], "'+ic");
});
t('ext(reviews_ext) の列単位書き戻し: 書く列は order_number / rating / posted_at / review_type / updated_at のみで、いずれも検証済み・正規化済みの値。他の列は触れない', () => {
  const sh = books.SS_A.sheets.reviews; const h = c => sh.rows[0].indexOf(c);
  sh.rows.length = 1; seedRow(sh, URL(902), { body: "'=keep", buyer_key: "'=keep2" });
  const r = call(TA, [good(902, { review_id: URL(902) })], { dry_run: false }); assert.equal(r.updated, 1, JSON.stringify(r));
  const row = sh.rows.find(x => x[h('review_id')] === URL(902)); assert.equal(row[h('body')], "'=keep"); assert.equal(row[h('buyer_key')], "'=keep2");
  sh.rows.forEach(x => x.forEach(c => assert.ok(!/^[=+\-@\t\r]/.test(String(c)), String(c))));
});

console.log('(b) 店舗入力の設定値・テンプレート');
t('settings 値: 文字列の先頭 = + - @ だけ \' 付き。数値文字列・日付・空は壊れない', () => {
  const sh = books.SS_A.sheets.settings; const v = k => sh.rows.find(r => r[0] === k)[1];
  ['=1+1', '+81', '-5', '@x'].forEach(x => { assert.equal(ctx.setTenantSettingValue_('shopa', 'follow_days_after_ship', x).ok, true); assert.equal(v('follow_days_after_ship'), "'" + x); });
  ['7', '2026-11-03', '', '3.5', 'abc'].forEach(x => { ctx.setTenantSettingValue_('shopa', 'follow_days_after_ship', x); assert.strictEqual(v('follow_days_after_ship'), x); });
  assert.deepEqual(ctx.setTenantSettingValue_('shopa', 'go_live_date', '=1'), { ok: false, error: 'not_editable' });
});
t('settings 値(管理者用): 未知キー追加・既存更新とも数式を無害化', () => {
  const sh = books.SS_A.sheets.settings;
  ctx.setTenantSettingValueAdmin_('shopa', 'follow_days_after_ship', '=2'); assert.equal(sh.rows.find(r => r[0] === 'follow_days_after_ship')[1], "'=2");
  ctx.setTenantSettingValueAdmin_('shopa', 'follow_days_after_ship', '5'); assert.strictEqual(sh.rows.find(r => r[0] === 'follow_days_after_ship')[1], '5');
});
t('テンプレート subject / body: 先頭が数式なら無害化。通常の文面はそのまま', () => {
  const sh = books.SS_A.sheets.templates; sh.rows.length = 1; sh.rows.push(['follow_v1', 's', 'b', 'x']);
  assert.equal(ctx.setTenantTemplate_('shopa', 'follow_v1', '=HYPERLINK("x")', '+cmd').ok, true);
  assert.equal(sh.rows[1][1], "'=HYPERLINK(\"x\")"); assert.equal(sh.rows[1][2], "'+cmd");
  ctx.setTenantTemplate_('shopa', 'follow_v1', '{{shop_name}} です', 'こんにちは\n{{buyer_name}} 様'); assert.equal(sh.rows[1][1], '{{shop_name}} です'); assert.equal(sh.rows[1][2], 'こんにちは\n{{buyer_name}} 様');
});

console.log('正規トークンの優先（制限中でも通る）・キャッシュ');
t('制限中でも正規トークンは通る。制限中の無効・形式不正は busy で、カウントを増やさない', () => {
  clearCache(); clearProps('EXT_AUTHFAIL__');
  for (let i = 0; i < 30; i++) assert.equal(call(BAD, []).error, 'unauthorized');
  assert.equal(props['EXT_AUTHFAIL__' + fmtDay()], '30');
  assert.equal(call(TA, [], { dry_run: true }).ok, true, '制限中でも正規は通る');
  assert.equal(call(BAD, []).error, 'busy'); assert.equal(call('garbage', []).error, 'busy'); assert.equal(call(undefined, []).error, 'busy');
  assert.equal(props['EXT_AUTHFAIL__' + fmtDay()], '30', '制限中の無効分は数え増さない');
  clearCache(); assert.equal(call(BAD, []).error, 'unauthorized', '解除後は通常どおり');
});
t('カウントされるのは照合に失敗したものだけ（正規トークンの成功は数えない）', () => {
  clearCache(); clearProps('EXT_AUTHFAIL__');
  for (let i = 0; i < 20; i++) call(TA, [], { dry_run: true });
  assert.equal(props['EXT_AUTHFAIL__' + fmtDay()], undefined);
  call(BAD, []); call('nope', []); assert.equal(props['EXT_AUTHFAIL__' + fmtDay()], '2');
});
t('キャッシュ: 無効トークンの連続でも認証シートは 1 回しか開かない。キャッシュにはハッシュだけで平文は無い', () => {
  clearCache();
  const opened = countSheetOpens(() => { for (let i = 0; i < 10; i++) assert.equal(call('sse_' + String(i).repeat(40), []).error, 'unauthorized'); });
  assert.equal(opened, 1);
  assert.ok(cacheStore.ext_token_hashes, 'キャッシュに載っている');
  assert.ok(!cacheStore.ext_token_hashes.includes(TA) && !cacheStore.ext_token_hashes.includes(TA.slice(4)), '平文が載っている');
  assert.ok(cacheStore.ext_token_hashes.includes(ctx.hashToken_(TA)));
  assert.equal(countSheetOpens(() => assert.equal(call(TA, [], { dry_run: true }).ok, true)), 0, '正規もキャッシュで照合');
});
t('キャッシュ経由でも失効・再発行は即時反映（revoked と unknown の区別も保つ）', () => {
  clearCache(); assert.equal(call(TA, [], { dry_run: true }).ok, true);   // キャッシュに載る
  const TA2 = ctx.issueExtToken_('shopa');                                // 再発行 → キャッシュ破棄
  assert.equal(call(TA, [], { dry_run: true }).error, 'token_revoked'); assert.equal(call(TA2, [], { dry_run: true }).ok, true);
  assert.equal(call(BAD, []).error, 'unauthorized');
  ctx.revokeExtToken_('shopa');                                           // 失効 → キャッシュ破棄
  assert.equal(call(TA2, [], { dry_run: true }).error, 'token_revoked'); assert.equal(call(BAD, []).error, 'unauthorized');
});
t('キャッシュが載らない大きさ(put 失敗)でも動く: シート読みにフォールバックし、制限中は 30 秒に 1 回までしか読まない', () => {
  clearCache(); cacheRefuse = true;
  try {
    assert.equal(countSheetOpens(() => { for (let i = 0; i < 3; i++) assert.equal(call(BAD, []).error, 'unauthorized'); }), 3, '載らないので毎回シートを読む(非制限時)');
    clearCache(); clearProps('EXT_AUTHFAIL__'); cacheStore.ext_auth_fail_block = '1';   // 制限中
    assert.equal(countSheetOpens(() => { for (let i = 0; i < 5; i++) assert.equal(call(BAD, []).error, 'busy'); }), 1, '制限中は 1 回だけ');
  } finally { cacheRefuse = false; clearCache(); }
});

console.log('login 回数制限');
const LOGIN_PW = 'correct-horse-9';
const login = (id, pw) => ctx.loginAttempt_(id, pw);
t('準備: shopa にパスワードを設定', () => { ctx.setTenantPassword_('shopa', LOGIN_PW); assert.ok(login('shopa', LOGIN_PW)); });
t('同じ tenant_id で 10 回失敗すると、正しいパスワードでも拒否。他の tenant_id は影響を受けない', () => {
  clearCache(); clearProps('LOGIN_FAIL__');
  for (let i = 0; i < 9; i++) assert.equal(login('shopa', 'wrong-' + i), null);
  assert.ok(login('shopa', LOGIN_PW), '9 回目までは通る');   // 成功でクリア
  for (let i = 0; i < 10; i++) assert.equal(login('shopa', 'wrong-' + i), null);
  assert.equal(login('shopa', LOGIN_PW), null, '制限中は正しくても拒否');
  ctx.setTenantPassword_('shopb', LOGIN_PW); assert.ok(login('shopb', LOGIN_PW));
});
t('15 分経過で解除。成功でカウントがクリアされる', () => {
  Object.keys(cacheStore).filter(k => k.indexOf('login_') === 0).forEach(k => delete cacheStore[k]);   // TTL 経過相当
  assert.ok(login('shopa', LOGIN_PW));
  for (let i = 0; i < 9; i++) login('shopa', 'x' + i);
  assert.ok(login('shopa', LOGIN_PW)); for (let i = 0; i < 9; i++) login('shopa', 'y' + i);
  assert.ok(login('shopa', LOGIN_PW), '成功でカウントが 0 に戻るので 9 回失敗してもまだ通る');
});
t('存在しない tenant_id も同じ回数で拒否され、応答は同じ(null)。入力は正規化され、形式外は共通バケットに集約', () => {
  clearCache();
  const same = (id) => { for (let i = 0; i < 10; i++) assert.equal(login(id, 'pw' + i), null); return cacheStore['login_blk_' + ctx.normalizeLoginTenantId_(id)]; };
  assert.equal(same('nosuchshop'), '1'); assert.equal(same('shopa'), '1');
  assert.equal(login('NoSuchShop ', LOGIN_PW), null, '大文字・空白は正規化されて同じバケット');
  assert.equal(ctx.normalizeLoginTenantId_('a'.repeat(5000)), '_invalid'); assert.equal(ctx.normalizeLoginTenantId_('x y;--'), '_invalid'); assert.equal(ctx.normalizeLoginTenantId_(undefined), '_invalid');
  same('!!!' + 'z'.repeat(100)); same('???');   // 形式外はどれも同じキー
  assert.deepEqual(Object.keys(cacheStore).filter(k => k.indexOf('login_blk_') === 0).sort(), ['login_blk__invalid', 'login_blk_nosuchshop', 'login_blk_shopa']);
});
t('doPost action=login 経由でも同じ制限（unauthorized のみ。制限中も通常失敗と同じ応答）', () => {
  clearCache(); const post = (id, pw) => JSON.parse(JSON.stringify(ctx.doPost({ postData: { contents: JSON.stringify({ action: 'login', payload: { tenant_id: id, password: pw } }) } })));
  const a = post('nosuchshop', 'x'), b = post('shopa', 'x');
  assert.deepEqual(a, { ok: false, error: 'unauthorized' }); assert.deepEqual(a, b);
  for (let i = 0; i < 12; i++) post('shopa', 'x' + i);
  assert.deepEqual(post('shopa', LOGIN_PW), a);
});
t('日次通知: 前日以前の失敗件数を tenant_id 別に ADMIN_EMAIL へ。当日分は残す。未設定ならログのみ。checkBillingDaily から呼ばれる', () => {
  clearProps('LOGIN_FAIL__'); mails.length = 0; fakeNow = new Date('2026-12-10T09:00:00+09:00');
  props['LOGIN_FAIL__2026-12-09'] = JSON.stringify({ shopa: 12, _invalid: 3, "bad id<script>": 5, nosuchshop: 1 }); props['LOGIN_FAIL__2026-12-10'] = JSON.stringify({ shopa: 1 });
  delete props.ADMIN_EMAIL; assert.deepEqual(ctx.checkLoginFailures_(), []); assert.equal(mails.length, 0); assert.ok(props['LOGIN_FAIL__2026-12-09']);
  props.ADMIN_EMAIL = 'admin@example.jp'; assert.deepEqual(ctx.checkLoginFailures_(), ['2026-12-09']);
  assert.equal(mails.length, 1); assert.ok(mails[0].subject.includes('16件'), mails[0].subject); assert.ok(mails[0].body.includes('shopa: 12') && mails[0].body.includes('_invalid: 3'));
  assert.ok(!mails[0].body.includes('script'), '文字種外の tenant_id は載せない'); assert.equal(props['LOGIN_FAIL__2026-12-09'], undefined); assert.ok(props['LOGIN_FAIL__2026-12-10']);
  mails.length = 0; props['LOGIN_FAIL__2026-12-08'] = JSON.stringify({ shopa: 2 }); ctx.checkBillingDaily(); assert.ok(mails.some(m => m.subject.includes('ログイン失敗')));
});
t('失敗の日別記録は tenant_id 30 種を超えたら _other にまとめる', () => {
  clearCache(); clearProps('LOGIN_FAIL__'); fakeNow = new Date('2026-12-11T09:00:00+09:00');
  for (let i = 0; i < 40; i++) login('shop' + String(i).padStart(3, '0'), 'x');
  const m = JSON.parse(props['LOGIN_FAIL__2026-12-11']); assert.equal(Object.keys(m).length, 31); assert.equal(m._other, 10);
});

console.log('招待コード');
const mkInvite = () => ctx.createInvite_('shopa').invite;
t('生成: 小文字16進40文字(約154bit)。形式外はシートを開かずに無効', () => {
  const code = mkInvite(); assert.ok(/^[0-9a-f]{40}$/.test(code), '形式');
  const sh = books.MASTER.sheets.invites; let opened = 0; const orig = ctx.getInvitesSheet_; ctx.getInvitesSheet_ = () => { opened++; return orig(); };
  ['', 'abc', 'x'.repeat(41), code.toUpperCase().replace(/[0-9A-F]/g, 'G'), 12345, null, undefined, {}].forEach(v => assert.equal(ctx.verifyInvite_(v, false), null));
  assert.equal(opened, 0); assert.equal(ctx.verifyInvite_(code, false), 'shopa'); assert.equal(opened, 1); ctx.getInvitesSheet_ = orig;
});
t('onboard_check: 無効コードが 30 回で一時拒否。有効コードは制限中でも通り、制限中の無効分は数え増さない', () => {
  clearCache(); const code = mkInvite(); const bad = 'a'.repeat(40);
  for (let i = 0; i < 30; i++) assert.equal(ctx.onboardCheck_({ invite: bad }).error, 'invalid_invite');
  assert.ok(cacheStore.invite_fail_block, 'ブロック状態');
  assert.equal(ctx.onboardCheck_({ invite: code }).ok, true, '制限中でも有効コードは通る');
  assert.equal(ctx.onboardCheck_({ invite: bad }).error, 'invalid_invite'); assert.equal(cacheStore.invite_fail_count, undefined, '数え増さない');
  assert.equal(ctx.onboardSubmit_({ invite: bad }).error, 'invalid_invite');
  clearCache(); for (let i = 0; i < 5; i++) ctx.onboardCheck_({ invite: bad }); assert.equal(cacheStore.invite_fail_count, '5');
  ctx.onboardCheck_({ invite: code }); assert.equal(cacheStore.invite_fail_count, '5', '有効コードの成功は数えない');
});

console.log('review_id 制限（validateExtRow_ 経由）');
const rowWith = id => ({ review_id: id, order_number: ORD(1), rating: 5, posted_at: '2026/9/1 9:05:03' });
t('https://review.rakuten.co.jp/ 配下のみ通る', () => {
  ['https://review.rakuten.co.jp/item/1/shop_1/', 'https://review.rakuten.co.jp/a', 'https://review.rakuten.co.jp/shop/x?y=1#z'].forEach(u => assert.ok(ctx.validateExtRow_(rowWith(u)).rec, u));
});
t('http・別ホスト・サブドメイン偽装・@ 偽装・空白入り・パスなし・500 文字超は reason=review_id', () => {
  const bad = ['http://review.rakuten.co.jp/a', 'https://evil.example.com/a', 'https://review.rakuten.co.jp.evil.com/a', 'https://review.rakuten.co.jp@evil.com/a',
    'https://review.rakuten.co.jp/a b', 'https://review.rakuten.co.jp/a\tb', 'https://review.rakuten.co.jp', 'https://REVIEW.rakuten.co.jp.x/a', ' ftp://review.rakuten.co.jp/a', '',
    'https://review.rakuten.co.jp/' + 'a'.repeat(500)];
  bad.forEach(u => assert.deepEqual(ctx.validateExtRow_(rowWith(u)), { reason: 'review_id' }, u.slice(0, 60)));
  assert.deepEqual(ctx.validateExtRow_(rowWith(12345)), { reason: 'review_id' }); assert.deepEqual(ctx.validateExtRow_(rowWith(null)), { reason: 'review_id' });
});

console.log('管理機能（ADMIN_TOKEN）の回数制限');
const ADM = 'adm';   // テスト用モックの値（本番の値ではない）
const admOk = tk => { try { ctx.requireAdmin_(tk); return true; } catch (e) { return e.message === 'unauthorized' ? false : (() => { throw e; })(); } };
const admDay = () => props['ADMIN_AUTHFAIL__' + fmtDay()];
t('正しいトークンは通り、不一致は unauthorized。未設定は常に拒否(fail-closed)', () => {
  clearCache(); clearProps('ADMIN_AUTHFAIL__'); fakeNow = new Date('2026-12-20T09:00:00+09:00');
  assert.equal(admOk(ADM), true); assert.equal(admOk('wrong'), false); assert.equal(admDay(), '1');
  const saved = props.ADMIN_TOKEN; delete props.ADMIN_TOKEN;
  assert.equal(admOk(ADM), false); assert.equal(admOk(''), false); assert.equal(admOk(undefined), false); props.ADMIN_TOKEN = '';
  assert.equal(admOk(''), false); props.ADMIN_TOKEN = saved;
});
t('比較は hash_equals_（定数時間）: 長さ違い・同長で1文字違い・先頭一致の短縮は拒否、完全一致のみ許可', () => {
  assert.equal(ctx.hash_equals_('abcdef', 'abcdef'), true);
  assert.equal(ctx.hash_equals_('abcdef', 'abcdeg'), false); assert.equal(ctx.hash_equals_('abcdef', 'abcde'), false); assert.equal(ctx.hash_equals_('abcde', 'abcdef'), false);
  assert.equal(ctx.hash_equals_('abc', 'abc\u0000'), false, 'NUL 付加でも一致しない'); assert.equal(ctx.hash_equals_('', ''), true); assert.equal(ctx.hash_equals_('x', ''), false);
  const src = fs.readFileSync(path.join(SRC, 'auth.gs'), 'utf8'); const body = src.substring(src.indexOf('function hash_equals_'), src.indexOf('// ===== tenant_auth'));
  assert.ok(!/a\.length\s*!==\s*b\.length/.test(body), '長さの早期 return が無い');
  const reqSrc = src.substring(src.indexOf('function requireAdmin_'), src.indexOf('/** 定数時間比較'));
  assert.ok(reqSrc.includes('hash_equals_(stored, adminToken)') && !/===\s*adminToken|adminToken\s*===/.test(reqSrc), 'requireAdmin_ は hash_equals_ 経由');
  clearCache(); assert.equal(admOk('ad'), false); assert.equal(admOk('admx'), false); assert.equal(admOk('adn'), false); assert.equal(admOk('adm'), true);
});
t('10 回失敗で拒否状態。拒否中も正しいトークンは通り、不一致は数え増さず応答も同じ unauthorized', () => {
  clearCache(); clearProps('ADMIN_AUTHFAIL__');
  for (let i = 0; i < 9; i++) assert.equal(admOk('bad' + i), false);
  assert.equal(admOk(ADM), true, '9 回目までは通る'); assert.equal(cacheStore.admin_auth_fail_block, undefined);
  assert.equal(admOk('bad9'), false); assert.equal(cacheStore.admin_auth_fail_block, '1');
  assert.equal(admDay(), '10');
  assert.equal(admOk(ADM), true, '制限中でも正しいトークンは通る');
  for (let i = 0; i < 5; i++) assert.equal(admOk('bad-more' + i), false);
  assert.equal(admDay(), '10', '制限中の不一致は数え増さない');
  const post = tk => JSON.parse(JSON.stringify(ctx.doPost({ postData: { contents: JSON.stringify({ action: 'list_tenants', token: tk, payload: {} }) } })));
  assert.deepEqual(post('nope'), { ok: false, error: 'unauthorized' }); assert.equal(post(ADM).ok, true, 'doPost 経由でも制限中に正規が通る');
});
t('600 秒経過相当で解除され、再び数えられる', () => {
  Object.keys(cacheStore).filter(k => k.indexOf('admin_auth_fail') === 0).forEach(k => delete cacheStore[k]);
  assert.equal(admOk('again'), false); assert.equal(admDay(), '11'); assert.equal(cacheStore.admin_auth_fail_count, '1');
});
t('制限はテナント系処理(login / 店舗トークン / ext)に影響しない', () => {
  clearCache(); for (let i = 0; i < 12; i++) admOk('x' + i); assert.equal(cacheStore.admin_auth_fail_block, '1');
  ctx.setTenantPassword_('shopa', 'correct-horse-9'); assert.ok(ctx.loginAttempt_('shopa', 'correct-horse-9'));
  const tk = ctx.issueTenantToken_('shopa'); assert.equal(ctx.verifyTenantToken_(tk), 'shopa');
  assert.equal(call(ctx.issueExtToken_('shopa'), [], { dry_run: true }).ok, true);
});
t('日次通知: 前日以前の件数を ADMIN_EMAIL へ(件数のみ)。当日分は残す。未設定ならログのみ。checkBillingDaily から呼ばれる', () => {
  clearCache(); clearProps('ADMIN_AUTHFAIL__'); mails.length = 0; fakeNow = new Date('2026-12-21T09:00:00+09:00');
  props['ADMIN_AUTHFAIL__2026-12-20'] = '14'; props['ADMIN_AUTHFAIL__2026-12-21'] = '2';
  delete props.ADMIN_EMAIL; assert.deepEqual(ctx.checkAdminAuthFailures_(), []); assert.equal(mails.length, 0); assert.ok(props['ADMIN_AUTHFAIL__2026-12-20']);
  props.ADMIN_EMAIL = 'admin@example.jp'; assert.deepEqual(ctx.checkAdminAuthFailures_(), ['2026-12-20']);
  assert.equal(mails.length, 1); assert.ok(mails[0].subject.includes('管理機能の認証失敗') && mails[0].subject.includes('14件')); assert.ok(!mails[0].body.includes(ADM));
  assert.equal(props['ADMIN_AUTHFAIL__2026-12-20'], undefined); assert.equal(props['ADMIN_AUTHFAIL__2026-12-21'], '2');
  mails.length = 0; props['ADMIN_AUTHFAIL__2026-12-19'] = '3'; ctx.checkBillingDaily(); assert.ok(mails.some(m => m.subject.includes('管理機能の認証失敗')));
});

console.log('rotateAdminToken');
t('新しい値は hex 192 文字(約732bit)・毎回異なる・ログに1回だけ。旧い値はログ・プロパティ・戻り値のどこにも出ない。ROTATED_AT は時刻のみ', () => {
  const OLD = 'OLD-ADMIN-VALUE-MARKER-' + 'q'.repeat(30); props.ADMIN_TOKEN = OLD; props.OTHER_KEEP = 'keep'; const before = JSON.stringify(Object.assign({}, props, { ADMIN_TOKEN: 0, ADMIN_TOKEN_ROTATED_AT: 0 }));
  logs.length = 0; fakeNow = new Date('2026-12-22T09:30:15+09:00');
  const ret = ctx.rotateAdminToken(); assert.equal(ret, undefined);
  const v1 = props.ADMIN_TOKEN; assert.ok(/^[0-9a-f]{192}$/.test(v1), '長さ・文字種'); assert.notEqual(v1, OLD);
  assert.equal(logs.filter(l => l.includes(v1)).length, 1, '新しい値は実行ログに1回だけ');
  assert.ok(!logs.join('\n').includes(OLD) && !logs.join('\n').includes('OLD-ADMIN'), '旧い値はログに出ない');
  assert.ok(!JSON.stringify(Object.assign({}, props, { ADMIN_TOKEN: 0 })).includes(OLD), '旧い値はどのプロパティにも残らない');
  assert.equal(props.ADMIN_TOKEN_ROTATED_AT, '2026-12-22 09:30:15'); assert.ok(!props.ADMIN_TOKEN_ROTATED_AT.includes(v1));
  assert.equal(JSON.stringify(Object.assign({}, props, { ADMIN_TOKEN: 0, ADMIN_TOKEN_ROTATED_AT: 0 })), before, '他の Script Properties は変わらない');
  const seen = new Set([v1]); for (let i = 0; i < 20; i++) { ctx.rotateAdminToken(); seen.add(props.ADMIN_TOKEN); } assert.equal(seen.size, 21, '毎回異なる');
  assert.equal(admOk(OLD), false, '旧い値は使えない'); assert.equal(admOk(props.ADMIN_TOKEN), true, '新しい値は使える');
  const src = fs.readFileSync(path.join(SRC, 'auth.gs'), 'utf8'); const fn = src.substring(src.indexOf('function rotateAdminToken'));
  assert.ok(!/getProperty\(/.test(fn), '上書き前に旧値を読まない(getProperty を呼ばない)'); props.ADMIN_TOKEN = ADM;
});

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
