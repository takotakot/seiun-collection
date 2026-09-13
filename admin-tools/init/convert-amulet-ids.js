import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const seedJsonPath = join(__dirname, 'seed-items.json');

try {
  const items = JSON.parse(readFileSync(seedJsonPath, 'utf8'));
  console.log(`シードファイルから ${items.length} 件のアイテムを読み込みました。`);

  // 1. マップ作成： 旧 itemId -> 新 itemId、 旧 id -> 新 id
  const itemIdMap = new Map();
  const idMap = new Map();

  items.forEach(item => {
    if (item.generation === 4) {
      const paddedOrder = String(item.order).padStart(3, '0');
      let newId, newItemId;

      if (item.type === 'amulet') {
        newId = `4_amulet_${paddedOrder}`;
        newItemId = `amulet_${paddedOrder}`;
      } else if (item.type === 'stamp') {
        newId = `4_stamp_${paddedOrder}`;
        newItemId = `stamp_${paddedOrder}`;
      } else if (item.type === 'rune') {
        newId = `4_rune_${paddedOrder}`;
        newItemId = `rune_${paddedOrder}`;
      }

      if (newId && newItemId) {
        itemIdMap.set(item.itemId, newItemId);
        idMap.set(item.id, newId);
      }
    }
  });

  console.log(`変換マップを用意しました。対象お守り数: ${itemIdMap.size} 件`);

  // 2. 変換処理
  let convertedCount = 0;
  const updatedItems = items.map(item => {
    if (item.generation === 4) {
      const paddedOrder = String(item.order).padStart(3, '0');
      let newId, newItemId;

      if (item.type === 'amulet') {
        newId = `4_amulet_${paddedOrder}`;
        newItemId = `amulet_${paddedOrder}`;
      } else if (item.type === 'stamp') {
        newId = `4_stamp_${paddedOrder}`;
        newItemId = `stamp_${paddedOrder}`;
      } else if (item.type === 'rune') {
        newId = `4_rune_${paddedOrder}`;
        newItemId = `rune_${paddedOrder}`;
      }

      if (newId && newItemId) {
        const oldId = item.id;
        const oldItemId = item.itemId;

        item.id = newId;
        item.itemId = newItemId;

        if (oldId !== newId) {
          console.log(`[変換] ${oldId} -> ${item.id} (${item.name})`);
          convertedCount++;
        }
      }
    }

    // 強化先・強化元のリレーションIDの置換
    if (item.upgrade_to && itemIdMap.has(item.upgrade_to)) {
      const oldTo = item.upgrade_to;
      item.upgrade_to = itemIdMap.get(item.upgrade_to);
      console.log(`  - ${item.id} の upgrade_to を置換: ${oldTo} -> ${item.upgrade_to}`);
    }
    if (item.upgrade_from && itemIdMap.has(item.upgrade_from)) {
      const oldFrom = item.upgrade_from;
      item.upgrade_from = itemIdMap.get(item.upgrade_from);
      console.log(`  - ${item.id} の upgrade_from を置換: ${oldFrom} -> ${item.upgrade_from}`);
    }

    return item;
  });

  // 書き出し
  writeFileSync(seedJsonPath, JSON.stringify(updatedItems, null, 2), 'utf8');
  console.log(`✓ seed-items.json の一括ID変換が完了しました。(${convertedCount} 件)`);

} catch (err) {
  console.error("ID変換処理中にエラーが発生しました:", err);
}
