# step-samurai 管理画面（GitHub Pages）

フレームワーク・ビルド工程なしのバニラJS静的サイト。`index.html` / `app.js` / `style.css` の3ファイルのみ。
APIのURLとアクセストークンはソースコードに一切含まれておらず、ログイン画面で毎回入力する（ブラウザのメモリ上にのみ保持、保存はしない）。公開リポジトリにそのままpushしても秘密情報は漏れない設計。

## 公開手順

1. GitHubで新しいリポジトリを作成する（public/privateどちらでも動作する。Pagesは無料プランではpublicリポジトリのみ対応。privateリポジトリでPagesを使いたい場合はGitHub Pro等の有料プランが必要）。
2. この `webui` フォルダの中身（`index.html`, `app.js`, `style.css`, `README.md`）をリポジトリのルート（または任意のサブフォルダ）にpushする。
   ```
   cd webui
   git init
   git add .
   git commit -m "step-samurai 管理画面"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```
3. GitHubのリポジトリページで **Settings → Pages** を開く。
4. **Source** を「Deploy from a branch」にし、**Branch** で `main`（`webui`をサブフォルダとしてpushした場合は該当フォルダ）を選択して **Save**。
5. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` でアクセスできるようになる。

## 使い方（ログイン後）

1. GASエディタでWebAppとしてデプロイし、発行されたURL（`.../exec` で終わるもの）を「APIのURL」欄に入力する。
2. 管理者が `issueTenantToken_('tokyoflower')` などを実行して発行したトークンを「アクセストークン」欄に入力する。
3. ログイン後、「設定」「文面」「テスト送信」「履歴」の各タブで内容を確認・編集できる。
4. ページを閉じる、またはリロードすると再ログインが必要（トークンは保存されない）。

## 注意

- このフロントエンドはGAS WebAppのCORSプリフライト制約を回避するため、`Content-Type: text/plain` でPOSTしている。GAS側（`webapp.gs`）もContent-Typeでリクエストを弾かない実装になっている。
- DRY_RUNが有効な間は、「テスト送信」タブから実行しても実際のメールは送信されない（内容確認のみ）。
