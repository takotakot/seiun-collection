# 本番環境へのデプロイ手順マニュアル

「青雲コレクション」アプリ（Astro + React + Firebase）を本番環境（Firebase）へ安全かつ確実にデプロイするための公式運用・デプロイ手順書です。

本プロジェクトでは、**Astro SSG によるビルド時データ埋め込み（爆速初期表示・SEO最適化・Firestore読み取り削減）**、**Google Cloud ADC (Application Default Credentials) による鍵ファイル不要の安全な認証**、および **安全弁付き本番ビルド（`build:prd`）** を採用しています。

---

## 本番環境の基本情報
- **Firebase プロジェクトID**: `seiun-collection-prd`
- **独自ドメイン (Production)**: `https://seiun.jkgame.net`
- **Firebase Hosting ドメイン**: `https://seiun-collection-prd.web.app` / `https://seiun-collection-prd.firebaseapp.com`
- **Storage バケット**: `seiun-collection-prd.firebasestorage.app`
- **Firestore リージョン**: `asia-northeast1` (東京)

---

## 1. 事前準備：Firebase & Google Cloud の初期設定

本番環境へ初めてデプロイを行う際、またはインフラ構成を変更した際は、[Firebase Console](https://console.firebase.google.com/) および [Google Cloud Console](https://console.cloud.google.com/) で以下の設定を行います。

### 1.1. Firebase プロジェクトの作成とプラン確認
- プロジェクト `seiun-collection-prd` を作成します。
- **Blaze プラン（従量課金制）** を有効にします。
  - 不活動アカウント削除バッチ（Cloud Functions v2）や Cloud Scheduler のスケジュール実行に Blaze プランが必須となります。
  - Firebase の無料枠（毎月 200 万回呼び出し等）の範囲内であれば基本的にゼロ円で運用可能です。

### 1.2. Google 認証 (Firebase Authentication) の設定
1. **Authentication** ➔ **Sign-in method** で **Google** を有効にします。
2. **承認済みドメイン（Authorized domains）の追加**:
   - 同画面の「設定 (Settings)」➔「承認済みドメイン」に、以下がすべて登録されていることを確認・追加します：
     - `seiun.jkgame.net`（独自ドメイン）
     - `seiun-collection-prd.web.app`
     - `seiun-collection-prd.firebaseapp.com`
     - `localhost`（開発用）
3. **Google Cloud Console 側の OAuth リダイレクト URI の登録**:
   - [Google Cloud Console](https://console.cloud.google.com/) ➔「APIとサービス」➔「認証情報」を開きます。
   - 「OAuth 2.0 クライアント ID」の Web クライアントを編集し、**承認済みのリダイレクト URI** に以下を追加します：
     - `https://seiun-collection-prd.firebaseapp.com/__/auth/handler`
4. **OAuth 同意画面の公開ステータス**:
   - 「APIとサービス」➔「OAuth 同意画面」で、公開ステータスを **「アプリのリリース（本番）」** に変更します（テスト状態のままだと、登録済みのテストユーザー以外ログインできません）。

### 1.3. Cloud Firestore データベースの初期化
- **Cloud Firestore** ➔ **データベースの作成** を選択します。
- **本番モード** で作成し、ロケーションは `asia-northeast1` (東京) を選択します。

### 1.4. Firebase Storage バケットの初期化
- **Storage** ➔ **開始する** を選択し、本番バケットを作成します。
- バケット名: `seiun-collection-prd.firebasestorage.app`

### 1.5. Storage CORS の適用 (重要)
独自ドメイン（`https://seiun.jkgame.net`）や Hosting からの画像アクセス・アップロードを正常に行うため、リポジトリルートにある `storage-cors.json` を Storage バケットへ適用します。

```bash
# gcloud CLI を使用してバケットに CORS を適用
gcloud storage buckets update gs://seiun-collection-prd.firebasestorage.app --cors-file=storage-cors.json

# または gsutil を使用する場合
# gsutil cors set storage-cors.json gs://seiun-collection-prd.firebasestorage.app
```

### 1.6. Web API キーの HTTP リファラー制限 (セキュリティ推奨)
フロントエンド JS に含まれる Firebase Web API キーの不正利用を防ぐため、アクセス元ドメインを制限します：
1. [Google Cloud Console](https://console.cloud.google.com/) ➔「APIとサービス」➔「認証情報」を開きます。
2. 「Browser key (auto created by Firebase)」を編集します。
3. **アプリケーションの制限**: 「ウェブサイト」を選択し、以下を許可リストに追加します：
   - `https://seiun.jkgame.net/*`
   - `https://seiun-collection-prd.web.app/*`
   - `https://seiun-collection-prd.firebaseapp.com/*`
   - `http://localhost:*/*` (ローカルテスト用)

---

## 2. 環境変数の設定 (`web/.env`)

Astro のフロントエンドビルド時に参照される本番環境変数を設定します。
`web/.env.example` を参考に、`web/.env` を作成します。
必要に応じて `__/firebase/init.json` を参照します。

##### ファイル配置パス: `web/.env`
```ini
PUBLIC_FIREBASE_API_KEY="AIzaSyA..."
PUBLIC_FIREBASE_AUTH_DOMAIN="seiun-collection-prd.firebaseapp.com"
PUBLIC_FIREBASE_PROJECT_ID="seiun-collection-prd"
PUBLIC_FIREBASE_STORAGE_BUCKET="seiun-collection-prd.firebasestorage.app"

# 本番ビルド時はエミュレータ接続を回避するため必ず "false" にする
PUBLIC_FIREBASE_USE_EMULATOR="false"

# お問い合わせ Google フォームのURL
PUBLIC_CONTACT_FORM_URL="https://docs.google.com/forms/d/e/1FAIpQLSfWWgqUedT6onHK0TO4thvbIEgCEBVEgCetCCBDse1JHhZ9aQ/viewform"
```

> **注意**: `.env` は機密情報保護のため `.gitignore` されており、リポジトリにはコミットされません。

---

## 3. クライアントビルド（SSG & 安全弁付きビルド）

本アプリケーションは、**Astro の静的サイト生成（SSG）** により、ビルド時に本番 Firestore から第4世代マスターデータ（全414件）を取得して静的 HTML に事前埋め込みします。これにより、以下のメリットが得られます：
- **初期表示が爆速**（HTML ダウンロード直後に全アイテム・画像が表示可能）。
- **Firestore 読み取りコストの激減**（クライアントはビルド時刻以降の更新差分のみを取得）。
- **完全な SEO 対応**（クローラーが素の HTML からアイテム名や効果テキストをインデックス可能）。

### 3.1. Google Cloud CLI (ADC) へのログイン
ビルド時に本番 Firestore から安全にデータを取得するため、開発者の端末で Google Cloud ADC 認証を通します（サービスアカウント鍵ファイルは不要です）。

```bash
gcloud auth application-default login
```

### 3.2. 安全弁付き本番ビルドの実行 (`build:prd`)
`astro.config.mjs` に組み込まれた安全弁チェックにより、環境変数の誤り（エミュレータ有効化のまま、ダミーAPIキーのままなど）を自動検知してビルドを防止します。

```bash
cd web
npm run build:prd
cd ..
```
*ビルドに成功すると、Firestore の埋め込みデータを含んだ静的 HTML / アセットが `web/dist/` 配下に生成されます。*

> **フォールバック（DB接続なしビルドモード）**:
> オフライン環境や本番 DB 接続権限のない CI/CD 環境等でビルドを行う場合は、`npm run build:no-db`（または `FETCH_DB_ON_BUILD=false npm run build`）を実行することで、ローカルの `seed-items.json` を使ったフォールバック静的ビルドが可能です。

---

## 4. Firebase への本番デプロイ

### 4.1. Firebase CLI ログインとプロジェクト指定
```bash
# Firebase CLI へのログイン
firebase login

# 本番プロジェクトをアクティブに設定
firebase use seiun-collection-prd
```

### 4.2. デプロイの実行

#### ■ 一括デプロイ（Rules, Hosting, Storage, Functions）
全リソースをまとめてデプロイします：
```bash
firebase --project=seiun-collection-prd deploy
```

#### ■ 個別リソースのデプロイ
必要に応じて、特定のリソースのみをデプロイできます：
```bash
# フロントエンド (Hosting) のみ更新
firebase --project=seiun-collection-prd deploy --only hosting

# セキュリティルール（Firestore / Storage）のみ更新
firebase --project=seiun-collection-prd deploy --only firestore:rules,storage

# 不活動削除バッチ (Functions) のみ更新
firebase --project=seiun-collection-prd deploy --only functions
```

### 4.3. 日常デプロイ用スクリプト (`daily-deploy.sh`)
日々のフロントエンド更新・デプロイは、リポジトリルートにあるシェルスクリプトでワンステップ実行できます：
```bash
bash daily-deploy.sh
```
*※ `daily-deploy.sh` は内部で安全弁付き本番ビルド（`build:prd`）と Hosting デプロイを自動実行します。*

---

## 5. 本番データベースへのシード投入（画像プール・マスターデータ）

初めて本番環境を構築した際や、マスターデータ・画像プールを一括更新したい場合に実行します。
Google Cloud ADC 認証により、サービスアカウント鍵ファイル（`serviceAccountKey.json`）を置くことなく安全に実行できます。

### Step 5.1: 画像プールのアップロード (`admin-tools/seed-pool.js`)
ローカルに保存されたスクレイピング画像（`refs/images/` または `SEED_IMAGES_DIR`）を本番 Storage バケットへ一括アップロードし、Firestore の `/image_pool` に登録します。

```bash
PUBLIC_FIREBASE_USE_EMULATOR="false" \
PUBLIC_FIREBASE_PROJECT_ID="seiun-collection-prd" \
PUBLIC_FIREBASE_STORAGE_BUCKET="seiun-collection-prd.firebasestorage.app" \
node admin-tools/seed-pool.js
```
*※ ローカルに画像ディレクトリが存在しない場合は安全にスキップされます。*

### Step 5.2: マスターデータのインポート & 画像自動紐付け (`admin-tools/seed.js`)
`admin-tools/seed-items.json` に定義された全414件の第4世代マスターデータを Firestore `/items` に投入し、画像プールと自動マッチング・紐付けを行います。

```bash
PUBLIC_FIREBASE_USE_EMULATOR="false" \
PUBLIC_FIREBASE_PROJECT_ID="seiun-collection-prd" \
node admin-tools/seed.js
```

---

## 6. トラブルシューティング：よくある問題と解決策

### 6.1. Google ログインのポップアップがすぐに消えてしまう
- **原因 1: 承認済みドメイン（Authorized domains）の未登録**
  - **解決策**: [Firebase Console] ➔ **Authentication** ➔ **設定** ➔ **承認済みドメイン** に、アクセスしているドメイン（`seiun.jkgame.net`、`seiun-collection-prd.web.app`）が登録されているか確認します。
- **原因 2: Google Cloud Console 側の OAuth リダイレクト URI の未登録**
  - **解決策**: [Google Cloud Console] ➔ **APIとサービス** ➔ **認証情報** ➔ OAuth 2.0 クライアント ID の「承認済みのリダイレクト URI」に `https://seiun-collection-prd.firebaseapp.com/__/auth/handler` が設定されているか確認します。
- **原因 3: OAuth 同意画面が「テスト中」**
  - **解決策**: [Google Cloud Console] ➔ **OAuth 同意画面** のステータスを「アプリのリリース（本番）」にするか、テストユーザーに対象アカウントを追加します。
- **原因 4: サードパーティ Cookie の制限やブラウザ拡張機能**
  - **解決策**: ブラウザのクロスサイトトラッキング防止やシールド機能（Brave Shields 等）を一時的に解除するか、拡張機能のない環境で確認します。

### 6.2. 画像が表示されない / アップロード時に CORS エラーが発生する
- **原因**: Firebase Storage バケットに CORS ルールが適用されていないため、ブラウザからの直接アクセスがブロックされています。
- **解決策**: `gcloud storage buckets update gs://seiun-collection-prd.firebasestorage.app --cors-file=storage-cors.json` を実行して CORS を適用します。

### 6.3. 本番ビルド時に Firestore のデータ取得に失敗する / 警告が出る
- **原因**: ローカルの Google Cloud ADC 認証が切れているか、プロジェクトへの読み取り権限がありません。
- **解決策**:
  - `gcloud auth application-default login` を再実行してログインを通します。
  - DB 接続を行わずに静的ビルドを完了させたい場合は、`npm run build:no-db` を実行します（フォールバックデータが使用されます）。

### 6.4. デプロイしたのに最新の変更がブラウザに反映されない
- **原因**: ブラウザキャッシュ、または Astro SSG の事前レンダリング HTML が更新前の状態です。
- **解決策**:
  - ブラウザでハードリロード（Ctrl+Shift+R / Cmd+Shift+R）を実行します。
  - ビルド時に本番 Firestore から最新データが取得できているか、ビルドログの `[Build] Firestore からアイテム ... 件を取得` を確認します。
