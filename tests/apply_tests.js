// node tests/apply_tests.js — モニター応募の受付（apply.gs）: 検証・数式インジェクション・締切・ハニーポット・Turnstile・回数制限・fail-closed
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const props = { TENANT_MASTER_SHEET_ID: 'MASTER' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) };
const fmtJst = (d, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
const Utilities = { getUuid: () => 'u' + Math.random().toString(36).slice(2), formatDate: fmtJst };
const logs = []; const Logger = { log: m => logs.push(String(m)) };
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastColumn() { return Math.max(...this.rows.map(r => r.length)); } getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => { const c = r.slice(); while (c.length < s.getLastColumn()) c.push(''); return c; }) }; }
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValue: v => { while (s.rows.length < r) s.rows.push([]); s.rows[r - 1][c - 1] = v; } }; }
  appendRow(r) { this.rows.push(r.slice()); } deleteRows(from, n) { this.rows.splice(from - 1, n); } }
class SS { constructor(sh) { this.sheets = sh; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }
const master = new Sheet([['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'shop_email', 'cc_email'],
  ['tokyoflower', '東京', 'S1', 'active', 'a@x.jp', ''], ['legacyshop', '旧', 'S2', 'active', 'b@x.jp', ''], ['newshop', '新', 'S3', 'setup', 'c@x.jp', ''], ['cancelshop', '解', 'S4', 'active', 'd@x.jp', '']]);
const books = { MASTER: new SS({ tenants: master }) };
const toJst = v => { if (!v) return null; if (v instanceof Date) return fmtJst(v, 'yyyy-MM-dd'); const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(v)); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const base = () => ({ PropertiesService, Utilities, Logger, console, SpreadsheetApp: { openById: id => books[id] }, hash_equals_: (a, b) => a === b,
  toJstDateString_: toJst, CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) } });
// billing.gs の日付は「今日」を固定するため billingToday_ / billingNowStr_ を後勝ちで差し替える
const fixDate = c => vm.runInContext('var __today = "2026-09-29"; function billingToday_() { return __today; } function billingNowStr_() { return __today + " 12:00:00"; }', c);
const setToday = (c, d) => vm.runInContext(`__today = "${d}"`, c);


const ctx = base();
const props2 = props;
let fetchCalls = [], fetchResp = { success: true, hostname: 'step-samurai.ginzasugiden.com' };
const UrlFetchApp = { fetch: (url, o) => { fetchCalls.push({ url, o }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify(fetchResp) }; } };
const sent = []; const MailApp = { sendEmail: (to, subj, body) => sent.push({ to, subj, body }) };
const cacheStore = {}; const CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] ?? null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) };
props2.ADMIN_EMAIL = 'admin@example.jp';
const crypto = require('crypto');
Object.assign(ctx, { UrlFetchApp, MailApp, CacheService, PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props2 ? props2[k] : null) }) } });
ctx.Utilities = Object.assign({}, Utilities, { computeDigest: (a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, formatDate: (d, tz, f) => fmtJst(d, f) });
vm.createContext(ctx);
['crypto_store.gs', 'tenant.gs', 'billing.gs', 'apply.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const tabs = () => books.MASTER.sheets;
const plain = o => JSON.parse(JSON.stringify(o));
const good = o => Object.assign({ shop_name: '花屋おおさか', shop_code: 'hana', contact_name: '山田', email: 'a@example.jp', monthly_orders: '30〜100件', follow_mail: '送っていない', rms_api: '利用中', browser: 'Chrome', expectation: '期待', case_publish: '匿名なら可', consent: true, website: '', turnstile_token: 'tok' }, o);
const reset = () => { Object.keys(cacheStore).forEach(k => delete cacheStore[k]); fetchCalls = []; sent.length = 0; fetchResp = { success: true, hostname: 'step-samurai.ginzasugiden.com' }; };
const tabsBefore = Object.keys(tabs()).sort().join(',');

console.log('エディタ用の確認関数');
t('testMonitorApplyValidation が全項目 OK（末尾 _ なしで公開）', () => { logs.length = 0; assert.equal(ctx.testMonitorApplyValidation(), true); assert.ok(logs.includes('全項目 OK')); assert.ok(!logs.some(l => l.startsWith('NG'))); });

console.log('fail-closed / 締切 / ハニーポット');
t('TURNSTILE_SECRET 未設定は not_ready。Turnstile へ通信せず、applications タブも作らない', () => { reset(); const r = ctx.handleMonitorApply_(good()); assert.deepEqual(plain(r), { ok: false, error: 'not_ready' }); assert.equal(fetchCalls.length, 0); assert.equal(Object.keys(tabs()).sort().join(','), tabsBefore); });
props2.TURNSTILE_SECRET = 'test-secret-not-real';
t('ハニーポットに値 → ok:true だが保存・通信・メールなし', () => { reset(); const r = ctx.handleMonitorApply_(good({ website: 'http://spam' })); assert.equal(r.ok, true); assert.equal(fetchCalls.length, 0); assert.equal(sent.length, 0); assert.equal(Object.keys(tabs()).sort().join(','), tabsBefore); });
t('締切を過ぎたら closed（通信・保存なし）', () => { reset(); vm.runInContext('var __c = monitorApplyClosed_; monitorApplyClosed_ = function () { return true; };', ctx); try { assert.equal(ctx.handleMonitorApply_(good()).error, 'closed'); assert.equal(fetchCalls.length, 0); } finally { vm.runInContext('monitorApplyClosed_ = __c;', ctx); } });
t('締切時刻の境界（JST 11/24 23:59:59 まで受付）', () => { assert.equal(ctx.monitorApplyClosed_(new Date('2026-11-24T23:59:59+09:00').getTime()), false); assert.equal(ctx.monitorApplyClosed_(new Date('2026-11-25T00:00:00+09:00').getTime()), true); });

console.log('Turnstile');
t('success=false / hostname 違い / トークン無しは verify_failed（保存なし）', () => {
  reset(); fetchResp = { success: false }; assert.equal(ctx.handleMonitorApply_(good()).error, 'verify_failed');
  reset(); fetchResp = { success: true, hostname: 'evil.example.com' }; assert.equal(ctx.handleMonitorApply_(good()).error, 'verify_failed');
  reset(); assert.equal(ctx.handleMonitorApply_(good({ turnstile_token: '' })).error, 'verify_failed'); assert.equal(fetchCalls.length, 0);
  assert.equal(Object.keys(tabs()).sort().join(','), tabsBefore); });
t('siteverify へは secret と response を POST する', () => { reset(); ctx.handleMonitorApply_(good({ email: 'v1@example.jp' })); const c = fetchCalls[0]; assert.equal(c.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); assert.equal(c.o.method, 'post'); assert.equal(c.o.payload.response, 'tok'); assert.equal(c.o.payload.secret, 'test-secret-not-real'); });

console.log('入力検証');
t('不正な入力は invalid と fields（保存なし）', () => { reset(); const before = Object.keys(tabs()).sort().join(','); const r = ctx.handleMonitorApply_(good({ email: 'x', shop_code: 'https://example.com/', consent: false, rms_api: 'zzz' })); assert.equal(r.error, 'invalid'); ['email', 'shop_url', 'consent', 'rms_api'].forEach(f => assert.ok(r.fields.includes(f), f)); assert.equal(Object.keys(tabs()).sort().join(','), before); });
t('文字数の境界（店舗名100/101・担当者50/51・店舗コード64/65・メール254/255・期待1000/1001）', () => {
  const v = o => ctx.validateMonitorApply_(good(o)).ok;
  assert.equal(v({ shop_name: 'a'.repeat(100) }), true); assert.equal(v({ shop_name: 'a'.repeat(101) }), false);
  assert.equal(v({ contact_name: 'a'.repeat(50) }), true); assert.equal(v({ contact_name: 'a'.repeat(51) }), false);
  assert.equal(v({ shop_code: 'a'.repeat(64) }), true); assert.equal(v({ shop_code: 'a'.repeat(65) }), false);
  const e = n => 'a'.repeat(n - 12) + '@example.com'; assert.equal(v({ email: e(254) }), true); assert.equal(v({ email: e(255) }), false);
  assert.equal(v({ expectation: 'a'.repeat(1000) }), true); assert.equal(v({ expectation: 'a'.repeat(1001) }), false); });
t('任意項目は空でよい', () => { assert.equal(ctx.validateMonitorApply_(good({ browser: '', case_publish: '', expectation: '' })).ok, true); });

console.log('店舗コード');
const codeOf = v => { const r = ctx.validateMonitorApply_(good({ shop_code: v })); return r.ok ? r.clean.shop_url : null; };
const TF = 'https://www.rakuten.co.jp/tokyoflower/';
t('店舗コード・空白/大文字/末尾/・www/item のURL は同じ正規化URLになる', () => { ['tokyoflower', ' TokyoFlower/ ', 'https://www.rakuten.co.jp/tokyoflower/', 'https://item.rakuten.co.jp/tokyoflower/abc123/', 'https://www.rakuten.co.jp/TokyoFlower/?x=1'].forEach(v => assert.equal(codeOf(v), TF, v)); });
t('他ドメイン・空白入り・../・空・65字は NG（fields に shop_url）', () => { ['https://evil.com/tokyoflower', 'tokyo flower', '../x', '', 'a'.repeat(65), 'http://www.rakuten.co.jp/x', 'https://www.rakuten.co.jp.evil.com/x'].forEach(v => { const r = ctx.validateMonitorApply_(good({ shop_code: v })); assert.equal(r.ok, false, v); assert.ok(r.fields.includes('shop_url'), v); }); });
t('互換: shop_code が無く shop_url（URL）だけ来ても受け付ける', () => { const p = good(); delete p.shop_code; p.shop_url = 'https://www.rakuten.co.jp/hana/'; assert.equal(ctx.validateMonitorApply_(p).clean.shop_url, 'https://www.rakuten.co.jp/hana/'); });
t('保存・通知は正規化後のURL（列構成は不変）', () => { reset(); const keep = tabs().applications; delete tabs().applications; ctx.handleMonitorApply_(good({ shop_code: ' TokyoFlower/ ', email: 'sc@example.jp' })); const rows = tabs().applications.rows; assert.equal(rows[0].length, 13); assert.equal(rows[0][2], 'shop_url'); assert.equal(rows[1][2], TF); assert.ok(sent[0].body.includes('店舗URL: ' + TF)); if (keep) tabs().applications = keep; });
t('処理順: シークレット未設定＋トークンなし → not_ready（verify_failed にならない）', () => { reset(); const sec = props2.TURNSTILE_SECRET; delete props2.TURNSTILE_SECRET; try { assert.equal(ctx.handleMonitorApply_(good({ turnstile_token: '' })).error, 'not_ready'); assert.equal(fetchCalls.length, 0); } finally { props2.TURNSTILE_SECRET = sec; } });
t('処理順: シークレットあり＋トークンなし → verify_failed（検証前に入力検証・保存へ進まない）', () => { reset(); const before = (tabs().applications || { rows: [] }).rows.length; assert.equal(ctx.handleMonitorApply_(good({ turnstile_token: '', shop_code: '!!' })).error, 'verify_failed'); assert.equal((tabs().applications || { rows: [] }).rows.length, before); });

console.log('保存・通知・回数制限');
t('成功: applications タブを作り、見出し＋1行（status=new）。運営宛てのみ通知（応募者へは送らない）', () => {
  reset(); delete tabs().applications; const r = ctx.handleMonitorApply_(good({ email: 'ok1@example.jp' })); assert.equal(r.ok, true);
  const rows = tabs().applications.rows; assert.equal(rows[0].join(','), 'received_at,shop_name,shop_url,contact_name,email,monthly_orders,follow_mail,rms_api,browser,expectation,case_publish,status,memo');
  assert.equal(rows.length, 2); assert.equal(rows[1][1], '花屋おおさか'); assert.equal(rows[1][11], 'new'); assert.match(rows[1][0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'admin@example.jp'); assert.equal(sent[0].subj, '[step-samurai] モニター応募: 花屋おおさか'); assert.ok(sent[0].body.includes('2 行目')); assert.ok(sent[0].body.includes('ok1@example.jp')); });
t('既存タブ tenants は変更しない', () => { assert.equal(tabs().tenants.rows.length, master.rows.length); });
t('数式インジェクション: = + - @ 始まりは先頭にアポストロフィを付けて保存', () => { reset(); ctx.handleMonitorApply_(good({ email: 'inj@example.jp', shop_name: '=HYPERLINK("x")', contact_name: '+1', expectation: '@SUM(1)' })); const row = tabs().applications.rows.slice(-1)[0]; assert.equal(row[1], "'=HYPERLINK(\"x\")"); assert.equal(row[3], "'+1"); assert.equal(row[9], "'@SUM(1)"); });
t('同じメールは10分に1回（2回目は rate_limited・保存なし）', () => { reset(); assert.equal(ctx.handleMonitorApply_(good({ email: 'rl@example.jp' })).ok, true); const n = tabs().applications.rows.length; assert.equal(ctx.handleMonitorApply_(good({ email: 'RL@example.jp' })).error, 'rate_limited'); assert.equal(tabs().applications.rows.length, n); });
t('全体で1時間30件まで（31件目は rate_limited）', () => { reset(); for (let i = 0; i < 30; i++) assert.equal(ctx.handleMonitorApply_(good({ email: `g${i}@example.jp` })).ok, true, 'i=' + i); assert.equal(ctx.handleMonitorApply_(good({ email: 'g99@example.jp' })).error, 'rate_limited'); });
t('通知メールが失敗しても受付は成功', () => { reset(); const orig = ctx.MailApp.sendEmail; ctx.MailApp.sendEmail = () => { throw new Error('mail down'); }; try { assert.equal(ctx.handleMonitorApply_(good({ email: 'mf@example.jp' })).ok, true); } finally { ctx.MailApp.sendEmail = orig; } });
t('既存タブ applications の見出しが想定と違えば書かず internal_error（詳細は返さない）', () => { reset(); const keep = tabs().applications; tabs().applications = new Sheet([['x', 'y']]); try { const r = ctx.handleMonitorApply_(good({ email: 'col@example.jp' })); assert.deepEqual(plain(r), { ok: false, error: 'internal_error' }); assert.equal(tabs().applications.rows.length, 1); } finally { tabs().applications = keep; } });

console.log('doPost の分岐');
t('webapp.gs: monitor_apply は onboard_check より前の1行のみ', () => { const w = load('webapp.gs'); const a = w.indexOf("action === 'monitor_apply'"), o = w.indexOf("action === 'onboard_check'"); assert.ok(a > 0 && a < o); assert.equal((w.match(/monitor_apply/g) || []).length, 1); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
