import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const requireBase = existsSync(join(__dirname, '../web/node_modules/firebase-admin'))
  ? new URL('../web/package.json', import.meta.url)
  : import.meta.url;
const require = createRequire(requireBase);
const { initializeApp, getApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const isForce = args.includes('--force');
  const isExportLocal = args.includes('--export-local');
  const projectArg = args.find(a => a.startsWith('--project='));
  const targetProjectId = projectArg ? projectArg.split('=')[1] : null;

  console.log('=== 第4.5世代 初期データ投入スクリプト ===');
  console.log(`モード: ${isApply ? '【APPLY (本番書き込み)】' : '【DRY-RUN (シミュレーション・書き込みなし)】'}`);
  console.log(`上書き設定 (--force): ${isForce ? '有効 (既存データを上書き)' : '無効 (既存データは保護・スキップ)'}`);

  // Firebase接続初期化
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true';
  const projectId = targetProjectId || process.env.PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || (isEmulator ? 'demo-seiun-collection-app' : 'seiun-collection-prd');

  if (isEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    console.log(`ローカルエミュレータを使用して接続します (Host: ${process.env.FIRESTORE_EMULATOR_HOST}, Project: ${projectId})`);
  }

  const saKeyEnv = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const saKeyDefaultPath = join(__dirname, '../serviceAccountKey.json');
  let credential;

  if (saKeyEnv && existsSync(saKeyEnv)) {
    console.log(`サービスアカウントキー (FIREBASE_SERVICE_ACCOUNT_KEY) を使用します: ${saKeyEnv}`);
    credential = cert(JSON.parse(readFileSync(saKeyEnv, 'utf8')));
  } else if (existsSync(saKeyDefaultPath)) {
    console.log(`サービスアカウントキーを使用します: ${saKeyDefaultPath}`);
    credential = cert(JSON.parse(readFileSync(saKeyDefaultPath, 'utf8')));
  } else if (!isEmulator) {
    console.log(`Google Cloud ADC / gcloud 認証情報を使用します (Project: ${projectId})`);
  }

  let app;
  try {
    app = getApp();
  } catch (e) {
    const appOptions = { projectId };
    if (credential) {
      appOptions.credential = credential;
    }
    app = initializeApp(appOptions);
  }

  const db = getFirestore(app);

  // 1. 第4世代のスタンプ (28件) とルーン石 (24件) を取得
  console.log('\n[1/4] Firestore から第4世代 (generation: 4) のスタンプおよびルーン石を取得中...');
  const gen4Snapshot = await db.collection('items').where('generation', '==', 4).get();

  let stampDocs = [];
  let runeDocs = [];

  gen4Snapshot.forEach(doc => {
    const data = doc.data();
    if (data.type === 'stamp') stampDocs.push(data);
    if (data.type === 'rune') runeDocs.push(data);
  });

  console.log(`Firestoreから取得完了: スタンプ ${stampDocs.length} 件, ルーン石 ${runeDocs.length} 件`);

  // エミュレータ等で0件の場合のフォールバック
  if (stampDocs.length === 0 || runeDocs.length === 0) {
    console.warn('⚠️ 警告: Firestoreから第4世代のスタンプ/ルーン石が取得できませんでした。admin-tools/seed-items.json からフォールバック読み込みします。');
    const seedDataPath = join(__dirname, 'seed-items.json');
    if (existsSync(seedDataPath)) {
      const seedItems = JSON.parse(readFileSync(seedDataPath, 'utf8'));
      if (stampDocs.length === 0) {
        stampDocs = seedItems.filter(it => it.generation === 4 && it.type === 'stamp');
        console.log(`seed-items.json からスタンプ ${stampDocs.length} 件を読み込みました。`);
      }
      if (runeDocs.length === 0) {
        runeDocs = seedItems.filter(it => it.generation === 4 && it.type === 'rune');
        console.log(`seed-items.json からルーン石 ${runeDocs.length} 件を読み込みました。`);
      }
    }
  }

  stampDocs.sort((a, b) => (a.order || 0) - (b.order || 0));
  runeDocs.sort((a, b) => (a.order || 0) - (b.order || 0));

  if (stampDocs.length !== 28) {
    console.warn(`⚠️ 警告: スタンプの件数が28件ではありません (${stampDocs.length} 件)`);
  }
  if (runeDocs.length !== 24) {
    console.warn(`⚠️ 警告: ルーン石の件数が24件ではありません (${runeDocs.length} 件)`);
  }

  // 第4.5世代スタンプデータの構築
  const gen45Stamps = stampDocs.map(d => ({
    id: `4.5_${d.itemId}`,
    itemId: d.itemId,
    generation: 4.5,
    order: d.order,
    type: 'stamp',
    name: d.name,
    effect_text: d.effect_text,
    image_url: d.image_url || '',
    report_count: 0,
    reported_by: [],
    updated_at: FieldValue.serverTimestamp()
  }));

  // 第4.5世代ルーン石データの構築
  const gen45Runes = runeDocs.map(d => ({
    id: `4.5_${d.itemId}`,
    itemId: d.itemId,
    generation: 4.5,
    order: d.order,
    type: 'rune',
    name: d.name,
    effect_text: d.effect_text,
    image_url: d.image_url || '',
    report_count: 0,
    reported_by: [],
    updated_at: FieldValue.serverTimestamp()
  }));

  // 2. 第4.5世代のお守りモックデータ (326件) の生成
  console.log('\n[2/4] 第4.5世代 お守りモックデータ (全326件: order 1〜326) を生成中...');
  const gen45Amulets = [];
  for (let order = 1; order <= 326; order++) {
    const padded = String(order).padStart(3, '0');
    const itemId = `amulet_4.5_${padded}`;
    const id = `4.5_${itemId}`;
    const isOdd = order % 2 !== 0;

    const amulet = {
      id,
      itemId,
      generation: 4.5,
      order,
      type: 'amulet',
      amulet_kind: 'normal',
      name: `お守り #${order}`,
      effect_text: 'ゲーム内効果テキスト（確認中・検証をお待ちください）',
      image_url: '',
      upgrade_to: isOdd ? `amulet_4.5_${String(order + 1).padStart(3, '0')}` : '',
      upgrade_from: !isOdd ? `amulet_4.5_${String(order - 1).padStart(3, '0')}` : '',
      report_count: 0,
      reported_by: [],
      updated_at: FieldValue.serverTimestamp()
    };
    gen45Amulets.push(amulet);
  }

  const allGen45Items = [...gen45Amulets, ...gen45Stamps, ...gen45Runes];
  console.log(`生成合計: ${allGen45Items.length} 件 (お守り: ${gen45Amulets.length} 件, スタンプ: ${gen45Stamps.length} 件, ルーン石: ${gen45Runes.length} 件)`);

  // 3. 既存の第4.5世代ドキュメントの重複チェック
  console.log('\n[3/4] Firestore 上の既存 第4.5世代 (generation: 4.5) ドキュメントを確認中...');
  const existingSnapshot = await db.collection('items').where('generation', '==', 4.5).get();
  const existingDocIds = new Set();
  existingSnapshot.forEach(doc => existingDocIds.add(doc.id));

  console.log(`Firestore上に既存の第4.5世代ドキュメント: ${existingDocIds.size} 件検出`);

  let toInsert = [];
  let skipped = [];

  for (const item of allGen45Items) {
    if (existingDocIds.has(item.id) && !isForce) {
      skipped.push(item.id);
    } else {
      toInsert.push(item);
    }
  }

  console.log(`投入対象: ${toInsert.length} 件`);
  if (skipped.length > 0) {
    console.log(`スキップ対象: ${skipped.length} 件 (既に存在するため保護。強制上書きする場合は --force を指定してください)`);
  }

  // 4. 書き込み実行 (DRY-RUN or APPLY)
  console.log('\n[4/4] データ投入処理...');
  if (!isApply) {
    console.log('ℹ️ [DRY-RUN モード] 実際の Firestore 書き込みはスキップされました。');
    console.log('   投入を実行するには `--apply` フラグを付与して実行してください。');
    console.log(`   例: node admin-tools/seed-gen4.5.js --apply${targetProjectId ? ` --project=${targetProjectId}` : ''}`);
  } else {
    if (toInsert.length === 0) {
      console.log('投入対象ドキュメントが 0 件のため、Firestore への書き込みはスキップされました。');
    } else {
      console.log(`Firestore への書き込みを開始します (対象: ${toInsert.length} 件, 400件チャンク分割)...`);
      const BATCH_LIMIT = 400;
      let batch = db.batch();
      let opCount = 0;
      let totalCommitted = 0;

      for (const item of toInsert) {
        const docRef = db.collection('items').doc(item.id);
        batch.set(docRef, item, { merge: true });
        opCount++;

        if (opCount >= BATCH_LIMIT) {
          await batch.commit();
          totalCommitted += opCount;
          console.log(`バッチコミット完了 (${totalCommitted} / ${toInsert.length} 件)`);
          batch = db.batch();
          opCount = 0;
        }
      }

      if (opCount > 0) {
        await batch.commit();
        totalCommitted += opCount;
        console.log(`最終バッチコミット完了 (${totalCommitted} / ${toInsert.length} 件)`);
      }

      console.log(`✅ 第4.5世代初期データ (${totalCommitted} 件) の Firestore 投入が正常に完了しました！`);
    }
  }

  // 5. ローカル seed-items.json へのエクスポート (--export-local 指定時)
  if (isExportLocal) {
    console.log('\n[オプション] ローカル seed-items.json の第4.5世代データを更新中 (--export-local)...');
    const seedDataPath = join(__dirname, 'seed-items.json');
    if (existsSync(seedDataPath)) {
      const existingItems = JSON.parse(readFileSync(seedDataPath, 'utf8'));
      const withoutGen45 = existingItems.filter(it => it.generation !== 4.5);

      // JSON シリアライズ用に updated_at 等を除去したクリーンなオブジェクト
      const exportableGen45 = allGen45Items.map(item => {
        const cleanItem = {
          id: item.id,
          itemId: item.itemId,
          generation: item.generation,
          order: item.order,
          type: item.type,
          name: item.name,
          effect_text: item.effect_text,
          image_url: item.image_url,
          ...(item.amulet_kind ? { amulet_kind: item.amulet_kind } : {}),
          ...(item.upgrade_to ? { upgrade_to: item.upgrade_to } : {}),
          ...(item.upgrade_from ? { upgrade_from: item.upgrade_from } : {})
        };
        return cleanItem;
      });

      const updatedAll = [...withoutGen45, ...exportableGen45];
      writeFileSync(seedDataPath, JSON.stringify(updatedAll, null, 2) + '\n', 'utf8');
      console.log(`✅ seed-items.json に第4.5世代 ${exportableGen45.length} 件を保存しました (合計: ${updatedAll.length} 件)。`);
    } else {
      console.warn(`⚠️ ${seedDataPath} が見つかりませんでした。エクスポートをスキップしました。`);
    }
  }

  console.log('\n=== 処理完了 ===');
}

main().catch(error => {
  console.error('エラーが発生しました:', error);
  process.exit(1);
});
