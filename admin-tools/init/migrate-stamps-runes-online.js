import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || join(__dirname, '../serviceAccountKey.json');

try {
  // 1. Firebase SDK の初期化
  let app;
  try {
    app = getApp();
  } catch (e) {
    let credential;
    let projectId = 'demo-seiun-collection-app';

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
        projectId = process.env.PUBLIC_FIREBASE_PROJECT_ID || 'seiun-collection-prd';
      }
    }

    app = initializeApp(credential ? { credential, projectId } : { projectId });
  }

  const db = getFirestore(app);

  // 2. マップ作成（古いID -> 新しいID、および itemId）
  const idMap = {};
  const itemIdMap = {};

  // スタンプマッピング (1〜28)
  for (let order = 1; order <= 28; order++) {
    const padded = String(order).padStart(3, '0');
    const newId = `4_stamp_${padded}`;
    const newItemId = `stamp_${padded}`;

    let oldId, oldItemId;
    if (order === 1) {
      oldId = '4_stamp_noumu_shield';
      oldItemId = 'stamp_noumu_shield';
    } else if (order === 2) {
      oldId = '4_stamp_saisei';
      oldItemId = 'stamp_saisei';
    } else if (order === 3) {
      oldId = '4_stamp_kakuchou';
      oldItemId = 'stamp_kakuchou';
    } else {
      oldId = `4_stamp_slot_${order}`;
      oldItemId = `stamp_slot_${order}`;
    }

    idMap[oldId] = newId;
    itemIdMap[oldItemId] = newItemId;
  }

  // ルーンマッピング (1〜24)
  for (let order = 1; order <= 24; order++) {
    const padded = String(order).padStart(3, '0');
    const newId = `4_rune_${padded}`;
    const newItemId = `rune_${padded}`;

    let oldId, oldItemId;
    if (order === 1) {
      oldId = '4_rune_jifu';
      oldItemId = 'rune_jifu';
    } else if (order === 2) {
      oldId = '4_rune_toiputao';
      oldItemId = 'rune_toiputao';
    } else {
      oldId = `4_rune_slot_${order}`;
      oldItemId = `rune_slot_${order}`;
    }

    idMap[oldId] = newId;
    itemIdMap[oldItemId] = newItemId;
  }

  console.log(`--- スタンプ・ルーンの無停止移行スクリプトを実行中 (Project: ${db.projectId}) ---`);
  console.log(`移行マッピング総数: ${Object.keys(idMap).length} 件`);

  const batch = db.batch();
  let count = 0;

  // 3. /items コレクションから現在のデータを取得して新IDへ移動 (100%データを引き継ぐ)
  for (const oldId of Object.keys(idMap)) {
    const docRef = db.collection('items').doc(oldId);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      const data = docSnap.data();
      const newId = idMap[oldId];
      const newItemId = itemIdMap[data.itemId] || data.itemId;

      // 既存の本番編集データ(例: image_url や report_count など)を 100% そのままロードしてマージ
      const newData = {
        ...data,
        id: newId,
        itemId: newItemId
      };

      console.log(`移行対象を検出: ${oldId} -> ${newId} (${data.name})`);

      const newDocRef = db.collection('items').doc(newId);
      const oldDocRef = db.collection('items').doc(oldId);

      // バッチに「新IDでの追加（コピー）」と「旧IDの削除」をセット
      batch.set(newDocRef, newData, { merge: true });
      batch.delete(oldDocRef);
      count++;
    }
  }

  // 4. image_pool の古いスタンプ・ルーン参照先の書き換え
  const poolSnapshot = await db.collection('image_pool').get();
  for (const doc of poolSnapshot.docs) {
    const poolData = doc.data();
    if (poolData.target_item_id && idMap[poolData.target_item_id]) {
      const oldTargetId = poolData.target_item_id;
      const newTargetId = idMap[oldTargetId];
      
      console.log(`Image Pool 参照を更新 [${doc.id}]: ${oldTargetId} -> ${newTargetId}`);
      batch.update(doc.ref, { target_item_id: newTargetId });
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
    console.log(`\n🎉 移行コミット完了！合計 ${count} 件のドキュメント作成・整理をすべて安全に行いました（amuletやお守りマスタには一切干渉していません）。`);
  } else {
    console.log('\n移行対象となる古いスタンプ・ルーンのドキュメントは存在しませんでした。すでに完了しています。');
  }

} catch (err) {
  console.error('マイグレーション中にエラーが発生しました:', err);
  process.exit(1);
}
