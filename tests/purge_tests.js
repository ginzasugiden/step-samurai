// node tests/purge_tests.js — 修正4: purgeTenant（disabled のみ・tenant_id 再入力・複製後に削除・billing_events に記録）。実テナントには触れないローカル検証
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const runId = "t1";
const TID = `e2etest_${runId}`;
const toSigned = b => (b > 127 ? b - 256 : b);
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', SECRETS_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_TOKEN: 'adm' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) };
const fmt = (d, f) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return f === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
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
let ssSeq = 0;
class SS { constructor(sheets) { this.sheets = sheets; Object.keys(sheets).forEach(k => { sheets[k].ss = this; sheets[k].key = k; }); this.id = 'SS_' + (++ssSeq); books[this.id] = this; }
  getId() { return this.id; } getSheets() { return Object.values(this.sheets); } getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { const sh = new Sheet([], n); sh.ss = this; sh.key = n; return (this.sheets[n] = sh); } }
const books = {};
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'], ['tokyoflower', '東京', 'SS_TF', 'active', 'a@x.jp', '']], 'tenants');
new SS({ tenants: master }); books.MASTER = books.SS_1; delete books.SS_1;
const tf = new SS({ orders: new Sheet([['order_number'], ['240364-20260901-0566501349']], 'orders'), settings: new Sheet([['key', 'value', 'description', 'editable_by_tenant'], ['dry_run', 'false', '', 'FALSE']], 'settings') }); books.SS_TF = tf;

// purge 用の Spreadsheet 拡張（copy / rename）。copy は全タブの深いコピーを新しいブックとして作る
SS.prototype.copy = function (name) { const sheets = {}; Object.keys(this.sheets).forEach(k => { sheets[k] = new Sheet(this.sheets[k].rows, k); }); const n = new SS(sheets); n.name = name; return n; };
SS.prototype.rename = function (name) { this.name = name; };
let lockOk = true, lockHeld = false;
const LockService = { getScriptLock: () => ({ tryLock: () => { if (!lockOk) return false; lockHeld = true; return true; }, releaseLock: () => { lockHeld = false; } }) };
let breakOpenFor = null;
const realOpen = id => books[id];
const rmsCode = 200;
const ctx = { PropertiesService, Utilities, Logger: { log() {} }, console, LockService, notifyAdmin_: () => {}, isDryRun_: () => false, RMS_BASE: 'x', formatRmsDate_: () => '',
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => rmsCode, getContentText: () => '{}' }) },
  SpreadsheetApp: { openById: id => { if (breakOpenFor && id === breakOpenFor) throw new Error('drive unavailable'); return books[id]; }, create: name => { const s = new SS({ Sheet1: new Sheet([], 'Sheet1') }); s.name = name; return s; } } };
vm.createContext(ctx);
['crypto_store.gs', 'auth.gs', 'tenant.gs', 'config.gs', 'billing.gs', 'onboarding.gs', 'admin_api.gs', 'purge.gs', 'analytics_backfill.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext('function jsonResponse_(o) { return o; }', ctx);
ctx.ensureBillingSchema_(); ctx.seedBillingTokyoflower();
ctx.putTenantSecret_('tokyoflower', 'rms', { service_secret: 'TF-SS', license_key: 'TF-LK', sid: '240364' }, { sid: '240364', expiry: '2026-12-01' });

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const mrow = id => master.rows.find(r => r[0] === id);
const secretRows = id => (books.MASTER.sheets.tenant_secrets ? books.MASTER.sheets.tenant_secrets.rows.filter(r => r[0] === id).length : 0);
const authRows = id => (books.MASTER.sheets.tenant_auth ? books.MASTER.sheets.tenant_auth.rows.slice(1).filter(r => r[0] === id).length : 0);
const inviteRows = id => (books.MASTER.sheets.invites ? books.MASTER.sheets.invites.rows.slice(1).filter(r => r[0] === id).length : 0);
const events = id => books.MASTER.sheets.billing_events.rows.slice(1).filter(r => r[2] === id).map(r => r[4]);
const makeTenant = id => {
  const inv = ctx.adminCreateInvite_({ tenant_id: id, shop_name: id + '店', shop_email: id + '@example.jp' }); assert.equal(inv.ok, true);
  ctx.putTenantSecret_(id, 'rms', { service_secret: 'S-' + id, license_key: 'L-' + id, sid: '123456' }, { sid: '123456' }); ctx.putTenantSecret_(id, 'smtp', { smtp_user: 'u', smtp_pass: 'p-' + id }, {});
  ctx.setTenantPassword_(id, 'password-' + id); ctx.issueTenantToken_(id); props['REVIEW_INGEST_KEY__' + id] = 'K-' + id; props['ANALYTICS_BACKFILL_CURSOR__' + id] = '2026-01';
  books[mrow(id)[2]].getSheetByName('orders').appendRow(['ORDER-' + id]);
};
const snapshot = id => JSON.stringify([mrow(id), secretRows(id), authRows(id), inviteRows(id), props['REVIEW_INGEST_KEY__' + id], props['ANALYTICS_BACKFILL_CURSOR__' + id]]);

makeTenant('zshop'); makeTenant('yshop');
const zHashes = books.MASTER.sheets.tenant_auth.rows.slice(1).filter(r => r[0] === 'zshop').map(r => String(r[1])).filter(Boolean); assert.ok(zHashes.length >= 2);
const TF_SNAP = JSON.stringify([mrow('tokyoflower'), ctx.readBillingRow_('tokyoflower'), secretRows('tokyoflower')]);

console.log('purgeTenant: 拒否される条件（何も削除しない）');
t('status が disabled 以外（setup / paused / active）は拒否', () => {
  ['setup', 'paused', 'active'].forEach(st => { ctx.setTenantStatus_('zshop', st); const s = snapshot('zshop'); const r = ctx.adminPurgeTenant_({ tenant_id: 'zshop', confirm_tenant_id: 'zshop' }); assert.equal(r.error, 'tenant_not_disabled', st); assert.equal(snapshot('zshop'), s); });
  assert.equal(events('zshop').includes('purge_started'), false); });
t('tenant_id の再入力が一致しない・空・大文字違いは拒否', () => {
  ctx.setTenantStatus_('zshop', 'disabled'); const s = snapshot('zshop');
  ['', 'yshop', 'ZSHOP', ' zshop2', undefined].forEach(c => assert.equal(ctx.adminPurgeTenant_({ tenant_id: 'zshop', confirm_tenant_id: c }).error, 'confirm_mismatch', String(c)));
  assert.equal(snapshot('zshop'), s); });
t('tokyoflower は disabled でも拒否（保護）、tenant_id 未指定・未登録も拒否', () => {
  ctx.setTenantStatus_('tokyoflower', 'disabled'); assert.equal(ctx.adminPurgeTenant_({ tenant_id: 'tokyoflower', confirm_tenant_id: 'tokyoflower' }).error, 'protected_tenant'); ctx.setTenantStatus_('tokyoflower', 'active');
  assert.equal(ctx.adminPurgeTenant_({ confirm_tenant_id: '' }).error, 'tenant_id_required'); assert.equal(ctx.adminPurgeTenant_({ tenant_id: 'ghost', confirm_tenant_id: 'ghost' }).error, 'tenant_not_found'); });
t('ロックが取れなければ busy で何もしない', () => { lockOk = false; const s = snapshot('zshop'); assert.equal(ctx.adminPurgeTenant_({ tenant_id: 'zshop', confirm_tenant_id: 'zshop' }).error, 'busy'); assert.equal(snapshot('zshop'), s); lockOk = true; });
t('複製に失敗したら中止し、何も削除しない', () => {
  breakOpenFor = mrow('zshop')[2]; const s = snapshot('zshop'); const nBooks = Object.keys(books).length;
  const r = ctx.adminPurgeTenant_({ tenant_id: 'zshop', confirm_tenant_id: 'zshop' }); breakOpenFor = null;
  assert.equal(r.error, 'backup_failed'); assert.equal(snapshot('zshop'), s); assert.equal(events('zshop').includes('purge_started'), false); assert.equal(lockHeld, false); assert.equal(Object.keys(books).length, nBooks, 'シート複製は作られていない'); });

console.log('purgeTenant: 実行');
let res;
t('disabled＋再入力一致: 複製が作られ、暗号文・認証・招待・Script Properties・マスター行が消える', () => {
  res = ctx.adminPurgeTenant_({ tenant_id: 'zshop', confirm_tenant_id: 'zshop' });
  assert.equal(res.ok, true); assert.equal(res.deleted.tenant_secrets, 2); assert.ok(res.deleted.tenant_auth >= 2); assert.equal(res.deleted.invites, 1); assert.equal(res.deleted.properties, 2); assert.equal(res.deleted.master_row, 1);
  assert.equal(secretRows('zshop'), 0); assert.equal(authRows('zshop'), 0); assert.equal(inviteRows('zshop'), 0); assert.equal(mrow('zshop'), undefined);
  assert.equal(props['REVIEW_INGEST_KEY__zshop'], undefined); assert.equal(props['ANALYTICS_BACKFILL_CURSOR__zshop'], undefined); assert.equal(lockHeld, false); });
t('専用シートの複製にデータが残り、元シートは PURGED_ に改名されるだけ（消えない）', () => {
  const b = books[res.backups.sheet_backup_id]; assert.ok(b); assert.ok(b.name.startsWith('purge_backup_zshop_')); assert.ok(JSON.stringify(b.sheets.orders.rows).includes('ORDER-zshop'));
  const orig = Object.values(books).find(x => x.name && x.name.startsWith('PURGED_zshop_')); assert.ok(orig, '元シートは改名されて残る'); assert.ok(JSON.stringify(orig.sheets.orders.rows).includes('ORDER-zshop')); });
t('マスター行の複製: tenants 行と billing_events を含み、暗号文・パスワード/トークンのハッシュを含まない', () => {
  const m = books[res.backups.master_backup_id]; assert.ok(m.name.startsWith('purge_backup_master_zshop_'));
  assert.equal(m.sheets.tenants.rows.length, 2); assert.equal(m.sheets.tenants.rows[1][0], 'zshop'); assert.ok(m.sheets.billing_events.rows.length >= 2);
  const dump = JSON.stringify(Object.keys(m.sheets).map(k => m.sheets[k].rows)); assert.ok(!dump.includes('S-zshop') && !dump.includes('p-zshop') && !dump.includes('L-zshop'));
  zHashes.forEach(h => assert.ok(!dump.includes(h), 'ハッシュを複製に含めない')); });
t('billing_events に purge_started と purge_tenant が記録される（複製ID付き）', () => {
  const ev = events('zshop'); assert.ok(ev.includes('purge_started') && ev.includes('purge_tenant'));
  const started = books.MASTER.sheets.billing_events.rows.find(r => r[2] === 'zshop' && r[4] === 'purge_started'); assert.ok(started[7].includes(res.backups.sheet_backup_id)); });
t('他のテナント（tokyoflower・yshop）には一切触れない', () => {
  assert.equal(JSON.stringify([mrow('tokyoflower'), ctx.readBillingRow_('tokyoflower'), secretRows('tokyoflower')]), TF_SNAP);
  assert.equal(secretRows('yshop'), 2); assert.ok(authRows('yshop') >= 2); assert.equal(inviteRows('yshop'), 1); assert.ok(mrow('yshop')); assert.equal(props['REVIEW_INGEST_KEY__yshop'], 'K-yshop'); });
t('二重実行は tenant_not_found（マスター行が無いので何も起きない）', () => { assert.equal(ctx.adminPurgeTenant_({ tenant_id: 'zshop', confirm_tenant_id: 'zshop' }).error, 'tenant_not_found'); });

console.log('管理 API 経由');
t('purge_tenant は ADMIN_ACTIONS_ に含まれ、ADMIN_TOKEN 無しは unauthorized・店舗トークンでは呼べない', () => {
  assert.ok(vm.runInContext('ADMIN_ACTIONS_', ctx).includes('purge_tenant'));
  const s = snapshot('yshop'); ctx.setTenantStatus_('yshop', 'disabled');
  assert.equal(ctx.handleAdminAction_({ token: 'wrong', action: 'purge_tenant', payload: { tenant_id: 'yshop', confirm_tenant_id: 'yshop' } }).error, 'unauthorized');
  assert.ok(mrow('yshop'), '未認証では消えない');
  const ok = ctx.handleAdminAction_({ token: 'adm', action: 'purge_tenant', payload: { tenant_id: 'yshop', confirm_tenant_id: 'yshop' } }); assert.equal(ok.ok, true); assert.equal(mrow('yshop'), undefined); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
