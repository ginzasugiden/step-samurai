// node tests/monitor_tests.js — 毎時処理の外部チェック（checkHourlyHealth_）・pipeline_log の保持（prunePipelineLog_）・tenant_warn
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'gas', 'src');
const load = f => fs.readFileSync(path.join(SRC, f), 'utf8').split('\r\n').join('\n');

const props = {};
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) };
const fmtJst = (d, fmt) => { const j = new Date(d.getTime() + 9 * 3600e3); const p = n => String(n).padStart(2, '0'); const s = `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`; return fmt === 'yyyy-MM-dd' ? s : `${s} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`; };
let uuidSeq = 0;
const Utilities = { getUuid: () => `${String(++uuidSeq).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`, formatDate: (d, tz, fmt) => fmtJst(d, fmt) };
const logs = [], errs = [], mails = [];
const Logger = { log: m => logs.push(String(m)) };
const fakeConsole = { error: m => errs.push(String(m)), log() {} };

let copyCalls = 0, copyFails = false;
class Sheet {
  constructor(rows, ss, name) { this.rows = rows.map(r => r.slice()); this.ss = ss; this.name = name; }
  getLastRow() { return this.rows.length; }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; }
  appendRow(r) { this.rows.push(r.slice()); }
  deleteRows(from, n) { this.rows.splice(from - 1, n); }
  copyTo(ss) { if (copyFails) throw new Error('copy denied'); copyCalls++; const c = new Sheet(this.rows, ss, '__copy'); ss.sheets['pipeline_log のコピー'] = c; c.name = 'pipeline_log のコピー'; return c; }
  setName(n) { delete this.ss.sheets[this.name]; this.name = n; this.ss.sheets[n] = this; } }
class SS { constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new Sheet([], this, n)); }
  deleteSheet(sh) { delete this.sheets[sh.name]; } }
const book = new SS();
const ctx = { PropertiesService, Utilities, Logger, console: fakeConsole, SpreadsheetApp: { openById: () => book }, MailApp: { sendEmail: (...a) => mails.push(a) } };
vm.createContext(ctx);
['billing.gs', 'main.gs', 'rakuten_api.gs'].forEach(f => vm.runInContext(load(f), ctx, { filename: f }));
const realFetchOrders = ctx.fetchOrders;

const MIN = 60000, DAY = 86400000;
const VMDate = vm.runInContext('Date', ctx);   // vm 内の Date（instanceof Date の判定は realm ごと）
let NOW = Date.UTC(2026, 9, 16, 3, 0, 0);   // 2026-10-16 12:00 JST
const origWb = ctx.getMasterWorkbook_;
ctx.hourlyNow_ = () => new Date(NOW);
ctx.billingNowStr_ = () => fmtJst(new Date(NOW), 'yyyy-MM-dd HH:mm:ss');
ctx.billingToday_ = () => fmtJst(new Date(NOW), 'yyyy-MM-dd');
ctx.getMasterWorkbook_ = () => book;
const origWbMock = ctx.getMasterWorkbook_;
let tenantList = [{ tenant_id: 'A' }, { tenant_id: 'B' }]; const calls = []; let thanksFail = {};
ctx.listActiveTenants = () => tenantList.slice();
ctx.billingAllows_ = () => true;
ctx.fetchOrders = id => calls.push('fetch:' + id);
ctx.linkOrdersReviews = id => calls.push('link:' + id);
ctx.sendPendingMails = id => calls.push('mails:' + id);
ctx.sendPendingReviewThanks = id => { calls.push('thanks:' + id); if (thanksFail[id]) throw new Error(thanksFail[id]); };

const reset = () => {
  Object.keys(book.sheets).forEach(k => delete book.sheets[k]);
  Object.keys(props).forEach(k => delete props[k]);
  logs.length = errs.length = mails.length = calls.length = 0; copyCalls = 0; copyFails = false; thanksFail = {};
  tenantList = [{ tenant_id: 'A' }, { tenant_id: 'B' }]; NOW = Date.UTC(2026, 9, 16, 3, 0, 0);
  ctx.getMasterWorkbook_ = origWbMock; ctx.MailApp.sendEmail = (...a) => mails.push(a);
  ctx.tenantWarnReset_('');
};
const at = msAgo => fmtJst(new Date(NOW - msAgo), 'yyyy-MM-dd HH:mm:ss');
const LOGHEAD = ['tenant_id', 'event', 'detail', 'at'];
const plog = () => { if (!book.sheets.pipeline_log) book.sheets.pipeline_log = new Sheet([LOGHEAD], book, 'pipeline_log'); return book.sheets.pipeline_log; };
const seed = (tenant, event, detail, msAgo) => plog().appendRow([tenant, event, detail, typeof msAgo !== 'number' ? msAgo : at(msAgo)]);
const rows = () => (book.sheets.pipeline_log ? book.sheets.pipeline_log.rows.slice(1) : []);
const evRows = e => rows().filter(r => r[1] === e);
const bak = () => book.sheets.pipeline_log_bak_20261016;

let pass = 0; const t = (n, f) => { reset(); try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

console.log('日次の外部チェック checkHourlyHealth_');
t('179分前は通知なし・記録なし', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('_hourly', 'hourly_start', 'run=aaaa0001', 179 * MIN);
  assert.equal(ctx.checkHourlyHealth_(), 'ok'); assert.equal(mails.length, 0); assert.equal(evRows('hourly_health_alert').length, 0); });
t('180分前は通知（件名・本文: 最終 start / 直近 hourly_error / incomplete・gap 件数）。記録も残る', () => {
  props.ADMIN_EMAIL = 'admin@x.jp';
  seed('_hourly', 'hourly_start', 'run=aaaa0001', 400 * MIN); seed('_hourly', 'hourly_incomplete', 'run=aaaa0002 prev=aaaa0001', 390 * MIN);
  seed('_hourly', 'hourly_gap', 'run=aaaa0002 gap_min=200', 390 * MIN); seed('_hourly', 'hourly_gap', 'run=aaaa0003 gap_min=300', 300 * MIN);
  seed('A', 'hourly_error', 'run=aaaa0001 stage=fetchOrders msg=old', 399 * MIN); seed('B', 'hourly_error', 'run=aaaa0009 stage=billing msg=latest', 250 * MIN);
  seed('_hourly', 'hourly_start', 'run=aaaa0010', 180 * MIN);
  assert.equal(ctx.checkHourlyHealth_(), 'sent'); assert.equal(mails.length, 1);
  const [to, subj, body] = mails[0]; assert.equal(to, 'admin@x.jp'); assert.equal(subj, '[step-samurai] 毎時処理が止まっています');
  assert.ok(body.includes(at(180 * MIN)), '最終 hourly_start の時刻'); assert.ok(body.includes('run=aaaa0009 stage=billing msg=latest') && !body.includes('msg=old'));
  assert.ok(body.includes('hourly_incomplete 件数: 1') && body.includes('hourly_gap 件数: 2'));
  assert.equal(evRows('hourly_health_alert').length, 1); assert.equal(evRows('hourly_health_alert')[0][0], '_hourly'); });
t('hourly_start がまったく無い場合も停止として通知（その旨を本文に）', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; assert.equal(ctx.checkHourlyHealth_(), 'sent'); assert.ok(mails[0][2].includes('1件もありません')); });
t('pipeline_log タブ自体が無くても停止として通知', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; assert.equal(book.sheets.pipeline_log, undefined); assert.equal(ctx.checkHourlyHealth_(), 'sent'); });
t('at が Date 型でも判定できる（最新の start で判定）', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('_hourly', 'hourly_start', 'run=a', new VMDate(NOW - 500 * MIN)); seed('_hourly', 'hourly_start', 'run=b', new VMDate(NOW - 30 * MIN));
  assert.equal(ctx.checkHourlyHealth_(), 'ok'); });
t('同日2回目は送らない', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('_hourly', 'hourly_start', 'run=a', 300 * MIN);
  assert.equal(ctx.checkHourlyHealth_(), 'sent'); NOW += 60 * MIN; assert.equal(ctx.checkHourlyHealth_(), 'duplicate'); assert.equal(mails.length, 1); assert.equal(evRows('hourly_health_alert').length, 1); });
t('翌日は再通知', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('_hourly', 'hourly_start', 'run=a', 300 * MIN);
  ctx.checkHourlyHealth_(); NOW += DAY; assert.equal(ctx.checkHourlyHealth_(), 'sent'); assert.equal(mails.length, 2); assert.equal(evRows('hourly_health_alert').length, 2); });
t('ADMIN_EMAIL 未設定: ログのみ・送信なし・記録なし', () => {
  seed('_hourly', 'hourly_start', 'run=a', 300 * MIN); assert.equal(ctx.checkHourlyHealth_(), 'stale_no_admin_email');
  assert.equal(mails.length, 0); assert.equal(evRows('hourly_health_alert').length, 0); assert.ok(logs.some(l => l.includes('ADMIN_EMAIL 未設定'))); });
t('メール送信が失敗したら記録せず（翌回リトライ可能）、例外を出さない', () => {
  props.ADMIN_EMAIL = 'admin@x.jp'; seed('_hourly', 'hourly_start', 'run=a', 300 * MIN); ctx.MailApp.sendEmail = () => { throw new Error('quota'); };
  assert.equal(ctx.checkHourlyHealth_(), 'send_failed'); assert.equal(evRows('hourly_health_alert').length, 0); assert.ok(errs.some(m => m.includes('send failed'))); });
t('judgeHourlyHealth_ は純粋関数として境界を判定する', () => {
  const j = (min) => ctx.judgeHourlyHealth_([{ tenant: '_hourly', event: 'hourly_start', detail: 'run=a', at: at(min * MIN) }], NOW, '2026-10-16');
  assert.equal(j(179).stale, false); assert.equal(j(180).stale, true); assert.equal(j(180).minAgo, 180); });

console.log('pipeline_log の保持 prunePipelineLog_');
t('14日より古い行だけ消える。バックアップタブが新規作成され元の全行を含む。ヘッダは残る', () => {
  seed('x', 'e', 'd20', 20 * DAY); seed('x', 'e', 'd15', 15 * DAY); seed('x', 'e', 'd13', 13 * DAY); seed('x', 'e', 'd1', 1 * DAY);
  const r = ctx.prunePipelineLog_(); assert.equal(r.backup_created, true); assert.equal(r.deleted_old, 2);
  assert.deepEqual(rows().map(x => x[2]), ['d13', 'd1']); assert.deepEqual(Array.from(book.sheets.pipeline_log.rows[0]), LOGHEAD);
  assert.equal(bak().rows.length, 5); assert.equal(bak().rows[1][2], 'd20'); assert.ok(logs.some(l => l.includes('prunePipelineLog_') && l.includes('2件')));
  assert.equal(props.PIPELINE_LOG_PRUNED_DATE, '2026-10-16'); });
t('at が解釈不能な行は残る（先頭の古い連続ブロックのみ削除）', () => {
  seed('x', 'e', 'old1', 20 * DAY); seed('x', 'e', 'bad', 'not-a-date'); seed('x', 'e', 'old2', 19 * DAY); seed('x', 'e', 'new', 1 * DAY);
  ctx.prunePipelineLog_(); assert.deepEqual(rows().map(x => x[2]), ['bad', 'old2', 'new']); });
t('Date 型の at でも期間判定できる', () => {
  seed('x', 'e', 'oldD', new VMDate(NOW - 30 * DAY)); seed('x', 'e', 'newD', new VMDate(NOW - 1 * DAY)); ctx.prunePipelineLog_(); assert.deepEqual(rows().map(x => x[2]), ['newD']); });
const fill = (n, tag) => { const sh = plog(); for (let i = 0; i < n; i++) sh.rows.push(['x', 'e', tag + i, at(1 * DAY)]); };
t('5,000行超過分を古い順に削る（バックアップ既存の2回目以降）', () => {
  book.sheets.pipeline_log_bak_20261016 = new Sheet([LOGHEAD, ['keep', 'bak', 'marker', '']], book, 'pipeline_log_bak_20261016');
  fill(5100, 'r'); const r = ctx.prunePipelineLog_(); assert.equal(r.backup_created, false); assert.equal(r.deleted_over, 100);
  assert.equal(rows().length, 5000); assert.equal(rows()[0][2], 'r100'); assert.equal(rows()[4999][2], 'r5099'); assert.equal(book.sheets.pipeline_log.rows[0][0], 'tenant_id'); });
t('初回（バックアップ新規作成時）は5,000行規則を適用しない', () => {
  fill(5100, 'r'); const r = ctx.prunePipelineLog_(); assert.equal(r.backup_created, true); assert.equal(r.deleted_over, 0); assert.equal(rows().length, 5100); });
t('バックアップタブは冪等: 2回目は複製せず内容も上書きしない', () => {
  seed('x', 'e', 'a', 1 * DAY); ctx.prunePipelineLog_(); assert.equal(copyCalls, 1); const before = JSON.stringify(bak().rows);
  seed('x', 'e', 'b', 1 * DAY); delete props.PIPELINE_LOG_PRUNED_DATE; ctx.prunePipelineLog_(); assert.equal(copyCalls, 1); assert.equal(JSON.stringify(bak().rows), before); });
t('バックアップ失敗時は一切削除しない（日付も記録しない＝次回再試行）', () => {
  seed('x', 'e', 'old', 30 * DAY); fill(5100, 'r'); copyFails = true; const n = rows().length;
  const r = ctx.prunePipelineLog_(); assert.equal(r.skipped, 'backup_failed'); assert.equal(rows().length, n); assert.equal(bak(), null); assert.equal(props.PIPELINE_LOG_PRUNED_DATE, undefined);
  assert.ok(errs.some(m => m.includes('backup failed'))); });
t('同日2回目は何もしない。翌日は再び実行', () => {
  seed('x', 'e', 'old', 30 * DAY); ctx.prunePipelineLog_(); seed('x', 'e', 'old2', 30 * DAY);
  assert.equal(ctx.prunePipelineLog_().skipped, 'already_today'); assert.ok(rows().some(x => x[2] === 'old2'));
  NOW += DAY; ctx.prunePipelineLog_(); assert.ok(!rows().some(x => x[2] === 'old2')); });
t('整理の結果は pipeline_log に行を追加しない（ログのみ）', () => {
  seed('x', 'e', 'a', 1 * DAY); const n = rows().length; ctx.prunePipelineLog_(); assert.equal(rows().length, n); });
t('pipelineLog_ は行を削除しない（毎時処理の負荷を増やさない）', () => {
  fill(300, 'r'); const n = rows().length; ctx.pipelineLog_('y', 'e', 'z'); assert.equal(rows().length, n + 1); });

console.log('tenant_warn');
t('tenantWarn_ が tenant_warn 行（run / stage / msg）を記録する', () => {
  ctx.tenantWarnReset_('run0001'); assert.equal(ctx.tenantWarn_('A', 'syncCancelledOrders_', 'boom'), true);
  const w = evRows('tenant_warn'); assert.equal(w.length, 1); assert.equal(w[0][0], 'A'); assert.equal(w[0][2], 'run=run0001 stage=syncCancelledOrders_ msg=boom'); });
t('同じ run・テナント・stage は1行。stage が違えば別行、別テナントも別行、新しい run でまた記録', () => {
  ctx.tenantWarnReset_('r1'); ctx.tenantWarn_('A', 's1', 'm'); ctx.tenantWarn_('A', 's1', 'm2'); assert.equal(evRows('tenant_warn').length, 1);
  ctx.tenantWarn_('A', 's2', 'm'); assert.equal(evRows('tenant_warn').length, 2); ctx.tenantWarn_('B', 's1', 'm'); assert.equal(evRows('tenant_warn').length, 3);
  ctx.tenantWarnReset_('r2'); ctx.tenantWarn_('A', 's1', 'm'); assert.equal(evRows('tenant_warn').length, 4); });
t('runHourlyFollowPipeline の外から呼んでも落ちない / シート書込失敗でも例外を出さない', () => {
  assert.doesNotThrow(() => ctx.tenantWarn_('A', 's', 'm')); assert.equal(evRows('tenant_warn').length, 1);
  ctx.getMasterWorkbook_ = () => { throw new Error('sheet down'); }; assert.doesNotThrow(() => ctx.tenantWarn_('A', 's9', 'm')); assert.ok(errs.some(m => m.includes('pipelineLog_ failed'))); });
t('お礼メール失敗: tenant_warn が残り、errors= は従来どおり集計、他テナントと hourly_done は継続', () => {
  thanksFail = { A: 'smtp down' }; ctx.runHourlyFollowPipeline();
  const w = evRows('tenant_warn'); assert.equal(w.length, 1); assert.equal(w[0][0], 'A'); assert.ok(/^run=\S+ stage=sendPendingReviewThanks msg=smtp down$/.test(w[0][2]));
  assert.ok(calls.includes('thanks:B')); assert.ok(rows().some(r => r[0] === 'A' && r[1] === 'hourly_done'));
  assert.ok(rows().find(r => r[0] === '_hourly' && r[1] === 'hourly_done')[2].includes('errors=1')); });
t('run が変わればまた記録される（run ごとにリセット）', () => {
  thanksFail = { A: 'x' }; ctx.runHourlyFollowPipeline(); ctx.runHourlyFollowPipeline(); assert.equal(evRows('tenant_warn').length, 2);
  assert.notEqual(evRows('tenant_warn')[0][2].split(' ')[0], evRows('tenant_warn')[1][2].split(' ')[0]); });

// fetchOrders: 実物を使い、依存だけモック
const mockFetchDeps = (over) => {
  const orders = { getRange: () => ({ getValues: () => [['order_number']] }), getLastColumn: () => 1 };
  const d = { ensureAnalyticsColumns_: () => {}, getTenantSpreadsheet: () => ({ getSheetByName: () => orders }), searchOrderNumbers_: () => [], getOrdersByNumbers_: () => [], upsertOrdersBatch_: () => {},
    syncCancelledOrders_: () => 0, recomputePurchaseCounts_: () => calls.push('recompute'), ...over };
  Object.keys(d).forEach(k => { ctx[k] = d[k]; });
};
t('ensureAnalyticsColumns_ 失敗: tenant_warn を残し、受注取得・後続処理は継続', () => {
  mockFetchDeps({ ensureAnalyticsColumns_: () => { throw new Error('cols fail'); }, searchOrderNumbers_: () => ['N1'], getOrdersByNumbers_: () => [{}], upsertOrdersBatch_: () => calls.push('upsert') });
  assert.doesNotThrow(() => realFetchOrders('A'));
  const w = evRows('tenant_warn'); assert.equal(w.length, 1); assert.ok(w[0][2].includes('stage=ensureAnalyticsColumns_ msg=cols fail')); assert.ok(calls.includes('upsert') && calls.includes('recompute'));
  assert.ok(logs.some(l => l.includes('ensureAnalyticsColumns_ skip'))); });
t('syncCancelledOrders_ 失敗: tenant_warn を残し、後続（purchase_count 再計算）は継続', () => {
  mockFetchDeps({ syncCancelledOrders_: () => { throw new Error('rms 503'); } });
  assert.doesNotThrow(() => realFetchOrders('A'));
  const w = evRows('tenant_warn'); assert.equal(w.length, 1); assert.ok(w[0][2].includes('stage=syncCancelledOrders_ msg=rms 503')); assert.ok(calls.includes('recompute'));
  assert.ok(logs.some(l => l.includes('syncCancelledOrders_ skip'))); });

console.log('checkBillingDaily への影響');
const setupDaily = () => {
  const writes = []; ctx.listAllTenants_ = () => [{ tenant_id: 'T1', shop_name: '店' }];
  ctx.readBillingRow_ = () => ({ billing_status: 'trial', trial_end: '2026-10-01', billing_note: '' });
  ctx.writeBillingFields_ = (id, f) => writes.push([id, f]); ctx.appendBillingEvent_ = () => {}; ctx.sendTrialDigest_ = () => 'none';
  return writes;
};
t('外部チェックが例外でも flagged を返し trial 処理は反映される', () => {
  const writes = setupDaily(); const origH = ctx.checkHourlyHealth_; ctx.checkHourlyHealth_ = () => { throw new Error('health boom'); };
  try { assert.deepEqual(Array.from(ctx.checkBillingDaily()), ['T1']); } finally { ctx.checkHourlyHealth_ = origH; }
  assert.equal(writes.length, 1); assert.ok(writes[0][1].billing_note.includes('trial期限切れ')); assert.ok(errs.some(m => m.includes('checkHourlyHealth_ failed'))); });
t('整理が例外でも flagged を返し trial 処理は反映される', () => {
  const writes = setupDaily(); const orig = ctx.prunePipelineLog_; ctx.prunePipelineLog_ = () => { throw new Error('prune boom'); };
  try { assert.deepEqual(Array.from(ctx.checkBillingDaily()), ['T1']); } finally { ctx.prunePipelineLog_ = orig; }
  assert.equal(writes.length, 1); assert.ok(errs.some(m => m.includes('prunePipelineLog_ failed'))); });
t('実物の外部チェック・整理が走っても（マスターシート障害時でも）checkBillingDaily は完走する', () => {
  const writes = setupDaily(); ctx.getMasterWorkbook_ = () => { throw new Error('master down'); };
  assert.deepEqual(Array.from(ctx.checkBillingDaily()), ['T1']); assert.equal(writes.length, 1); });
t('正常時は外部チェック・整理が checkBillingDaily から1回ずつ実行される', () => {
  setupDaily(); props.ADMIN_EMAIL = 'admin@x.jp'; seed('x', 'e', 'old', 30 * DAY); seed('_hourly', 'hourly_start', 'run=a', 300 * MIN);
  ctx.checkBillingDaily(); assert.equal(mails.length, 1); assert.equal(props.PIPELINE_LOG_PRUNED_DATE, '2026-10-16'); assert.ok(!rows().some(r => r[2] === 'old')); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
