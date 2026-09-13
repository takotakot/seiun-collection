import { initializeApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

try {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  const app = initializeApp({ projectId: 'demo-seiun-collection-app' });
  const db = getFirestore(app);

  console.log('--- テストデータ作成開始 ---');

  // 1. テストユーザーの登録
  const userRef = db.collection('users').doc('test-user-123');
  await userRef.set({
    display_name: 'マイグレーションテスト太郎',
    last_active_at: new Date()
  });
  console.log('✓ テストユーザー test-user-123 作成完了');

  // 2. 所持アイテムサブコレクションの作成
  const collRef = userRef.collection('collections');
  
  await collRef.doc('4_amulet_001').set({
    id: '4_amulet_001',
    itemId: 'amulet_001',
    is_owned: true,
    created_at: new Date()
  });

  await collRef.doc('4_amulet_005').set({
    id: '4_amulet_005',
    itemId: 'amulet_005',
    is_owned: true,
    created_at: new Date()
  });

  await collRef.doc('4_stamp_001').set({ // 影響を受けないはずのスタンプ
    id: '4_stamp_001',
    itemId: 'stamp_001',
    is_owned: true,
    created_at: new Date()
  });

  console.log('✓ ユーザー所持テストデータ作成完了 (4_amulet_001, 4_amulet_005, 4_stamp_001)');

  // 3. image_pool の作成
  await db.collection('image_pool').doc('test_image_1').set({
    url: 'https://example.com/image1.png',
    target_item_id: '4_amulet_001',
    is_linked: true
  });

  await db.collection('image_pool').doc('test_image_2').set({
    url: 'https://example.com/image2.png',
    target_item_id: '4_stamp_001', // 影響を受けないはずのスタンプ
    is_linked: true
  });

  console.log('✓ image_pool テストデータ作成完了');
  console.log('--- テストデータ作成終了 ---');

} catch (err) {
  console.error('テストデータ作成エラー:', err);
}
