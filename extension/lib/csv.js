/* CSV 解析と5項目への絞り込み。商品名・タイトル・本文・フラグは行ごとに破棄し、どこにも保持しない。 */
(function (root, name, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var req = function (n) { return isNode ? require('./' + n) : root.SSX[n]; };
  var api = factory(req);
  if (isNode) module.exports = api; else { root.SSX = root.SSX || {}; root.SSX[name] = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, 'csv', function (req) {
  var config = req('config');

  function decodeShiftJis(buf) { return new TextDecoder('shift_jis').decode(buf); }

  /** 引用符つき CSV（"" エスケープ・セル内改行・CRLF・BOM）。行ごとに onRow(row, index) を呼ぶ。引用符が閉じないと csv_format */
  function parseCsv(text, onRow) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var row = [], field = '', inQ = false, i = 0, n = text.length, idx = 0;
    function emit() {
      row.push(field); field = '';
      var blank = row.length === 1 && row[0] === '';
      var r = row; row = [];
      if (!blank) onRow(r, idx++);
    }
    while (i < n) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; emit(); i++; continue; }
      field += c; i++;
    }
    if (inQ) throw config.makeError('csv_format');
    if (field !== '' || row.length) emit();
  }

  function findColumns(header) {
    var names = header.map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
    var idx = {};
    for (var k in config.COLUMNS) {
      idx[k] = names.indexOf(config.COLUMNS[k]);
      if (idx[k] < 0) return null;
    }
    return idx;
  }

  /**
   * CSV 全文 → { reviews: [{review_type, review_id, rating, posted_at, order_number}], total, skippedNoOrder, skippedNoId }
   * total = データ行数（スキップ分を含む。3,000 件上限の判定に使う）。ヘッダ不備は csv_format。
   */
  function extractReviews(text) {
    var cols = null, reviews = [], total = 0, skippedNoOrder = 0, skippedNoId = 0;
    parseCsv(text, function (row, i) {
      if (i === 0) {
        cols = findColumns(row);
        if (!cols) throw config.makeError('csv_format');
        return;
      }
      total++;
      var get = function (k) { var v = row[cols[k]]; return v === undefined ? '' : String(v).trim(); };
      var orderNumber = get('order_number');
      if (!orderNumber) { skippedNoOrder++; return; }
      var reviewId = get('review_id');
      if (!reviewId) { skippedNoId++; return; }
      var rating = get('rating');
      reviews.push({
        review_type: get('review_type'),
        review_id: reviewId,
        rating: /^\d$/.test(rating) ? Number(rating) : rating,
        posted_at: get('posted_at'),
        order_number: orderNumber,
      });
    });
    if (!cols) throw config.makeError('csv_format');
    return { reviews: reviews, total: total, skippedNoOrder: skippedNoOrder, skippedNoId: skippedNoId };
  }

  return { decodeShiftJis: decodeShiftJis, parseCsv: parseCsv, findColumns: findColumns, extractReviews: extractReviews };
});
