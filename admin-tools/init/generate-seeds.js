import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const seedJsonPath = join(__dirname, 'seed-items.json');

/**
 * 第4世代お守りの order 番号から種類 (amulet_kind) を特定するヘルパー関数
 */
function getAmuletKindByOrder(order) {
  if (order >= 1 && order <= 112) return 'normal';
  if (order >= 113 && order <= 218) return 'rare';
  if (order >= 219 && order <= 322) return 'super_rare';
  if (order >= 323 && order <= 348) return 'ultra_rare';
  if (order >= 349 && order <= 362) return 'ghost';
  throw new Error(`無効なお守り order です: ${order}`);
}

try {
  // 既存のシードを取得
  const existingItems = JSON.parse(readFileSync(seedJsonPath, 'utf8'));
  console.log(`既存のシードから ${existingItems.length} 件のアイテムが読み込まれました。`);

  const initializedItems = [];

  // 1. お守り (1 to 362)
  for (let order = 1; order <= 362; order++) {
    // 既存にお守りタイプでこの順番に合致するものがあるか確認
    const existing = existingItems.filter(item => item.type === 'amulet' && item.order === order);
    const kind = getAmuletKindByOrder(order);
    
    if (existing.length > 0) {
      // 存在する場合はそれらをそのままマージ追加し、amulet_kind を正規化設定
      for (const item of existing) {
        initializedItems.push({
          ...item,
          amulet_kind: kind
        });
      }
    } else {
      // 存在しない場合はスケルトン（プレースホルダー）を差し込む
      initializedItems.push({
        id: `4_amulet_${String(order).padStart(3, '0')}`,
        itemId: `amulet_${String(order).padStart(3, '0')}`,
        generation: 4,
        order: order,
        type: 'amulet',
        amulet_kind: kind,
        name: `お守り #${order}`,
        effect_text: "ゲーム内効果テキスト（確認中・検証をお待ちください）",
        image_url: "" // 未アタッチ：プール、またはアップロードから選択されます
      });
    }
  }

  // 2. スタンプ (1 to 28) - 3桁ゼロ埋め形式に統一
  for (let order = 1; order <= 28; order++) {
    const existing = existingItems.filter(item => item.type === 'stamp' && item.order === order);
    
    if (existing.length > 0) {
      initializedItems.push(...existing);
    } else {
      initializedItems.push({
        id: `4_stamp_${String(order).padStart(3, '0')}`,
        itemId: `stamp_${String(order).padStart(3, '0')}`,
        generation: 4,
        order: order,
        type: 'stamp',
        name: `スタンプ #${order}`,
        effect_text: "ゲーム内スタンプ効果テキスト（確認中・検証をお待ちください）",
        image_url: ""
      });
    }
  }

  // 3. ルーン (1 to 24) - 3桁ゼロ埋め形式に統一
  for (let order = 1; order <= 24; order++) {
    const existing = existingItems.filter(item => item.type === 'rune' && item.order === order);
    
    if (existing.length > 0) {
      initializedItems.push(...existing);
    } else {
      initializedItems.push({
        id: `4_rune_${String(order).padStart(3, '0')}`,
        itemId: `rune_${String(order).padStart(3, '0')}`,
        generation: 4,
        order: order,
        type: 'rune',
        name: `ルーン石 #${order}`,
        effect_text: "ゲーム内ルーン石効果・説明テキスト（確認中・検証をお待ちください）",
        image_url: ""
      });
    }
  }

  // --- 厳格な整合性検証 ---
  const gen4Amulets = initializedItems.filter(i => i.generation === 4 && i.type === 'amulet');
  if (gen4Amulets.length !== 362) {
    throw new Error(`第4世代お守り件数異常: 期待 362, 実際 ${gen4Amulets.length}`);
  }

  const kindCounts = { normal: 0, rare: 0, super_rare: 0, ultra_rare: 0, ghost: 0 };
  const ordersSet = new Set();

  for (const item of gen4Amulets) {
    if (!item.order || typeof item.order !== 'number' || item.order < 1 || item.order > 362) {
      throw new Error(`不正な order 値です: ${item.id} (order: ${item.order})`);
    }
    if (ordersSet.has(item.order)) {
      throw new Error(`重複した order が検出されました: ${item.order}`);
    }
    ordersSet.add(item.order);

    if (!kindCounts.hasOwnProperty(item.amulet_kind)) {
      throw new Error(`不正な amulet_kind です: ${item.id} (kind: ${item.amulet_kind})`);
    }
    kindCounts[item.amulet_kind]++;
  }

  const expectedCounts = { normal: 112, rare: 106, super_rare: 104, ultra_rare: 26, ghost: 14 };
  for (const [k, expected] of Object.entries(expectedCounts)) {
    if (kindCounts[k] !== expected) {
      throw new Error(`種類 [${k}] の件数不一致: 期待 ${expected}, 実際 ${kindCounts[k]}`);
    }
  }

  console.log('✓ 検証成功: 第4世代お守り 362件の order 範囲および amulet_kind 分類が正常です。');
  console.log(`  内訳: normal=${kindCounts.normal}, rare=${kindCounts.rare}, super_rare=${kindCounts.super_rare}, ultra_rare=${kindCounts.ultra_rare}, ghost=${kindCounts.ghost}`);

  // 新しいシードデータを seed-items.json に書き出し
  writeFileSync(seedJsonPath, JSON.stringify(initializedItems, null, 2), 'utf8');
  console.log(`初期化完了: 合計 ${initializedItems.length} 件のお守り、スタンプ、ルーンをシードファイルに統合書き出ししました！`);

} catch (err) {
  console.error("シード自動初期化エラー:", err);
  process.exit(1);
}
