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

// Firebase Admin 初期化
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || join(__dirname, '../serviceAccountKey.json');

try {
  let app;
  try {
    app = getApp();
  } catch (e) {
    let credential;
    let projectId = targetProjectId || process.env.PUBLIC_FIREBASE_PROJECT_ID || 'demo-seiun-collection-app';

    if (existsSync(serviceAccountPath)) {
      try {
        const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
        credential = cert(serviceAccount);
        projectId = serviceAccount.project_id || projectId;
      } catch (err) {
        console.warn('認証情報ファイルの解析に失敗しました。', err);
      }
    } else {
      const isEmulator = process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true';
      if (isEmulator) {
        process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
      } else {
        projectId = targetProjectId || process.env.PUBLIC_FIREBASE_PROJECT_ID || 'seiun-collection-prd';
      }
    }

    app = initializeApp(credential ? { credential, projectId } : { projectId });
  }

  const db = getFirestore(app);

  console.log(`=== 第4世代お守り amulet_kind 限定移行スクリプト ===`);
  console.log(`実行モード: ${isApply ? '【本番適用 (APPLY)】' : '【事前確認 (DRY-RUN)】'}`);
  console.log(`エミュレーター接続: ${process.env.FIRESTORE_EMULATOR_HOST ? process.env.FIRESTORE_EMULATOR_HOST : 'なし (クラウド接続)'}`);

  // 1. ローカルマスター seed-items.json の読み込みと完全性検証
  const seedDataPath = join(__dirname, 'seed-items.json');
  if (!existsSync(seedDataPath)) {
    throw new Error('seed-items.json が見つかりません。');
  }

  const localItems = JSON.parse(readFileSync(seedDataPath, 'utf8'));
  const gen4LocalAmulets = localItems.filter(i => i.generation === 4 && i.type === 'amulet');

  if (gen4LocalAmulets.length !== 362) {
    throw new Error(`ローカルマスターの第4世代お守り件数が不整合です: ${gen4LocalAmulets.length} (期待: 362)`);
  }

  const localMap = new Map();
  const kindCounts = { normal: 0, rare: 0, super_rare: 0, ultra_rare: 0, ghost: 0 };

  for (const item of gen4LocalAmulets) {
    if (!item.amulet_kind || !kindCounts.hasOwnProperty(item.amulet_kind)) {
      throw new Error(`ローカルマスターに不正な amulet_kind が含まれています: ${item.id} (${item.amulet_kind})`);
    }
    kindCounts[item.amulet_kind]++;
    localMap.set(item.id, item);
  }

  const expectedCounts = { normal: 112, rare: 106, super_rare: 104, ultra_rare: 26, ghost: 14 };
  for (const [k, exp] of Object.entries(expectedCounts)) {
    if (kindCounts[k] !== exp) {
      throw new Error(`ローカルマスターの種類 [${k}] 件数不一致: 期待 ${exp}, 実際 ${kindCounts[k]}`);
    }
  }

  console.log(`✓ ローカルマスター検証合格 (全 362 件: N=${kindCounts.normal}, R=${kindCounts.rare}, SR=${kindCounts.super_rare}, UR=${kindCounts.ultra_rare}, Ghost=${kindCounts.ghost})`);

  // 2. Firestore から第4世代のお守りドキュメントを取得
  console.log('Firestore から第4世代のお守りデータを取得中...');
  const snapshot = await db.collection('items').where('generation', '==', 4).where('type', '==', 'amulet').get();

  console.log(`Firestore 取得件数: ${snapshot.size} 件`);

  if (snapshot.size !== 362) {
    throw new Error(`Firestore 上の第4世代お守り件数が不整合です: ${snapshot.size} (期待: 362)。移行を中止します。`);
  }

  const updates = [];
  let unchangedCount = 0;
  let missingDocCount = 0;

  snapshot.forEach(docSnap => {
    const remoteData = docSnap.data();
    const docId = docSnap.id;
    const localData = localMap.get(docId);

    if (!localData) {
      console.error(`エラー: Firestore ドキュメント ${docId} に対応するローカルマスターが存在しません。`);
      missingDocCount++;
      return;
    }

    if (remoteData.itemId !== localData.itemId || remoteData.order !== localData.order) {
      console.error(`エラー: ID/itemId/order の不一致 [${docId}]: Remote(itemId=${remoteData.itemId}, order=${remoteData.order}) vs Local(itemId=${localData.itemId}, order=${localData.order})`);
      missingDocCount++;
      return;
    }

    if (remoteData.amulet_kind === localData.amulet_kind) {
      unchangedCount++;
    } else {
      updates.push({
        ref: docSnap.ref,
        id: docId,
        order: localData.order,
        oldKind: remoteData.amulet_kind || '(未設定)',
        newKind: localData.amulet_kind
      });
    }
  });

  if (missingDocCount > 0) {
    throw new Error(`ドキュメント構成・属性に ${missingDocCount} 件の不整合が検出されたため、処理を停止しました。`);
  }

  console.log(`--- 移行対象チェック結果 ---`);
  console.log(`変更不要（既に最新）: ${unchangedCount} 件`);
  console.log(`更新対象 (amulet_kind 差分あり): ${updates.length} 件`);

  if (updates.length > 0) {
    console.log(`\n【更新対象一覧サンプル (最大10件)】:`);
    updates.slice(0, 10).forEach(u => {
      console.log(`  - [order #${u.order}] ${u.id}: ${u.oldKind} -> ${u.newKind}`);
    });
    if (updates.length > 10) {
      console.log(`  ...他 ${updates.length - 10} 件`);
    }
  }

  if (!isApply) {
    console.log(`\n※ DRY-RUN モードで完了しました。Firestore への変更は一切行われていません。`);
    console.log(`実際の反映を行う場合は '--apply' オプションを付与して実行してください。`);
    process.exit(0);
  }

  if (updates.length === 0) {
    console.log(`\nすべてのドキュメントが既に最新状態です。更新の必要はありません。`);
    process.exit(0);
  }

  // 3. 実際の更新処理 (APPLY)
  console.log(`\nFirestore への書き込みを開始します (${updates.length} 件)...`);
  const batch = db.batch();

  for (const item of updates) {
    batch.update(item.ref, {
      amulet_kind: item.newKind
    });
  }

  await batch.commit();
  console.log(`✓ 正常完了: ${updates.length} 件のドキュメントの amulet_kind を更新しました。`);

} catch (err) {
  console.error('\n❌ エラーが発生したため処理を中断しました:', err.message || err);
  process.exit(1);
}