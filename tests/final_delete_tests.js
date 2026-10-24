// node tests/final_delete_tests.js — 最終削除 final_delete_tenant（purge 済みの PURGED シート・複製2つをゴミ箱へ移すだけ）。DriveApp はモック。実ファイルには触れない
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const toSigned = b => (b > 127 ? b - 256 : b);
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', SECRETS_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_TOKEN: 'adm' };
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
let ssSeq = 0;
class SS { constructor(sheets) { this.sheets = sheets; Object.keys(sheets).forEach(k => { sheets[k].ss = this; sheets[k].key = k; }); this.id = 'SS_' + (++ssSeq); books[this.id] = this; }
  getId() { return this.id; } getSheets() { return Object.values(this.sheets); } getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { const sh = new Sheet([], n); sh.ss = this; sh.key = n; return (this.sheets[n] = sh); } }
const books = {};
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'], ['tokyoflower', '東京', 'SS_TF', 'active', 'a@x.jp', '']], 'tenants');
new SS({ tenants: master }); books.MASTER = books.SS_1; delete books.SS_1;
books.SS_TF = new SS({ orders: new Sheet([['order_number'], ['240364-20260901-0566501349']], 'orders'), settings: new Sheet([['key', 'value', 'description', 'editable_by_tenant'], ['dry_run', 'false', '', 'FALSE']], 'settings') });
SS.prototype.copy = function (name) { const sheets = {}; Object.keys(this.sheets).forEach(k => { sheets[k] = new Sheet(this.sheets[k].rows, k); }); const n = new SS(sheets); n.name = name; return n; };
SS.prototype.rename = function (name) { this.name = name; };
let lockOk = true, lockHeld = false;
const LockService = { getScriptLock: () => ({ tryLock: () => { if (!lockOk) return false; lockHeld = true; return true; }, releaseLock: () => { lockHeld = false; } }) };
// DriveApp モック: 名前は SS の name。setTrashed の呼び出しを記録する（完全削除 API は存在しない）
const trashLog = []; const trashed = {};
let brokenFile = null;
const DriveApp = { getFileById: id => {
  if (id === brokenFile || !books[id]) throw new Error('not accessible');
  return { getName: () => books[id].name, isTrashed: () => !!trashed[id], setTrashed: v => { trashed[id] = v; trashLog.push(id + ':' + v); } }; } };
const ctx = { DriveApp, PropertiesService, Utilities, Logger: { log() {} }, console, LockService, notifyAdmin_: () => {}, isDryRun_: () => false, RMS_BASE: 'x', formatRmsDate_: () => '',
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
  SpreadsheetApp: { openById: id => books[id], create: name => { const s = new SS({ Sheet1: new Sheet([], 'Sheet1') }); s.name = name; return s; } } };
vm.createContext(ctx);
['crypto_store.gs', 'auth.gs', 'tenant.gs', 'config.gs', 'billing.gs', 'onboarding.gs', 'admin_api.gs', 'purge.gs', 'analytics_backfill.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
vm.runInContext('function jsonResponse_(o) { return o; }', ctx);
ctx.ensureBillingSchema_(); ctx.seedBillingTokyoflower();
ctx.putTenantSecret_('tokyoflower', 'rms', { service_secret: 'TF-SS', license_key: 'TF-LK', sid: '240364' }, { sid: '240364', expiry: '2026-12-01' });

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const mrow = id => master.rows.find(r => r[0] === id);
const secretRows = id => (books.MASTER.sheets.tenant_secrets ? books.MASTER.sheets.tenant_secrets.rows.filter(r => r[0] === id).length : 0);
const events = id => books.MASTER.sheets.billing_events.rows.slice(1).filter(r => r[2] === id).map(r => r[4]);
const makeTenant = id => {
  const inv = ctx.adminCreateInvite_({ tenant_id: id, shop_name: id + '店', shop_email: id + '@example.jp' }); assert.equal(inv.ok, true);
  ctx.putTenantSecret_(id, 'rms', { service_secret: 'S-' + id, license_key: 'L-' + id, sid: '123456' }, { sid: '123456' }); ctx.putTenantSecret_(id, 'smtp', { smtp_user: 'u', smtp_pass: 'p-' + id }, {});
  ctx.setTenantPassword_(id, 'password-' + id); ctx.issueTenantToken_(id);
  books[mrow(id)[2]].getSheetByName('orders').appendRow(['ORDER-' + id]);
};
const purgeIt = id => { makeTenant(id); ctx.setTenantStatus_(id, 'disabled'); const r = ctx.adminPurgeTenant_({ tenant_id: id, confirm_tenant_id: id }); assert.equal(r.ok, true); return r; };
const purgedIdOf = id => Object.keys(books).find(k => books[k].name && books[k].name.startsWith(`PURGED_${id}_`));
const fd = (id, c) => ctx.adminFinalDeleteTenant_({ tenant_id: id, confirm_tenant_id: c === undefined ? id : c });

makeTenant('liveshop');   // purge していない店
const pz = purgeIt('zshop'); const pzId = purgedIdOf('zshop');
const pw = purgeIt('wshop'); const pwId = purgedIdOf('wshop');
const TF_SNAP = JSON.stringify([mrow('tokyoflower'), ctx.readBillingRow_('tokyoflower'), secretRows('tokyoflower')]);

console.log('final_delete_tenant: 拒否される条件（何も触らない）');
t('tenant_id 未指定 / 再入力不一致 / tokyoflower は拒否', () => {
  assert.equal(ctx.adminFinalDeleteTenant_({ confirm_tenant_id: '' }).error, 'tenant_id_required');
  ['', 'wshop', 'ZSHOP'].forEach(c => assert.equal(fd('zshop', c).error, 'confirm_mismatch'));
  assert.equal(ctx.adminFinalDeleteTenant_({ tenant_id: 'zshop' }).error, 'confirm_mismatch');
  assert.equal(fd('tokyoflower').error, 'protected_tenant'); assert.deepEqual(trashLog, []); });
t('マスターにまだ存在する（purge 前の）テナントは tenant_not_purged', () => { ctx.setTenantStatus_('liveshop', 'disabled'); assert.equal(fd('liveshop').error, 'tenant_not_purged'); assert.deepEqual(trashLog, []); });
t('purge_tenant の記録が無ければ purge_record_not_found（未登録 ID / purge_started だけで完了していない場合）', () => {
  assert.equal(fd('ghost').error, 'purge_record_not_found');
  ctx.appendBillingEvent_('halfshop', 'manual', 'purge_started', 'disabled', 'disabled', `backup sheet=${pz.backups.sheet_backup_id} master=${pz.backups.master_backup_id}`);
  assert.equal(fd('halfshop').error, 'purge_record_not_found'); assert.deepEqual(trashLog, []); });
t('ロックが取れなければ busy', () => { lockOk = false; assert.equal(fd('zshop').error, 'busy'); lockOk = true; assert.deepEqual(trashLog, []); assert.equal(lockHeld, false); });
t('管理 API: final_delete_tenant は ADMIN_ACTIONS_ に含まれ、ADMIN_TOKEN が違えば unauthorized', () => {
  assert.ok(vm.runInContext('ADMIN_ACTIONS_', ctx).includes('final_delete_tenant'));
  assert.equal(ctx.handleAdminAction_({ token: 'wrong', action: 'final_delete_tenant', payload: { tenant_id: 'zshop', confirm_tenant_id: 'zshop' } }).error, 'unauthorized'); assert.deepEqual(trashLog, []); });

console.log('final_delete_tenant: 名前が想定と違う・取得できないファイルは触らない');
t('PURGED シートが改名されていたら skipped（name_mismatch）。他の2つはゴミ箱へ', () => {
  const orig = books[pwId].name; books[pwId].name = 'my_important_sheet';
  const r = fd('wshop'); assert.equal(r.ok, true); assert.equal(r.trashed, 2);
  assert.deepEqual(r.skipped, [{ target: 'purged_sheet', reason: 'name_mismatch' }]);
  assert.ok(!trashLog.includes(pwId + ':true')); assert.ok(trashLog.includes(pw.backups.sheet_backup_id + ':true') && trashLog.includes(pw.backups.master_backup_id + ':true'));
  assert.ok(events('wshop').includes('final_delete')); books[pwId].name = orig; });
t('二重実行は already_final_deleted（もう何も触らない）', () => { const n = trashLog.length; assert.equal(fd('wshop').error, 'already_final_deleted'); assert.equal(trashLog.length, n); });
t('全部スキップ（取得不可・改名）なら何も移さず final_delete を記録しない（直してやり直せる）', () => {
  const n0 = trashLog.length; brokenFile = pz.backups.sheet_backup_id;
  const nm = books[pz.backups.master_backup_id].name, np = books[pzId].name;
  books[pz.backups.master_backup_id].name = 'renamed1'; books[pzId].name = 'renamed2';
  const r = fd('zshop'); assert.equal(r.ok, true); assert.equal(r.trashed, 0); assert.equal(r.skipped.length, 3); assert.equal(trashLog.length, n0);
  assert.deepEqual(r.skipped.map(s => s.reason).sort(), ['name_mismatch', 'name_mismatch', 'not_accessible']);
  assert.equal(events('zshop').includes('final_delete'), false);
  brokenFile = null; books[pz.backups.master_backup_id].name = nm; books[pzId].name = np; });
t('接頭辞が似た別テナント（zshop2）のファイル名は移さない', () => {
  const n0 = trashLog.length; const sheetBk = books[pz.backups.sheet_backup_id]; const keep = sheetBk.name;
  sheetBk.name = keep.replace('purge_backup_zshop_', 'purge_backup_zshop2_');
  const r = fd('zshop'); assert.equal(r.trashed, 2); assert.deepEqual(r.skipped, [{ target: 'sheet_backup', reason: 'name_mismatch' }]);
  assert.ok(!trashLog.includes(pz.backups.sheet_backup_id + ':true')); assert.equal(trashLog.length, n0 + 2); sheetBk.name = keep;
  trashLog.length = 0; delete trashed[pzId]; delete trashed[pz.backups.master_backup_id];
  const idx = books.MASTER.sheets.billing_events.rows.findIndex(x => x[2] === 'zshop' && x[4] === 'final_delete'); books.MASTER.sheets.billing_events.rows.splice(idx, 1); });   // 次のテスト用に zshop を未実行へ戻す

console.log('final_delete_tenant: 実行');
t('正常系（yshop）: PURGED シート・シート複製・マスター複製の3つをゴミ箱へ（setTrashed(true) のみ）。final_delete が記録される', () => {
  const py = purgeIt('yshop'); const pyId = purgedIdOf('yshop'); const n0 = trashLog.length;
  const r = fd('yshop'); assert.equal(r.ok, true); assert.equal(r.trashed, 3); assert.deepEqual(r.skipped, []); assert.equal(r.tenant_id, 'yshop');
  assert.deepEqual(trashLog.slice(n0).sort(), [pyId, py.backups.sheet_backup_id, py.backups.master_backup_id].map(x => x + ':true').sort());
  assert.ok(trashLog.slice(n0).every(x => x.endsWith(':true')), 'ゴミ箱へ移す以外の操作はしない');
  assert.ok(!JSON.stringify(r).includes(pyId) && !JSON.stringify(r).includes(py.backups.sheet_backup_id), '応答にファイル ID を含めない');
  const e = books.MASTER.sheets.billing_events.rows.find(x => x[2] === 'yshop' && x[4] === 'final_delete'); assert.ok(e); assert.ok(e[7].includes(pyId));
  assert.equal(lockHeld, false); assert.equal(fd('yshop').error, 'already_final_deleted'); });
t('他のテナント（tokyoflower）・未 purge の店には一切触れない', () => {
  assert.equal(JSON.stringify([mrow('tokyoflower'), ctx.readBillingRow_('tokyoflower'), secretRows('tokyoflower')]), TF_SNAP);
  assert.ok(mrow('liveshop')); assert.equal(secretRows('liveshop'), 2);
  const touched = trashLog.map(x => x.split(':')[0]); ['SS_TF', mrow('liveshop')[2]].forEach(id => assert.ok(!touched.includes(id))); });
t('管理 API 経由で実行できる（zshop）', () => {
  const r = ctx.handleAdminAction_({ token: 'adm', action: 'final_delete_tenant', payload: { tenant_id: 'zshop', confirm_tenant_id: 'zshop' } }); assert.equal(r.ok, true); assert.equal(r.trashed, 3); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
