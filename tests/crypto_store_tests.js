// node tests/crypto_store_tests.js — 暗号化保管・招待・セルフ登録
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');

const toSigned = b => (b > 127 ? b - 256 : b);
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', SECRETS_KEY: crypto.randomBytes(32).toString('base64') };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) };
const Utilities = {
  base64Encode: x => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => b & 255))).toString('base64'),
  base64Decode: b64 => [...Buffer.from(b64, 'base64')].map(toSigned),
  computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key.map(b => b & 255))).update(Buffer.from(data.map(b => b & 255))).digest()].map(toSigned),
  computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(toSigned),
  newBlob: x => typeof x === 'string' ? { getBytes: () => [...Buffer.from(x, 'utf8')].map(toSigned) } : { getDataAsString: () => Buffer.from(x.map(b => b & 255)).toString('utf8') },
  getUuid: () => crypto.randomUUID(),
  formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; },
  DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
};
class Sheet { constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return { getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => v.forEach((row, i) => { row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }), setValue: v => { s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } deleteRow(i) { this.rows.splice(i - 1, 1); } }
class SS { constructor(sheets) { this.sheets = sheets; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }
const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email'], ['hanaya','花屋','SS_H','setup','h@example.jp','']]);
const settings = new Sheet([['key','value','description','editable_by_tenant']]);
const templates = new Sheet([['template_id','subject','body','updated_at']]);
const books = { MASTER: new SS({ tenants: master }), SS_H: new SS({ settings, templates }) };
const SpreadsheetApp = { openById: id => books[id] };
let rmsCode = 200;
const UrlFetchApp = { fetch: () => ({ getResponseCode: () => rmsCode, getContentText: () => JSON.stringify({ MessageModelList: [{ messageType: rmsCode === 200 ? 'INFO' : 'ERROR', messageCode: rmsCode === 200 ? 'ORDER_EXT_API_SEARCH_ORDER_INFO_101' : 'AUTH_ERROR' }] }) }) };
const notified = [];
const ctx = { PropertiesService, Utilities, SpreadsheetApp, UrlFetchApp, Logger: { log: () => {} }, console, notifyAdmin_: m => notified.push(m), isDryRun_: () => false, CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) }, RMS_BASE: 'x', formatRmsDate_: () => '' };
vm.createContext(ctx);
['crypto_store.gs', 'auth.gs', 'tenant.gs', 'config.gs', 'onboarding.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

console.log('encryption');
t('往復', () => { const ct = ctx.encryptString_('秘密🔑 secret'); assert.notEqual(ct, '秘密🔑 secret'); assert.equal(ctx.decryptString_(ct), '秘密🔑 secret'); });
t('同じ平文でも暗号文は毎回異なる（nonce）', () => assert.notEqual(ctx.encryptString_('a'), ctx.encryptString_('a')));
t('改ざん検知', () => { const ct = ctx.encryptString_('abc'); const b = Buffer.from(ct, 'base64'); b[20] ^= 1; assert.throws(() => ctx.decryptString_(b.toString('base64')), /tampered/); });
t('鍵違いは復号不可', () => { const ct = ctx.encryptString_('abc'); const k = props.SECRETS_KEY; props.SECRETS_KEY = crypto.randomBytes(32).toString('base64'); assert.throws(() => ctx.decryptString_(ct)); props.SECRETS_KEY = k; });
t('長い平文（keystream 複数ブロック）', () => { const s = 'x'.repeat(5000); assert.equal(ctx.decryptString_(ctx.encryptString_(s)), s); });
t('鍵未設定はエラー', () => { const k = props.SECRETS_KEY; delete props.SECRETS_KEY; assert.throws(() => ctx.encryptString_('a'), /SECRETS_KEY/); props.SECRETS_KEY = k; });

console.log('tenant_secrets');
t('put/get/meta、シートに平文が無い', () => {
  ctx.putTenantSecret_('hanaya', 'rms', { service_secret: 'SS-PLAIN', license_key: 'LK-PLAIN' }, { sid: '1', expiry: '2027-01-01' });
  const rows = JSON.stringify(books.MASTER.sheets.tenant_secrets.rows); assert.ok(!rows.includes('SS-PLAIN') && !rows.includes('LK-PLAIN'));
  assert.equal(ctx.getTenantSecret_('hanaya', 'rms').secret.license_key, 'LK-PLAIN'); assert.equal(ctx.getTenantSecretMeta_('hanaya', 'rms').meta.expiry, '2027-01-01');
  ctx.putTenantSecret_('hanaya', 'rms', { service_secret: 'S2', license_key: 'L2' }, {}); assert.equal(books.MASTER.sheets.tenant_secrets.rows.length, 2);
  assert.equal(ctx.getTenantSecret_('hanaya', 'rms').secret.license_key, 'L2'); });
t('getRmsCredentials は tenant_secrets を優先し api_key シートを見ない', () => { const c = ctx.getRmsCredentials('hanaya'); assert.equal(c.license_key, 'L2'); assert.equal(c.from_email, 'h@example.jp'); });

console.log('invite / onboarding');
let invite;
t('招待発行・検証', () => { invite = ctx.createInvite_('hanaya').invite; assert.equal(ctx.verifyInvite_(invite, false), 'hanaya'); assert.equal(ctx.verifyInvite_('wrong', false), null); assert.ok(!JSON.stringify(books.MASTER.sheets.invites.rows).includes(invite)); });
t('onboard_check は秘密を返さない', () => { const r = ctx.onboardCheck_({ invite }); assert.equal(r.ok, true); assert.equal(r.tenant_id, 'hanaya'); assert.ok(!('token' in r)); });
t('入力不足は保存しない', () => { const r = ctx.onboardSubmit_({ invite, sid: '123', shop_name: 'x' }); assert.equal(r.error, 'validation'); assert.equal(ctx.verifyInvite_(invite, false), 'hanaya'); });
const good = { invite, sid: '123456', shop_name: '花屋', shop_email: 'h@example.jp', service_secret: 'SS', license_key: 'LK', license_expiry: '2027-09-01', smtp_user: 'smtpuser', smtp_pass: 'pw', follow_days: '4', go_live_date: '2026-10-01' };
t('RMS 認証失敗なら保存せず招待も消費しない', () => { rmsCode = 401; const r = ctx.onboardSubmit_(good); assert.equal(r.error, 'rms_auth_failed'); assert.equal(ctx.getTenantSecret_('hanaya', 'smtp'), null); assert.equal(ctx.verifyInvite_(invite, false), 'hanaya'); rmsCode = 200; });
t('成功時: 暗号化保存・settings反映・トークン発行・招待消費・運営者通知', () => {
  const r = ctx.onboardSubmit_(good); assert.equal(r.ok, true); assert.ok(r.token.length > 40);
  assert.equal(ctx.getTenantSecret_('hanaya', 'smtp').secret.smtp_pass, 'pw'); assert.equal(ctx.getTenantSecretMeta_('hanaya', 'smtp').meta.smtp_user_masked, 'sm****er');
  assert.equal(ctx.getTenantSecret_('hanaya', 'rms').meta.expiry, '2027-09-01');
  assert.equal(ctx.verifyInvite_(invite, false), null);
  assert.equal(ctx.verifyTenantToken_(r.token), 'hanaya');
  assert.equal(settings.rows.find(x => x[0] === 'follow_days_after_ship')[1], '4'); assert.equal(settings.rows.find(x => x[0] === 'go_live_date')[1], '2026-10-01'); assert.equal(settings.rows.find(x => x[0] === 'dry_run')[1], 'true');
  assert.equal(notified.length, 1); });
t('credentialsStatus_ は秘密を含まない', () => { const s = JSON.stringify(ctx.credentialsStatus_('hanaya')); assert.ok(!s.includes('LK') && !s.includes('"pw"')); assert.ok(s.includes('sm****er')); });
t('updateCredentials_ は接続失敗なら保存しない', () => { rmsCode = 401; assert.equal(ctx.updateCredentials_('hanaya', { service_secret: 'N', license_key: 'N' }).error, 'rms_auth_failed'); assert.equal(ctx.getTenantSecret_('hanaya', 'rms').secret.license_key, 'LK'); rmsCode = 200; assert.equal(ctx.updateCredentials_('hanaya', { service_secret: 'N', license_key: 'N2', license_expiry: '2028-01-01' }).ok, true); assert.equal(ctx.getTenantSecret_('hanaya', 'rms').secret.license_key, 'N2'); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
