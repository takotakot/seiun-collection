import { initializeApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  let app;
  try {
    app = getApp();
  } catch (e) {
    const projectId = process.env.PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'demo-seiun-collection-app';
    const isEmulator = process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true';

    if (isEmulator) {
      console.log(`ローカルエミュレータ（接続迂回）を使用して接続します (Project: ${projectId})。`);
      process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    } else {
      console.log(`Google Cloud CLI (ADC/gcloud login) のローカル認証情報を使用します (Project: ${projectId})。`);
    }

    app = initializeApp({
      projectId: projectId
    });
  }

  const db = getFirestore(app);

  // 1. image_pool の既存データを一意にメモリへ読み込む
  console.log('image_pool コレクションからデータをフェッチしてマッピングしています...');
  const poolSnapshot = await db.collection('image_pool').get();
  const poolDocs = {};
  poolSnapshot.forEach(doc => {
    poolDocs[doc.id] = doc.data();
  });
  console.log(`マスタープールから ${Object.keys(poolDocs).length} 件の画像インデックスを取得しました。`);

  const seedDataPath = join(__dirname, 'seed-items.json');
  const items = JSON.parse(readFileSync(seedDataPath, 'utf8'));

  console.log(`${items.length} 件のマスタデータをインポート中...`);

  const batch = db.batch();

  for (const item of items) {
    // 初期値として、通報系のデフォルトフィールドを追加
    item.report_count = item.report_count || 0;
    item.reported_by = item.reported_by || [];

    // ローカル相対パス表記 （e.g. /images/fu_0018.png）の場合は、プール上にあるバケットURLへ自動アタッチ
    // ただし、Hostingから直接配信する /images/runes/ などの例外はスキップする
    if (item.image_url && item.image_url.startsWith('/images/') && !item.image_url.startsWith('/images/runes/')) {
      const fileName = item.image_url.split('/').pop();
      const imageId = fileName.replace(/\.[^/.]+$/, ""); // 拡張子を削除してID化

      if (poolDocs[imageId]) {
        console.log(`マッチ成功: [${item.name}] にバケット上の直リンク画像 [${poolDocs[imageId].url}] をアタッチします。`);
        item.image_url = poolDocs[imageId].url;

        // image_pool 側の該当エントリも「既紐付け (is_linked: true)」に更新
        const poolDocRef = db.collection('image_pool').doc(imageId);
        batch.update(poolDocRef, {
          is_linked: true,
          target_item_id: item.id
        });
      } else {
        console.warn(`警告: 画像プールに ${imageId} が見つかりませんでした。空のままで登録されます。`);
        item.image_url = "";
      }
    }

    const docRef = db.collection('items').doc(item.id);
    batch.set(docRef, item, { merge: true });
    console.log(`インポートキューに追加されました: ${item.id} (${item.name})`);
  }

  await batch.commit();
  console.log('すべてのマスタデータのインポートおよび画像自動アタッチが完了しました。');
} catch (error) {
  console.error('インポートエラーが発生しました:', error);
  process.exit(1);
}
