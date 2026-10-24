(function () {
  'use strict';
  var SSX = globalThis.SSX, state = SSX.state, sender = SSX.sender;
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_RE = /^sse_[A-Za-z0-9]{16,200}$/;

  $('privacy').href = SSX.config.PRIVACY_URL;

  function say(text, isError) { var m = $('message'); m.textContent = text; m.style.color = isError ? '#b91c1c' : '#15803d'; }
  function masked(token) { return token.slice(0, 4) + '…' + token.slice(-4); }

  async function showSaved() {
    var s = state.normalize(await chrome.storage.local.get(state.KEYS));
    $('saved').textContent = s.token ? masked(s.token) : 'なし';
  }

  $('save').addEventListener('click', async function () {
    var v = $('token').value.trim();
    if (!TOKEN_RE.test(v)) { say('トークンの形式が正しくありません。sse_ から始まる文字列を貼り付けてください。', true); return; }
    await chrome.storage.local.set({ token: v, status: '' });
    $('token').value = '';
    say('保存しました。', false);
    await showSaved();
  });

  $('remove').addEventListener('click', async function () {
    await chrome.storage.local.remove(['token']);
    $('token').value = '';
    say('トークンを削除しました。', false);
    await showSaved();
  });

  $('test').addEventListener('click', async function () {
    var s = state.normalize(await chrome.storage.local.get(state.KEYS));
    if (!s.token) { say('先にトークンを保存してください。', true); return; }
    $('test').disabled = true;
    say('接続を確認しています…', false);
    try {
      var r = await sender.probe(s.token, {
        fetchFn: function (u, o) { return fetch(u, o); },
        sleep: function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); },
      });
      if (r.ok) say('接続OK', false); else say(state.messageFor(r.error), true);
    } finally { $('test').disabled = false; }
  });

  showSaved();
})();
