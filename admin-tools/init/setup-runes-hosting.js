import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const runesSrcDir = join(__dirname, '../refs/runes');
const runesDestDir = join(__dirname, '../web/public/images/runes');
const seedJsonPath = join(__dirname, 'seed-items.json');

console.log('--- ルーンストーン Hosting 配信セットアップスクリプトを起動 ---');

// 1. コピー先ディレクトリの作成
if (!existsSync(runesDestDir)) {
  console.log(`作成中: コピー先ディレクトリ -> ${runesDestDir}`);
  mkdirSync(runesDestDir, { recursive: true });
}

// 2. refs/runes/ からコピー、または既にコピー先にあるか確認
let hasImages = false;
if (existsSync(runesSrcDir)) {
  const files = readdirSync(runesSrcDir).filter(f => f.match(/^rune_stone_\d+\.webp$/i));
  console.log(`コピー元 (${runesSrcDir}) から ${files.length} 件のルーン画像を検出しました。`);

  for (const file of files) {
    const srcFile = join(runesSrcDir, file);
    const destFile = join(runesDestDir, file);
    copyFileSync(srcFile, destFile);
  }
  console.log(`✅ すべての画像を ${runesDestDir} へコピー完了しました。`);
  hasImages = files.length > 0;
} else {
  // 既にコピー先に入っているかチェック
  const existingFiles = readdirSync(runesDestDir).filter(f => f.match(/^rune_stone_\d+\.webp$/i));
  if (existingFiles.length > 0) {
    console.log(`ℹ️ コピー元は見つかりませんでしたが、既に ${runesDestDir} 内に ${existingFiles.length} 件のルーン画像が存在します。こちらを使用します。`);
    hasImages = true;
  } else {
    console.error(`❌ エラー: ルーン画像がコピー元 (${runesSrcDir}) にもコピー先 (${runesDestDir}) にも見つかりません。`);
    process.exit(1);
  }
}

// 3. seed-items.json のルーン画像パスの一括更新
if (existsSync(seedJsonPath)) {
  console.log(`読み込み中: ${seedJsonPath}`);
  const seedData = JSON.parse(readFileSync(seedJsonPath, 'utf8'));

  let updateCount = 0;
  for (const item of seedData) {
    if (item.type === 'rune') {
      const paddedOrder = String(item.order).padStart(2, '0');
      const expectedFileName = `rune_stone_${paddedOrder}.webp`;
      
      // 対応するファイルの存在確認
      if (existsSync(join(runesDestDir, expectedFileName))) {
        item.image_url = `/images/runes/${expectedFileName}`;
        updateCount++;
      } else {
        console.warn(`⚠️ 警告: 対応する画像アセットが存在しません: ${expectedFileName} (Item: ${item.name})`);
      }
    }
  }

  writeFileSync(seedJsonPath, JSON.stringify(seedData, null, 2), 'utf8');
  console.log(`✅ seed-items.json内 ${updateCount} 件のルーン画像参照パスを /images/runes/ に更新完了しました！`);
} else {
  console.error(`❌ エラー: seed-items.json が見つかりません。 ${seedJsonPath}`);
  process.exit(1);
}

console.log('\n🎉 セットアップが完了しました！');
console.log('ローカルでの確認方法:');
console.log('  1. "node admin-tools/setup-runes-hosting.js" を実行 (完了済み)');
console.log('  2. ローカルエミュレータ起動状態で "node admin-tools/seed.js" を実行して Firestore を更新');
console.log('  3. アプリを起動して正常に表示されるか確認してください。');
