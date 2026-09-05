/**
 * analytics_backfill.gs — 受注データの遡及取得（分析の母集団づくり）
 *
 * 目的:
 *  - orders タブに無い過去注文を取り込み、既存行には order_datetime / units / coupon_* を埋める
 *  - キャンセル(800/900)も取り込み、status='cancelled' として母集団から除外できるようにする
 *  - purchase_count を過去分込みで再計算し、新規/リピート判定の精度を上げる
 *
 * 安全性:
 *  - 取り込まれた過去注文は ship_date が GO_LIVE_DATE より前なので、フォローメールの対象にならない
 *    （mailer.gs sendPendingMails の isOnOrAfterGoLiveDate_ ガード）。クーポン経路は毎時パイプラインから除外済み。
 *  - 1回の実行で1ヶ月分だけ処理する（GAS 6分制限対策）。進捗は Script Properties のカーソルに保存。
 *
 * 使い方（GASエディタ）:
 *  A) backfillNextMonthTokyoflower を月数分だけ手動で繰り返す（1回 ≒ 1ヶ月）
 *  B) backfillAutoTokyoflower を1回実行 → 以降は自分自身を2分後の一回限りトリガーで呼び直し、
 *     完了時に自動で止まる。既存トリガー（runHourlyFollowPipeline 等）には一切触れない。
 *  進捗をやり直したいときは resetBackfillCursorTokyoflower を実行。
 */

const BACKFILL_MONTHS_ = 13;

function backfillCursorKey_(tenantId) { return `ANALYTICS_BACKFILL_CURSOR__${tenantId}`; }

/** 'yyyy-MM' を返す */
function ym_(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM'); }

function startYm_() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (BACKFILL_MONTHS_ - 1));
  return ym_(d);
}

function nextYm_(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1); // m は 1-origin なのでそのまま渡すと翌月1日
  return ym_(d);
}

/**
 * 指定月（'yyyy-MM'）の全注文（キャンセル含む）を RMS から取得し orders タブへ一括 upsert する。
 * 戻り値: { searched, fetched, updated, inserted }
 */
function backfillOrdersMonth_(tenantId, ym) {
  ensureAnalyticsColumns_(tenantId);
  const [y, m] = ym.split('-').map(Number);
  const from = new Date(y, m - 1, 1, 0, 0, 0);
  const to   = new Date(y, m, 0, 23, 59, 59); // 月末
  const now  = new Date();
  const toClamped = to > now ? now : to;

  const numbers = searchOrderNumbers_(tenantId, 1, from, toClamped, [100, 200, 300, 400, 500, 600, 700, 800, 900]);
  const uniq    = [...new Set(numbers)];
  if (uniq.length === 0) return { searched: 0, fetched: 0, updated: 0, inserted: 0 };

  const orders = getOrdersByNumbers_(tenantId, uniq);
  const sheet  = getTenantSpreadsheet(tenantId).getSheetByName('orders');
  const r      = upsertOrdersBatch_(sheet, orders);
  return { searched: uniq.length, fetched: orders.length, updated: r.updated, inserted: r.inserted };
}

/**
 * カーソルの月を1つ処理して進める。完了していれば true を返す。
 */
function backfillStep_(tenantId) {
  const props = PropertiesService.getScriptProperties();
  const key   = backfillCursorKey_(tenantId);
  let cursor  = props.getProperty(key) || startYm_();
  const current = ym_(new Date());

  if (cursor > current) {
    props.deleteProperty(key);
    Logger.log(`backfill [${tenantId}]: 完了（カーソル ${cursor} > 今月 ${current}）。purchase_count を再計算します`);
    const sheet  = getTenantSpreadsheet(tenantId).getSheetByName('orders');
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    recomputePurchaseCounts_(sheet, col => header.indexOf(col));
    return true;
  }

  const t0 = Date.now();
  const r  = backfillOrdersMonth_(tenantId, cursor);
  Logger.log(`backfill [${tenantId}] ${cursor}: 検索${r.searched}件 取得${r.fetched}件 更新${r.updated} 追加${r.inserted} (${Math.round((Date.now() - t0) / 1000)}秒)`);
  if (r.searched > 0 && r.fetched === 0) {
    throw new Error(`backfill ${cursor}: searchOrder は ${r.searched}件返したが getOrder が0件。認証/API異常の可能性があるためカーソルを進めません`);
  }
  props.setProperty(key, nextYm_(cursor));
  return false;
}

// ===== GASエディタ用ラッパー（tokyoflower） =====

/** 1回実行 = 1ヶ月分。ログで進捗を確認しながら繰り返す */
function backfillNextMonthTokyoflower() {
  const done = backfillStep_('tokyoflower');
  Logger.log(done ? '遡及取得: すべて完了' : `遡及取得: 次のカーソル ${PropertiesService.getScriptProperties().getProperty(backfillCursorKey_('tokyoflower'))}`);
}

/**
 * 自動継続版。1ヶ月処理 → 未完了なら2分後に自分自身を一回限りトリガーで再実行。
 * 自分自身のトリガー以外は削除しない（setupTriggers とは無関係）。
 */
function backfillAutoTokyoflower() {
  const fn = 'backfillAutoTokyoflower';
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === fn)
    .forEach(t => ScriptApp.deleteTrigger(t));

  let done = false;
  try {
    done = backfillStep_('tokyoflower');
  } catch (e) {
    Logger.log(`backfillAutoTokyoflower: エラーのため自動継続を停止: ${e.message}`);
    notifyAdmin_(`[step-samurai] 遡及取得エラー（自動継続停止）: ${e.message}`);
    return;
  }
  if (done) { Logger.log('backfillAutoTokyoflower: 完了'); return; }
  ScriptApp.newTrigger(fn).timeBased().after(2 * 60 * 1000).create();
  Logger.log('backfillAutoTokyoflower: 2分後に次の月を処理します');
}

/** 進捗カーソルを消してやり直す */
function resetBackfillCursorTokyoflower() {
  PropertiesService.getScriptProperties().deleteProperty(backfillCursorKey_('tokyoflower'));
  Logger.log('遡及取得カーソルを削除しました（次回は13ヶ月前から）');
}

/** 現在のカーソルを表示 */
function showBackfillCursorTokyoflower() {
  Logger.log(PropertiesService.getScriptProperties().getProperty(backfillCursorKey_('tokyoflower')) || '(未設定: 次回は13ヶ月前から開始)');
}
