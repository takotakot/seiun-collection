import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

export interface Item {
  id: string;
  itemId: string;
  generation: number;
  order: number;
  type: 'amulet' | 'stamp' | 'rune';
  amulet_kind?: 'normal' | 'rare' | 'super_rare' | 'ultra_rare' | 'ghost';
  name: string;
  effect_text: string;
  image_url: string;
  upgrade_from?: string;
  upgrade_to?: string;
  relates_from?: string;
  relates_to?: string;
  recipe_sources?: string[];
  recipe_target?: string;
  report_count?: number;
  reported_by?: string[];
  uploaded_at?: any;
  updated_at?: any;
}

export interface BuildItemsResult {
  items: Item[];
  buildTimestamp: number;
  isFromDb: boolean;
}

/**
 * Astro ビルド時 (SSG) に Firestore からマスターデータを取得する
 */
export async function getBuildItemsData(): Promise<BuildItemsResult> {
  const fetchDbOnBuild = process.env.FETCH_DB_ON_BUILD;
  if (fetchDbOnBuild === 'false') {
    console.log('ℹ️ [Build] FETCH_DB_ON_BUILD=false のため、ビルド時のDBフェッチをスキップします。');
    return getFallbackData();
  }

  const projectId = process.env.PUBLIC_FIREBASE_PROJECT_ID || 'seiun-collection-prd';

  try {
    console.log(`📡 [Build] 本番 Firestore (${projectId}) からマスターデータを取得中...`);

    const app = getApps().length === 0
      ? initializeApp({ projectId })
      : getApps()[0];

    const db = getFirestore(app);
    const snapshot = await db.collection('items').where('generation', '==', 4).get();

    if (snapshot.empty) {
      console.warn('⚠️ [Build] Firestore の items コレクションに第4世代データが存在しません。フォールバックします。');
      return getFallbackData();
    }

    const items: Item[] = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      // Firestore Timestamp 型などをプレーンなオブジェクト/数値に変換（JSONシリアライズ対応）
      const item: Item = {
        id: doc.id,
        itemId: data.itemId || '',
        generation: data.generation ?? 4,
        order: data.order ?? 0,
        type: data.type || 'amulet',
        amulet_kind: data.amulet_kind,
        name: data.name || '',
        effect_text: data.effect_text || '',
        image_url: data.image_url || '',
        upgrade_from: data.upgrade_from || '',
        upgrade_to: data.upgrade_to || '',
        relates_from: data.relates_from || '',
        relates_to: data.relates_to || '',
        recipe_sources: data.recipe_sources || [],
        recipe_target: data.recipe_target || '',
        report_count: data.report_count || 0,
        reported_by: data.reported_by || [],
        uploaded_at: data.uploaded_at?.toMillis ? data.uploaded_at.toMillis() : null,
        updated_at: data.updated_at?.toMillis ? data.updated_at.toMillis() : (data.uploaded_at?.toMillis ? data.uploaded_at.toMillis() : null)
      };
      items.push(item);
    });

    items.sort((a, b) => a.order - b.order);

    const buildTimestamp = Date.now();
    console.log(`✅ [Build] Firestore から ${items.length} 件のアイテムデータを取得し、HTML に埋め込みました (BuildTimestamp: ${buildTimestamp})。`);

    return {
      items,
      buildTimestamp,
      isFromDb: true
    };
  } catch (error) {
    console.warn('⚠️ [Build] Firestore からのデータ取得に失敗しました。フォールバックデータを使用します:', error);
    return getFallbackData();
  }
}

/**
 * DB接続不可時やオフラインビルド時のフォールバック処理
 */
function getFallbackData(): BuildItemsResult {
  // admin-tools/seed-items.json があればそれを試みる
  const possibleSeedPaths = [
    resolve(process.cwd(), '../admin-tools/seed-items.json'),
    resolve(process.cwd(), 'admin-tools/seed-items.json')
  ];

  for (const seedPath of possibleSeedPaths) {
    if (existsSync(seedPath)) {
      try {
        const raw = readFileSync(seedPath, 'utf8');
        const seedItems = JSON.parse(raw) as Item[];
        const gen4Items = seedItems.filter(it => it.generation === 4).sort((a, b) => a.order - b.order);
        console.log(`📁 [Build] シードファイル (${seedPath}) から ${gen4Items.length} 件のアイテムを読み込みました。`);
        return {
          items: gen4Items,
          buildTimestamp: 0, // 0にすることでクライアント側が差分ではなく最新取得をトリガー可能
          isFromDb: false
        };
      } catch (e) {
        console.warn('⚠️ [Build] シードファイルのパースに失敗しました:', e);
      }
    }
  }

  return {
    items: [],
    buildTimestamp: 0,
    isFromDb: false
  };
}
