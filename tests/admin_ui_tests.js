// node tests/admin_ui_tests.js — 管理画面(webui/admin.js)の搭載チェック新項目・最終削除のスキップ理由表示、および appsscript.json のスコープ回帰（架空データ）
const fs = require('fs'), path = require('path'), assert = require('assert'), vm = require('vm');
let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const src = fs.readFileSync(path.join(__dirname, '..', 'webui', 'admin.js'), 'utf8').split('\r\n').join('\n');
const pick = (re) => { const m = re.exec(src); assert.ok(m, 'admin.js に見つからない: ' + re); return m[0]; };

// admin.js 全体は DOM 依存なので、必要な関数・定数だけを抜き出して実行する
const checklistFn = pick(/function renderChecklist\(t\) \{[\s\S]*?\n\}\n/);
const skipDefs = pick(/const FINAL_DELETE_SKIP = [^\n]*\n/) + pick(/const finalDeleteSkipText = [^\n]*\n/);
const lis = [];
const ctx = { document: { createElement: () => ({ set className(v) {}, set textContent(v) { this._t = v; lis.push(this); }, get textContent() { return this._t; } }) }, $: () => ({ innerHTML: '', appendChild() {} }) };
vm.createContext(ctx); vm.runInContext(skipDefs + checklistFn, ctx);
const tenant = o => Object.assign({ tenant_id: 'x', status: 'setup', settings: {}, has_credentials: true, has_smtp: true, active_tokens: 1, ext_token_active: false }, o);
const labelOf = () => lis.map(l => l.textContent);

console.log('搭載チェック: 拡張用トークン項目');
t('未発行は ✘、発行済みは ✔。店舗トークン項目の直後にある', () => {
  lis.length = 0; vm.runInContext('renderChecklist', ctx)(tenant({ ext_token_active: false }));
  let L = labelOf(); const i = L.findIndex(x => x.includes('拡張用トークンを発行し、拡張機能の案内を送る'));
  assert.ok(i > 0); assert.ok(L[i].startsWith('✘ ')); assert.ok(L[i].includes('「操作」→ レビュー取込トークン'));
  assert.ok(L[i - 1].includes('店舗トークンを発行し店舗へ渡す'));
  lis.length = 0; vm.runInContext('renderChecklist', ctx)(tenant({ ext_token_active: true }));
  L = labelOf(); assert.ok(L.find(x => x.includes('拡張用トークンを発行し')).startsWith('✔ '));
});
t('ext_token_active が来ない（旧レスポンス）でも例外にならず ✘', () => {
  lis.length = 0; const x = tenant({}); delete x.ext_token_active; vm.runInContext('renderChecklist', ctx)(x);
  assert.ok(labelOf().find(l => l.includes('拡張用トークンを発行し')).startsWith('✘ ')); });

console.log('最終削除のスキップ理由表示');
t('固定値と「trash_failed: メッセージ」の両方を読める', () => {
  const f = ctx.finalDeleteSkipText || vm.runInContext('finalDeleteSkipText', ctx);
  assert.equal(f('name_mismatch'), 'ファイル名が想定と違うため触りませんでした');
  assert.equal(f('trash_failed'), 'ゴミ箱への移動に失敗しました');
  assert.equal(f('trash_failed: Exception: no permission'), 'ゴミ箱への移動に失敗しました [Exception: no permission]');
  assert.equal(f('unknown_x'), 'unknown_x'); });

console.log('appsscript.json: スコープ回帰');
t('webapp セクションを保持し、oauthScopes を明示するなら Drive 全体スコープ(drive)と spreadsheets を含む', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas', 'src', 'appsscript.json'), 'utf8'));
  assert.ok(m.webapp && m.webapp.executeAs === 'USER_DEPLOYING' && m.webapp.access === 'ANYONE_ANONYMOUS');
  if (m.oauthScopes) { // setTrashed/getFileById/copy には drive.file や drive.readonly では足りない
    ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'].forEach(sc => assert.ok(m.oauthScopes.includes(sc), '不足: ' + sc)); } });

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
