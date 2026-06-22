import { initializeApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readdirSync, existsSync } from 'fs';
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
      process.env.FIREBASE_STORAGE_EMULATOR_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
    } else {
      console.log(`Google Cloud CLI (ADC/gcloud login) のローカル認証情報を使用します (Project: ${projectId})。`);
    }

    const storageBucket = process.env.PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;

    app = initializeApp({
      projectId: projectId,
      storageBucket: storageBucket
    });
  }

  const db = getFirestore(app);
  const storage = getStorage(app);
  const bucket = storage.bucket();

  const localImagesDir = process.env.SEED_IMAGES_DIR || join(__dirname, '../refs/images');
  if (!existsSync(localImagesDir)) {
    console.warn(`警告: ローカル画像ディレクトリが見つかりません (${localImagesDir})。画像プールのシード処理をスキップします。`);
    process.exit(0);
  }

  const files = readdirSync(localImagesDir).filter(f => f.match(/\.(png|jpg|jpeg|webp)$/i));
  if (files.length === 0) {
    console.warn(`警告: 対象の画像ファイルが見つかりません (${localImagesDir})。画像プールのシード処理をスキップします。`);
    process.exit(0);
  }
  console.log(`ローカル画像ディレクトリーから ${files.length} 件のファイルを検出しました。`);

  // エミュレータ稼働時と本番稼働時でベースホストを自動スイッチ
  const isEmulator = !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const storageHost = isEmulator ? 'http://127.0.0.1:9199' : 'https://firebasestorage.googleapis.com';
  const bucketName = bucket.name;

  console.log(`Firebase Storage バケット: ${bucketName} (Emulator: ${isEmulator})`);
  console.log('アップロード及び画像プール (/image_pool) の書き込みを開始します...');

  for (const [index, fileName] of files.entries()) {
    const localFilePath = join(localImagesDir, fileName);
    const destination = `item-images/${fileName}`;
    const token = `token-${Math.random().toString(36).substring(2)}-${Date.now()}`;

    // 1. Storage バケットへファイルを直接転送
    await bucket.upload(localFilePath, {
      destination: destination,
      metadata: {
        contentType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        metadata: {
          firebaseStorageDownloadTokens: token
        }
      }
    });

    // 2. Firebase Storage 直リンク絶対URLの作成
    const encodedDestination = encodeURIComponent(destination);
    const downloadUrl = `${storageHost}/v0/b/${bucketName}/o/${encodedDestination}?alt=media&token=${token}`;

    // ドキュメントIDは拡張子を除いたファイル名にする (e.g. fu_0001)
    const imageId = fileName.replace(/\.[^/.]+$/, "");

    // 3. Firestore の /image_pool コレクションに書き込み/マージ
    const poolRef = db.collection('image_pool').doc(imageId);
    await poolRef.set({
      id: imageId,
      fileName: fileName,
      url: downloadUrl,
      is_linked: false,
      target_item_id: null
    }, { merge: true });

    if ((index + 1) % 10 === 0 || index + 1 === files.length) {
      console.log(`進捗: ${index + 1}/${files.length} 件の画像の転送とプール登録が完了しました。`);
    }
  }

  console.log('すべての画像のバケット転送および /image_pool コレクションへの初期登録が完了しました！');
} catch (error) {
  console.error('シードプールエラーが発生しました:', error);
  process.exit(1);
}
