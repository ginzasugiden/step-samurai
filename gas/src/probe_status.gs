/**
 * probe_status.gs — 稼働状況の読み取り専用プローブ
 *
 * probeSystemStatus() をGASエディタから手動実行すると、以下をMarkdown表として
 * Logger.log に出力する。シート・プロパティ・トリガーへの書き込みは一切行わない。
 *
 *  1. トリガー一覧（関数名・種別・イベント種別）
 *     ※ 時間主導型トリガーの「間隔（毎時/毎日 等）」は ScriptApp API から取得できないため、
 *        GASエディタの「トリガー」画面で確認する旨を併記する。
 *  2. Script Properties のキー一覧
 *     - 値を表示するのは DRY_RUN / GO_LIVE_DATE / TEST_MAIL_TO の3キーのみ
 *     - キー名に SECRET / TOKEN / KEY を含むものは値を一切出力しない（長さも出さない）
 *     - それ以外のキーも値は出力しない（設定有無のみ）
 *  3. マスター管理シート tenants タブの全行（tenant_id / shop_name / status のみ）
 *  4. tokyoflower テナントシート：
 *     - orders 行数・最終更新日時（Driveメタデータ）・order_datetime 列の有無
 *     - sends 直近7日の日別送信数（sent / error 別）と直近24hのエラー件数
 *     - settings / templates / stats_hourly / stats_cohort タブの有無と行数
 *
 * シートIDは Script Properties（TENANT_MASTER_SHEET_ID）とマスター tenants タブから
 * 解決するのを優先し、取得できない場合のみ下記の既知IDにフォールバックする。
 */

const PROBE_MASTER_SHEET_ID_FALLBACK_  = '1kVafBJoO2ujmqjlnYwKzRAQxQ30bzA0D_cQbfPGnWBo';
const PROBE_TENANT_SHEET_ID_FALLBACK_  = '12jmxOCVQvYM5Jhv222h_OnNqbYJx3ZU9yt_uFjJnGd0';
const PROBE_TENANT_ID_                 = 'tokyoflower';
const PROBE_VALUE_VISIBLE_KEYS_        = ['DRY_RUN', 'GO_LIVE_DATE', 'TEST_MAIL_TO'];
const PROBE_SENSITIVE_KEY_PATTERN_     = /SECRET|TOKEN|KEY/i;

function probeSystemStatus() {
  const lines = [];
  const now   = new Date();
  lines.push('# step-samurai 稼働状況プローブ（読み取り専用）');
  lines.push('');
  lines.push(`実行日時: ${probeFmtDateTime_(now)} (Asia/Tokyo)`);
  lines.push('');

  probeSection_(lines, '## 1. トリガー一覧',            probeTriggers_);
  probeSection_(lines, '## 2. Script Properties',       probeScriptProperties_);
  probeSection_(lines, '## 3. マスター管理シート tenants', probeMasterTenants_);
  probeSection_(lines, '## 4. tokyoflower テナントシート', () => probeTenantSheet_(now));

  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

/** セクション実行のラッパ。1セクションで例外が出ても残りのセクションを続行する */
function probeSection_(lines, title, fn) {
  lines.push(title);
  lines.push('');
  try {
    const sectionLines = fn();
    sectionLines.forEach(l => lines.push(l));
  } catch (e) {
    lines.push(`> ⚠️ このセクションの取得に失敗: ${e.message}`);
  }
  lines.push('');
}

// ===== 1. トリガー =====

function probeTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  const out = [];
  out.push('| # | 関数名 | 種別(source) | イベント種別 | 間隔 |');
  out.push('|---|---|---|---|---|');
  if (triggers.length === 0) {
    out.push('| - | (登録なし) | - | - | - |');
  }
  triggers.forEach((t, i) => {
    const source = String(t.getTriggerSource());
    const event  = String(t.getEventType());
    const interval = (source === 'CLOCK')
      ? 'API非公開（GASエディタ「トリガー」画面で確認）'
      : '-';
    out.push(`| ${i + 1} | ${t.getHandlerFunction()} | ${source} | ${event} | ${interval} |`);
  });
  out.push('');
  out.push(`トリガー総数: ${triggers.length}`);
  return out;
}

// ===== 2. Script Properties =====

function probeScriptProperties_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const keys  = Object.keys(props).sort();
  const out = [];
  out.push('| キー | 値 | 備考 |');
  out.push('|---|---|---|');
  keys.forEach(k => {
    let shown, note;
    if (PROBE_SENSITIVE_KEY_PATTERN_.test(k)) {
      shown = '(秘匿・非表示)';
      note  = 'SECRET/TOKEN/KEY を含むため値は出力しない';
    } else if (PROBE_VALUE_VISIBLE_KEYS_.includes(k)) {
      const v = props[k];
      shown = (v === '' || v === null || v === undefined) ? '(空)' : `\`${v}\``;
      note  = '表示対象キー';
    } else {
      shown = '(非表示)';
      note  = '設定あり';
    }
    out.push(`| ${k} | ${shown} | ${note} |`);
  });
  // 表示対象キーが未設定の場合もそれと分かるように出す
  PROBE_VALUE_VISIBLE_KEYS_.forEach(k => {
    if (!keys.includes(k)) out.push(`| ${k} | (未設定) | 表示対象キーだがプロパティ自体が存在しない |`);
  });
  out.push('');
  out.push(`プロパティ総数: ${keys.length}`);
  return out;
}

// ===== 3. マスター管理シート =====

function probeResolveMasterSheetId_() {
  const fromProps = PropertiesService.getScriptProperties().getProperty('TENANT_MASTER_SHEET_ID');
  return fromProps || PROBE_MASTER_SHEET_ID_FALLBACK_;
}

function probeMasterTenants_() {
  const id    = probeResolveMasterSheetId_();
  const ss    = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName('tenants') || ss.getSheets()[0];
  const data  = sheet.getDataRange().getValues();
  const out = [];
  out.push(`シートID: \`${id}\`（${id === PROBE_MASTER_SHEET_ID_FALLBACK_ ? '既知ID' : 'Script Propertiesから解決'}）`);
  out.push(`タブ一覧: ${ss.getSheets().map(s => `${s.getName()}(${s.getLastRow()}行)`).join(', ')}`);
  out.push('');
  out.push('| tenant_id | shop_name | status |');
  out.push('|---|---|---|');
  if (data.length < 2) {
    out.push('| (データ行なし) | - | - |');
    return out;
  }
  const header = data[0];
  const idx    = col => header.indexOf(col);
  data.slice(1).forEach(row => {
    const tid = idx('tenant_id') >= 0 ? row[idx('tenant_id')] : '';
    if (!tid) return;
    const name   = idx('shop_name') >= 0 ? row[idx('shop_name')] : '';
    const status = idx('status')    >= 0 ? row[idx('status')]    : '';
    out.push(`| ${tid} | ${name} | ${status} |`);
  });
  return out;
}

// ===== 4. tokyoflower テナントシート =====

function probeResolveTenantSheetId_() {
  try {
    const id    = probeResolveMasterSheetId_();
    const ss    = SpreadsheetApp.openById(id);
    const sheet = ss.getSheetByName('tenants') || ss.getSheets()[0];
    const data  = sheet.getDataRange().getValues();
    const header = data[0];
    const idx    = col => header.indexOf(col);
    const row = data.slice(1).find(r => r[idx('tenant_id')] === PROBE_TENANT_ID_);
    if (row && idx('spreadsheet_id') >= 0 && row[idx('spreadsheet_id')]) {
      return { id: String(row[idx('spreadsheet_id')]), source: 'マスター tenants タブから解決' };
    }
  } catch (e) {
    // フォールバックへ
  }
  return { id: PROBE_TENANT_SHEET_ID_FALLBACK_, source: '既知ID（フォールバック）' };
}

function probeTenantSheet_(now) {
  const resolved = probeResolveTenantSheetId_();
  const ss  = SpreadsheetApp.openById(resolved.id);
  const out = [];
  out.push(`テナント: ${PROBE_TENANT_ID_}`);
  out.push(`シートID: \`${resolved.id}\`（${resolved.source}）`);
  if (resolved.id !== PROBE_TENANT_SHEET_ID_FALLBACK_) {
    out.push(`> ℹ️ 既知ID \`${PROBE_TENANT_SHEET_ID_FALLBACK_}\` と異なる。マスター側の spreadsheet_id を正とする。`);
  }

  let lastUpdated = '(取得不可)';
  try {
    lastUpdated = probeFmtDateTime_(DriveApp.getFileById(resolved.id).getLastUpdated());
  } catch (e) {
    lastUpdated = `(取得不可: ${e.message})`;
  }
  out.push(`スプレッドシート最終更新: ${lastUpdated}`);
  out.push('');

  // --- orders ---
  out.push('### orders');
  const orders = ss.getSheetByName('orders');
  if (!orders) {
    out.push('> ⚠️ orders タブが存在しない');
  } else {
    const header  = orders.getRange(1, 1, 1, Math.max(orders.getLastColumn(), 1)).getValues()[0];
    const dataRows = Math.max(orders.getLastRow() - 1, 0);
    out.push('| 項目 | 値 |');
    out.push('|---|---|');
    out.push(`| データ行数（ヘッダ除く） | ${dataRows} |`);
    out.push(`| 列数 | ${header.filter(h => h !== '').length} |`);
    out.push(`| order_datetime 列 | ${header.includes('order_datetime') ? '有' : '無'} |`);
    out.push(`| order_date 列 | ${header.includes('order_date') ? '有' : '無'} |`);
    out.push(`| ship_date 列 | ${header.includes('ship_date') ? '有' : '無'} |`);
    out.push(`| ヘッダ | ${header.filter(h => h !== '').join(', ')} |`);
  }
  out.push('');

  // --- sends ---
  out.push('### sends（直近7日の日別送信数 / 直近24hエラー）');
  const sends = ss.getSheetByName('sends');
  if (!sends) {
    out.push('> ⚠️ sends タブが存在しない');
  } else {
    const data = sends.getDataRange().getValues();
    const header = data[0] || [];
    const iSentAt = header.indexOf('sent_at');
    const iResult = header.indexOf('result');
    const iType   = header.indexOf('type');
    out.push(`データ行数（ヘッダ除く）: ${Math.max(data.length - 1, 0)}`);
    if (iSentAt < 0 || iResult < 0) {
      out.push('> ⚠️ sent_at / result 列が見つからないため集計不可');
    } else {
      const dayKeys = [];
      for (let d = 6; d >= 0; d--) {
        const dt = new Date(now.getTime() - d * 86400000);
        dayKeys.push(Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy-MM-dd'));
      }
      const daily = {};
      dayKeys.forEach(k => { daily[k] = { sent: 0, error: 0, follow: 0, coupon: 0 }; });
      let errors24h = 0;
      const errorSamples = [];
      const cutoff24h = now.getTime() - 24 * 3600000;

      data.slice(1).forEach(row => {
        const ts = probeParseDate_(row[iSentAt]);
        if (!ts) return;
        const key    = Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy-MM-dd');
        const result = String(row[iResult] || '');
        const isErr  = result.toLowerCase().startsWith('error');
        if (daily[key]) {
          if (isErr) daily[key].error++; else daily[key].sent++;
          const type = iType >= 0 ? String(row[iType] || '') : '';
          if (type === 'follow') daily[key].follow++;
          if (type === 'coupon') daily[key].coupon++;
        }
        if (isErr && ts.getTime() >= cutoff24h) {
          errors24h++;
          if (errorSamples.length < 5) {
            // 注文番号は出さず、エラー種別の先頭80文字のみ
            errorSamples.push(result.substring(0, 80));
          }
        }
      });

      out.push('');
      out.push('| 日付 | 送信成功 | エラー | (follow) | (coupon) |');
      out.push('|---|---|---|---|---|');
      dayKeys.forEach(k => {
        const d = daily[k];
        out.push(`| ${k} | ${d.sent} | ${d.error} | ${d.follow} | ${d.coupon} |`);
      });
      out.push('');
      out.push(`直近24hのエラー件数: ${errors24h}`);
      if (errorSamples.length) {
        out.push('直近24hエラー例（先頭80文字）:');
        errorSamples.forEach(s => out.push(`- ${s}`));
      }
    }
  }
  out.push('');

  // --- 補助タブ ---
  out.push('### 補助タブの有無と行数');
  out.push('| タブ | 有無 | データ行数（ヘッダ除く） |');
  out.push('|---|---|---|');
  ['settings', 'templates', 'stats_hourly', 'stats_cohort', 'reviews', 'coupons'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) {
      out.push(`| ${name} | 無 | - |`);
    } else {
      out.push(`| ${name} | 有 | ${Math.max(sh.getLastRow() - 1, 0)} |`);
    }
  });
  out.push('');
  out.push(`全タブ: ${ss.getSheets().map(s => s.getName()).join(', ')}`);
  return out;
}

// ===== ユーティリティ =====

function probeFmtDateTime_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

/** シートの Date 型 / 'yyyy-MM-dd HH:mm:ss' 文字列のどちらでも Date に変換する。不正なら null */
function probeParseDate_(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const str = String(value).trim();
  // 'yyyy-MM-dd HH:mm:ss' は JST として解釈する（recordSend_ が Asia/Tokyo で書き込むため）
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}
