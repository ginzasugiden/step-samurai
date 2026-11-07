/**
 * モニター応募の受付（apply.html → doPost action=monitor_apply）。認証不要の公開入口なので fail-closed で作る。
 *  - Script Properties TURNSTILE_SECRET（Cloudflare Turnstile のシークレット。値はシート・ログ・コードに出さない）が未設定なら受け付けない（not_ready）。
 *  - 受付はマスターシートの applications タブに追記するだけ（既存タブは変更しない）。応募者への自動返信は送らない。
 *  - 例外時はスタックトレースを返さず internal_error。
 */
const MONITOR_APPLY_DEADLINE_MS_ = new Date('2026-11-24T23:59:59+09:00').getTime();   // JST 23:59:59 まで受付
const MONITOR_APPLY_SHEET_ = 'applications';
const MONITOR_APPLY_HEADER_ = ['received_at', 'shop_name', 'shop_url', 'contact_name', 'email', 'monthly_orders', 'follow_mail', 'rms_api', 'browser', 'expectation', 'case_publish', 'status', 'memo'];
const MONITOR_TURNSTILE_VERIFY_URL_ = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MONITOR_TURNSTILE_HOSTNAME_ = 'step-samurai.ginzasugiden.com';
const MONITOR_EMAIL_INTERVAL_SEC_ = 600;   // 同じメールアドレスは10分に1回
const MONITOR_GLOBAL_LIMIT_ = 30;          // 全体で1時間30件
const MONITOR_GLOBAL_WINDOW_SEC_ = 3600;
const MONITOR_OPTIONS_ = {
  monthly_orders: ['30件未満', '30〜100件', '100〜300件', '300件以上'],
  follow_mail: ['送っていない', '手動で送っている', '他のツールを利用', 'その他'],
  rms_api: ['利用中', '未申請', 'わからない'],
  browser: ['Chrome', 'その他'],           // 任意
  case_publish: ['可', '匿名なら可', '不可']   // 任意
};
const MONITOR_LIMITS_ = { shop_name: 100, shop_url: 300, contact_name: 50, email: 254, expectation: 1000 };

/** 締切判定（JST 2026-11-24 23:59:59 を超えたら true） */
function monitorApplyClosed_(nowMs) { return nowMs > MONITOR_APPLY_DEADLINE_MS_; }

/** ハニーポット（隠し項目 website）に値があれば true */
function isMonitorApplyHoneypot_(p) { return String((p && p.website) || '').trim() !== ''; }

/** 1行項目の空白（改行・タブ含む）を畳む。メールの件名・本文への改行混入を防ぐ */
function monitorOneLine_(v) { return String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim(); }

/** 入力検証。{ ok:true, clean } または { ok:false, fields:[不正な項目名] }。副作用なし */
function validateMonitorApply_(p) {
  p = p || {};
  const bad = [];
  const clean = {};
  ['shop_name', 'contact_name'].forEach(k => { clean[k] = monitorOneLine_(p[k]); if (!clean[k] || clean[k].length > MONITOR_LIMITS_[k]) bad.push(k); });
  clean.shop_url = monitorOneLine_(p.shop_url);
  if (!/^https:\/\/(www|item)\.rakuten\.co\.jp\/[^\s]*$/.test(clean.shop_url) || clean.shop_url.length > MONITOR_LIMITS_.shop_url) bad.push('shop_url');
  clean.email = monitorOneLine_(p.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.email) || clean.email.length > MONITOR_LIMITS_.email) bad.push('email');
  ['monthly_orders', 'follow_mail', 'rms_api'].forEach(k => { clean[k] = monitorOneLine_(p[k]); if (MONITOR_OPTIONS_[k].indexOf(clean[k]) < 0) bad.push(k); });
  ['browser', 'case_publish'].forEach(k => { clean[k] = monitorOneLine_(p[k]); if (clean[k] !== '' && MONITOR_OPTIONS_[k].indexOf(clean[k]) < 0) bad.push(k); });
  clean.expectation = String(p.expectation === undefined || p.expectation === null ? '' : p.expectation).replace(/\r\n?/g, '\n').trim();
  if (clean.expectation.length > MONITOR_LIMITS_.expectation) bad.push('expectation');
  if (p.consent !== true) bad.push('consent');
  return bad.length ? { ok: false, fields: bad } : { ok: true, clean: clean };
}

/** applications タブの1行（数式インジェクション対策済み）。received_at は JST 文字列、status は new */
function buildMonitorApplyRow_(clean, receivedAt) {
  const safe = sheetSafeText_;
  return [receivedAt, safe(clean.shop_name), safe(clean.shop_url), safe(clean.contact_name), safe(clean.email), safe(clean.monthly_orders), safe(clean.follow_mail),
    safe(clean.rms_api), safe(clean.browser), safe(clean.expectation), safe(clean.case_publish), 'new', ''];
}

function verifyMonitorTurnstile_(secret, token) {
  if (!token || String(token).length > 2048) return false;
  const res = UrlFetchApp.fetch(MONITOR_TURNSTILE_VERIFY_URL_, { method: 'post', payload: { secret: secret, response: String(token) }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return false;
  const j = JSON.parse(res.getContentText());
  return !!j && j.success === true && j.hostname === MONITOR_TURNSTILE_HOSTNAME_;
}

function monitorEmailKey_(email) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email).toLowerCase(), Utilities.Charset.UTF_8);
  return 'mapply_e_' + d.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

/** 回数制限。通れば true（カウントも進める）。CacheService が使えない場合は fail-closed（false） */
function monitorApplyRateOk_(email) {
  try {
    const cache = CacheService.getScriptCache();
    const ek = monitorEmailKey_(email);
    if (cache.get(ek)) return false;
    const n = Number(cache.get('mapply_global') || 0);
    if (n >= MONITOR_GLOBAL_LIMIT_) return false;
    cache.put(ek, '1', MONITOR_EMAIL_INTERVAL_SEC_);
    cache.put('mapply_global', String(n + 1), MONITOR_GLOBAL_WINDOW_SEC_);
    return true;
  } catch (e) { return false; }
}

function getMonitorApplySheet_() {
  const ss = getMasterWorkbook_();
  let sh = ss.getSheetByName(MONITOR_APPLY_SHEET_);
  if (!sh) { sh = ss.insertSheet(MONITOR_APPLY_SHEET_); sh.appendRow(MONITOR_APPLY_HEADER_); return sh; }
  if (String(sh.getRange(1, 1).getValues()[0][0]) !== MONITOR_APPLY_HEADER_[0]) throw new Error('applications タブの見出しが想定と異なる');   // 既存タブとの衝突は書かずに失敗
  return sh;
}

function handleMonitorApply_(payload) {
  try {
    const p = payload || {};
    if (monitorApplyClosed_(Date.now())) return { ok: false, error: 'closed' };
    if (isMonitorApplyHoneypot_(p)) return { ok: true };   // bot には成功に見せて保存しない
    const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
    if (!secret) return { ok: false, error: 'not_ready' };
    if (!verifyMonitorTurnstile_(secret, p.turnstile_token)) return { ok: false, error: 'verify_failed' };
    const v = validateMonitorApply_(p);
    if (!v.ok) return { ok: false, error: 'invalid', fields: v.fields };
    if (!monitorApplyRateOk_(v.clean.email)) return { ok: false, error: 'rate_limited' };
    const sh = getMonitorApplySheet_();
    sh.appendRow(buildMonitorApplyRow_(v.clean, Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')));
    const rowNo = sh.getLastRow();
    try { notifyMonitorApply_(v.clean, rowNo); } catch (e) { Logger.log('monitor_apply notify failed: ' + e.message); }   // 通知失敗でも受付は成功
    return { ok: true };
  } catch (e) {
    Logger.log('handleMonitorApply_ error: ' + e.message);
    return { ok: false, error: 'internal_error' };
  }
}

/** 運営宛て通知（応募者へは送らない）。宛先は他の運営通知と同じ Script Properties ADMIN_EMAIL */
function notifyMonitorApply_(c, rowNo) {
  const to = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (!to) { Logger.log('monitor_apply: ADMIN_EMAIL 未設定のため通知せず'); return; }
  const body = [
    `モニター応募がありました（applications シート ${rowNo} 行目）。`, '',
    `店舗名: ${c.shop_name}`, `店舗URL: ${c.shop_url}`, `ご担当者名: ${c.contact_name}`, `メール: ${c.email}`,
    `月の注文数: ${c.monthly_orders}`, `現在のフォローメール: ${c.follow_mail}`, `RMS WEB SERVICE: ${c.rms_api}`,
    `ブラウザ: ${c.browser || '（未回答）'}`, `事例掲載: ${c.case_publish || '（未回答）'}`, '', '期待・困っていること:', c.expectation || '（未回答）'
  ].join('\n');
  MailApp.sendEmail(to, `[step-samurai] モニター応募: ${c.shop_name}`, body);
}

/** GAS エディタから実行できる確認用（純粋関数のみ。Turnstile 通信・シート書き込み・メール送信はしない） */
function testMonitorApplyValidation() {
  const ok = { shop_name: '花屋', shop_url: 'https://www.rakuten.co.jp/hana/', contact_name: '山田', email: 'a@example.jp', monthly_orders: '30〜100件', follow_mail: '送っていない', rms_api: '利用中', consent: true };
  const mod = o => validateMonitorApply_(Object.assign({}, ok, o));
  const bad = (o, f) => { const r = mod(o); return !r.ok && r.fields.indexOf(f) >= 0; };
  const cases = [
    ['正常な入力は通る', validateMonitorApply_(ok).ok === true],
    ['店舗名 空は NG', bad({ shop_name: '' }, 'shop_name')],
    ['店舗名 101字は NG・100字は通る', bad({ shop_name: 'あ'.repeat(101) }, 'shop_name') && mod({ shop_name: 'あ'.repeat(100) }).ok === true],
    ['URL: item.rakuten.co.jp は通る', mod({ shop_url: 'https://item.rakuten.co.jp/x/y' }).ok === true],
    ['URL: 他ドメイン・http・前方一致の偽装は NG', bad({ shop_url: 'https://example.com/' }, 'shop_url') && bad({ shop_url: 'http://www.rakuten.co.jp/x' }, 'shop_url') && bad({ shop_url: 'https://www.rakuten.co.jp.evil.com/' }, 'shop_url')],
    ['メール形式 NG', bad({ email: 'abc' }, 'email')],
    ['選択肢は許可リストのみ', bad({ monthly_orders: '999件' }, 'monthly_orders') && bad({ follow_mail: 'x' }, 'follow_mail') && bad({ rms_api: '' }, 'rms_api')],
    ['任意の選択肢: 空は通る・不正値は NG', mod({ browser: '', case_publish: '' }).ok === true && bad({ browser: 'Edge' }, 'browser') && bad({ case_publish: 'x' }, 'case_publish')],
    ['期待 1001字は NG', bad({ expectation: 'あ'.repeat(1001) }, 'expectation')],
    ['同意なしは NG', bad({ consent: false }, 'consent')],
    ['1行項目の改行は空白に畳む', mod({ shop_name: 'A\r\nB' }).clean.shop_name === 'A B'],
    ['数式インジェクション: = + - @ 始まりにアポストロフィを付ける', ['=1+1', '+1', '-1', '@x'].every(v => buildMonitorApplyRow_(Object.assign({}, validateMonitorApply_(ok).clean, { shop_name: v, expectation: v }), 't')[1] === "'" + v)],
    ['締切: 2026-11-24 23:59:59 JST は受付・翌0:00 は終了', !monitorApplyClosed_(new Date('2026-11-24T23:59:59+09:00').getTime()) && monitorApplyClosed_(new Date('2026-11-25T00:00:00+09:00').getTime())],
    ['ハニーポット: 値があれば true、空・未指定は false', isMonitorApplyHoneypot_({ website: 'x' }) && !isMonitorApplyHoneypot_({ website: '' }) && !isMonitorApplyHoneypot_({})]
  ];
  let ng = 0;
  cases.forEach(c => { Logger.log((c[1] ? 'OK' : 'NG') + '  ' + c[0]); if (!c[1]) ng++; });
  Logger.log(ng ? 'NG: ' + ng + '件' : '全項目 OK');
  return ng === 0;
}
