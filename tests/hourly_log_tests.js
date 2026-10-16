// node tests/hourly_log_tests.js — runHourlyFollowPipeline の実行全体の記録（pipeline_log の _hourly 行）・未完了/発火漏れ検知・通知
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const props = { TENANT_MASTER_SHEET_ID: 'MASTER' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) };
const fmtJst = (d, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
let uuidSeq = 0;
const Utilities = { getUuid: () => `${String(++uuidSeq).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`, formatDate: (d, tz, fmt) => fmtJst(d, fmt) };
const logs = [], errs = [], mails = [];
const Logger = { log: m => logs.push(String(m)) };
const fakeConsole = { error: m => errs.push(String(m)), log() {} };
class Sheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; }
  appendRow(r) { this.rows.push(r.slice()); } deleteRows(from, n) { this.rows.splice(from - 1, n); } }
class SS { constructor(sh) { this.sheets = sh; } getSheetByName(n) { return this.sheets[n] || null; } insertSheet(n) { return (this.sheets[n] = new Sheet([])); } }
const book = new SS({});
const ctx = { PropertiesService, Utilities, Logger, console: fakeConsole, SpreadsheetApp: { openById: () => book },
  MailApp: { sendEmail: (...a) => mails.push(a) } };
vm.createContext(ctx);
['billing.gs', 'main.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));

// 時計と依存関数のモック（ctx のグローバルを後勝ちで差し替える）
let NOW = Date.UTC(2026, 9, 15, 16, 0, 0);   // 2026-10-16 01:00 JST
const MIN = 60000;
ctx.hourlyNow_ = () => new Date(NOW);
ctx.billingNowStr_ = () => fmtJst(new Date(NOW), 'yyyy-MM-dd HH:mm:ss');
let tenantList = [{ tenant_id: 'A' }, { tenant_id: 'B' }];
const calls = []; let failFetch = {};
ctx.listActiveTenants = () => tenantList.slice();
ctx.billingAllows_ = id => id !== 'C';
ctx.fetchOrders = id => { calls.push('fetch:' + id); if (failFetch[id]) throw new Error(failFetch[id]); };
ctx.linkOrdersReviews = id => calls.push('link:' + id);
ctx.sendPendingMails = id => calls.push('mails:' + id);
ctx.sendPendingReviewThanks = id => calls.push('thanks:' + id);

const reset = () => { delete book.sheets.pipeline_log; logs.length = errs.length = mails.length = calls.length = 0; failFetch = {}; tenantList = [{ tenant_id: 'A' }, { tenant_id: 'B' }]; delete props.ADMIN_EMAIL; NOW = Date.UTC(2026, 9, 15, 16, 0, 0); ctx.getMasterWorkbook_ = origWb; ctx.MailApp.sendEmail = (...a) => mails.push(a); };
const origWb = ctx.getMasterWorkbook_;
const rows = () => (book.sheets.pipeline_log ? book.sheets.pipeline_log.rows.slice(1) : []);
const hourly = () => rows().filter(r => r[0] === '_hourly');
const ev = e => hourly().filter(r => r[1] === e);
const seed = (event, detail, minAgo) => { if (!book.sheets.pipeline_log) book.sheets.pipeline_log = new Sheet([['tenant_id', 'event', 'detail', 'at']]); book.sheets.pipeline_log.appendRow(['_hourly', event, detail, fmtJst(new Date(NOW - minAgo * MIN), 'yyyy-MM-dd HH:mm:ss')]); };
const run = () => ctx.runHourlyFollowPipeline();
const runId = r => /run=(\S+)/.exec(r[2])[1];

let pass = 0; const t = (n, f) => { reset(); try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

console.log('正常系');
t('hourly_start と hourly_done が run ID で対になり、集計値が入る。テナント別 hourly_done にも run が付く', () => {
  ctx.billingAllows_ = id => id !== 'B'; tenantList = [{ tenant_id: 'A' }, { tenant_id: 'B' }];
  try { run(); } finally { ctx.billingAllows_ = id => id !== 'C'; }
  const s = ev('hourly_start'), d = ev('hourly_done'); assert.equal(s.length, 1); assert.equal(d.length, 1);
  assert.equal(runId(s[0]), runId(d[0])); assert.equal(d[0][2], `run=${runId(s[0])} tenants=2 ran=1 billing_skipped=1 errors=0`);
  const td = rows().find(r => r[0] === 'A' && r[1] === 'hourly_done'); assert.equal(td[2], `run=${runId(s[0])}`); });

console.log('例外経路');
t('listActiveTenants が投げる → _hourly/hourly_error stage=listActiveTenants（終了マーカー）', () => {
  ctx.listActiveTenants = () => { throw new Error('master down'); };
  try { assert.doesNotThrow(run); } finally { ctx.listActiveTenants = () => tenantList.slice(); }
  const e = ev('hourly_error'); assert.equal(e.length, 1); assert.ok(e[0][2].includes('stage=listActiveTenants') && e[0][2].includes('msg=master down'));
  assert.equal(runId(e[0]), runId(ev('hourly_start').slice(-1)[0])); });
t('fetchOrders が投げる → テナント別 hourly_error に stage 付き・他テナントは継続・全体は errors=1 で done', () => {
  failFetch = { A: 'rms 500' }; run();
  const te = rows().find(r => r[0] === 'A' && r[1] === 'hourly_error'); assert.ok(te[2].includes('stage=fetchOrders') && te[2].includes('msg=rms 500') && te[2].startsWith('run='));
  assert.ok(calls.includes('fetch:B') && calls.includes('thanks:B')); assert.ok(rows().some(r => r[0] === 'B' && r[1] === 'hourly_done'));
  assert.ok(ev('hourly_done')[0][2].includes('ran=1') && ev('hourly_done')[0][2].includes('errors=1')); });
t('notifyAdmin_ が投げても他テナントが処理され、hourly_done まで記録される', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; ctx.MailApp.sendEmail = () => { throw new Error('mail quota'); }; failFetch = { A: 'boom' }; assert.doesNotThrow(run);
  assert.ok(calls.includes('thanks:B')); assert.equal(ev('hourly_done').length, 1); assert.ok(errs.some(m => m.includes('notifyAdmin_ failed'))); });

console.log('skip 記録');
t('アクティブテナント0件 → hourly_skip reason=no_active_tenants が終了マーカー（hourly_done は出さない）', () => {
  tenantList = []; run();
  const s = ev('hourly_start')[0], k = ev('hourly_skip'); assert.equal(k.length, 1); assert.equal(k[0][2], `run=${runId(s)} reason=no_active_tenants`); assert.equal(ev('hourly_done').length, 0);
  // 終了マーカーがあるので次回は incomplete にならない
  NOW += 60 * MIN; run(); assert.equal(ev('hourly_incomplete').length, 0); });

console.log('未完了・発火漏れ検知');
t('start だけ残った状態で次回実行 → hourly_incomplete（prev / prev_start 付き）、start より前に記録される', () => {
  seed('hourly_start', 'run=dead0001', 60); run();
  const i = ev('hourly_incomplete'); assert.equal(i.length, 1); assert.equal(i[0][2], `run=${runId(ev('hourly_start').slice(-1)[0])} prev=dead0001 prev_start=2026-10-16 00:00:00`);
  const order = hourly().map(r => r[1]); assert.ok(order.indexOf('hourly_incomplete') < order.lastIndexOf('hourly_start')); });
t('終了マーカー（done / error / skip）があれば incomplete にならない', () => {
  ['hourly_done', 'hourly_error', 'hourly_skip'].forEach(m => { reset(); seed('hourly_start', 'run=ok000001', 60); seed(m, 'run=ok000001', 59); run(); assert.equal(ev('hourly_incomplete').length, 0, m); }); });
t('前回 start が 90 分超前 → hourly_gap。60 分前・ちょうど 90 分では出ない', () => {
  seed('hourly_start', 'run=old00001', 100); seed('hourly_done', 'run=old00001', 99); run();
  assert.equal(ev('hourly_gap').length, 1); assert.ok(/^run=\S+ gap_min=100$/.test(ev('hourly_gap')[0][2]));
  reset(); seed('hourly_start', 'run=old00002', 60); seed('hourly_done', 'run=old00002', 59); run(); assert.equal(ev('hourly_gap').length, 0);
  reset(); seed('hourly_start', 'run=old00003', 90); seed('hourly_done', 'run=old00003', 89); run(); assert.equal(ev('hourly_gap').length, 0); });
t('初回（_hourly 行なし）では何も検知しない', () => { run(); assert.equal(ev('hourly_incomplete').length + ev('hourly_gap').length + ev('hourly_alert').length, 0); });

console.log('通知（2回連続・1日1回）');
const advance = min => { NOW += min * MIN; };
t('1回だけの異常では通知しない', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('hourly_start', 'run=dead0001', 200); run(); advance(60); run();
  assert.equal(ev('hourly_incomplete').length, 1); assert.equal(mails.length, 0); assert.equal(ev('hourly_alert').length, 0); });
t('2回連続で通知1回 → 同日の3回目は重複通知しない → 翌日は再通知', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('hourly_start', 'run=dead0001', 200);
  run();                         // 1回目: incomplete+gap（前回 run に異常なし → 通知なし）
  assert.equal(mails.length, 0); advance(120);
  run();                         // 2回目: gap かつ前回 run も異常 → 通知
  assert.equal(mails.length, 1); assert.equal(mails[0][0], 'admin@x.jp'); assert.equal(ev('hourly_alert').length, 1); advance(120);
  run();                         // 3回目（同日）: 異常は続くが通知しない
  console.log(hourly().map(r => r.join(' / ')).join('\n'));
  assert.equal(mails.length, 1); assert.equal(ev('hourly_alert').length, 1); assert.ok(ev('hourly_gap').length >= 3);
  advance(26 * 60);              // 翌日
  run();                         // 前回 run も異常 → 翌日なので再通知
  assert.equal(mails.length, 2); assert.equal(ev('hourly_alert').length, 2); });
t('ADMIN_EMAIL 未設定ではログのみ（送信なし・hourly_alert なし）', () => {
  seed('hourly_start', 'run=dead0001', 200); run(); advance(120); run();
  assert.equal(mails.length, 0); assert.equal(ev('hourly_alert').length, 0); assert.ok(logs.some(l => l.includes('ADMIN_EMAIL 未設定'))); });

console.log('pipelineLog_ 失敗');
t('シート書き込みが投げても runHourlyFollowPipeline は最後まで走り、console.error が呼ばれる', () => {
  ctx.getMasterWorkbook_ = () => { throw new Error('sheet unavailable'); };
  assert.doesNotThrow(run);
  assert.deepEqual(calls.filter(c => c.startsWith('fetch:')), ['fetch:A', 'fetch:B']); assert.ok(calls.includes('thanks:B'));
  assert.ok(errs.some(m => m.includes('pipelineLog_ failed') && m.includes('sheet unavailable'))); });
t('pipelineLog_ の戻り値: 成功 true / 失敗 false', () => {
  assert.strictEqual(ctx.pipelineLog_('x', 'y', 'z'), true); ctx.getMasterWorkbook_ = () => { throw new Error('boom'); }; assert.strictEqual(ctx.pipelineLog_('x', 'y', 'z'), false); });
t('前回状態の読み出し失敗時は検知をスキップして続行（console.error）', () => {
  seed('hourly_start', 'run=dead0001', 60);
  const orig = ctx.readHourlyLogRows_; ctx.readHourlyLogRows_ = () => { throw new Error('read fail'); };
  try { assert.doesNotThrow(run); } finally { ctx.readHourlyLogRows_ = orig; }
  assert.ok(errs.some(m => m.includes('detectHourlyAnomalies_ skip'))); assert.equal(ev('hourly_incomplete').length, 0); assert.equal(ev('hourly_done').length, 1); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
