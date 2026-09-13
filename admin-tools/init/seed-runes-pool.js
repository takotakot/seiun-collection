import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || join(__dirname, '../serviceAccountKey.json');

try {
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
        process.env.FIREBASE_STORAGE_EMULATOR_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
      } else {
        console.log('Google Cloud CLI (ADC/gcloud login) のローカル認証情報を使用します。');
        projectId = process.env.PUBLIC_FIREBASE_PROJECT_ID || 'seiun-collection-prd';
      }
    }

    const storageBucket = projectId === 'seiun-collection-prd'
      ? `${projectId}.firebasestorage.app`
      : `${projectId}.appspot.com`;

    app = initializeApp(credential ? {
      credential,
      projectId: projectId,
      storageBucket: storageBucket
    } : {
      projectId: projectId,
      storageBucket: storageBucket
    });
  }

  const db = getFirestore(app);
  const storage = getStorage(app);
  const bucket = storage.bucket();

  // コピー元（ルーン画像があるフォルダ）
  const localImagesDir = join(__dirname, '../web/public/images/runes');
  if (!existsSync(localImagesDir)) {
    console.error(`エラー: ルーン画像ディレクトリが見つかりません。 ${localImagesDir}`);
    process.exit(1);
  }

  const files = readdirSync(localImagesDir).filter(f => f.match(/^rune_stone_\d+\.webp$/i));
  console.log(`ルーン画像ディレクトリーから ${files.length} 件のファイルを検出しました。`);

  const isEmulator = !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const storageHost = isEmulator ? 'http://127.0.0.1:9199' : 'https://firebasestorage.googleapis.com';
  const bucketName = bucket.name;

  console.log(`Firebase Storage バケット: ${bucketName} (Emulator: ${isEmulator})`);
  console.log('アップロードおよび画像プール (/image_pool) への登録を開始します（itemsコレクションへのアタッチは行いません）...');

  for (const [index, fileName] of files.entries()) {
    const localFilePath = join(localImagesDir, fileName);
    const destination = `item-images/${fileName}`;
    const token = `token-${Math.random().toString(36).substring(2)}-${Date.now()}`;

    // 1. Storage バケットへファイルを転送
    await bucket.upload(localFilePath, {
      destination: destination,
      metadata: {
        contentType: 'image/webp',
        metadata: {
          firebaseStorageDownloadTokens: token
        }
      }
    });

    // 2. Firebase Storage 直リンク絶対URLの作成
    const encodedDestination = encodeURIComponent(destination);
    const downloadUrl = `${storageHost}/v0/b/${bucketName}/o/${encodedDestination}?alt=media&token=${token}`;

    // ドキュメントIDは拡張子を除いたファイル名にする (e.g. rune_stone_01)
    const imageId = fileName.replace(/\.[^/.]+$/, "");

    // 3. Firestore の /image_pool コレクションに書き込み/マージ (itemsコレクションは一切いじりません)
    const poolRef = db.collection('image_pool').doc(imageId);
    await poolRef.set({
      id: imageId,
      fileName: fileName,
      url: downloadUrl,
      is_linked: false,
      target_item_id: null
    }, { merge: true });

    console.log(`登録完了 [${imageId}] -> ${fileName}`);
  }

  console.log('🎉 ルーンストーン画像のバケット転送および /image_pool へのプール登録がすべて完了しました！');
  console.log('これで本番 Web 上の「画像変更」機能から手動でルーンを各個別にアタッチできるようになります。');
} catch (error) {
  console.error('ルーンプール移行中にエラーが発生しました:', error);
  process.exit(1);
}
