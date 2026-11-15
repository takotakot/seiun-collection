import { initializeApp, getApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VALID_KINDS = new Set(['normal', 'rare', 'super_rare', 'ultra_rare', 'ghost']);
const ALLOWED_OVERRIDE_FIELDS = [
  'amulet_kind',
  'name',
  'effect_text',
  'upgrade_from',
  'upgrade_to',
  'relates_from',
  'relates_to',
  'recipe_sources',
  'recipe_target'
];

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const projectArg = args.find(a => a.startsWith('--project='));
  const targetProjectId = projectArg ? projectArg.split('=')[1] : null;
  const configArg = args.find(a => a.startsWith('--config='));
  const configPath = configArg ? configArg.split('=')[1] : join(__dirname, 'gen4.5-rarity-config.json');

  console.log('=== 第4.5世代 レアリティ＆個別情報 一括更新スクリプト ===');
  console.log(`設定ファイル: ${configPath}`);
  console.log(`モード: ${isApply ? '【APPLY (本番書き込み)】' : '【DRY-RUN (シミュレーション・書き込みなし)】'}`);

  // 1. 設定ファイルの読み込みと検証
  if (!existsSync(configPath)) {
    throw new Error(`設定ファイルが見つかりません: ${configPath}`);
  }

  const rawConfig = readFileSync(configPath, 'utf8');
  const config = JSON.parse(rawConfig);

  if (config.generation !== 4.5) {
    throw new Error(`設定ファイルの generation は 4.5 である必要があります (現在: ${config.generation})`);
  }

  const maxTotal = config.expectedTotal || 326;
  const ranges = config.ranges || [];
  const overrides = config.overrides || {};

  // ranges のバリデーション（重複チェック含む）
  const coveredOrders = new Map();
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to)) {
      throw new Error(`ranges[${i}] の from / to は整数である必要があります: from=${r.from}, to=${r.to}`);
    }
    if (r.from < 1 || r.to > maxTotal || r.from > r.to) {
      throw new Error(`ranges[${i}] の範囲が無効です: from=${r.from}, to=${r.to} (許容範囲: 1〜${maxTotal})`);
    }
    if (!VALID_KINDS.has(r.amulet_kind)) {
      throw new Error(`ranges[${i}] の amulet_kind が不正です: ${r.amulet_kind} (有効値: ${Array.from(VALID_KINDS).join(', ')})`);
    }

    for (let ord = r.from; ord <= r.to; ord++) {
      if (coveredOrders.has(ord)) {
        throw new Error(`範囲が重複しています: order #${ord} が ranges[${coveredOrders.get(ord)}] と ranges[${i}] の両方に含まれています`);
      }
      coveredOrders.set(ord, i);
    }
  }

  // overrides のバリデーション
  for (const [orderKey, fields] of Object.entries(overrides)) {
    const orderNum = parseInt(orderKey, 10);
    if (isNaN(orderNum) || orderNum < 1 || orderNum > maxTotal) {
      throw new Error(`overrides のキー #${orderKey} が無効です (許容範囲: 1〜${maxTotal})`);
    }
    if (fields.amulet_kind && !VALID_KINDS.has(fields.amulet_kind)) {
      throw new Error(`overrides[${orderKey}].amulet_kind が不正です: ${fields.amulet_kind}`);
    }
    for (const key of Object.keys(fields)) {
      if (!ALLOWED_OVERRIDE_FIELDS.includes(key)) {
        throw new Error(`overrides[${orderKey}] に未許可のフィールド '${key}' が含まれています (許可フィールド: ${ALLOWED_OVERRIDE_FIELDS.join(', ')})`);
      }
    }
  }

  console.log(`設定バリデーション成功: ranges ${ranges.length} 件, overrides ${Object.keys(overrides).length} 件`);

  // 2. Firebase 接続初期化
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true';
  const projectId = targetProjectId || process.env.PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || (isEmulator ? 'demo-seiun-collection-app' : 'seiun-collection-prd');

  if (isEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    console.log(`ローカルエミュレータを使用して接続します (Host: ${process.env.FIRESTORE_EMULATOR_HOST}, Project: ${projectId})`);
  }

  const saKeyEnv = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const saKeyDefaultPath = join(__dirname, '../serviceAccountKey.json');
  let credential;

  if (saKeyEnv && existsSync(saKeyEnv)) {
    console.log(`サービスアカウントキー (FIREBASE_SERVICE_ACCOUNT_KEY) を使用します: ${saKeyEnv}`);
    credential = cert(JSON.parse(readFileSync(saKeyEnv, 'utf8')));
  } else if (existsSync(saKeyDefaultPath)) {
    console.log(`サービスアカウントキーを使用します: ${saKeyDefaultPath}`);
    credential = cert(JSON.parse(readFileSync(saKeyDefaultPath, 'utf8')));
  } else if (!isEmulator) {
    console.log(`Google Cloud ADC / gcloud 認証情報を使用します (Project: ${projectId})`);
  }

  let app;
  try {
    app = getApp();
  } catch (e) {
    const appOptions = { projectId };
    if (credential) {
      appOptions.credential = credential;
    }
    app = initializeApp(appOptions);
  }

  const db = getFirestore(app);

  // 3. Firestore から第4.5世代のお守りドキュメントを取得
  console.log('\nFirestore から第4.5世代 (generation: 4.5) のアイテムを取得中...');
  const snapshot = await db.collection('items').where('generation', '==', 4.5).get();

  const amuletDocs = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.type === 'amulet') {
      amuletDocs.push({ id: doc.id, ref: doc.ref, data });
    }
  });

  amuletDocs.sort((a, b) => (a.data.order || 0) - (b.data.order || 0));
  console.log(`Firestoreから第4.5世代のお守りドキュメント ${amuletDocs.length} 件を取得しました。`);

  // 4. 差分計算
  const updates = [];
  let unchangedCount = 0;
  let skippedNoConfigCount = 0;

  for (const { id, ref, data } of amuletDocs) {
    const order = data.order;
    const orderStr = String(order);

    // 目的のフィールド値を計算
    let targetKind = undefined;
    if (coveredOrders.has(order)) {
      const rangeIdx = coveredOrders.get(order);
      targetKind = ranges[rangeIdx].amulet_kind;
    }

    const orderOverride = overrides[orderStr] || {};
    if (orderOverride.amulet_kind) {
      targetKind = orderOverride.amulet_kind;
    }

    const diff = {};

    // amulet_kind の差分チェック
    if (targetKind !== undefined && data.amulet_kind !== targetKind) {
      diff.amulet_kind = targetKind;
    }

    // overrides 内のその他許可属性の差分チェック
    for (const key of ALLOWED_OVERRIDE_FIELDS) {
      if (key === 'amulet_kind') continue;
      if (orderOverride[key] !== undefined) {
        const currentVal = data[key];
        const nextVal = orderOverride[key];
        if (JSON.stringify(currentVal) !== JSON.stringify(nextVal)) {
          diff[key] = nextVal;
        }
      }
    }

    if (Object.keys(diff).length > 0) {
      updates.push({
        id,
        order,
        ref,
        diff,
        oldKind: data.amulet_kind || 'none'
      });
    } else if (targetKind !== undefined || Object.keys(orderOverride).length > 0) {
      unchangedCount++;
    } else {
      skippedNoConfigCount++;
    }
  }

  // 5. 差分レポート出力
  console.log('\n=== 更新対象一覧 ===');
  if (updates.length === 0) {
    console.log('✅ 差分はありません。すべてのドキュメントが最新の設定と一致しています。');
  } else {
    for (const update of updates) {
      const orderPadded = `#${String(update.order).padStart(3, '0')}`;
      const changeParts = [];

      if (update.diff.amulet_kind) {
        changeParts.push(`amulet_kind: [${update.oldKind} -> ${update.diff.amulet_kind}]`);
      }

      for (const [k, v] of Object.entries(update.diff)) {
        if (k === 'amulet_kind') continue;
        changeParts.push(`${k}: ${JSON.stringify(v)}`);
      }

      console.log(`  ${orderPadded} (${update.id}): ${changeParts.join(', ')}`);
    }
  }

  console.log('\n=== 集計結果 ===');
  console.log(`全お守り件数: ${amuletDocs.length} 件`);
  console.log(`更新対象: ${updates.length} 件`);
  console.log(`変更なし (設定と一致): ${unchangedCount} 件`);
  if (skippedNoConfigCount > 0) {
    console.log(`未指定のためスキップ (現状維持): ${skippedNoConfigCount} 件`);
  }

  // 6. コミット実行
  if (!isApply) {
    console.log('\nℹ️ [DRY-RUN モード] 実際の Firestore 書き込みはスキップされました。');
    console.log('   変更を反映するには `--apply` フラグを付与して実行してください。');
    console.log(`   例: node admin-tools/update-gen4.5-rarities.js --apply${targetProjectId ? ` --project=${targetProjectId}` : ''}`);
  } else {
    if (updates.length === 0) {
      console.log('\n更新対象ドキュメントが 0 件のため、Firestore 書き込みは行われませんでした。');
    } else {
      console.log(`\nFirestore への部分更新を開始します (対象: ${updates.length} 件, 400件チャンク分割)...`);
      const BATCH_LIMIT = 400;
      let batch = db.batch();
      let opCount = 0;
      let totalCommitted = 0;

      for (const update of updates) {
        batch.update(update.ref, {
          ...update.diff,
          updated_at: FieldValue.serverTimestamp()
        });
        opCount++;

        if (opCount >= BATCH_LIMIT) {
          await batch.commit();
          totalCommitted += opCount;
          console.log(`バッチコミット完了 (${totalCommitted} / ${updates.length} 件)`);
          batch = db.batch();
          opCount = 0;
        }
      }

      if (opCount > 0) {
        await batch.commit();
        totalCommitted += opCount;
        console.log(`最終バッチコミット完了 (${totalCommitted} / ${updates.length} 件)`);
      }

      console.log(`✅ 第4.5世代レアリティ更新 (${totalCommitted} 件) が正常に完了しました！`);
    }
  }

  console.log('\n=== 処理完了 ===');
}

main().catch(error => {
  console.error('エラーが発生しました:', error);
  process.exit(1);
});
