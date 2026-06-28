import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || join(__dirname, '../serviceAccountKey.json');

try {
  // 1. seed-items.json のローカルマスタデータを読み込んで自動アップグレード関係を挿入・上書き保存
  const seedDataPath = join(__dirname, 'seed-items.json');
  if (existsSync(seedDataPath)) {
    console.log('ローカルの seed-items.json のリレーションを自動解決しています...');
    const localItems = JSON.parse(readFileSync(seedDataPath, 'utf8'));

    // 第4世代のお守り（amulet）を抽出してソート
    const amulets = localItems
      .filter(item => item.generation === 4 && item.type === 'amulet')
      .sort((a, b) => a.order - b.order);

    for (let i = 0; i < amulets.length; i++) {
      const current = amulets[i];
      // 奇数のorderの場合に次の偶数orderお守りと連携させる
      if (current.order % 2 === 1) {
        const next = amulets.find(item => item.order === current.order + 1);
        if (next) {
          // 本来のオブジェクト側も更新
          const origCurrent = localItems.find(item => item.id === current.id);
          const origNext = localItems.find(item => item.id === next.id);

          if (origCurrent) {
            origCurrent.upgrade_to = origCurrent.upgrade_to || next.itemId;
          }
          if (origNext) {
            origNext.upgrade_from = origNext.upgrade_from || current.itemId;
          }
        }
      }
    }

    // 綺麗にインデントして書き戻す
    writeFileSync(seedDataPath, JSON.stringify(localItems, null, 2), 'utf8');
    console.log('✓ ローカルの seed-items.json への強化リレーション自動適用が完了しました。');
  }

  // 2. Firebase Admin SDK の初期化
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
        console.log(`Firebase Admin SDK を認証情報ファイルで初期化します (Project: ${projectId})。`);
      } catch (err) {
        console.warn('認証情報ファイルの解析に失敗しました。', err);
      }
    } else {
      const isEmulator = process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true';
      if (isEmulator) {
        console.log('ローカルエミュレータ（接続迂回）を使用して接続します。');
        process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
      } else {
        console.log('Google Cloud CLI (ADC/gcloud login) のローカル認証情報を使用します。');
        projectId = process.env.PUBLIC_FIREBASE_PROJECT_ID || 'seiun-collection-prd';
      }
    }

    app = initializeApp(credential ? {
      credential,
      projectId: projectId
    } : {
      projectId: projectId
    });
  }

  const db = getFirestore(app);

  // 3. Firestore の既存データをフェッチし、足りないupgradeリレーションを算出してバッチ書き込み
  console.log('Firestore の items コレクションからデータをフェッチしています...');
  const itemsSnapshot = await db.collection('items').get();
  const dbItems = [];
  itemsSnapshot.forEach(doc => {
    dbItems.push({ id: doc.id, ...doc.data() });
  });

  const dbAmulets = dbItems
    .filter(item => item.generation === 4 && item.type === 'amulet')
    .sort((a, b) => a.order - b.order);

  console.log(`第4世代のお守りを ${dbAmulets.length} 件検出しました。リレーションを同期します...`);

  const batch = db.batch();
  let updateCount = 0;

  for (let i = 0; i < dbAmulets.length; i++) {
    const current = dbAmulets[i];
    if (current.order % 2 === 1) {
      const next = dbAmulets.find(item => item.order === current.order + 1);
      if (next) {
        let isCurrentChanged = false;
        let isNextChanged = false;

        const currentUpdate = {};
        const nextUpdate = {};

        if (!current.upgrade_to) {
          currentUpdate.upgrade_to = next.itemId;
          isCurrentChanged = true;
        }
        if (!next.upgrade_from) {
          nextUpdate.upgrade_from = current.itemId;
          isNextChanged = true;
        }

        if (isCurrentChanged) {
          const currentRef = db.collection('items').doc(current.id);
          batch.update(currentRef, currentUpdate);
          console.log(`アップグレード設定 [${current.name} -> ${next.name}] (upgrade_to: ${next.itemId}) を追加します。`);
          updateCount++;
        }
        if (isNextChanged) {
          const nextRef = db.collection('items').doc(next.id);
          batch.update(nextRef, nextUpdate);
          console.log(`アップグレード設定 [${next.name} <- ${current.name}] (upgrade_from: ${current.itemId}) を追加します。`);
          updateCount++;
        }
      }
    }
  }

  if (updateCount > 0) {
    await batch.commit();
    console.log(`✓ Firestore上の ${updateCount} 件のリレーション更新をアトミックに適用しました！`);
  } else {
    console.log('Firestore上の全お守りは既に奇数➔偶数の強化リレーションが満たされています。更新は不要です。');
  }

} catch (error) {
  console.error('マイグレーション中にエラーが発生しました:', error);
  process.exit(1);
}
