// node tests/extension_send_tests.js — 拡張の送信オーケストレーション・状態遷移・自動同期（1日1回）・バッジ。値はすべて架空。
const assert = require('assert'), path = require('path');
const L = p => require(path.join(__dirname, '..', 'extension', 'lib', p));
const sender = L('sender'), state = L('state'), config = L('config');

const tests = []; const t = (n, f) => tests.push([n, f]);
const TOKEN = 'sse_' + 'a'.repeat(64);
const jst = (y, m, d, h = 0, i = 0) => Date.UTC(y, m - 1, d, h, i) - 9 * 3600e3;
const revs = n => Array.from({ length: n }, (_, i) => ({ review_type: '商品レビュー', review_id: `https://example.invalid/r/${i}`, rating: 5, posted_at: '2026/10/1 0:00:00', order_number: '111111-20261001-0000000001' }));
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const mkDeps = (handler) => { const calls = [], sleeps = []; return { calls, sleeps, fetchFn: async (u, o) => { calls.push({ u, o, body: JSON.parse(o.body) }); return handler(calls.length, calls[calls.length - 1]); }, sleep: async ms => { sleeps.push(ms); } }; };
const mkStore = (init = {}) => { const s = { ...init }; return { data: s, get: async () => ({ ...s }), set: async p => { Object.assign(s, p); } }; };

t('送信: POST text/plain・action/payload の形・dry_run:false・500件ずつ', async () => {
  const d = mkDeps(() => jsonRes({ ok: true, inserted: 1, updated: 0 }));
  const r = await sender.sendAll(revs(1200), TOKEN, d);
  assert.ok(r.ok); assert.equal(d.calls.length, 3);
  const c = d.calls[0];
  assert.equal(c.u, config.GAS_URL); assert.equal(c.o.method, 'POST'); assert.equal(c.o.headers['Content-Type'], 'text/plain');
  assert.equal(c.body.action, 'ext_ingest_reviews'); assert.equal(c.body.payload.token, TOKEN); assert.equal(c.body.payload.dry_run, false);
  assert.deepEqual(d.calls.map(x => x.body.payload.reviews.length), [500, 500, 200]);
});
t('0件でも空配列を1回 POST（心拍）', async () => {
  const d = mkDeps(() => jsonRes({ ok: true, inserted: 0, updated: 0 }));
  const r = await sender.sendAll([], TOKEN, d);
  assert.ok(r.ok); assert.equal(d.calls.length, 1); assert.deepEqual(d.calls[0].body.payload.reviews, []);
});
t('probe は dry_run:true・空配列で initial_from を返す', async () => {
  const d = mkDeps(() => jsonRes({ ok: true, dry_run: true, initial_from: '2026-09-24' }));
  const r = await sender.probe(TOKEN, d);
  assert.deepEqual(r, { ok: true, initialFrom: '2026-09-24' });
  assert.equal(d.calls[0].body.payload.dry_run, true); assert.deepEqual(d.calls[0].body.payload.reviews, []);
});
t('成功で lastSyncAt = 同期の開始時刻、status = ok', async () => {
  const store = mkStore({ token: TOKEN }); const now = jst(2026, 10, 24, 10);
  const b = await state.beginSync(store, now, false); assert.ok(b.ok);
  const d = mkDeps(() => jsonRes({ ok: true, inserted: 2, updated: 0 }));
  await state.finishSync(store, b.startedAt, await sender.sendAll(revs(2), TOKEN, d));
  assert.equal(store.data.lastSyncAt, now); assert.equal(store.data.status, 'ok'); assert.equal(store.data.syncingSince, 0);
});
t('途中のチャンクで失敗したら lastSyncAt を更新せず、以降のチャンクを送らない', async () => {
  const prev = jst(2026, 10, 20);
  const store = mkStore({ token: TOKEN, lastSyncAt: prev });
  const b = await state.beginSync(store, jst(2026, 10, 24), false);
  const d = mkDeps(n => n === 2 ? jsonRes({ ok: false, error: 'busy' }) : jsonRes({ ok: true }));
  const r = await sender.sendAll(revs(1200), TOKEN, d);
  await state.finishSync(store, b.startedAt, r);
  assert.equal(r.ok, false); assert.equal(r.error, 'busy'); assert.equal(d.calls.length, 2);
  assert.equal(store.data.lastSyncAt, prev); assert.equal(store.data.status, 'busy');
});
t('GAS のエラーコード（unauthorized 等）は再試行せず停止し、状態を保存する', async () => {
  for (const code of ['unauthorized', 'token_revoked', 'tenant_not_active', 'billing_not_allowed', 'invalid_payload', 'too_many_rows', 'busy', 'internal_error']) {
    const d = mkDeps(() => jsonRes({ ok: false, error: code }));
    const r = await sender.sendAll(revs(3), TOKEN, d);
    assert.deepEqual([r.ok, r.error, d.calls.length, d.sleeps.length], [false, code, 1, 0], code);
  }
  const d = mkDeps(() => jsonRes({ ok: false, error: 'なにか未知' }));
  assert.equal((await sender.sendAll(revs(1), TOKEN, d)).error, 'internal_error');
});
t('5xx・通信失敗は 1s/3s/9s で3回再試行し、以降は network で停止（次回に持ち越し）', async () => {
  const d = mkDeps(() => jsonRes({}, 503));
  const r = await sender.sendAll(revs(3), TOKEN, d);
  assert.equal(r.ok, false); assert.equal(r.error, 'network'); assert.equal(d.calls.length, 4); assert.deepEqual(d.sleeps, [1000, 3000, 9000]);
  const d2 = mkDeps(() => { throw new Error('offline'); });
  assert.equal((await sender.sendAll(revs(3), TOKEN, d2)).error, 'network'); assert.equal(d2.calls.length, 4);
});
t('再試行の途中で成功すれば続行する', async () => {
  const d = mkDeps(n => n < 3 ? jsonRes({}, 502) : jsonRes({ ok: true, inserted: 1 }));
  const r = await sender.sendAll(revs(1), TOKEN, d);
  assert.ok(r.ok); assert.equal(d.calls.length, 3);
});

t('自動同期は1日1回まで（成功・失敗にかかわらず JST 日付で記録）、手動は無制限', async () => {
  const store = mkStore({ token: TOKEN });
  const morning = jst(2026, 10, 24, 9), evening = jst(2026, 10, 24, 23, 59), nextDay = jst(2026, 10, 25, 0, 1);
  let b = await state.beginSync(store, morning, true); assert.ok(b.ok);
  await state.finishSync(store, b.startedAt, { ok: false, error: 'login_required' });   // 失敗でも試行日は残る
  assert.equal(store.data.lastAutoDay, '2026-10-24');
  b = await state.beginSync(store, evening, true); assert.deepEqual([b.ok, b.reason], [false, 'already_tried_today']);
  b = await state.beginSync(store, evening, false); assert.ok(b.ok); await state.finishSync(store, b.startedAt, { ok: true });   // 手動は可
  b = await state.beginSync(store, nextDay, true); assert.ok(b.ok);   // JST の日付が変われば再度可
});
t('同期中フラグ: 二重実行を拒否し、タイムアウト後は再開できる。トークン未設定は拒否', async () => {
  const store = mkStore({ token: TOKEN }); const now = jst(2026, 10, 24, 9);
  assert.ok((await state.beginSync(store, now, false)).ok);
  assert.equal((await state.beginSync(store, now + 60e3, false)).reason, 'syncing');
  assert.ok((await state.beginSync(store, now + config.SYNC_TIMEOUT_MS + 1, false)).ok);
  assert.equal((await state.beginSync(mkStore({}), now, false)).reason, 'no_token');
});
t('バッジ: 設定 / 未ログイン・失敗は赤い ! / 48時間超は赤い 48h / 正常は空（0件でも正常）', () => {
  const now = jst(2026, 10, 24, 9), fresh = now - 3600e3, old = now - 48 * 3600e3 - 1000;
  const b = o => state.badgeFor(o, now);
  assert.equal(b({}).text, '設定');
  assert.equal(b({ token: TOKEN }).text, '');
  assert.equal(b({ token: TOKEN, lastSyncAt: old, status: 'ok' }).text, '48h'); assert.equal(b({ token: TOKEN, lastSyncAt: old, status: 'ok' }).color, '#dc2626');
  assert.equal(b({ token: TOKEN, lastSyncAt: fresh, status: 'ok' }).text, '');
  assert.equal(b({ token: TOKEN, lastSyncAt: now - 47 * 3600e3 }).text, '');
  ['login_required', 'token_revoked', 'unauthorized', 'csv_format', 'billing_not_allowed', 'network', 'fetch_failed'].forEach(st => { const r = b({ token: TOKEN, lastSyncAt: fresh, status: st }); assert.equal(r.text, '!', st); assert.equal(r.color, '#dc2626'); });
  assert.equal(state.classify({ token: TOKEN, status: 'login_required' }), 'not_logged_in'); assert.equal(state.classify({ token: TOKEN, status: 'csv_format' }), 'failed'); assert.equal(state.classify({ token: TOKEN, status: 'ok' }), 'ok');
  assert.equal(b({ token: TOKEN, lastSyncAt: fresh, status: 'ok' }).text, '');
});
t('日本語の案内: すべての状態コードに文面があり、保存対象は5キーのみ', () => {
  ['login_required', 'csv_format', 'cap_unsplittable', 'unauthorized', 'token_revoked', 'tenant_not_active', 'billing_not_allowed', 'invalid_payload', 'too_many_rows', 'busy', 'network', 'internal_error'].forEach(c => assert.ok(/[぀-ヿ一-鿿]/.test(state.MESSAGES[c]), c));
  assert.deepEqual(state.KEYS, ['token', 'lastSyncAt', 'status', 'lastAutoDay', 'syncingSince', 'notified']);
  const d = state.describe({ token: TOKEN, lastSyncAt: jst(2026, 10, 24, 9, 5) }, jst(2026, 10, 24, 10));
  assert.equal(d.lastSync, '2026/10/24 9:05（日本時間）');
});

(async () => {
  let pass = 0;
  for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } }
  console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
})();
