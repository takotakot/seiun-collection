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

  const seedDataPath = join(__dirname, 'seed-items.json');
  const items = JSON.parse(readFileSync(seedDataPath, 'utf8'));

  console.log(`${items.length} 件のマスタデータをインポート中...`);

  const batch = db.batch();

  for (const item of items) {
    const docRef = db.collection('items').doc(item.id);
    batch.set(docRef, item, { merge: true });
    console.log(`インポートキューに追加されました: ${item.id} (${item.name})`);
  }

  await batch.commit();
  console.log('すべてのマスタデータのインポートが完了しました。');
} catch (error) {
  console.error('インポートエラーが発生しました:', error);
  process.exit(1);
}
