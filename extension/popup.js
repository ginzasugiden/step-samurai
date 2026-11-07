(function () {
  'use strict';
  var state = globalThis.SSX.state;
  var $ = function (id) { return document.getElementById(id); };
  var LEVEL_LABEL = { ok: '正常', warn: '注意', error: 'エラー', info: '案内' };

  async function render() {
    var raw = await chrome.storage.local.get(state.KEYS);
    var d = state.describe(raw, Date.now());
    var lv = $('level');
    lv.className = 'badge ' + d.level;
    lv.textContent = LEVEL_LABEL[d.level];
    $('headline').textContent = d.headline;
    $('status').className = 'status ' + d.level;
    $('detail').textContent = d.detail;
    $('last').textContent = d.lastSync;
    $('sync').disabled = state.isSyncing(state.normalize(raw), Date.now());
  }

  $('sync').addEventListener('click', async function () {
    $('result').textContent = '取り込んでいます…';
    $('sync').disabled = true;
    var r;
    try { r = await chrome.runtime.sendMessage({ type: 'manual_sync' }); } catch (e) { r = { ok: false, error: 'internal_error' }; }
    if (r && r.ok) $('result').textContent = '取り込みが完了しました。';
    else if (r && r.reason === 'syncing') $('result').textContent = 'すでに取り込み中です。';
    else if (r && r.reason === 'no_token') $('result').textContent = state.messageFor('no_token');
    else $('result').textContent = state.messageFor((r && r.error) || 'internal_error');
    await render();
  });
  $('openrms').addEventListener('click', function () { chrome.runtime.sendMessage({ type: 'open_rms' }); });

  $('settings').addEventListener('click', function (e) { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  chrome.storage.onChanged.addListener(function () { render(); });
  render();
})();
