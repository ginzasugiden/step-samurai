# step-samurai 管理画面（GitHub Pages）

フレームワーク・ビルド工程なしのバニラJS静的サイト。`index.html` / `app.js` / `style.css` の3ファイルのみ。
APIのURLとアクセストークンはソースコードに一切含まれておらず、ログイン画面で毎回入力する（ブラウザのメモリ上にのみ保持、保存はしない）。公開リポジトリにそのままpushしても秘密情報は漏れない設計。

## 公開手順

このフロントエンドは `step-samurai` リポジトリ（GAS用の `gas/`、資料用の `docs/`、ブリッジ用の `bridge/` と同居するモノレポ構成）の `webui/` サブフォルダとして管理されている。GitHub Pagesの「Deploy from a branch」方式は**リポジトリのルートか `/docs` フォルダしか選べない**ため（このリポジトリには既に別用途の `docs/` があるため流用できない）、`webui/` だけを公開するには以下のいずれかが必要になる。

Pages自体の有効化操作（Settingsでの設定）はユーザーが行うこと。

### このリポジトリが public の場合

**方法A: GitHub Actionsで `webui/` だけを公開する（推奨）**

1. リポジトリ直下に `.github/workflows/pages.yml` を作成し、以下の内容にする（`webui/` のみをアーティファクトとしてアップロードする設定）。
   ```yaml
   name: Deploy webui to Pages
   on:
     push:
       branches: [main]
       paths: ['webui/**']
     workflow_dispatch:
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - uses: actions/checkout@v4
         - uses: actions/upload-pages-artifact@v3
           with:
             path: webui
         - id: deployment
           uses: actions/deploy-pages@v4
   ```
2. GitHubのリポジトリページで **Settings → Pages** を開き、**Source** を「GitHub Actions」に変更する。
3. 上記ワークフローが実行されると、`https://<ユーザー名>.github.io/<リポジトリ名>/` で `webui/index.html` が公開される。

**方法B: `webui/` だけを別のpublicリポジトリに切り出す（シンプル・Actions不要）**

下記「このリポジトリが private の場合」の切り出し手順と同じ方法で、新しいpublicリポジトリを作りそちらにPages設定する。モノレポとは別物として管理したい場合はこちらが簡単。

### このリポジトリが private の場合

Pagesを private リポジトリで使うには **GitHub Pro等の有料プラン**が必要（Free プランは public リポジトリのみ対応）。有料プランを使わない場合は、`webui/` だけを別の public リポジトリへ切り出すのが最も簡単。

**切り出し手順:**
```
mkdir ../step-samurai-webui
cp -r webui/* ../step-samurai-webui/
cd ../step-samurai-webui
git init
git add .
git commit -m "step-samurai 管理画面"
git branch -M main
git remote add origin https://github.com/ginzasugiden/step-samurai-webui.git
git push -u origin main
```
その後、GitHubの新しいリポジトリページで **Settings → Pages** → **Source**: 「Deploy from a branch」→ **Branch**: `main` / `/(root)` → **Save**。
数分後 `https://ginzasugiden.github.io/step-samurai-webui/` でアクセスできるようになる。

APIのURL・トークンはソースに含まれないため、切り出したリポジトリを public にしても秘密情報は漏れない。

## 使い方（ログイン後）

1. GASエディタでWebAppとしてデプロイし、発行されたURL（`.../exec` で終わるもの）を「APIのURL」欄に入力する。
2. 管理者が `issueTenantToken_('tokyoflower')` などを実行して発行したトークンを「アクセストークン」欄に入力する。
3. ログイン後、「設定」「文面」「テスト送信」「履歴」の各タブで内容を確認・編集できる。
4. ページを閉じる、またはリロードすると再ログインが必要（トークンは保存されない）。

## 注意

- このフロントエンドはGAS WebAppのCORSプリフライト制約を回避するため、`Content-Type: text/plain` でPOSTしている。GAS側（`webapp.gs`）もContent-Typeでリクエストを弾かない実装になっている。
- DRY_RUNが有効な間は、「テスト送信」タブから実行しても実際のメールは送信されない（内容確認のみ）。
