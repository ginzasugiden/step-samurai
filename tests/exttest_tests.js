// node tests/exttest_tests.js — 拡張機能の疎通確認用テナント exttest の作成・撤去（setupExtTestTenant / teardownExtTestTenant）。値はすべて架空。DriveApp 等はモック
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const toSigned = b => (b > 127 ? b - 256 : b);
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', SECRETS_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_TOKEN: 'adm', ADMIN_EMAIL: 'admin@example.jp' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) };
const fmt = (d, f) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; if (f === 'yyyyMMdd-HHmmss') return s.split('-').join('') + `-${p(j.getUTCHours())}${p(j.getUTCMinutes())}${p(j.getUTCSeconds())}`; return f === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
const Utilities = {
  base64Encode: x => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => b & 255))).toString('base64'),
  base64Decode: b64 => [...Buffer.from(b64, 'base64')].map(toSigned),
  computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key.map(b => b & 255))).update(Buffer.from(data.map(b => b & 255))).digest()].map(toSigned),
  computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(toSigned),
  newBlob: x => typeof x === 'string' ? { getBytes: () => [...Buffer.from(x, 'utf8')].map(toSigned) } : { getDataAsString: () => Buffer.from(x.map(b => b & 255)).toString('utf8') },
  getUuid: () => crypto.randomUUID(), formatDate: (d, tz, f) => fmt(d, f), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
};
class Sheet { constructor(rows, name) { this.rows = rows.map(r => r.slice()); this.name = name; }
  getName() { return this.name; } setName(n) { this.name = n; if (this.ss) { delete this.ss.sheets[this.key]; this.ss.sheets[n] = this; this.key = n; } }
  getLastColumn() { return Math.max(1, ...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return { getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => v.forEach((row, i) => { while (s.rows.length < r + i) s.rows.push([]); row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }), setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } deleteRow(i) { this.rows.splice(i - 1, 1); } }
let ssSeq = 0; const books = {};
class SS { constructor(sheets) { this.sheets = sheets; Object.keys(sheets).forEach(k => { sheets[k].ss = this; sheets[k].key = k; }); this.id = 'SS_' + (++ssSeq); books[this.id] = this; }
  getId() { return this.id; } getSheets() { return Object.values(this.sheets); } getSheetByName(n) { return this.sheets[n] || null; } getSpreadsheetTimeZone() { return 'Asia/Tokyo'; }
  insertSheet(n) { const sh = new Sheet([], n); sh.ss = this; sh.key = n; return (this.sheets[n] = sh); }
  copy(name) { const sheets = {}; Object.keys(this.sheets).forEach(k => { sheets[k] = new Sheet(this.sheets[k].rows, k); }); const n = new SS(sheets); n.name = name; return n; }
  rename(name) { this.name = name; } }
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'], ['tokyoflower', '東京', 'SS_TF', 'active', 'a@x.jp', '']], 'tenants');
new SS({ tenants: master }); books.MASTER = books.SS_1; delete books.SS_1;
const ORD_HDR = ['order_number', 'order_date', 'buyer_key', 'masked_email', 'buyer_name', 'item_code', 'item_name', 'amount', 'purchase_count', 'prefecture', 'ship_date', 'status', 'review_linked'];
books.SS_TF = new SS({ orders: new Sheet([ORD_HDR, ['240364-20260901-0566501349', '2026-09-01', 'b1', 'a@example.jp', '山田', '', '', 5000, 1, '', '2026-09-03', 'shipped', '']], 'orders'),
  reviews: new Sheet([['review_id', 'order_number', 'buyer_key', 'item_code', 'rating', 'posted_at', 'body']], 'reviews'),
  settings: new Sheet([['key', 'value', 'description', 'editable_by_tenant'], ['dry_run', 'false', '', 'FALSE']], 'settings') });
let lockOk = true;
const LockService = { getScriptLock: () => ({ tryLock: () => lockOk, releaseLock: () => {} }) };
const trashLog = [], trashed = {}; const logs = [], mails = [];
const DriveApp = { getFileById: id => { if (!books[id]) throw new Error('not accessible'); return { getName: () => books[id].name, isTrashed: () => !!trashed[id], setTrashed: v => { trashed[id] = v; trashLog.push(id + ':' + v); } }; } };
const ctx = { DriveApp, PropertiesService, Utilities, Logger: { log: m => logs.push(String(m)) }, console, LockService, notifyAdmin_: () => {}, isDryRun_: () => false, RMS_BASE: 'x', formatRmsDate_: () => '',
  MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  UrlFetchApp: { fetch: () => { throw new Error('UrlFetchApp must not be called'); } },
  SpreadsheetApp: { openById: id => { if (!books[id]) throw new Error('no book ' + id); return books[id]; }, create: name => { const s = new SS({ Sheet1: new Sheet([], 'Sheet1') }); s.name = name; return s; } } };
vm.createContext(ctx);
fs.readdirSync(SRC).filter(f => f.endsWith('.gs') && !['test_review_flow.gs', 'coupon_test.gs'].includes(f)).forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext('function jsonResponse_(o) { return o; }', ctx);
ctx.ensureBillingSchema_(); ctx.seedBillingTokyoflower();
ctx.putTenantSecret_('tokyoflower', 'rms', { service_secret: 'TF-SS', license_key: 'TF-LK', sid: '240364' }, { sid: '240364', expiry: '2027-12-01' });
ctx.issueTenantToken_('tokyoflower'); ctx.issueExtToken_('tokyoflower');

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const mrow = id => master.rows.find(r => r[0] === id);
const authRows = id => (books.MASTER.sheets.tenant_auth ? books.MASTER.sheets.tenant_auth.rows.slice(1).filter(r => r[0] === id) : []);
const secretRows = id => (books.MASTER.sheets.tenant_secrets ? books.MASTER.sheets.tenant_secrets.rows.filter(r => r[0] === id).length : 0);
const events = id => books.MASTER.sheets.billing_events.rows.slice(1).filter(r => r[2] === id).map(r => r[4]);
const tfSnap = () => JSON.stringify([mrow('tokyoflower'), ctx.readBillingRow_('tokyoflower'), secretRows('tokyoflower'), authRows('tokyoflower'), books.SS_TF.sheets.settings.rows, books.SS_TF.sheets.reviews.rows, books.SS_TF.sheets.orders.rows]);
const TF0 = tfSnap();
const allCells = () => JSON.stringify(Object.values(books).map(b => Object.values(b.sheets).map(s => s.rows)));
const run = () => { logs.length = 0; return ctx.setupExtTestTenant(); };
const tokensInLogs = () => logs.join('\n').match(/sse_[0-9a-f]{64}/g);
const payload = (token, dry, id = 1) => ({ token, dry_run: dry, reviews: [{ review_id: `https://review.example.jp/r/${id}`, order_number: '123456-20261001-0000000001', rating: 5, posted_at: '2026-10-20 10:00:00', review_type: '商品レビュー' }] });

console.log('setupExtTestTenant: 作成');
let TOKEN, EXT_SS;
t('exttest が status=setup・dry_run=true・RMS/SMTP なし・billing は manual/active で作られる', () => {
  const r = run(); assert.equal(r.ok, true); assert.equal(r.created, true); assert.equal(r.token_issued, true);
  const m = mrow('exttest'); assert.ok(m); assert.equal(m[3], 'setup'); EXT_SS = m[2];
  assert.equal(ctx.getTenantSettingValue_('exttest', 'dry_run'), 'true');
  assert.equal(secretRows('exttest'), 0); assert.equal(ctx.getTenantSecretMeta_('exttest', 'rms'), null); assert.equal(ctx.getTenantSecretMeta_('exttest', 'smtp'), null);
  const b = ctx.readBillingRow_('exttest'); assert.equal(b.billing_provider, 'manual'); assert.equal(b.billing_status, 'active'); assert.equal(b.plan, 'exttest'); assert.equal(b.fincode_customer_id, ''); assert.equal(b.fincode_subscription_id, '');
  assert.equal(ctx.billingDecision_('exttest').allowed, true);
  assert.ok(events('exttest').includes('exttest_setup')); });
t('トークン平文は実行ログに1回だけ出る。シートにはハッシュだけ（平文はどのセルにも無い）', () => {
  const m = tokensInLogs(); assert.equal(m.length, 1); TOKEN = m[0];
  assert.ok(!allCells().includes(TOKEN)); const rows = authRows('exttest').filter(r => r[4] === 'ext_review'); assert.equal(rows.length, 1);
  assert.equal(rows[0][1], ctx.hashToken_(TOKEN)); assert.equal(rows[0][3], 'active'); });
t('active への変更は activationBlockers_ で拒否される（RMS・SMTP 未登録）', () => {
  const r = ctx.adminSetStatus_('exttest', 'active'); assert.equal(r.ok, false); assert.equal(r.error, 'activation_requirements_not_met'); assert.equal(mrow('exttest')[3], 'setup'); });

console.log('setupExtTestTenant: 二重実行');
t('2回目はテナント・スプレッドシート・トークンを増やさず、トークンを再表示しない', () => {
  const n0 = ssSeq, masterN = master.rows.length, authN = books.MASTER.sheets.tenant_auth.rows.length;
  const r = run(); assert.equal(r.ok, true); assert.equal(r.created, false); assert.equal(r.token_issued, false);
  assert.equal(ssSeq, n0); assert.equal(master.rows.length, masterN); assert.equal(books.MASTER.sheets.tenant_auth.rows.length, authN);
  assert.equal(tokensInLogs(), null); assert.ok(logs.some(l => l.includes('既に存在')) && logs.some(l => l.includes('失効→再発行')));
  assert.equal(authRows('exttest').filter(r => r[4] === 'ext_review' && r[3] === 'active').length, 1); });
t('失効済みトークンの行があっても勝手に再発行しない（管理画面で再発行）', () => {
  ctx.revokeExtToken_('exttest'); const n = authRows('exttest').length; const r = run(); assert.equal(r.token_issued, false); assert.equal(tokensInLogs(), null); assert.equal(authRows('exttest').length, n);
  TOKEN = ctx.issueExtToken_('exttest'); });   // 以降は管理画面相当の再発行トークンを使う

console.log('毎時・日次の処理で exttest が skip される');
const calls = [];
['fetchOrders', 'linkOrdersReviews', 'sendPendingMails', 'sendPendingReviewThanks', 'sendMonthlyReport', 'issueCoupon', 'sendCouponMail'].forEach(fn => { ctx[fn] = id => { calls.push(fn + ':' + id); }; });
ctx.evaluateCoupons = id => { calls.push('evaluateCoupons:' + id); return []; };
t('runHourlyFollowPipeline / runPipeline / runMonthlyReport は tokyoflower のみ（exttest の呼び出しなし・メールなし）', () => {
  calls.length = 0; mails.length = 0; ctx.runHourlyFollowPipeline(); ctx.runPipeline(); ctx.runMonthlyReport();
  assert.ok(calls.length > 0 && calls.every(c => c.endsWith(':tokyoflower')), calls.join(',')); assert.ok(calls.includes('sendPendingMails:tokyoflower'));
  assert.equal(mails.length, 0); assert.deepEqual(Array.from(ctx.listActiveTenants()).map(x => x.tenant_id), ['tokyoflower']); });
t('日次（checkBillingDaily / checkExtStale_ / checkPurgeReminders_ / checkLicenseExpiry）は exttest に通知・記録しない（数ヶ月先でも）', () => {
  assert.equal(ctx.handleExtIngestReviews_(payload(TOKEN, false, 99)).ok, true);   // last_used_at を記録
  const realToday = ctx.billingToday_; ctx.billingToday_ = () => '2027-06-01';
  try {
    mails.length = 0; const before = events('exttest').length;
    ctx.checkBillingDaily(); assert.ok(!Array.from(ctx.checkExtStale_()).includes('exttest')); assert.deepEqual(Array.from(ctx.checkPurgeReminders_()), []); ctx.checkLicenseExpiry();
    assert.ok(mails.every(m => !m.subject.includes('exttest') && !m.body.includes('exttest')), JSON.stringify(mails));
    assert.equal(events('exttest').length, before); assert.ok(!ctx.readBillingRow_('exttest').billing_note.includes('期限切れ'));
  } finally { ctx.billingToday_ = realToday; } });

console.log('ext_ingest_reviews が exttest で受け付けられる');
t('dry_run: ok・would_insert=1・シートは変わらない・last_used_at も記録しない', () => {
  const rv = books[EXT_SS].sheets.reviews; const before = JSON.stringify(rv.rows); const lu = JSON.stringify(authRows('exttest'));
  const r = ctx.handleExtIngestReviews_(payload(TOKEN, true, 1)); assert.equal(r.ok, true); assert.equal(r.dry_run, true); assert.equal(r.valid, 1); assert.equal(r.would_insert, 1);
  assert.equal(JSON.stringify(rv.rows), before); assert.equal(JSON.stringify(authRows('exttest')), lu); });
t('実書き込み: reviews に1行（source=chrome_ext）・last_used_at 記録。テナント設定 dry_run=true のままで受け付ける', () => {
  const r = ctx.handleExtIngestReviews_(payload(TOKEN, false, 1)); assert.equal(r.ok, true); assert.equal(r.dry_run, false); assert.equal(r.inserted, 1);
  const rv = books[EXT_SS].sheets.reviews.rows; const h = rv[0]; const row = rv.find(x => x[h.indexOf('review_id')] === 'https://review.example.jp/r/1');
  assert.ok(row); assert.equal(row[h.indexOf('source')], 'chrome_ext'); assert.equal(String(row[h.indexOf('order_number')]), '123456-20261001-0000000001');
  const ar = authRows('exttest').find(x => x[3] === 'active' && x[4] === 'ext_review'); assert.ok(ar[books.MASTER.sheets.tenant_auth.rows[0].indexOf('last_used_at')]);
  assert.equal(ctx.getTenantSettingValue_('exttest', 'dry_run'), 'true'); });
t('同じ review_id の再送は updated（重複行を作らない）。tokyoflower のシートには書かない', () => {
  const r = ctx.handleExtIngestReviews_(payload(TOKEN, false, 1)); assert.equal(r.inserted, 0); assert.equal(r.updated, 1);
  assert.equal(books[EXT_SS].sheets.reviews.rows.length, 3); assert.equal(tfSnap(), TF0); });
t('メールは送られない（UrlFetchApp はモックが例外を投げるので RMS も呼ばれていない）', () => { assert.equal(mails.length, 0); });

console.log('teardownExtTestTenant: 撤去');
t('exttest 以外のテナント（otherco・setup）がいても、それには触れず exttest だけ全部消える', () => {
  const inv = ctx.adminCreateInvite_({ tenant_id: 'otherco', shop_name: 'その他店', shop_email: 'o@example.jp' }); assert.equal(inv.ok, true);
  ctx.setTenantPassword_('otherco', 'password-otherco'); ctx.issueExtToken_('otherco');
  const OTHER = JSON.stringify([mrow('otherco'), authRows('otherco'), Object.assign({}, ctx.readBillingRow_('otherco'), { row: 0 })]); const otherSs = mrow('otherco')[2];
  assert.ok(mrow('exttest'));
  trashLog.length = 0; logs.length = 0; const r = ctx.teardownExtTestTenant(); assert.equal(r.ok, true); assert.equal(r.existed, true); assert.equal(r.trashed, 3); assert.equal(r.revoked.ext, 1);
  assert.equal(mrow('exttest'), undefined); assert.equal(authRows('exttest').length, 0); assert.equal(ctx.resolveExtToken_(TOKEN).status, 'unknown');
  assert.equal(secretRows('exttest'), 0);
  assert.ok(Object.values(books).some(b => /^PURGED_exttest_\d{8}-\d{6}$/.test(b.name || '')));
  assert.equal(trashLog.length, 3); trashLog.forEach(x => { const id = x.split(':')[0]; assert.ok(/^(PURGED_exttest_|purge_backup_exttest_|purge_backup_master_exttest_)/.test(books[id].name), books[id].name); });
  ['purge_started', 'purge_tenant', 'final_delete'].forEach(e => assert.ok(events('exttest').includes(e), e));
  assert.equal(JSON.stringify([mrow('otherco'), authRows('otherco'), Object.assign({}, ctx.readBillingRow_('otherco'), { row: 0 })]), OTHER); assert.ok(!trashLog.some(x => x.startsWith(otherSs + ':')));
  assert.ok(logs.some(l => l.includes('撤去完了'))); });
t('tokyoflower は作成〜撤去を通じて何も変わらない（マスター行・billing・secrets・auth・settings・reviews・orders）', () => { assert.equal(tfSnap(), TF0); });
t('exttest が無い状態で再実行しても何もしない（otherco は無事）', () => {
  trashLog.length = 0; logs.length = 0; const n = events('otherco').length; const r = ctx.teardownExtTestTenant(); assert.equal(r.existed, false); assert.equal(trashLog.length, 0); assert.ok(logs.some(l => l.includes('存在しない')));
  assert.ok(mrow('otherco')); assert.equal(events('otherco').length, n); });
t('撤去後に再度 setup すると新しいトークンで作り直せる（旧トークンは無効のまま）', () => {
  const r = run(); assert.equal(r.created, true); assert.equal(r.token_issued, true); const nt = tokensInLogs()[0]; assert.notEqual(nt, TOKEN);
  assert.equal(ctx.resolveExtToken_(TOKEN).status, 'unknown'); assert.equal(ctx.resolveExtToken_(nt).status, 'ok'); TOKEN = nt; });
t('exttest が disabled で残っている場合 setup は拒否し、トークンも作らない', () => {
  ctx.setTenantStatus_('exttest', 'disabled'); const n = authRows('exttest').length; const r = run(); assert.equal(r.ok, false); assert.equal(tokensInLogs(), null); assert.equal(authRows('exttest').length, n);
  ctx.setTenantStatus_('exttest', 'setup'); });
t('exttest が active なら teardown は拒否（何も消さない）', () => {
  mrow('exttest')[3] = 'active'; trashLog.length = 0; const r = ctx.teardownExtTestTenant_(); assert.equal(r.ok, false); assert.equal(r.error, 'exttest_is_active'); assert.ok(mrow('exttest')); assert.equal(trashLog.length, 0); mrow('exttest')[3] = 'setup'; });
t('purge が失敗（busy）したら中断してエラーを返し、再実行で完了できる。この間も tokyoflower に触れない', () => {
  lockOk = false; const r = ctx.teardownExtTestTenant_(); lockOk = true; assert.equal(r.ok, false); assert.equal(r.step, 'purge'); assert.equal(r.error, 'busy');
  assert.equal(mrow('exttest')[3], 'disabled'); assert.equal(ctx.resolveExtToken_(TOKEN).status, 'revoked');
  const r2 = ctx.teardownExtTestTenant_(); assert.equal(r2.ok, true); assert.equal(mrow('exttest'), undefined); assert.equal(tfSnap(), TF0); });
t('teardown は引数を取らない（定数 exttest 固定）。tenant_id を渡しても無視される', () => {
  assert.equal(ctx.teardownExtTestTenant.length, 0); assert.equal(ctx.teardownExtTestTenant_.length, 0);
  const r = ctx.teardownExtTestTenant('tokyoflower'); assert.equal(r.existed, false); assert.ok(mrow('tokyoflower')); assert.equal(tfSnap(), TF0); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
