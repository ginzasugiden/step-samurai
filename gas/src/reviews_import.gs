/**
 * reviews_import.gs — レビューCSVの取込（テナント自身が管理画面から行う）
 *
 * 背景:
 *  楽天のレビューAPIは利用できず（/es/2.0/review/list/ が404）、tokyoflower では Selenium で
 *  RMS にログインして取得している。外部店舗の R-Login / 楽天会員ID・パスワード・SMS認証を
 *  預かるのは現実的でない（店舗側のリスクが大きく、SMS OTP で自動化も止まる）ため、
 *  店舗が RMS「レビューチェックツール」からダウンロードしたCSVを管理画面に貼り付けて取り込む方式を用意する。
 *
 * 安全設計:
 *  - テナントトークンで解決した tenant_id の reviews タブにしか書かない
 *  - review_id をキーに upsert（同じCSVを何度取り込んでも重複しない）
 *  - CSVの列は名前で自動判定する（列順や余分な列があっても壊れない）。判定できなければ取り込まずエラー
 *  - 取り込み後に orders との紐づけ（linkOrdersReviews）を実行し review_linked を更新する
 *
 * reviews タブの列: review_id | order_number | buyer_key | item_code | rating | posted_at | body
 */

// 列名の候補（部分一致・大文字小文字無視）。先に一致したものを採用する
const REVIEW_CSV_COLUMN_HINTS_ = {
  review_id:    ['レビューid', 'review_id', 'レビュー番号', 'reviewid'],
  order_number: ['注文番号', '受注番号', 'order_number', 'ordernumber'],
  item_code:    ['商品管理番号', '商品番号', 'item_code', 'itemnumber', '商品コード'],
  rating:       ['総合評価', '評価', 'rating', '点数', '星'],
  posted_at:    ['投稿日時', '投稿日', 'posted_at', '登録日時', '日時'],
  body:         ['レビュー内容', 'コメント', '本文', 'body', 'レビュー本文', '内容'],
  buyer_key:    ['購入者', 'buyer', 'レビュアー', 'ニックネーム'],
};

/** RFC4180 風の CSV パーサ（ダブルクォート・改行含みセル・CRLF・BOM 対応） */
function parseCsv_(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else if (c === '\r') { /* クォート内の CRLF も LF に統一 */ }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/** ヘッダ行から各項目の列番号を推定する */
function mapReviewCsvHeader_(header) {
  const norm = header.map(h => String(h || '').toLowerCase().replace(/\s/g, ''));
  const map = {};
  Object.keys(REVIEW_CSV_COLUMN_HINTS_).forEach(key => {
    const hints = REVIEW_CSV_COLUMN_HINTS_[key];
    let found = -1;
    for (const hint of hints) {
      const i = norm.findIndex(h => h.includes(hint.toLowerCase()));
      if (i >= 0) { found = i; break; }
    }
    map[key] = found;
  });
  return map;
}

/** 投稿日時を 'yyyy-MM-dd HH:mm:ss' または 'yyyy-MM-dd' に正規化（解釈不能ならそのまま） */
function normalizeReviewDate_(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[ T]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return s;
  const p = n => String(n).padStart(2, '0');
  const date = `${m[1]}-${p(m[2])}-${p(m[3])}`;
  return m[4] ? `${date} ${p(m[4])}:${m[5]}:${m[6] || '00'}` : date;
}

/**
 * CSVテキストを解析し、preview=true なら件数と先頭5行を返す（書き込みなし）。
 * preview=false なら reviews タブへ upsert し、紐づけを更新する。
 */
function importReviewsFromCsv_(tenantId, csvText, preview) {
  if (!csvText || csvText.length > 2 * 1024 * 1024) return { ok: false, error: 'csv_empty_or_too_large' };
  const rows = parseCsv_(csvText);
  if (rows.length < 2) return { ok: false, error: 'csv_has_no_data_rows' };

  const header = rows[0];
  const map = mapReviewCsvHeader_(header);
  const missing = ['order_number', 'rating', 'posted_at'].filter(k => map[k] < 0);
  if (missing.length) {
    return { ok: false, error: 'csv_columns_not_recognized', missing: missing, header: header };
  }

  const get = (r, k) => (map[k] >= 0 ? String(r[map[k]] || '').trim() : '');
  const records = rows.slice(1).map(r => {
    const orderNumber = get(r, 'order_number');
    const postedAt    = normalizeReviewDate_(get(r, 'posted_at'));
    const ratingNum   = Number(String(get(r, 'rating')).replace(/[^\d.]/g, ''));
    const reviewId    = get(r, 'review_id') || `csv_${orderNumber}_${postedAt.replace(/[^\d]/g, '')}`;
    return {
      review_id:    reviewId,
      order_number: orderNumber,
      buyer_key:    get(r, 'buyer_key'),
      item_code:    get(r, 'item_code'),
      rating:       isNaN(ratingNum) ? 0 : ratingNum,
      posted_at:    postedAt,
      body:         get(r, 'body').substring(0, 5000),
    };
  }).filter(x => x.order_number);

  const result = {
    ok: true, preview: !!preview,
    parsed_rows: rows.length - 1, valid_rows: records.length,
    column_map: Object.keys(map).reduce((o, k) => { o[k] = map[k] >= 0 ? header[map[k]] : null; return o; }, {}),
    sample: records.slice(0, 5).map(x => ({ review_id: x.review_id, order_number: x.order_number, rating: x.rating, posted_at: x.posted_at })),
  };
  if (preview) return result;

  const ss    = getTenantSpreadsheet(tenantId);
  const sheet = ss.getSheetByName('reviews');
  if (!sheet) return { ok: false, error: 'reviews_sheet_missing' };
  const data   = sheet.getDataRange().getValues();
  const hdr    = data[0].map(String);
  const idIdx  = hdr.indexOf('review_id');
  const rowByIdx = {};
  for (let i = 1; i < data.length; i++) { const id = String(data[i][idIdx] || ''); if (id) rowByIdx[id] = i; }

  const cols = ['review_id', 'order_number', 'buyer_key', 'item_code', 'rating', 'posted_at', 'body'];
  const toRow = rec => { const row = Array(hdr.length).fill(''); cols.forEach(c => { const i = hdr.indexOf(c); if (i >= 0) row[i] = rec[c]; }); return row; };

  let updated = 0; const newRows = [];
  records.forEach(rec => {
    const i = rowByIdx[rec.review_id];
    if (i !== undefined) { sheet.getRange(i + 1, 1, 1, hdr.length).setValues([toRow(rec)]); updated++; }
    else newRows.push(toRow(rec));
  });
  if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, hdr.length).setValues(newRows);

  let linked = 0;
  try { linkOrdersReviews(tenantId); linked = 1; } catch (e) { Logger.log(`importReviewsFromCsv_ link error: ${e.message}`); }

  result.updated = updated; result.inserted = newRows.length; result.linked = linked === 1;
  return result;
}
