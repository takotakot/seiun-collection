import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

  console.log(`--- スタンプのテキストデータインポート＆上書きスクリプトを開始 (Project: ${db.projectId}) ---`);

  // 2. 提供されたスタンプテキストデータの読み込み & パース
  const stampDataPath = join(__dirname, '../temp/stamp_data.txt');
  if (!existsSync(stampDataPath)) {
    console.error(`エラー: スタンプデータのテキストファイルが見つかりません: ${stampDataPath}`);
    process.exit(1);
  }

  const rawText = readFileSync(stampDataPath, 'utf8');
  const stampLines = rawText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  console.log(`提供されたスタンプデータ検出数: ${stampLines.length} 件`);

  const parsedStamps = stampLines.map((line, index) => {
    const parts = line.split('\t');
    const name = parts[0].trim();
    const effect_text = parts[1] ? parts[1].trim() : '';
    const order = index + 1;
    const id = `4_stamp_${String(order).padStart(3, '0')}`;
    const itemId = `stamp_${String(order).padStart(3, '0')}`;
    
    // 画像アセットの存在チェック (refs/images内に badge_600{order}0.png があるか確認)
    const orderPadded = String(order).padStart(3, '0');
    const localImgName = `badge_600${orderPadded}0.png`;
    const localImgPath = join(__dirname, '../refs/images', localImgName);
    
    const hasImage = existsSync(localImgPath);
    const image_url = hasImage ? `/images/${localImgName}` : '';

    return {
      id,
      itemId,
      generation: 4,
      order,
      type: 'stamp',
      name,
      effect_text,
      image_url
    };
  });

  // 3. Firestore データベースへの上書き/更新
  const batch = db.batch();
  let updateCount = 0;

  for (const stamp of parsedStamps) {
    const docRef = db.collection('items').doc(stamp.id);
    const docSnap = await docRef.get();

    let shouldUpdate = false;
    let reason = '';

    if (!docSnap.exists) {
      shouldUpdate = true;
      reason = '新規登録';
    } else {
      const currentData = docSnap.data();
      
      // 仮置き（初期値）のままでない（＝値が異なる）場合は上書き
      const nameDiff = currentData.name !== stamp.name;
      const effectDiff = currentData.effect_text !== stamp.effect_text;
      const imageDiff = currentData.image_url !== stamp.image_url;

      if (nameDiff || effectDiff || imageDiff) {
        shouldUpdate = true;
        reason = `差分あり [${nameDiff ? '名前 ' : ''}${effectDiff ? '効果説明 ' : ''}${imageDiff ? '画像 ' : ''}]`;
      }
    }

    if (shouldUpdate) {
      console.log(`[更新対象] ID: ${stamp.id} | 名前: ${stamp.name} | 理由: ${reason}`);
      batch.set(docRef, stamp, { merge: true });
      updateCount++;
    } else {
      console.log(`[スキップ] ID: ${stamp.id} | 名前: ${stamp.name} (既に一致しているため変更不要)`);
    }
  }

  if (updateCount > 0) {
    await batch.commit();
    console.log(`\n🎉 Firestore 更新完了！合計 ${updateCount} 件のスタンプ情報を Firestore に上書き保存しました。`);
  } else {
    console.log('\nすべてのスタンプ情報について Firestore 側は最新の状態に保たれています。更新はありません。');
  }

  // 4. ローカルの seed-items.json ファイルも更新・同期する
  const seedItemsPath = join(__dirname, '../admin-tools/seed-items.json');
  if (existsSync(seedItemsPath)) {
    try {
      const localItems = JSON.parse(readFileSync(seedItemsPath, 'utf8'));
      let fileUpdated = false;

      const updatedLocalItems = localItems.map(item => {
        if (item.type === 'stamp' && item.generation === 4) {
          const match = parsedStamps.find(s => s.id === item.id);
          if (match) {
            // 差分があるかチェック
            if (
              item.name !== match.name ||
              item.effect_text !== match.effect_text ||
              item.image_url !== match.image_url
            ) {
              fileUpdated = true;
              return {
                ...item,
                name: match.name,
                effect_text: match.effect_text,
                image_url: match.image_url
              };
            }
          }
        }
        return item;
      });

      if (fileUpdated) {
        writeFileSync(seedItemsPath, JSON.stringify(updatedLocalItems, null, 2), 'utf8');
        console.log(`✓ ローカルファイル ${seedItemsPath} も最新のスタンプ情報で同期・上書き保存しました。`);
      } else {
        console.log(`✓ ローカルファイル ${seedItemsPath} はすでに最新状態に同期されていました。`);
      }
    } catch (err) {
      console.error('ローカル seed-items.json の更新・同期処理中にエラーが発生しました:', err);
    }
  }

} catch (err) {
  console.error('予期せぬエラーが発生しました:', err);
}
