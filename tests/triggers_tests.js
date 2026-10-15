// node tests/triggers_tests.js — 修正5: setupTriggers は管理対象だけを冪等に登録し、他のトリガーを消さない
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
const load = f => fs.readFileSync(path.join(__dirname, '..', 'gas', 'src', f), 'utf8').split('\r\n').join('\n');

let triggers = []; const logs = []; let seq = 0;
const ScriptApp = {
  getProjectTriggers: () => triggers.slice(),
  deleteTrigger: t => { triggers = triggers.filter(x => x !== t); },
  newTrigger: h => { const spec = { handler: h, kind: '', every: '', hour: null };
    const b = { timeBased: () => b, everyHours: n => { spec.kind = 'hours'; spec.every = n; return b; }, everyDays: n => { spec.kind = 'days'; spec.every = n; return b; },
      atHour: n => { spec.hour = n; return b; }, onMonthDay: () => { spec.kind = 'month'; return b; },
      create: () => { const tr = Object.assign({ id: ++seq, getHandlerFunction: () => h }, spec); triggers.push(tr); return tr; } }; return b; },
};
const ctx = { ScriptApp, Logger: { log: m => logs.push(String(m)) }, console, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } };
vm.createContext(ctx); vm.runInContext(load('main.gs'), ctx, { filename: 'main.gs' });
const handlers = () => triggers.map(t => t.getHandlerFunction()).sort();
const mk = h => { triggers.push({ id: ++seq, getHandlerFunction: () => h }); return triggers[triggers.length - 1]; };

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

t('planManagedTriggers_: 0本→作成 / 1本→維持 / 2本以上→1本目を残して重複削除 / 管理外は無視', () => {
  const managed = [{ handler: 'a' }, { handler: 'b' }];
  assert.deepEqual(ctx.planManagedTriggers_([], managed), { create: ['a', 'b'], dedupe: [], keep: [] });
  assert.deepEqual(ctx.planManagedTriggers_(['a', 'x', 'b'], managed), { create: [], dedupe: [], keep: ['a', 'b'] });
  assert.deepEqual(ctx.planManagedTriggers_(['a', 'b', 'a', 'a'], managed), { create: [], dedupe: [2, 3], keep: ['a', 'b'] }); });
t('空の状態: runHourlyFollowPipeline（毎時）・checkBillingDaily（毎日9時）・runLicenseCheck（毎日9時）の3本が作られる', () => {
  const r = ctx.setupTriggers(); assert.deepEqual(handlers(), ['checkBillingDaily', 'runHourlyFollowPipeline', 'runLicenseCheck']); assert.equal(r.created.length, 3);
  const h = triggers.find(x => x.handler === 'runHourlyFollowPipeline'), d = triggers.find(x => x.handler === 'checkBillingDaily'), l = triggers.find(x => x.handler === 'runLicenseCheck');
  assert.equal(h.kind, 'hours'); assert.equal(h.every, 1); assert.equal(d.kind, 'days'); assert.equal(d.hour, 9); assert.equal(l.kind, 'days'); assert.equal(l.every, 1); assert.equal(l.hour, 9); });
t('冪等: 何度実行しても本数も既存トリガーの実体も変わらない（時刻がずれない）', () => {
  const ids = triggers.map(x => x.id); ctx.setupTriggers(); ctx.setupTriggers(); assert.deepEqual(triggers.map(x => x.id), ids); assert.equal(triggers.length, 3); });
t('他のトリガー（runPipeline / runMonthlyReport / 任意）は消さない', () => {
  triggers = []; mk('runPipeline'); mk('runMonthlyReport'); mk('someManualFunction'); ctx.setupTriggers();
  assert.deepEqual(handlers(), ['checkBillingDaily', 'runHourlyFollowPipeline', 'runLicenseCheck', 'runMonthlyReport', 'runPipeline', 'someManualFunction']); });
t('管理対象が重複登録されていれば1本に減らし、片方だけ無ければ補う', () => {
  triggers = []; const first = mk('runHourlyFollowPipeline'); mk('runHourlyFollowPipeline'); mk('runHourlyFollowPipeline'); mk('runPipeline');
  ctx.setupTriggers(); assert.deepEqual(handlers(), ['checkBillingDaily', 'runHourlyFollowPipeline', 'runLicenseCheck', 'runPipeline']); assert.ok(triggers.includes(first), '1本目が残る'); });
t('現在の本番構成（runHourlyFollowPipeline と checkBillingDaily の2本）では runLicenseCheck だけが追加され、既存2本は変わらない', () => {
  triggers = []; mk('runHourlyFollowPipeline'); mk('checkBillingDaily'); const ids = triggers.map(x => x.id); const r = ctx.setupTriggers();
  assert.deepEqual(triggers.slice(0, 2).map(x => x.id), ids); assert.deepEqual(r.created, ['runLicenseCheck']); assert.equal(r.deduped, 0); assert.equal(triggers.length, 3);
  const r2 = ctx.setupTriggers(); assert.equal(r2.created.length, 0); assert.equal(triggers.length, 3); });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
