// node tests/extension_manifest_tests.js — 拡張の manifest（権限の完全一致・MV3）と、参照ファイルの実在・禁止 API の不使用。
const assert = require('assert'), fs = require('fs'), path = require('path');
const EXT = path.join(__dirname, '..', 'extension');
const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');

let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };
const sorted = a => [...a].sort();

t('Manifest V3・名前・バージョン', () => {
  assert.equal(m.manifest_version, 3); assert.equal(m.name, 'ステップ侍 レビュー取込'); assert.equal(m.version, '1.0.0');
});
t('permissions は storage と alarms のみ（完全一致）', () => {
  assert.deepEqual(sorted(m.permissions), ['alarms', 'storage']);
  assert.equal(m.optional_permissions, undefined); assert.equal(m.optional_host_permissions, undefined);
});
t('host_permissions は3つのみ（完全一致）', () => {
  assert.deepEqual(sorted(m.host_permissions), ['https://review.rms.rakuten.co.jp/*', 'https://script.google.com/*', 'https://script.googleusercontent.com/*']);
});
t('content_scripts の matches は review.rms.rakuten.co.jp のみ', () => {
  assert.equal(m.content_scripts.length, 1);
  assert.deepEqual(m.content_scripts[0].matches, ['https://review.rms.rakuten.co.jp/*']);
});
t('参照ファイル（service worker・content・popup・options・アイコン・lib）が実在する', () => {
  const files = [m.background.service_worker, ...m.content_scripts[0].js, m.action.default_popup, m.options_ui.page, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  files.forEach(f => assert.ok(fs.existsSync(path.join(EXT, f)), f));
  [16, 48, 128].forEach(s => assert.ok(m.icons[String(s)]));
  assert.equal(m.background.type, undefined);   // classic service worker（importScripts）
  const imports = /importScripts\(([^)]*)\)/.exec(read('background.js'))[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  imports.forEach(f => assert.ok(fs.existsSync(path.join(EXT, f)), f));
  ['popup.html', 'options.html'].forEach(h => (read(h).match(/(?:src|href)="([^"#]+)"/g) || []).map(s => s.replace(/^[a-z]+="|"$/g, '')).filter(u => !/^https?:/.test(u)).forEach(f => assert.ok(fs.existsSync(path.join(EXT, f)), h + ' -> ' + f)));
});
t('アイコンは PNG（16/48/128 の寸法）', () => {
  [16, 48, 128].forEach(s => { const b = fs.readFileSync(path.join(EXT, `icons/icon${s}.png`)); assert.equal(b.readUInt32BE(16), s); assert.equal(b.readUInt32BE(20), s); assert.equal(b.slice(1, 4).toString(), 'PNG'); });
});
t('HTML にインライン script がなく、外部スクリプト（リモートコード）を読み込まない', () => {
  ['popup.html', 'options.html'].forEach(h => {
    const s = read(h);
    (s.match(/<script\b[^>]*>/g) || []).forEach(tag => { assert.ok(/\bsrc="[^"]+"/.test(tag) && !/src="https?:/.test(tag), h + ' ' + tag); });
    (s.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || []).forEach(x => assert.equal(x.replace(/<script\b[^>]*>|<\/script>/g, '').trim(), '', h));
    assert.ok(!/\son\w+\s*=/.test(s), h + ' にインラインイベントハンドラ');
  });
});
t('コードが禁止 API を使わない（tabs 権限が要る API・cookies・webRequest・notifications・scripting・storage.sync・eval）', () => {
  const code = ['background.js', 'content.js', 'popup.js', 'options.js', ...fs.readdirSync(path.join(EXT, 'lib')).map(f => 'lib/' + f)].map(read).join('\n');
  [/chrome\.cookies/, /chrome\.webRequest/, /chrome\.notifications/, /chrome\.scripting/, /storage\.sync/, /\beval\s*\(/, /new Function\(/, /document\.cookie/].forEach(re => assert.ok(!re.test(code), String(re)));
  assert.ok(!/\.tabs\.(create|update|remove|reload)\b/.test(code));
  assert.ok(/chrome\.tabs\.query\(\{ url:/.test(code));   // host 権限で足りる形（url フィルタ）
  assert.ok(!/innerHTML/.test(code));
});

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
