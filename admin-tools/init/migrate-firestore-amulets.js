import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || join(__dirname, '../serviceAccountKey.json');

class FirestoreBatcher {
  constructor(db) {
    this.db = db;
    this.batch = db.batch();
    this.opCount = 0;
    this.totalCommittedOps = 0;
  }

  async addOp(ref, data, type = 'set') {
    if (type === 'set') {
      this.batch.set(ref, data, { merge: true });
    } else if (type === 'update') {
      this.batch.update(ref, data);
    } else if (type === 'delete') {
      this.batch.delete(ref);
    }
    
    this.opCount++;

    if (this.opCount >= 400) {
      await this.commit();
    }
  }

  async commit() {
    if (this.opCount > 0) {
      console.log(`[Batcher] ${this.opCount} 操作をコミット中...`);
      await this.batch.commit();
      this.totalCommittedOps += this.opCount;
      this.batch = this.db.batch();
      this.opCount = 0;
    }
  }
}

try {
  // 1. 新しいシードデータをロードして変換マップを構成
  const seedDataPath = join(__dirname, 'seed-items.json');
  if (!existsSync(seedDataPath)) {
    throw new Error('seed-items.json が見つかりません。');
  }

  const newItems = JSON.parse(readFileSync(seedDataPath, 'utf8'));

  const idMap = {}; // oldId -> newId
  const itemIdMap = {}; // oldItemId -> newItemId

  for (const item of newItems) {
    if (item.generation === 4) {
      const order = item.order;
      const newId = item.id;
      const newItemId = item.itemId;

      let oldId, oldItemId;
      
      if (item.type === 'amulet') {
        if (order === 5) {
          oldId = '4_amulet_piggybank_1';
          oldItemId = 'amulet_piggybank_1';
        } else if (order === 6) {
          oldId = '4_amulet_piggybank_2';
          oldItemId = 'amulet_piggybank_2';
        } else {
          oldId = `4_amulet_slot_${order}`;
          oldItemId = `amulet_slot_${order}`;
        }
      } else if (item.type === 'stamp') {
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
      } else if (item.type === 'rune') {
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
      }

      if (oldId && newItemId) {
        idMap[oldId] = newId;
        itemIdMap[oldItemId] = newItemId;
      }
    }
  }

  console.log(`変換マップを構成しました。お守り・スタンプ・ルーンマッピング総数: ${Object.keys(idMap).length} 件`);

  // 2. Firebase SDK の初期化
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
  const batcher = new FirestoreBatcher(db);

  // -------------------------------------------------------------
  // 3. /items コレクションのマイグレーション
  // -------------------------------------------------------------
  console.log('--- Phase 1: /items コレクションを移行しています ---');
  const itemsSnapshot = await db.collection('items').get();
  console.log(`items コレクションから ${itemsSnapshot.size} 件のドキュメントを取得しました。`);

  for (const doc of itemsSnapshot.docs) {
    const oldId = doc.id;
    if (idMap[oldId]) {
      const newId = idMap[oldId];
      const data = doc.data();

      // 新ドキュメント用データの構築
      const newData = {
        ...data,
        id: newId,
        itemId: itemIdMap[data.itemId] || data.itemId,
      };

      if (data.upgrade_to && itemIdMap[data.upgrade_to]) {
        newData.upgrade_to = itemIdMap[data.upgrade_to];
      }
      if (data.upgrade_from && itemIdMap[data.upgrade_from]) {
        newData.upgrade_from = itemIdMap[data.upgrade_from];
      }

      console.log(`ドキュメントコピー [${data.type}]: ${oldId} -> ${newId} (${newData.name})`);
      
      const newDocRef = db.collection('items').doc(newId);
      const oldDocRef = db.collection('items').doc(oldId);

      await batcher.addOp(newDocRef, newData, 'set');
      await batcher.addOp(oldDocRef, null, 'delete');
    }
  }

  // -------------------------------------------------------------
  // 4. /image_pool コレクションの移行
  // -------------------------------------------------------------
  console.log('--- Phase 2: /image_pool コレクションを移行しています ---');
  const poolSnapshot = await db.collection('image_pool').get();
  console.log(`image_pool から ${poolSnapshot.size} 件を取得しました。`);

  for (const doc of poolSnapshot.docs) {
    const poolId = doc.id;
    const poolData = doc.data();

    if (poolData.target_item_id && idMap[poolData.target_item_id]) {
      const oldTargetId = poolData.target_item_id;
      const newTargetId = idMap[oldTargetId];

      console.log(`Image Pool の target_item_id を更新します [${poolId}]: ${oldTargetId} -> ${newTargetId}`);
      const poolDocRef = db.collection('image_pool').doc(poolId);
      await batcher.addOp(poolDocRef, { target_item_id: newTargetId }, 'update');
    }
  }

  // -------------------------------------------------------------
  // 5. /users/{userId}/collections サブコレクションの移行
  // -------------------------------------------------------------
  console.log('--- Phase 3: /users/{userId}/collections サブコレクションを移行しています ---');
  const usersSnapshot = await db.collection('users').get();
  console.log(`登録ユーザー数: ${usersSnapshot.size} 名`);

  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    const collRef = db.collection('users').doc(userId).collection('collections');
    const colsSnapshot = await collRef.get();

    console.log(`ユーザー [${userId}]: 所持アイテム数 ${colsSnapshot.size} 件`);

    for (const doc of colsSnapshot.docs) {
      const oldId = doc.id;
      if (idMap[oldId]) {
        const newId = idMap[oldId];
        const data = doc.data();

        // データを新IDに載せ替えてコピー
        const newData = {
          ...data,
          // フィールドに id / itemId / item_id があればこれも更新する
        };
        if (newData.id && idMap[newData.id]) {
          newData.id = idMap[newData.id];
        }
        if (newData.itemId && itemIdMap[newData.itemId]) {
          newData.itemId = itemIdMap[newData.itemId];
        }
        if (newData.item_id && idMap[newData.item_id]) {
          newData.item_id = idMap[newData.item_id];
        }

        console.log(`  [ユーザー所持置換] ${oldId} -> ${newId}`);
        const newColDocRef = collRef.doc(newId);
        const oldColDocRef = collRef.doc(oldId);

        await batcher.addOp(newColDocRef, newData, 'set');
        await batcher.addOp(oldColDocRef, null, 'delete');
      }
    }
  }

  // 残りのバッチをフラッシュ
  await batcher.commit();
  console.log(`\n🎉 マイグレーション完了！ 合計処理操作数: ${batcher.totalCommittedOps} 件`);

} catch (err) {
  console.error("マイグレーション中にエラーが発生しました:", err);
  process.exit(1);
}
