# 権限の正当化（審査用・ステップ侍 レビュー取込 v1.0.0）

`extension/manifest.json` の宣言と一致。ここに無い権限は宣言していない（`tabs` / `scripting` / `cookies` / `webRequest` / `notifications` / 任意ホストは不使用）。

## permissions

| 権限 | 用途（審査フォームに貼る文面） |
|---|---|
| `storage` | 店舗の連携トークン、前回の同期日時、状態コード、自動同期を試行した日付、同期中フラグを、この端末のブラウザ（`chrome.storage.local`）に保存するため。レビューのデータは保存しない。`chrome.storage.sync` は使わない。 |
| `alarms` | 1日1回、前回の同期から日数が経っていないか確認し、ツールバーのバッジで知らせるため。バックグラウンドで楽天 RMS を開くことはしない。 |

## host_permissions

| ホスト | 用途（審査フォームに貼る文面） |
|---|---|
| `https://review.rms.rakuten.co.jp/*` | 店舗がログイン済みの楽天 RMS「レビューチェックツール」から、レビュー一覧の CSV（`/search/csv/`）を取得するため。コンテンツスクリプトはこのホストのページでのみ動作し、同一オリジンの取得に店舗自身のログイン状態を使うだけで、ID・パスワード・Cookie は読み取らず、保存も送信もしない。 |
| `https://script.google.com/*` | 取得したレビューの5項目（レビュータイプ・レビュー詳細URL・評価・投稿日時・注文番号）を、店舗自身の step-samurai（Google Apps Script のウェブアプリ）に送信するため。 |
| `https://script.googleusercontent.com/*` | Google Apps Script のウェブアプリは、送信（POST）後に `script.googleusercontent.com` へリダイレクトして応答を返す仕様のため、その応答を受け取るために必要。 |

## content_scripts

- `matches` は `https://review.rms.rakuten.co.jp/*` のみ。RMS の他のホスト・他のサイトでは動作しない。

## リモートコードの不使用（宣言）

- 外部のスクリプト・ライブラリ・WebAssembly を読み込まない。すべてのコードは配布パッケージ内に含まれ、`eval` / `new Function` / インラインスクリプトを使わない。
- 外部ライブラリ・ビルドツールを使っていない（素の JavaScript）。
- 通信先は、上記の RMS（取得）と Google Apps Script（送信）のみ。設定値（URL など）もコードに含まれ、リモートから取得しない。

## 使っていない主な権限（補足）

| 権限 | 使わない理由 |
|---|---|
| `tabs` | RMS のタブの検索は、ホスト権限があれば URL 指定の検索（`chrome.tabs.query({url})`）と `chrome.tabs.sendMessage` で足りるため。タブのタイトル・URL の一覧は取得しない。 |
| `scripting` | コンテンツスクリプトを manifest で宣言しているため不要。 |
| `cookies` | Cookie を読まない。RMS への取得はブラウザが同一オリジンで自動的に付ける。 |
| `webRequest` | 通信を監視・改変しない。 |
| `notifications` | 通知はバッジとポップアップのみ。 |
