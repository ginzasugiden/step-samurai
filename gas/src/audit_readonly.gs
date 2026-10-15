/**
 * audit_readonly.gs — 新規店舗受け入れ前の読み取り専用監査
 *
 * 読み取り専用・本番データを変更しない。
 * シート・Script Properties・トリガーは読むだけで、メール送信・外部 API 呼び出しも行わない。
 * 秘密値は出力しない（Script Properties は「有無・文字数・末尾4文字」のみ。暗号文は読まない）。
 * GAS エディタから auditOnboardingReadiness を実行すると、実行ログに
 * AUDIT_JSON_BEGIN ... AUDIT_JSON_END で挟んだ JSON を1回だけ出力する。
 */

const AUDIT_MASTER_SHEET_ID_ = '1kVafBJoO2ujmqjlnYwKzRAQxQ30bzA0D_cQbfPGnWBo';
const AUDIT_REQUIRED_TABS_ = ['orders', 'reviews', 'sends', 'coupons', 'settings', 'templates'];
const AUDIT_SETTING_KEYS_ = ['go_live_date', 'dry_run', 'follow_days_after_ship', 'review_thanks_since',
  'review_thanks_min_rating', 'coupon_enabled'];
const AUDIT_PROP_KEYS_ = ['TENANT_MASTER_SHEET_ID', 'API_KEY_SHEET_ID', 'ADMIN_TOKEN', 'ADMIN_EMAIL', 'SECRETS_KEY',
  'BRIDGE_URL', 'BRIDGE_SECRET', 'BRIDGE_TOKEN', 'FINCODE_WEBHOOK_SECRET', 'DRY_RUN', 'GO_LIVE_DATE',
  'EXCLUDE_ORDERS', 'SHOP_SIGNATURE__OVERRIDE', 'TEST_MAIL_TO'];

function auditOnboardingReadiness() {
  const out = { generated_at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'), errors: [] };
  const guard = (name, fn) => { try { return fn(); } catch (e) { out.errors.push(`${name}: ${String(e.message).substring(0, 120)}`); return null; } };

  const master = guard('open_master', () => SpreadsheetApp.openById(AUDIT_MASTER_SHEET_ID_));
  const tenants = master ? (guard('master', () => auditMaster_(master, out)) || []) : [];

  out.script_properties = guard('script_properties', () => auditProps_(tenants)) || null;
  out.triggers = guard('triggers', () => ScriptApp.getProjectTriggers().map(t => ({
    handler: t.getHandlerFunction(), event_type: String(t.getEventType()), source: String(t.getTriggerSource()),
  }))) || null;   // 実行間隔は Apps Script API から取得できないため、種別のみ
  out.webapp_url_available = guard('webapp_url', () => !!ScriptApp.getService().getUrl());

  out.tenant_audits = master ? tenants.map(t => ({ tenant_id: t.tenant_id, audit: guard(`tenant_${t.tenant_id}`, () => auditTenant_(master, t)) })) : [];

  Logger.log('AUDIT_JSON_BEGIN\n' + JSON.stringify(out) + '\nAUDIT_JSON_END');
  return out.errors.length;
}

function auditStr_(v) { return v === null || v === undefined ? '' : String(v); }

/** Date でも文字列でも JST の 'yyyy-MM-dd' に正規化（日付以外は空文字） */
function auditDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  const m = auditStr_(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function auditDateTime_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  return auditStr_(v);
}

/** 表の行をヘッダ名でオブジェクト化 */
function auditRows_(sheet) {
  const data = sheet.getDataRange().getValues();
  if (!data.length) return { header: [], rows: [] };
  const header = data[0].map(String);
  return { header: header, rows: data.slice(1).map((r, i) => ({ _row: i + 2, v: r })), idx: c => header.indexOf(c) };
}

function auditProps_(tenants) {
  const all = PropertiesService.getScriptProperties().getProperties();
  const describe = key => {
    const v = all[key];
    if (v === undefined || v === null || v === '') return { present: false };
    const s = String(v);
    return { present: true, length: s.length, last4: s.length >= 4 ? s.substring(s.length - 4) : '****' };
  };
  const known = {};
  AUDIT_PROP_KEYS_.forEach(k => { known[k] = describe(k); });
  tenants.forEach(t => { const k = `REVIEW_INGEST_KEY__${t.tenant_id}`; known[k] = describe(k); });
  const knownSet = new Set(Object.keys(known));
  // 上記以外のキー名（値は出さない）。ANALYTICS_BACKFILL_CURSOR__ は運用状態なので件数のみ
  const cursors = Object.keys(all).filter(k => k.indexOf('ANALYTICS_BACKFILL_CURSOR__') === 0);
  const other = Object.keys(all).filter(k => !knownSet.has(k) && cursors.indexOf(k) < 0);
  return { known: known, other_key_names: other, backfill_cursor_count: cursors.length, total_keys: Object.keys(all).length };
}

function auditMaster_(master, out) {
  const m = { tabs: master.getSheets().map(s => s.getName()) };

  // グローバル settings
  const gs = master.getSheetByName('settings');
  m.settings = {};
  if (gs) {
    const t = auditRows_(gs);
    ['plan_price_monthly', 'setup_fee', 'trial_days', 'fincode_payment_url'].forEach(k => {
      const r = t.rows.find(x => auditStr_(x.v[0]) === k);
      // fincode_payment_url は URL なので有無のみ
      m.settings[k] = r ? (k === 'fincode_payment_url' ? (auditStr_(r.v[1]) ? 'set' : 'empty') : auditStr_(r.v[1])) : '(missing)';
    });
  } else { m.settings = '(settings tab missing)'; }

  // tenants
  const ts = master.getSheetByName('tenants') || master.getSheets()[0];
  const tt = auditRows_(ts);
  const cols = ['tenant_id', 'shop_name', 'spreadsheet_id', 'status', 'plan', 'billing_provider', 'billing_status', 'trial_start', 'trial_end', 'billing_note'];
  m.tenants_missing_columns = cols.filter(c => tt.header.indexOf(c) < 0);
  const tenants = tt.rows.filter(r => auditStr_(r.v[tt.idx('tenant_id')])).map(r => {
    const o = {};
    cols.forEach(c => {
      const i = tt.idx(c); const v = i >= 0 ? r.v[i] : '';
      o[c] = (c === 'trial_start' || c === 'trial_end') ? auditDate_(v) : (c === 'spreadsheet_id' ? auditStr_(v) : auditStr_(v).substring(0, 200));
    });
    return o;
  });
  m.tenants = tenants.map(t => { const c = Object.assign({}, t); delete c.spreadsheet_id; return c; });

  // invites
  const inv = master.getSheetByName('invites');
  if (inv) {
    const t = auditRows_(inv); const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const c = { unused: 0, expired: 0, used: 0 };
    t.rows.forEach(r => {
      if (!auditStr_(r.v[0])) return;
      if (auditStr_(r.v[4])) c.used++;
      else if (auditDateTime_(r.v[3]) < now) c.expired++;
      else c.unused++;
    });
    m.invites = c;
  } else { m.invites = '(invites tab missing)'; }

  // e2etest の残骸（タブ名と行番号のみ。内容は出さない）
  m.e2etest_rows = {};
  master.getSheets().forEach(sh => {
    if (sh.getName() === 'tenant_secrets') return;   // 暗号文を含むタブは走査しない
    const hit = [];
    sh.getDataRange().getValues().forEach((row, i) => { if (row.some(c => auditStr_(c).toLowerCase().indexOf('e2etest') >= 0)) hit.push(i + 1); });
    if (hit.length) m.e2etest_rows[sh.getName()] = hit.slice(0, 20);
  });

  out.master = m;
  return tenants;
}

function auditTenant_(master, t) {
  const a = { status: t.status, billing_status: t.billing_status };

  // tenant_secrets(rms) の meta（暗号文は読まない）
  const sec = master.getSheetByName('tenant_secrets');
  a.rms = { registered: false };
  a.smtp = { registered: false };
  if (sec) {
    const data = sec.getDataRange().getValues();
    data.slice(1).forEach(r => {
      if (auditStr_(r[0]) !== t.tenant_id) return;
      let meta = {}; try { meta = JSON.parse(auditStr_(r[4]) || '{}'); } catch (e) {}
      if (auditStr_(r[1]) === 'rms') {
        const exp = auditDate_(meta.expiry);
        a.rms = { registered: true, has_sid: /^\d{4,}$/.test(auditStr_(meta.sid)), expiry: exp, updated_at: auditDateTime_(r[3]) };
        if (exp) {
          const days = Math.floor((new Date(exp + 'T00:00:00+09:00').getTime() - Date.now()) / 86400000);
          a.rms.days_left = days;
        }
      } else if (auditStr_(r[1]) === 'smtp') {
        a.smtp = { registered: true, updated_at: auditDateTime_(r[3]) };
      }
    });
  }

  // 専用シート
  if (!t.spreadsheet_id) { a.sheet = { opened: false, reason: 'no_spreadsheet_id' }; return a; }
  let ss;
  try { ss = SpreadsheetApp.openById(t.spreadsheet_id); } catch (e) { a.sheet = { opened: false, reason: 'open_failed' }; return a; }
  const tabs = ss.getSheets().map(s => s.getName());
  a.sheet = { opened: true, tabs: tabs, missing_tabs: AUDIT_REQUIRED_TABS_.filter(x => tabs.indexOf(x) < 0) };

  // settings の主要キー
  const st = ss.getSheetByName('settings');
  a.settings = {};
  if (st) {
    const tb = auditRows_(st); const ki = tb.idx('key'), vi = tb.idx('value');
    const get = k => { const r = tb.rows.find(x => auditStr_(x.v[ki]) === k); return r ? r.v[vi] : undefined; };
    AUDIT_SETTING_KEYS_.forEach(k => {
      const v = get(k);
      a.settings[k] = v === undefined ? '(missing)' : ((k === 'go_live_date' || k === 'review_thanks_since') ? (auditDate_(v) || auditStr_(v)) : auditStr_(v));
    });
    const sig = get('shop_signature_override');
    a.settings.shop_signature_override = sig === undefined ? '(missing)' : (auditStr_(sig) ? 'set' : 'empty');
  } else { a.settings = '(settings tab missing)'; }

  // pipeline_log 直近24件（マスターシート）
  const pl = master.getSheetByName('pipeline_log');
  if (pl) {
    const rows = pl.getDataRange().getValues().slice(1).filter(r => auditStr_(r[0]) === t.tenant_id).slice(-24);
    const isErr = r => /error/i.test(auditStr_(r[1]));
    a.pipeline_log = {
      count: rows.length,
      billing_skip: rows.some(r => auditStr_(r[1]) === 'billing_skip'),
      billing_skip_reasons: Array.from(new Set(rows.filter(r => auditStr_(r[1]) === 'billing_skip').map(r => auditStr_(r[2]).substring(0, 40)))),
      error_count: rows.filter(isErr).length,
      rows: rows.map(r => ({ at: auditDateTime_(r[3]), event: auditStr_(r[1]), detail: auditStr_(r[2]).substring(0, 60) })),
    };
  } else { a.pipeline_log = '(pipeline_log tab missing)'; }

  // sends 直近7日の type 別件数
  const sd = ss.getSheetByName('sends');
  if (sd) {
    const since = Utilities.formatDate(new Date(Date.now() - 7 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
    const c = {}; let errors = 0;
    sd.getDataRange().getValues().slice(1).forEach(r => {
      if (auditDate_(r[4]) < since) return;
      const ty = auditStr_(r[3]) || '(blank)'; c[ty] = (c[ty] || 0) + 1;
      if (auditStr_(r[6]).indexOf('error') === 0) errors++;
    });
    a.sends_7d = { by_type: c, error_rows: errors };
  } else { a.sends_7d = '(sends tab missing)'; }

  // e2etest の残骸（行番号のみ）
  a.e2etest_rows = {};
  ss.getSheets().forEach(sh => {
    const hit = [];
    sh.getDataRange().getValues().forEach((row, i) => { if (row.some(c => auditStr_(c).toLowerCase().indexOf('e2etest') >= 0)) hit.push(i + 1); });
    if (hit.length) a.e2etest_rows[sh.getName()] = hit.slice(0, 20);
  });
  return a;
}
