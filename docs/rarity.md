# お守りの種類および背景仕様定義書

本ドキュメントでは、お守りの「種類（種別）」の分類定義、アルバム表示における背景色（抽出カラー）および背景画像とCSSフォールバックの仕様、実装計画について定義します。

---

## 1. 概要と種類分類

お守りには「種類」が存在します。  
特に**第4世代（全362件）**においては、通常のお守り4区分とお化けのお守り（14枚）が存在し、アルバム表示時にそれぞれの背景画像・背景色によって視覚的に区別できる仕様とします。

### 第4世代における分類および order 範囲一覧
| 種類 ID (`amulet_kind`) | 日本語表示名 | order 範囲 | 件数 | 背景イメージ | 抽出色 / CSSフォールバック |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`normal`** | ノーマル (N) | `1` ～ `112` | 112件 | 緑基調 | `#8CB771` |
| **`rare`** | レア (R) | `113` ～ `218` | 106件 | 水色基調 | `#92C8E6` |
| **`super_rare`** | スーパーレア (SR) | `219` ～ `322` | 104件 | 肌色・オレンジ基調 | `#FCBE68` |
| **`ultra_rare`** | ウルトラレア (UR) | `323` ～ `348` | 26件 | 紫（上）から青（下）へのグラデーション | 紫: `#C8B1FA` / 青: `#BCDBEF`<br>`linear-gradient(180deg, #C8B1FA 0%, #BCDBEF 100%)` |
| **`ghost`** | お化け (Ghost) | `349` ～ `362` | 14件 | 灰色基調 | `#ACAA9E` |

※ 未所持カードでも本来の種類背景（背景画像およびCSS色）を表示します。  
※ クエスチョン（Q）背景 (`#ABA89D` / `card_q.webp`) は `amulet_kind` の欠損や未知値などのマスターデータ異常時のみ使用する表示フォールバックであり、Firestore の保存値としては使用しません。

---

## 2. 背景画像と CSS フォールバック構造

背景画像（`/images/cards/card_{kind}.webp`）をカード全体の背景レイヤーとして優先表示し、画像の未配置・読込中・読込失敗時には同じ種類の CSS 色（UR はグラデーション）を恒久的なフォールバックとして下層に常設表示します。

```css
/* 例: ノーマルお守り背景クラス */
.card-bg-normal {
  background-color: #8CB771; /* 恒久CSSフォールバック */
  background-image: url('/images/cards/card_n.webp');
  background-size: cover;
  background-position: center;
}

/* 例: ウルトラレアお守り背景クラス */
.card-bg-ultra_rare {
  background-image: url('/images/cards/card_ur.webp'), linear-gradient(180deg, #C8B1FA 0%, #BCDBEF 100%); /* 恒久グラデーションフォールバック */
  background-size: cover;
  background-position: center;
}
```

正式な種類別背景画像を受領した際は、同一パスのアセットファイルを差し替えるか、CSS 上の参照パスのみを変更することでデータモデルおよび React コンポーネントを変更せずにシームレスに対応可能です。

---

## 3. 実装方針と段階ステータス

1. **データモデルへの属性追加**:
   - Firestore `/items/{generation}_{itemId}` および TypeScript インターフェース `Item` に `amulet_kind` を追加。
2. **ローカルマスター更新とマイグレーション**:
   - `admin-tools/generate-seeds.js` により `order` 範囲から `amulet_kind` を自動付与し、件数・重複チェックを実施。
   - `admin-tools/migrate-amulet-kinds.js` により、Firestore ドキュメントに対して `amulet_kind` のみを制限的にバッチ更新（dry-run 対応）。
3. **アルバム UI 描画改修 (`Album.tsx`, `global.css`)**:
   - お守りカード全体の背景に `card-bg-{amulet_kind}` を適用。
   - 画像表示領域の個別緑/ベージュ背景指定を廃止し、可読性維持のためテキスト領域に半透明背景レイヤーを設定。
