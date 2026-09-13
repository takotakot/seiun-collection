import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// コマンドライン引数の解析
const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const projectArg = args.find(a => a.startsWith('--project='));
const targetProjectId = projectArg ? projectArg.split('=')[1] : null;

// Firebase Admin SDK 初期化
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || join(__dirname, '../serviceAccountKey.json');

let credential;
if (existsSync(serviceAccountPath)) {
  try {
    credential = cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8')));
  } catch (err) {
    console.warn('サービスアカウントキーの解析に失敗しました。ADC接続を試みます。', err);
  }
}

let app;
try {
  app = getApp();
} catch (e) {
  let projectId = targetProjectId || process.env.PUBLIC_FIREBASE_PROJECT_ID || 'demo-seiun-collection-app';

  const isEmulator = process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true';
  if (isEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  } else {
    projectId = targetProjectId || process.env.PUBLIC_FIREBASE_PROJECT_ID || 'seiun-collection-prd';
  }

  const appOptions = credential ? { credential, projectId } : { projectId };
  app = initializeApp(appOptions);
}

const db = getFirestore(app);

// 対象の旧ID -> 新IDのマッピング定義
const docMappings = [
  { oldId: '4_amulet_haiteikogetsu_1', oldItemId: 'amulet_haiteikogetsu_1', newId: '4_amulet_115', newItemId: 'amulet_115' },
  { oldId: '4_amulet_haiteikogetsu_2', oldItemId: 'amulet_haiteikogetsu_2', newId: '4_amulet_116', newItemId: 'amulet_116' },
  { oldId: '4_amulet_tennnomegumi_1',  oldItemId: 'amulet_tennnomegumi_1',  newId: '4_amulet_323', newItemId: 'amulet_323' },
  { oldId: '4_amulet_tennnomegumi_2',  oldItemId: 'amulet_tennnomegumi_2',  newId: '4_amulet_324', newItemId: 'amulet_324' },
  { oldId: '4_amulet_ukatousen_1',     oldItemId: 'amulet_ukatousen_1',     newId: '4_amulet_219', newItemId: 'amulet_219' },
  { oldId: '4_amulet_ukatousen_2',     oldItemId: 'amulet_ukatousen_2',     newId: '4_amulet_220', newItemId: 'amulet_220' }
];

async function migrateCustomAmulets() {
  console.log(`=== 古い形式のお守りドキュメント (6件) のコピー・移行スクリプト ===`);
  console.log(`実行モード: ${isApply ? '【本番適用 (APPLY)】' : '【事前確認 (DRY-RUN)】'}`);
  console.log(`エミュレーター接続: ${process.env.FIRESTORE_EMULATOR_HOST ? process.env.FIRESTORE_EMULATOR_HOST : 'なし (クラウド接続)'}\n`);

  // seed-items.json から新IDの基本定義を取得
  const seedDataPath = join(__dirname, 'seed-items.json');
  const seedItems = JSON.parse(readFileSync(seedDataPath, 'utf8'));
  const seedMap = new Map(seedItems.map(item => [item.id, item]));

  const idMap = new Map(docMappings.map(m => [m.oldId, m.newId]));
  const itemIdMap = new Map(docMappings.map(m => [m.oldItemId, m.newItemId]));

  // 1. /items コレクションの移行確認
  console.log('--- Phase 1: /items コレクション ---');
  const itemsToCopy = [];

  for (const mapping of docMappings) {
    const oldDocRef = db.collection('items').doc(mapping.oldId);
    const oldSnap = await oldDocRef.get();

    if (oldSnap.exists) {
      const oldData = oldSnap.data();
      const seedBase = seedMap.get(mapping.newId) || {};

      // 古いドキュメントのデータをベースにしつつ、ID・属性を正規化
      const newData = {
        ...oldData,
        ...seedBase,
        id: mapping.newId,
        itemId: mapping.newItemId
      };

      if (oldData.image_url) newData.image_url = oldData.image_url;
      if (oldData.report_count) newData.report_count = oldData.report_count;
      if (oldData.reported_by) newData.reported_by = oldData.reported_by;

      itemsToCopy.push({
        oldRef: oldDocRef,
        newRef: db.collection('items').doc(mapping.newId),
        oldId: mapping.oldId,
        newId: mapping.newId,
        newData
      });
      console.log(`[検出] ${mapping.oldId} -> ${mapping.newId} (${newData.name || seedBase.name})`);
    } else {
      console.log(`[スキップ] 旧ドキュメント ${mapping.oldId} は存在しません`);
    }
  }

  // 2. /image_pool コレクションの移行確認
  console.log('\n--- Phase 2: /image_pool コレクション ---');
  const poolUpdates = [];
  const poolSnap = await db.collection('image_pool').get();

  poolSnap.forEach(docSnap => {
    const data = docSnap.data();
    if (data.target_item_id && idMap.has(data.target_item_id)) {
      const newTargetId = idMap.get(data.target_item_id);
      poolUpdates.push({
        ref: docSnap.ref,
        id: docSnap.id,
        oldTarget: data.target_item_id,
        newTarget: newTargetId
      });
      console.log(`[ImagePool更新予定] ${docSnap.id}: ${data.target_item_id} -> ${newTargetId}`);
    }
  });

  // 3. /users/{userId}/collections サブコレクションの移行確認
  console.log('\n--- Phase 3: /users サブコレクション (所持データ) ---');
  const userColUpdates = [];
  const usersSnap = await db.collection('users').get();

  for (const userDoc of usersSnap.docs) {
    const userId = userDoc.id;
    const colSnap = await db.collection('users').doc(userId).collection('collections').get();

    colSnap.forEach(docSnap => {
      if (idMap.has(docSnap.id)) {
        const newId = idMap.get(docSnap.id);
        const data = docSnap.data();
        const newData = { ...data };

        if (newData.id) newData.id = newId;
        if (newData.itemId && itemIdMap.has(newData.itemId)) newData.itemId = itemIdMap.get(newData.itemId);
        if (newData.item_id && idMap.has(newData.item_id)) newData.item_id = idMap.get(newData.item_id);

        userColUpdates.push({
          oldRef: docSnap.ref,
          newRef: db.collection('users').doc(userId).collection('collections').doc(newId),
          userId,
          oldId: docSnap.id,
          newId,
          newData
        });
        console.log(`[ユーザー所持更新予定] User: ${userId}, ${docSnap.id} -> ${newId}`);
      }
    });
  }

  console.log('\n--- サマリー ---');
  console.log(`/items コレクションコピー件数: ${itemsToCopy.length} 件`);
  console.log(`/image_pool 更新件数: ${poolUpdates.length} 件`);
  console.log(`ユーザー所持データ移動件数: ${userColUpdates.length} 件`);

  if (!isApply) {
    console.log(`\n※ DRY-RUN モードで完了しました。Firestore への書き込みは行われていません。`);
    console.log(`本番へ反映する場合は '--apply' オプションを付与して実行してください。`);
    return;
  }

  // 書き込み処理 (APPLY)
  console.log(`\n書き込みを開始します...`);
  const batch = db.batch();

  // Phase 1: items のコピー
  for (const item of itemsToCopy) {
    batch.set(item.newRef, item.newData, { merge: true });
  }

  // Phase 2: image_pool の参照更新
  for (const pool of poolUpdates) {
    batch.update(pool.ref, { target_item_id: pool.newTarget });
  }

  // Phase 3: ユーザー所持データのコピー
  for (const ucol of userColUpdates) {
    batch.set(ucol.newRef, ucol.newData, { merge: true });
  }

  await batch.commit();
  console.log('✓ 指定ドキュメントのコピーが正常に完了しました！');
}

migrateCustomAmulets().catch(err => {
  console.error('エラーが発生しました:', err);
  process.exit(1);
});
