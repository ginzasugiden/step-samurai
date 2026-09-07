// node tests/auth_tests.js — 店舗ID＋パスワード / セッション / トークン共存
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm'), crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const toSigned = b => (b > 127 ? b - 256 : b);
let fakeNow = new Date('2026-09-07T10:00:00+09:00');
const props = { TENANT_MASTER_SHEET_ID: 'MASTER', ADMIN_TOKEN: 'admin' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] ?? null }) };
const Utilities = {
  computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(toSigned),
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
// 旧形式（4列）の tenant_auth に既存トークンがある状態から始める
const auth = new Sheet([['tenant_id','token_hash','issued_at','status']]);
const master = new Sheet([['tenant_id','shop_name','spreadsheet_id','status','shop_email','cc_email'], ['tokyoflower','TF','S1','active','a@b.jp',''], ['gone','X','S2','disabled','x@x.jp','']]);
const SpreadsheetApp = { openById: id => ({ MASTER: new SS({ tenant_auth: auth, tenants: master }) })[id] };
const ctx = { PropertiesService, Utilities, SpreadsheetApp, Logger: { log: () => {} }, console, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [fakeNow.getTime()])); } static now() { return fakeNow.getTime(); } } };
vm.createContext(ctx);
['auth.gs', 'tenant.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

let legacyToken;
t('旧形式トークンは kind 列追加後も有効', () => {
  legacyToken = 'legacy-token-xyz'; auth.appendRow(['tokyoflower', ctx.hashToken_(legacyToken), '2026-01-01', 'active']);
  ctx.ensureAuthColumns_(); assert.deepEqual(auth.rows[0], ['tenant_id','token_hash','issued_at','status','kind','expires_at','salt']);
  assert.equal(ctx.verifyTenantToken_(legacyToken), 'tokyoflower'); });
let pw;
t('パスワード設定: 平文・salt無しハッシュはシートに無い', () => { pw = ctx.setTenantPassword_('tokyoflower'); assert.equal(pw.length, 12); const j = JSON.stringify(auth.rows); assert.ok(!j.includes(pw)); assert.ok(!j.includes(ctx.hashToken_(pw))); assert.ok(ctx.hasTenantPassword_('tokyoflower')); });
t('パスワードハッシュはトークンとして使えない', () => { const row = auth.rows.find(r => r[4] === 'password'); assert.equal(ctx.verifyTenantToken_(pw), null); assert.equal(row[3], 'active'); });
let session;
t('ログイン成功 → セッショントークン（12h）', () => { session = ctx.loginWithPassword_('tokyoflower', pw); assert.ok(session && session.token); assert.equal(session.expires_at, '2026-09-07 22:00:00'); assert.equal(ctx.verifyTenantToken_(session.token), 'tokyoflower'); });
t('ログイン失敗（パスワード違い・ID違い・disabled）', () => { assert.equal(ctx.loginWithPassword_('tokyoflower', 'wrong'), null); assert.equal(ctx.loginWithPassword_('nobody', pw), null); ctx.setTenantPassword_('gone', 'password123'); assert.equal(ctx.loginWithPassword_('gone', 'password123'), null); });
t('期限切れセッションは無効', () => { fakeNow = new Date('2026-09-08T10:00:01+09:00'); assert.equal(ctx.verifyTenantToken_(session.token), null); assert.equal(ctx.verifyTenantToken_(legacyToken), 'tokyoflower'); fakeNow = new Date('2026-09-07T10:00:00+09:00'); });
t('パスワード再設定で旧パスワード・既存セッションが無効、新パスワードでログイン可', () => {
  const s2 = ctx.loginWithPassword_('tokyoflower', pw); assert.ok(s2);
  const pw2 = ctx.setTenantPassword_('tokyoflower', 'newpassword1');
  assert.equal(pw2, 'newpassword1'); assert.equal(ctx.loginWithPassword_('tokyoflower', pw), null); assert.equal(ctx.verifyTenantToken_(s2.token), null);
  assert.ok(ctx.loginWithPassword_('tokyoflower', 'newpassword1')); });
t('短いパスワードは拒否', () => assert.throws(() => ctx.setTenantPassword_('tokyoflower', 'short'), /too_short/));
t('全失効はトークン/セッションのみ。パスワードは残る', () => { ctx.revokeTenantToken_('tokyoflower'); assert.equal(ctx.verifyTenantToken_(legacyToken), null); assert.ok(ctx.hasTenantPassword_('tokyoflower')); assert.ok(ctx.loginWithPassword_('tokyoflower', 'newpassword1')); });
t('新規発行トークンは kind=token', () => { const tk = ctx.issueTenantToken_('tokyoflower'); const row = auth.rows.find(r => r[1] === ctx.hashToken_(tk)); assert.equal(row[4], 'token'); assert.equal(ctx.verifyTenantToken_(tk), 'tokyoflower'); });
t('期限切れセッション行はログイン時に掃除される', () => { fakeNow = new Date('2026-09-09T10:00:00+09:00'); ctx.loginWithPassword_('tokyoflower', 'newpassword1'); const sessions = auth.rows.filter(r => r[4] === 'session'); assert.equal(sessions.length, 1); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
