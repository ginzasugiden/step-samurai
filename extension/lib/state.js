/* 同期状態（storage.local に置く token / lastSyncAt / status / lastAutoDay / syncingSince のみ）の遷移、バッジ、日本語の案内。
 * レビューのデータは一切保存しない。store は { get(): Promise<object>, set(patch): Promise } を注入する。 */
(function (root, name, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var req = function (n) { return isNode ? require('./' + n) : root.SSX[n]; };
  var api = factory(req);
  if (isNode) module.exports = api; else { root.SSX = root.SSX || {}; root.SSX[name] = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, 'state', function (req) {
  var config = req('config'), time = req('time');

  var KEYS = ['token', 'lastSyncAt', 'status', 'lastAutoDay', 'syncingSince', 'notified'];

  var HARD_TOKEN = ['unauthorized', 'token_revoked'];
  var SOFT = ['busy', 'network'];   // 次回に持ち越す一時的な失敗（バッジは通常ロジック）

  var MESSAGES = {
    ok: '前回の同期は正常に完了しました。',
    no_token: '店舗トークンが未設定です。設定画面でトークンを保存してください。',
    login_required: '楽天 RMS にログインしていません。RMS にログインしてレビューチェックツールを開いてから、もう一度同期してください。',
    csv_format: 'RMS から取得したデータの形式が想定と違うため、何も送らずに停止しました。RMS の画面仕様が変わった可能性があります。拡張機能の更新をお待ちください。',
    cap_unsplittable: '1分間に3,000件以上のレビューがあり期間を分割できないため、何も送らずに停止しました。運営にご連絡ください。',
    fetch_failed: 'RMS からの取得に失敗しました。時間をおいて、もう一度同期してください。',
    no_content: 'RMS のページと接続できませんでした。RMS のレビューチェックツールのページを再読み込みしてから、もう一度押してください。',
    unauthorized: 'トークンが正しくありません。設定画面でトークンを確認してください。',
    token_revoked: 'このトークンは無効になっています。運営に再発行を依頼し、設定画面で新しいトークンを保存してください。',
    tenant_not_active: 'この店舗は現在停止中のため取り込めません。',
    billing_not_allowed: 'ご利用状況の確認が必要なため取り込めません。運営にご連絡ください。',
    invalid_payload: '送信内容の形式が正しくありません。拡張機能の更新が必要な可能性があります。運営にご連絡ください。',
    too_many_rows: '1回に送れる件数を超えました。運営にご連絡ください。',
    busy: '受け口が他の処理を実行中でした。しばらくして、もう一度同期してください（次回に持ち越します）。',
    network: '通信に失敗しました。インターネット接続を確認して、もう一度同期してください（次回に持ち越します）。',
    internal_error: '受け口で内部エラーが発生しました。時間をおいて、もう一度同期してください。続く場合は運営にご連絡ください。',
  };
  function messageFor(code) { return MESSAGES[code] || MESSAGES.internal_error; }

  /** 保存済み状態 → 正規化（欠けは null） */
  function normalize(raw) {
    raw = raw || {};
    return {
      token: typeof raw.token === 'string' && raw.token ? raw.token : null,
      lastSyncAt: Number(raw.lastSyncAt) > 0 ? Number(raw.lastSyncAt) : null,
      status: typeof raw.status === 'string' && raw.status ? raw.status : null,
      lastAutoDay: typeof raw.lastAutoDay === 'string' && raw.lastAutoDay ? raw.lastAutoDay : null,
      syncingSince: Number(raw.syncingSince) > 0 ? Number(raw.syncingSince) : null,
      notified: raw.notified === 'problem' ? 'problem' : '',
    };
  }
  function isSyncing(s, now) { return !!s.syncingSince && now - s.syncingSince < config.SYNC_TIMEOUT_MS; }
  function isStale(s, now) { return !s.lastSyncAt || now - s.lastSyncAt > config.STALE_MS; }

  /** 同期の開始許可。auto の場合は今日（JST）の試行日を記録する（成否にかかわらず1日1回）。 */
  async function beginSync(store, now, auto) {
    var s = normalize(await store.get());
    if (!s.token) return { ok: false, reason: 'no_token' };
    if (isSyncing(s, now)) return { ok: false, reason: 'syncing' };
    var today = time.jstDay(now);
    if (auto && s.lastAutoDay === today) return { ok: false, reason: 'already_tried_today' };
    var patch = { syncingSince: now };
    if (auto) patch.lastAutoDay = today;
    await store.set(patch);
    return { ok: true, startedAt: now, token: s.token, lastSyncAt: s.lastSyncAt };
  }

  /** 同期の終了。成功時のみ lastSyncAt = 開始時刻。失敗時は更新しない。 */
  async function finishSync(store, startedAt, result) {
    var patch = { syncingSince: 0 };
    if (result.ok) { patch.status = 'ok'; patch.lastSyncAt = startedAt; }
    else patch.status = result.error || 'internal_error';
    await store.set(patch);
  }

  /** 状態の分類（GAS へ送る値と同じ）: 'ok' | 'not_logged_in' | 'failed' */
  function classify(raw) {
    var s = normalize(raw);
    if (!s.status || s.status === 'ok') return 'ok';
    return s.status === 'login_required' ? 'not_logged_in' : 'failed';
  }
  /** 要対応か（未ログイン・失敗中、または最終成功から48時間超） */
  function needsAction(raw, now) {
    var s = normalize(raw);
    if (!s.token) return false;
    return classify(raw) !== 'ok' || (!!s.lastSyncAt && now - s.lastSyncAt > config.STALE_MS);
  }

  /** アイコンのバッジ: 設定未了は「設定」、未ログイン・失敗中は赤い「!」、48時間超は赤い「48h」。正常に戻ったら消す */
  function badgeFor(raw, now) {
    var s = normalize(raw);
    var GRAY = '#6b7280', RED = '#dc2626';
    if (!s.token) return { text: '設定', color: GRAY };
    if (classify(raw) !== 'ok') return { text: '!', color: RED };
    if (isStale(s, now) && s.lastSyncAt) return { text: '48h', color: RED };
    return { text: '', color: GRAY };
  }

  /** ポップアップ表示用 { level: 'ok'|'warn'|'error'|'info', headline, detail, lastSync } */
  function describe(raw, now) {
    var s = normalize(raw);
    var lastSync = s.lastSyncAt ? time.formatJst(s.lastSyncAt) + '（日本時間）' : 'まだ同期していません';
    if (!s.token) return { level: 'info', headline: '設定が必要です', detail: MESSAGES.no_token, lastSync: lastSync };
    if (isSyncing(s, now)) return { level: 'info', headline: '同期中です', detail: 'RMS からレビュー項目を取得して送信しています。', lastSync: lastSync };
    var st = s.status;
    if (st && st !== 'ok') {
      return { level: 'error', headline: st === 'login_required' ? '要対応：RMSにログインしてください' : '要対応：取り込めませんでした', detail: messageFor(st), lastSync: lastSync };
    }
    if (isStale(s, now) && s.lastSyncAt) {
      return { level: 'error', headline: '要対応：48時間以上取り込めていません', detail: 'Chrome を起動して RMS にログインし、「今すぐ取り込む」を押してください。', lastSync: lastSync };
    }
    if (!s.lastSyncAt) return { level: 'info', headline: '初回の取り込みを待っています', detail: 'Chrome を起動して RMS にログインしている間に、3時間ごとに自動で取り込みます。', lastSync: lastSync };
    return { level: 'ok', headline: '正常です', detail: MESSAGES.ok, lastSync: lastSync };
  }

  return { classify: classify, needsAction: needsAction, KEYS: KEYS, MESSAGES: MESSAGES, messageFor: messageFor, normalize: normalize, isSyncing: isSyncing, isStale: isStale, beginSync: beginSync, finishSync: finishSync, badgeFor: badgeFor, describe: describe };
});
