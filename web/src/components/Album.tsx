import React, { useState, useEffect } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  type User
} from 'firebase/auth';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  runTransaction,
  serverTimestamp,
  Timestamp,
  increment,
  arrayUnion
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, getMetadata } from 'firebase/storage';
import { db, auth, storage } from '../lib/firebase';
import plusIcon from '../assets/plus.webp';

interface Item {
  id: string;
  itemId: string;
  generation: number;
  order: number;
  type: 'amulet' | 'stamp' | 'rune';
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
}

interface ImagePoolItem {
  id: string;
  fileName: string;
  url: string;
  is_linked: boolean;
  target_item_id: string | null;
}

interface UserCollection {
  is_owned: boolean;
  updated_at: any;
}

interface SharedComment {
  content: string;
  updated_at: any;
  updated_by: string;
  updated_by_name: string;
  version: number;
}

export default function Album() {
  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [ownedItemsMap, setOwnedItemsMap] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<'amulet' | 'stamp' | 'rune'>('amulet');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [activeComment, setActiveComment] = useState<SharedComment | null>(null);
  const [commentText, setCommentText] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [lastActiveAtCache, setLastActiveAtAtCache] = useState<number | null>(null);
  const [colsMode, setColsMode] = useState<'responsive' | 'fixed6'>('fixed6');

  // 画像プール管理用の状態
  const [imagePool, setImagePool] = useState<ImagePoolItem[]>([]);
  const [showPoolSelector, setShowPoolSelector] = useState(false);
  const [showAllPoolImages, setShowAllPoolImages] = useState(false);
  const [uploadStage, setUploadStage] = useState<'idle' | 'compressing' | 'uploading' | 'saving' | 'success' | 'error'>('idle');
  const [updateRelatedImages, setUpdateRelatedImages] = useState(true);

  // 詳細情報編集用の状態
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEffectText, setEditEffectText] = useState('');
  const [editUpgradeFrom, setEditUpgradeFrom] = useState('');
  const [editUpgradeTo, setEditUpgradeTo] = useState('');
  const [editRelatesFrom, setEditRelatesFrom] = useState('');
  const [editRelatesTo, setEditRelatesTo] = useState('');
  const [detailSaveStatus, setDetailSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [detailErrorMessage, setDetailErrorMessage] = useState('');

  // 詳細情報の保存処理
  const handleSaveDetails = async () => {
    if (!user) {
      setDetailErrorMessage('情報の編集にはログインが必要です。');
      return;
    }
    if (!activeSelectedItem) return;
    if (!editName.trim()) {
      setDetailErrorMessage('名前を入力してください。');
      return;
    }

    setDetailSaveStatus('saving');
    setDetailErrorMessage('');

    try {
      const itemRef = doc(db, 'items', activeSelectedItem.id);
      const updateData: any = {
        name: editName.trim(),
        effect_text: editEffectText.trim(),
        upgrade_from: editUpgradeFrom || '',
        upgrade_to: editUpgradeTo || '',
        relates_from: editRelatesFrom || '',
        relates_to: editRelatesTo || ''
      };

      await updateDoc(itemRef, updateData);
      setDetailSaveStatus('success');
      setTimeout(() => {
        setDetailSaveStatus('idle');
        setIsEditingDetails(false);
      }, 1000);
    } catch (err: any) {
      console.error('詳細情報の保存失敗:', err);
      setDetailSaveStatus('error');
      setDetailErrorMessage('情報の保存中にエラーが発生しました。時間を置いて再度お試しください。');
    }
  };

  // 1. Google 認証
  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error('ログイン失敗:', err);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setOwnedItemsMap({});
      setLastActiveAtAtCache(null);
    } catch (err) {
      console.error('ログアウト失敗:', err);
    }
  };

  // 2. マスターデータ及び画像プールデータの取得
  // 第4世代のみを主軸として扱う（概要.mdに準拠）
  useEffect(() => {
    // itemsコレクションのリアルタイム購読にして、通報や画像変更が即時反映されるようにする
    const unsubscribeItems = onSnapshot(collection(db, 'items'), (snapshot) => {
      const loadedItems: Item[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data() as Item;
        if (data.generation === 4) {
          loadedItems.push(data);
        }
      });
      loadedItems.sort((a, b) => a.order - b.order);
      setItems(loadedItems);
      setIsDataLoaded(true);
    }, (err) => {
      console.error('マスターデータリアルタイム購読エラー:', err);
    });

    // image_poolコレクションのリアルタイム購読
    const unsubscribePool = onSnapshot(collection(db, 'image_pool'), (snapshot) => {
      const loadedPool: ImagePoolItem[] = [];
      snapshot.forEach((doc) => {
        loadedPool.push(doc.data() as ImagePoolItem);
      });
      setImagePool(loadedPool);
    }, (err) => {
      console.error('画像プール購読エラー:', err);
    });

    return () => {
      unsubscribeItems();
      unsubscribePool();
    };
  }, []);

  // 3. ユーザー所持状況のリアルタイム監視
  useEffect(() => {
    if (!user) {
      setOwnedItemsMap({});
      return;
    }

    // ユーザー基本情報から最終活動日時を一度取得してキャッシュする
    const fetchUserMeta = async () => {
      try {
        const userDocRef = doc(db, 'users', user.uid);
        const snap = await getDoc(userDocRef);
        if (snap.exists()) {
          const val = snap.data();
          if (val.last_active_at) {
            const timestamp = val.last_active_at as Timestamp;
            setLastActiveAtAtCache(timestamp.toMillis());
          }
        } else {
          // ドキュメントが存在しない場合は新規作成
          await setDoc(userDocRef, {
            userId: user.uid,
            last_active_at: serverTimestamp()
          });
          setLastActiveAtAtCache(Date.now());
        }
      } catch (e) {
        console.error('ユーザー情報のメタデータ取得エラー:', e);
      }
    };
    fetchUserMeta();

    // 所持状況サブコレクションの監視
    const collectionsRef = collection(db, 'users', user.uid, 'collections');
    const unsubscribe = onSnapshot(collectionsRef, (snapshot) => {
      const ownedMap: Record<string, boolean> = {};
      snapshot.forEach((doc) => {
        const data = doc.data();
        ownedMap[doc.id] = !!data.is_owned;
      });
      setOwnedItemsMap(ownedMap);
    }, (error) => {
      console.error('所持データ変更監視エラー:', error);
    });

    return () => unsubscribe();
  }, [user]);

  // ログイン状態変更の監視
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // 4. `last_active_at` の書き込み最適化と所持状況のトグル
  const toggleOwnership = async (item: Item) => {
    if (!user) {
      alert('進捗状況の管理にはログインが必要です。');
      return;
    }

    const itemFullId = `${item.generation}_${item.itemId}`;
    const currentlyOwned = !!ownedItemsMap[itemFullId];
    const newOwnedState = !currentlyOwned;

    try {
      const userDocRef = doc(db, 'users', user.uid);
      const collectionItemRef = doc(db, 'users', user.uid, 'collections', itemFullId);

      const now = Date.now();
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 168時間

      // 差分判定: キャッシュした前回アクティブ日時から7日以上経過している場合、またはキャッシュ未設定時のみ更新
      const shouldUpdateLastActive = !lastActiveAtCache || (now - lastActiveAtCache > SEVEN_DAYS_MS);

      if (shouldUpdateLastActive) {
        console.log('最終活動日時を更新します (7日以上経過、または初アクセス)。');
        // users ドキュメントとサブコレクションをそれぞれ書き込む
        await setDoc(userDocRef, {
          userId: user.uid,
          last_active_at: serverTimestamp()
        }, { merge: true });

        setLastActiveAtAtCache(now);
      }

      await setDoc(collectionItemRef, {
        is_owned: newOwnedState,
        updated_at: serverTimestamp()
      });

    } catch (err) {
      console.error('所持情報の更新に失敗しました:', err);
    }
  };

  // 5. 選択したアイテムの共有攻略メモのリアルタイム監視
  useEffect(() => {
    if (!selectedItemId) {
      setActiveComment(null);
      setCommentText('');
      return;
    }

    const commentDocRef = doc(db, 'comments', selectedItemId);
    const unsubscribe = onSnapshot(commentDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data() as SharedComment;
        setActiveComment(data);
        setCommentText(data.content || '');
      } else {
        setActiveComment({
          content: '',
          updated_at: null,
          updated_by: '',
          updated_by_name: '',
          version: 0
        });
        setCommentText('');
      }
    }, (error) => {
      console.error('共有コメント監視エラー:', error);
    });

    return () => unsubscribe();
  }, [selectedItemId]);

  // 6. 楽観的排他ロックを考慮したトランザクションによるWikiメモ更新
  const handleSaveComment = async () => {
    if (!user) {
      alert('攻略メモの編集にはログインが必要です。');
      return;
    }
    if (!selectedItemId) return;

    setSaveStatus('saving');
    setErrorMessage('');

    const commentDocRef = doc(db, 'comments', selectedItemId);

    try {
      await runTransaction(db, async (transaction) => {
        const commentSnap = await transaction.get(commentDocRef);

        let currentVersion = 0;

        if (commentSnap.exists()) {
          const currentComment = commentSnap.data() as SharedComment;
          currentVersion = currentComment.version || 0;
        }

        const clientVersion = activeComment ? activeComment.version : 0;

        // クライアントで保持していたバージョンと現在のバージョンが一致しているか確認
        if (clientVersion !== currentVersion) {
          throw new Error('VERSION_CONFLICT');
        }

        // 新しいデータをセット（セキュリティーポリシーに準拠するため、updated_by_nameは保存せず、更新者UIDのみ保存する）
        transaction.set(commentDocRef, {
          content: commentText.trim(),
          updated_at: serverTimestamp(),
          updated_by: user.uid,
          version: currentVersion + 1
        });
      });

      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err: any) {
      console.error('コメント更新トランザクション失敗:', err);
      setSaveStatus('error');
      if (err.message === 'VERSION_CONFLICT') {
        setErrorMessage('他のユーザーによってメモが同時に編集されました。再度取得された最新データを確認して、やり直してください。');
      } else {
        setErrorMessage('共有メモの保存中に不明なエラーが発生しました。時間を置いて再度お試しください。');
      }
    }
  };

  // 7. 進捗率の計算
  const filteredItems = items.filter(item => item.type === activeTab);
  const totalInTab = filteredItems.length;
  const ownedInTab = filteredItems.filter(item => !!ownedItemsMap[`${item.generation}_${item.itemId}`]).length;
  const percentageInTab = totalInTab > 0 ? Math.round((ownedInTab / totalInTab) * 100) : 0;

  const totalAll = items.length;
  const ownedAll = items.filter(item => !!ownedItemsMap[`${item.generation}_${item.itemId}`]).length;
  const percentageAll = totalAll > 0 ? Math.round((ownedAll / totalAll) * 100) : 0;

  // 強化リレーションに基づくアイテムの解決
  const findItemByItemId = (itId: string) => {
    return items.find(it => it.itemId === itId);
  };

  // お守りの強化リレーション（動的フォールバック・4->1や特殊進化の考慮）の解決
  const getUpgradeRelations = (item: Item) => {
    if (item.type !== 'amulet') return { fromItem: null, toItem: null, fromId: undefined, toId: undefined };

    // 1. DBの定義を優先
    let fromItemId = item.upgrade_from;
    let toItemId = item.upgrade_to;

    // 2. DBに定義されていない場合、デフォルトの奇数・偶数のペアでフォールバック
    if (!fromItemId && !toItemId && !item.relates_from && !item.relates_to) {
      if (item.order % 2 === 0) {
        const prevItem = items.find(it => it.type === 'amulet' && it.order === item.order - 1);
        if (prevItem) {
          fromItemId = prevItem.itemId;
        }
      } else {
        const nextItem = items.find(it => it.type === 'amulet' && it.order === item.order + 1);
        if (nextItem) {
          toItemId = nextItem.itemId;
        }
      }
    }

    const fromItem = fromItemId ? findItemByItemId(fromItemId) : null;
    const toItem = toItemId ? findItemByItemId(toItemId) : null;

    return { fromItem, toItem, fromId: fromItemId, toId: toItemId };
  };

  // 強化リレーションチェーンを辿って、接続されたすべてのアイテムを収集する
  const getUpgradeChainItems = (startItem: Item): Item[] => {
    const visited = new Set<string>();
    const chain: Item[] = [];

    const traverse = (item: Item) => {
      if (visited.has(item.itemId)) return;
      visited.add(item.itemId);
      chain.push(item);

      const { fromItem, toItem } = getUpgradeRelations(item);
      if (fromItem) traverse(fromItem);
      if (toItem) traverse(toItem);
    };

    traverse(startItem);
    // 自分自身を除外して返す
    return chain.filter(it => it.itemId !== startItem.itemId);
  };

  // 特殊な関連（relates_from / relates_to）の解決
  const getSpecialRelations = (item: Item) => {
    const fromId = item.relates_from;
    const toId = item.relates_to;
    const fromItem = fromId ? findItemByItemId(fromId) : null;
    const toItem = toId ? findItemByItemId(toId) : null;
    return { fromItem, toItem, fromId, toId };
  };

  // 4合体進化（レシピ）の解決
  const getRecipeRelations = (item: Item) => {
    // 自身が進化後の場合 (recipe_sources を持っている)
    const sources = item.recipe_sources ? item.recipe_sources.map(id => ({
      itemId: id,
      item: findItemByItemId(id)
    })) : [];

    // 自身が合体素材の場合 (recipe_target を持っている)
    const targetId = item.recipe_target;
    const targetItem = targetId ? findItemByItemId(targetId) : null;

    // 逆引き: 相手がrecipe_sourcesを持っているのに自分がrecipe_targetに指定されていない場合、自動ターゲット解決
    let autoTargetItem = targetItem;
    let autoTargetId = targetId;
    if (!autoTargetItem) {
      const match = items.find(it => it.recipe_sources && it.recipe_sources.includes(item.itemId));
      if (match) {
        autoTargetItem = match;
        autoTargetId = match.itemId;
      }
    }

    // 逆引き: 自身が進化後の場合に、素材側が自分をtargetに指定しているお守りを自動収集
    let autoSources = [...sources];
    if (autoSources.length === 0) {
      const matches = items.filter(it => it.recipe_target === item.itemId);
      if (matches.length > 0) {
        autoSources = matches.map(it => ({
          itemId: it.itemId,
          item: it
        }));
      }
    }

    return { 
      sources: autoSources, 
      targetItem: autoTargetItem, 
      targetId: autoTargetId 
    };
  };

  // 画像プールの特定画像をアイテムに紐付ける処理
  const handleAttachImage = async (poolItem: ImagePoolItem) => {
    if (!user) {
      alert('画像の紐付けにはログインが必要です。');
      return;
    }
    if (!selectedItemId) return;

    const currentItem = items.find(it => it.itemId === selectedItemId);
    if (!currentItem) return;

    try {
      // 強化リレーション先も更新する場合、対象アイテムを収集
      const relatedItems = updateRelatedImages ? getUpgradeChainItems(currentItem) : [];

      await runTransaction(db, async (transaction) => {
        const itemRef = doc(db, 'items', currentItem.id);
        const poolItemRef = doc(db, 'image_pool', poolItem.id);

        // トランザクション内でアイテムの画像、アップロードメタ情報を同期
        transaction.update(itemRef, {
          image_url: poolItem.url,
          uploaded_by: user.uid,
          uploaded_at: serverTimestamp()
        });

        // プール側の状態も「紐付け済み、指定アイテムID」に同期
        transaction.update(poolItemRef, {
          is_linked: true,
          target_item_id: currentItem.id
        });

        // 強化リレーション先のアイテムも同じ画像に更新
        for (const related of relatedItems) {
          const relatedRef = doc(db, 'items', related.id);
          transaction.update(relatedRef, {
            image_url: poolItem.url,
            uploaded_by: user.uid,
            uploaded_at: serverTimestamp()
          });
        }
      });

      const relatedMsg = relatedItems.length > 0
        ? `\n（強化リレーション先 ${relatedItems.length}件 も同時更新しました）`
        : '';
      alert(`プールの画像をお守りにアタッチしました！${relatedMsg}`);
      setShowPoolSelector(false);
    } catch (err) {
      console.error('画像アタッチエラー:', err);
      alert('画像の紐付けに失敗しました。');
    }
  };

  // 画像を新規アップロードし、自動トランスパイル・圧縮した上でバケット＆プール・アイテムに直接アタッチ
  const handleUploadAndAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!user) {
      alert('アップロードにはログインが必要です。');
      return;
    }
    if (!selectedItemId) return;

    const currentItem = items.find(it => it.itemId === selectedItemId);
    if (!currentItem) return;

    const file = e.target.files?.[0];
    if (!file) return;

    // クライアント側サイズ検証: 2MB以下
    if (file.size > 2 * 1024 * 1024) {
      alert('ファイルサイズが2MBを超えています。より軽量な画像を選択してください。');
      return;
    }

    setUploadStage('compressing');

    try {
      let compressedBlob: Blob;

      // すでにWebP形式であり、かつ150KB以下であれば、再圧縮をスキップしてそのままアップロード
      const isWebP = file.type === 'image/webp' || file.name.toLowerCase().endsWith('.webp');
      const SKIP_COMPRESS_SIZE_LIMIT = 150 * 1024; // 150KB

      if (isWebP && file.size <= SKIP_COMPRESS_SIZE_LIMIT) {
        compressedBlob = file;
      } else {
        // Browser Canvas を使ったクライアント側での画像自動リサイズ & WebP超トランスパイル (50KB前後)
        compressedBlob = await new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);
          img.src = objectUrl;
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            const canvas = document.createElement('canvas');
            const maxDim = 480; // お守り表示用に最大横幅・縦幅を480pxに制限
            let w = img.width;
            let h = img.height;

            if (w > maxDim || h > maxDim) {
              if (w > h) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
              } else {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
              }
            }

            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('Canvas context failed'));
              return;
            }

            ctx.drawImage(img, 0, 0, w, h);
            // 高圧縮率 0.82 の WebP に変換して超軽量化
            canvas.toBlob((blob) => {
              if (blob) resolve(blob);
              else reject(new Error('WebP Blob への変換に失敗しました。'));
            }, 'image/webp', 0.82);
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('画像の読み込みに失敗しました。ファイル形式または画像データをご確認ください。'));
          };
        });
      }

      setUploadStage('uploading');

      // 元ファイル名を尊重した Storage パスを生成（重複時のみ UUID サフィックス付与）
      const rawName = file.name.replace(/\.[^.]+$/, ''); // 拡張子を除去
      const sanitizedBase = rawName
        .replace(/[/\\#?%&=+<>{}|^~\[\]`]/g, '_') // Storage 非推奨文字を置換
        .replace(/\s+/g, '_')  // スペースをアンダースコアに
        .replace(/_+/g, '_')   // 連続アンダースコアを統合
        .replace(/^_|_$/g, '') // 先頭・末尾のアンダースコア除去
        || 'image';            // 空文字フォールバック

      // 同名ファイルの存在チェック（getMetadata が成功すれば既存）
      let finalName = `${sanitizedBase}.webp`;
      const candidateRef = ref(storage, `item-images/${finalName}`);
      try {
        await getMetadata(candidateRef);
        // 既存ファイルあり → 短い UUID サフィックスを付与して衝突回避
        const shortId = crypto.randomUUID().slice(0, 8);
        finalName = `${sanitizedBase}_${shortId}.webp`;
      } catch {
        // storage/object-not-found → 名前が使えるのでそのまま
      }

      const storagePath = `item-images/${finalName}`;
      const fileRef = ref(storage, storagePath);

      // Storage バケットへトランスパイルデータを転送
      await uploadBytes(fileRef, compressedBlob, {
        contentType: 'image/webp'
      });

      // ダウンロードリンクをフェッチ
      const downloadUrl = await getDownloadURL(fileRef);

      // image_pool ドキュメント ID 用の一意キー（拡張子なし）
      const docId = finalName.replace(/\.webp$/, '');

      setUploadStage('saving');

      // 強化リレーション先も更新する場合、対象アイテムを収集
      const relatedItems = updateRelatedImages ? getUpgradeChainItems(currentItem) : [];

      // Firestoreを一括アトミック更新
      await runTransaction(db, async (transaction) => {
        const itemRef = doc(db, 'items', currentItem.id);
        const poolItemRef = doc(db, 'image_pool', docId);

        // items の画像指定
        transaction.update(itemRef, {
          image_url: downloadUrl,
          uploaded_by: user.uid,
          uploaded_at: serverTimestamp()
        });

        // image_pool に画像情報をプール登録 (is_linked=true, 指定アイテム紐付け)
        transaction.set(poolItemRef, {
          id: docId,
          fileName: finalName,
          url: downloadUrl,
          is_linked: true,
          target_item_id: currentItem.id
        });

        // 強化リレーション先のアイテムも同じ画像に更新
        for (const related of relatedItems) {
          const relatedRef = doc(db, 'items', related.id);
          transaction.update(relatedRef, {
            image_url: downloadUrl,
            uploaded_by: user.uid,
            uploaded_at: serverTimestamp()
          });
        }
      });

      setUploadStage('success');
      const relatedMsg = relatedItems.length > 0
        ? `\n（強化リレーション先 ${relatedItems.length}件 も同時更新しました）`
        : '';
      alert(`画像をアップロードし、お守りへのアタッチが成功しました！${relatedMsg}`);
      setShowPoolSelector(false);
      setTimeout(() => setUploadStage('idle'), 3000);
    } catch (err: any) {
      console.error('アップロード・紐付け失敗:', err);
      setUploadStage('error');
      alert(`画像のアップロードまたは紐付けに失敗しました:\n${err?.message || err}`);
    }
  };

  const activeSelectedItem = items.find(it => it.itemId === selectedItemId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
      {/* 左カラム (1/4幅) : コントロール・詳細/攻略メモ・カテゴリタブ */}
      <div className="lg:col-span-1 space-y-6 order-2 lg:order-1 lg:sticky lg:top-24">
        {/* ログイン・ユーザーヘッダー */}
        <div className="bg-[#1b153a] border border-[#2d2654] rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row lg:flex-col items-center sm:items-start lg:items-center justify-between gap-4 shadow-lg">
          <div className="flex items-center gap-3 w-full">
            {user ? (
              <>
                {user.photoURL ? (
                  <img src={user.photoURL} alt="avatar" className="w-10 h-10 rounded-full border-2 border-[#ffa248]" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-[#ffa248]/20 text-[#ffa248] flex items-center justify-center font-bold border border-[#ffa248]/40">
                    {user.displayName?.charAt(0) || '👤'}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white truncate">{user.displayName || '雀士プロダクト'}</div>
                  <div className="text-xs text-indigo-300">ログイン中 (Google Auth)</div>
                </div>
              </>
            ) : (
              <div>
                <div className="text-sm font-bold text-indigo-100">進捗を同期しましょう</div>
                <div className="text-xs text-indigo-300">ログインすると、お守りチェックと攻略メモの編集が可能になります。</div>
              </div>
            )}
          </div>
          <div className="w-full sm:w-auto lg:w-full flex justify-end lg:justify-center">
            {user ? (
              <button 
                onClick={handleLogout}
                className="w-full sm:w-auto lg:w-full px-4 py-2 bg-[#2d2654] hover:bg-[#3d3470] text-indigo-200 border border-[#443a7a] rounded-xl text-xs font-bold transition-all cursor-pointer text-center"
              >
                ログアウト
              </button>
            ) : (
              <button 
                onClick={handleLogin}
                className="w-full sm:w-auto lg:w-full px-5 py-2.5 bg-gradient-to-b from-[#ffd98a] to-[#ffa248] hover:from-[#ffe09e] hover:to-[#ffb260] text-[#633307] font-black rounded-xl text-xs sm:text-sm shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer border border-[#633307]/20"
              >
                Googleでログイン
              </button>
            )}
          </div>
        </div>

        {/* 詳細 ＆ 共有攻略メモ */}
        <div className="bg-[#f5ebd7] border-4 border-[#523621] rounded-3xl p-5 md:p-6 shadow-xl relative overflow-hidden">
          {/* 装飾用の端の角丸木枠 */}
          <div className="absolute inset-2 border border-[#8a684b]/30 rounded-2xl pointer-events-none" />

          {!selectedItemId ? (
            <div className="text-center py-12 text-[#7c7764] space-y-3 z-10 relative">
              <span className="text-4xl block animate-bounce">🔍</span>
              <p className="text-xs font-bold leading-relaxed">アイテムをクリックして、詳細表示や攻略メモを書き込みましょう！</p>
            </div>
          ) : !activeSelectedItem ? (
            <div className="text-center py-12 text-[#7c7764] font-bold z-10 relative">
              選択されたアイテムのデータが見つかりません。
            </div>
          ) : (
            <div className="space-y-4 z-10 relative">
              {/* アイテムヘッダー部分 */}
              <div className="flex items-center gap-4 border-b border-[#8a684b]/40 pb-4">
                <div className={`w-14 h-14 rounded-xl flex items-center justify-center p-2 border relative shadow-inner ${
                  activeSelectedItem.type === 'amulet' 
                    ? 'bg-gradient-to-b from-[#64a56c] to-[#47804f] border-[#346039]' 
                    : 'bg-black/5 border-[#8a684b]/20'
                }`}>
                  {/* 通報状態の場合は警告プレースホルダー、通常状態は画像表示 */}
                  {activeSelectedItem.report_count && activeSelectedItem.report_count >= 1 ? (
                    <div className="absolute inset-0 bg-[#ebe0c5] flex flex-col items-center justify-center text-center p-1 border border-rose-300 rounded-xl z-20">
                      <span className="text-xs">⚠️</span>
                      <span className="text-[7px] text-rose-700 font-extrabold scale-90">確認中</span>
                    </div>
                  ) : (
                    <img src={activeSelectedItem.image_url} alt={activeSelectedItem.name} className="w-10 h-10 object-contain" />
                  )}
                </div>
                <div className="space-y-1 min-w-0 flex-grow">
                  <span className="text-[9px] tracking-wider font-extrabold px-1.5 py-0.5 rounded bg-[#ffa248] text-[#633307] border border-[#633307]/20">
                    {activeSelectedItem.type === 'amulet' ? 'お守り' : activeSelectedItem.type === 'stamp' ? 'スタンプ' : 'ルーン石'}
                  </span>
                  <h2 className="font-black text-sm sm:text-base text-[#523621] truncate leading-snug">{activeSelectedItem.name}</h2>
                </div>
                {/* ログインユーザー向け: 画像プールアタッチ / アップロードボタン */}
                {user && !isEditingDetails && (
                  <div className="flex flex-col gap-1 items-end shrink-0">
                    <button
                      onClick={() => setShowPoolSelector(true)}
                      className="px-2 py-1.5 bg-[#523621] hover:bg-[#6c482e] text-[#f5ebd7] font-bold rounded-lg text-[10px] shadow-sm transition-colors cursor-pointer border border-[#8a684b]/30"
                    >
                      🖼️ 画像変更
                    </button>
                    <button
                      onClick={() => {
                        setEditName(activeSelectedItem.name || '');
                        setEditEffectText(activeSelectedItem.effect_text || '');
                        setEditUpgradeFrom(activeSelectedItem.upgrade_from || '');
                        setEditUpgradeTo(activeSelectedItem.upgrade_to || '');
                        setEditRelatesFrom(activeSelectedItem.relates_from || '');
                        setEditRelatesTo(activeSelectedItem.relates_to || '');
                        setDetailSaveStatus('idle');
                        setDetailErrorMessage('');
                        setIsEditingDetails(true);
                      }}
                      className="px-2 py-1.5 bg-[#523621] hover:bg-[#6c482e] text-[#f5ebd7] font-bold rounded-lg text-[10px] shadow-sm transition-colors cursor-pointer border border-[#8a684b]/30"
                    >
                      📝 情報編集
                    </button>
                    {activeSelectedItem.image_url && !(activeSelectedItem.report_count && activeSelectedItem.report_count >= 1) && (
                      <button
                        onClick={async () => {
                          const confirmReport = confirm('この画像を不適切なコンテンツとして通報しますか？通報されると即座に確認中に切り替わり、他のユーザーに対して非表示になります。');
                          if (!confirmReport) return;
                          try {
                            const itemRef = doc(db, 'items', activeSelectedItem.id);
                            await updateDoc(itemRef, {
                              report_count: increment(1),
                              reported_by: arrayUnion(user.uid)
                            });
                            alert('通報が終了しました。画像は直ちに非表示に設定されました。');
                          } catch (err) {
                            console.error('通報エラー:', err);
                          }
                        }}
                        className="px-2 py-1 bg-rose-700 hover:bg-rose-600 text-white font-bold rounded text-[8px] tracking-wider cursor-pointer"
                      >
                        🚨 通報
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* 情報編集モード時の入力項目 (お守り名、効果・説明文、各種リレーション) */}
              {isEditingDetails ? (
                <div className="bg-[#ebe0c5] border border-[#d6ccb0] rounded-2xl p-4 space-y-3.5 shadow-inner text-xs">
                  <div className="text-[11px] text-[#523621] font-black border-b border-[#8a684b]/30 pb-1.5 flex items-center gap-1">
                    📝 お守り情報の編集
                  </div>
                  
                  {/* お守り名入力 */}
                  <div className="space-y-1">
                    <label className="text-[10px] text-[#8a684b] font-extrabold block">お守り・アイテム名</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="お守り名を入力してください"
                      className="w-full bg-[#f5ebd7] border border-[#d6ccb0] hover:border-[#bdae8c] text-[#523621] rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#ffa248]/20 font-bold"
                    />
                  </div>

                  {/* 効果・説明文入力 */}
                  <div className="space-y-1">
                    <label className="text-[10px] text-[#8a684b] font-extrabold block">効果・説明文</label>
                    <textarea
                      value={editEffectText}
                      onChange={(e) => setEditEffectText(e.target.value)}
                      placeholder="ゲーム内の効果や説明文を入力してください"
                      className="w-full h-24 bg-[#f5ebd7] border border-[#d6ccb0] hover:border-[#bdae8c] text-[#523621] rounded-lg p-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#ffa248]/20 font-semibold resize-none leading-relaxed"
                    />
                  </div>

                  {/* 強化・関連入力フォーム */}
                  <div className="space-y-2 border-t border-[#8a684b]/20 pt-2">
                    <span className="text-[10px] text-[#8a684b] font-extrabold tracking-wide block">🔗 強化リレーション・関連設定</span>
                    
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-[#8a684b] font-bold block mb-0.5">強化元 (upgrade_from)</label>
                        <select
                          value={editUpgradeFrom}
                          onChange={(e) => setEditUpgradeFrom(e.target.value)}
                          className="w-full bg-[#f5ebd7] border border-[#d6ccb0] text-[#523621] rounded-md px-1.5 py-1.5 text-[11px] focus:outline-none font-semibold font-mono cursor-pointer"
                        >
                          <option value="">(なし)</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.itemId}>
                              {it.type === 'amulet' ? '🧿' : it.type === 'stamp' ? '💮' : '🌀'} {it.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] text-[#8a684b] font-bold block mb-0.5">強化先 (upgrade_to)</label>
                        <select
                          value={editUpgradeTo}
                          onChange={(e) => setEditUpgradeTo(e.target.value)}
                          className="w-full bg-[#f5ebd7] border border-[#d6ccb0] text-[#523621] rounded-md px-1.5 py-1.5 text-[11px] focus:outline-none font-semibold font-mono cursor-pointer"
                        >
                          <option value="">(なし)</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.itemId}>
                              {it.type === 'amulet' ? '🧿' : it.type === 'stamp' ? '💮' : '🌀'} {it.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-[#8a684b] font-bold block mb-0.5">関連元 (relates_from)</label>
                        <select
                          value={editRelatesFrom}
                          onChange={(e) => setEditRelatesFrom(e.target.value)}
                          className="w-full bg-[#f5ebd7] border border-[#d6ccb0] text-[#523621] rounded-md px-1.5 py-1.5 text-[11px] focus:outline-none font-semibold font-mono cursor-pointer"
                        >
                          <option value="">(なし)</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.itemId}>
                              {it.type === 'amulet' ? '🧿' : it.type === 'stamp' ? '💮' : '🌀'} {it.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] text-[#8a684b] font-bold block mb-0.5">関連先 (relates_to)</label>
                        <select
                          value={editRelatesTo}
                          onChange={(e) => setEditRelatesTo(e.target.value)}
                          className="w-full bg-[#f5ebd7] border border-[#d6ccb0] text-[#523621] rounded-md px-1.5 py-1.5 text-[11px] focus:outline-none font-semibold font-mono cursor-pointer"
                        >
                          <option value="">(なし)</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.itemId}>
                              {it.type === 'amulet' ? '🧿' : it.type === 'stamp' ? '💮' : '🌀'} {it.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {detailErrorMessage && (
                    <div className="text-[10px] text-rose-700 font-bold leading-relaxed pt-1">
                      ⚠️ {detailErrorMessage}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#8a684b]/20">
                    {detailSaveStatus === 'success' && (
                      <span className="text-[10px] text-green-700 font-bold flex items-center">✓ 保存完了</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsEditingDetails(false)}
                      className="px-2.5 py-1.5 bg-[#2d2654]/10 hover:bg-[#2d2654]/20 text-[#523621] font-bold rounded-lg text-xs transition-colors cursor-pointer"
                    >
                      キャンセル
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveDetails}
                      disabled={detailSaveStatus === 'saving'}
                      className="px-4 py-1.5 bg-gradient-to-b from-[#ffd98a] to-[#ffa248] hover:from-[#ffe09e] hover:to-[#ffb260] text-[#633307] font-black rounded-lg text-xs shadow-md transition-colors cursor-pointer border border-[#633307]/20"
                    >
                      {detailSaveStatus === 'saving' ? '保存中...' : 'お守り情報を一括保存'}
                    </button>
                  </div>
                </div>
              ) : (
                /* ゲーム内の効果テキスト */
                <div className="bg-[#ebe0c5] border border-[#d6ccb0] rounded-2xl p-3.5 space-y-2 shadow-inner">
                  <span className="text-[9px] text-[#8a684b] font-extrabold tracking-wide block">効果・説明文</span>
                  <p className="text-xs text-[#523621] leading-relaxed font-bold">{activeSelectedItem.effect_text}</p>
                </div>
              )}

              {/* 強化ツリー（相互参照 / 動的フォールバック解決） */}
              {(() => {
                const { fromItem, toItem, fromId, toId } = getUpgradeRelations(activeSelectedItem);
                if (!fromItem && !toItem && !fromId && !toId) return null;
                return (
                  <div className="bg-[#ffa248]/10 rounded-2xl border border-[#ffa248]/30 p-3 space-y-1.5 text-[11px]">
                    <span className="text-[9px] text-[#b06c28] font-extrabold tracking-wide block">💡 強化リレーション</span>
                    <div className="flex flex-col gap-1.5">
                      {(fromItem || fromId) && (
                        <div className="flex items-center justify-between">
                          <span className="text-[#8a684b] font-bold">強化元:</span>
                          {fromItem ? (
                            <button 
                              onClick={() => setSelectedItemId(fromItem.itemId)}
                              className="text-[#b06c28] hover:underline font-black text-left"
                            >
                              {fromItem.name}
                            </button>
                          ) : (
                            <span className="text-[#8a684b] font-mono text-[10px]">{fromId}</span>
                          )}
                        </div>
                      )}
                      {(toItem || toId) && (
                        <div className="flex items-center justify-between">
                          <span className="text-[#8a684b] font-bold">強化先:</span>
                          {toItem ? (
                            <button 
                              onClick={() => setSelectedItemId(toItem.itemId)}
                              className="text-[#b06c28] hover:underline font-black text-left"
                            >
                              {toItem.name}
                            </button>
                          ) : (
                            <span className="text-[#8a684b] font-mono text-[10px]">{toId}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* 関連アイテム（名称変化アップグレード等） */}
              {(() => {
                const { fromItem, toItem, fromId, toId } = getSpecialRelations(activeSelectedItem);
                if (!fromItem && !toItem && !fromId && !toId) return null;
                return (
                  <div className="bg-[#8a684b]/10 rounded-2xl border border-[#8a684b]/30 p-3 space-y-1.5 text-[11px]">
                    <span className="text-[9px] text-[#8a684b] font-extrabold tracking-wide block">💡 関連アイテム</span>
                    <div className="flex flex-col gap-1.5">
                      {(fromItem || fromId) && (
                        <div className="flex items-center justify-between">
                          <span className="text-[#8a684b] font-bold">関連元:</span>
                          {fromItem ? (
                            <button 
                              onClick={() => setSelectedItemId(fromItem.itemId)}
                              className="text-[#8a684b] hover:underline font-black text-left"
                            >
                              {fromItem.name}
                            </button>
                          ) : (
                            <span className="text-[#8a684b] font-mono text-[10px]">{fromId}</span>
                          )}
                        </div>
                      )}
                      {(toItem || toId) && (
                        <div className="flex items-center justify-between">
                          <span className="text-[#8a684b] font-bold">関連先:</span>
                          {toItem ? (
                            <button 
                              onClick={() => setSelectedItemId(toItem.itemId)}
                              className="text-[#8a684b] hover:underline font-black text-left"
                            >
                              {toItem.name}
                            </button>
                          ) : (
                            <span className="text-[#8a684b] font-mono text-[10px]">{toId}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* 合体レシピ（4対1マージ進化） */}
              {(() => {
                const { sources, targetItem, targetId } = getRecipeRelations(activeSelectedItem);
                const hasSources = sources.length > 0;
                const hasTarget = !!targetItem || !!targetId;
                if (!hasSources && !hasTarget) return null;

                return (
                  <div className="bg-[#47804f]/10 rounded-2xl border border-[#47804f]/30 p-3 space-y-1.5 text-[11px]">
                    <span className="text-[9px] text-[#47804f] font-extrabold tracking-wide block">💡 合体進化レシピ</span>
                    <div className="flex flex-col gap-1.5">
                      {hasTarget && (
                        <div className="space-y-1">
                          <span className="text-[#8a684b] font-bold block">4枚集めて合体進化：</span>
                          <div className="flex justify-between items-center pl-2 border-l-2 border-[#47804f]/30">
                            {targetItem ? (
                              <button 
                                onClick={() => setSelectedItemId(targetItem.itemId)}
                                className="text-[#47804f] hover:underline font-black text-left font-bold"
                              >
                                ✨ {targetItem.name}
                              </button>
                            ) : (
                              <span className="text-[#8a684b] font-mono text-[10px] pl-1">{targetId}</span>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {hasSources && (
                        <div className="space-y-1">
                          <span className="text-[#8a684b] font-bold block">合体に必要な素材お守り：</span>
                          <div className="grid grid-cols-1 gap-1 pl-2 border-l-2 border-[#47804f]/30">
                            {sources.map((src, idx) => {
                              const isSrcOwned = src.item ? !!ownedItemsMap[`${src.item.generation}_${src.item.itemId}`] : false;
                              return (
                                <div key={src.itemId} className="flex items-center justify-between">
                                  {src.item ? (
                                    <button 
                                      onClick={() => setSelectedItemId(src.itemId)}
                                      className={`hover:underline font-bold text-left ${isSrcOwned ? 'text-[#346039]' : 'text-[#7c7764] line-through decoration-[#7c7764]/40 opacity-70'}`}
                                    >
                                      {idx + 1}. {src.item.name}
                                    </button>
                                  ) : (
                                    <span className="text-[#8a684b] font-mono text-[10px]">{src.itemId}</span>
                                  )}
                                  <span className={`text-[9px] px-1 py-0.2 rounded font-extrabold ${isSrcOwned ? 'bg-[#47804f]/15 text-[#346039]' : 'bg-[#7c7764]/10 text-[#7c7764]'}`}>
                                    {isSrcOwned ? '所持中' : '未所持'}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* 共有攻略メモセクション */}
              <div className="space-y-3 border-t border-[#8a684b]/40 pt-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-black text-[#523621] flex items-center gap-1.5">
                    📝 ユーザー共有攻略メモ
                  </h3>
                  {activeComment && activeComment.version > 0 && (
                    <span className="text-[9px] bg-[#ebe0c5] text-[#8a684b] font-mono px-1.5 py-0.5 rounded border border-[#d6ccb0] font-bold">
                      Ver. {activeComment.version}
                    </span>
                  )}
                </div>

                {/* 前回の更新者メタ情報（一般ユーザーに他のユーザー名が漏洩しないよう、UIDのみ表示。ログインユーザー自身の場合は「あなた」） */}
                {activeComment && activeComment.updated_by && (
                  <div className="text-[10px] text-[#8a684b] font-bold">
                    最終更新: <span className="text-[#523621]">
                      {user && activeComment.updated_by === user.uid ? 'あなた' : `UID: ${activeComment.updated_by}`}
                    </span> 
                    {activeComment.updated_at && (
                      <span className="font-normal text-[#8a684b]/80"> ({new Date(activeComment.updated_at.toMillis ? activeComment.updated_at.toMillis() : activeComment.updated_at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })})</span>
                    )}
                  </div>
                )}

                {/* 編集フォーム */}
                {user ? (
                  <div className="space-y-2">
                    <textarea
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="攻略メモを書き込みましょう。"
                      className="w-full h-28 bg-[#ebe0c5] border border-[#d6ccb0] hover:border-[#bdae8c] focus:border-[#ffa248] focus:ring-2 focus:ring-[#ffa248]/20 text-[#523621] placeholder-[#8a684b]/60 rounded-xl p-3 text-xs focus:outline-none transition-all resize-none leading-relaxed font-semibold"
                    />

                    {errorMessage && (
                      <div className="bg-rose-500/10 border border-rose-500/20 text-rose-700 text-xs p-3 rounded-lg leading-relaxed font-bold">
                        {errorMessage}
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-3">
                      {saveStatus === 'success' && (
                        <span className="text-xs text-green-700 font-bold flex items-center gap-1">
                          ✓ 保存しました！
                        </span>
                      )}
                      <button
                        onClick={handleSaveComment}
                        disabled={saveStatus === 'saving'}
                        className="px-4 py-2 bg-gradient-to-b from-[#ffd98a] to-[#ffa248] hover:from-[#ffe09e] hover:to-[#ffb260] disabled:opacity-50 text-[#633307] font-black rounded-lg text-xs shadow-md transition-all cursor-pointer border border-[#633307]/20"
                      >
                        {saveStatus === 'saving' ? '保存中...' : 'メモを更新する'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#ebe0c5]/50 border border-[#d6ccb0] rounded-2xl p-4 text-center space-y-2 shadow-inner">
                    <p className="text-xs text-[#8a684b] leading-relaxed font-bold">
                      ログインすると、共同編集に参加できます。
                    </p>
                    {activeComment && activeComment.content ? (
                      <div className="text-left py-2 px-2.5 bg-[#f5ebd7] border border-[#d6ccb0] rounded-xl text-xs text-[#523621] whitespace-pre-wrap leading-relaxed font-semibold">
                        {activeComment.content}
                      </div>
                    ) : (
                      <p className="text-xs text-[#8a684b]/60 italic font-bold">
                        現在、攻略メモはありません。
                      </p>
                    )}
                    <button
                      onClick={handleLogin}
                      className="inline-block px-4 py-1.5 bg-[#523621] hover:bg-[#6c482e] text-[#f5ebd7] font-bold rounded-lg text-xs transition-colors cursor-pointer"
                    >
                      ログインして編集
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* デスクトップ用カテゴリ切り替えタブ */}
        <div className="hidden lg:flex flex-col gap-2.5">
          <div className="text-xs text-[#3b2718] font-bold mb-1 font-game">カテゴリ切り替え</div>
          {(['amulet', 'stamp', 'rune'] as const).map((tab) => {
            const label = tab === 'amulet' ? '🧿 お守り' : tab === 'stamp' ? '💮 スタンプ' : '🌀 ルーン石';
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`w-full py-3.5 px-6 rounded-xl font-black text-sm transition-all cursor-pointer flex items-center justify-between shadow-md border ${
                  isActive 
                    ? 'bg-gradient-to-b from-[#ffd98a] to-[#ffa248] border-[#633307] text-[#633307]' 
                    : 'bg-[#3f396d] border-[#2d2654] text-[#a49ed5] hover:text-white hover:bg-[#4f4785]'
                }`}
              >
                <span>{label}</span>
                {isActive && <span className="text-xs">➔</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* 右カラム (3/4幅) : アルバムフレーム・プログレスバー */}
      <div className="lg:col-span-3 space-y-6 order-1 lg:order-2">
        {/* 全体プログレスバー */}
        {isDataLoaded && (
          <div className="bg-[#1b153a] border border-[#2d2654] rounded-2xl p-5 space-y-3 shadow-lg">
            <div className="flex justify-between items-center text-sm">
              <span className="font-bold text-[#ffa248] flex items-center gap-1.5 font-game">
                👑 第4世代 コンプリート率
              </span>
              <span className="font-bold font-mono text-white">
                [ {ownedAll} / {totalAll} ({percentageAll}%) ]
              </span>
            </div>
            <div className="w-full bg-[#0e0a22] rounded-full h-3 overflow-hidden border border-[#2d2654]">
              <div 
                className="bg-gradient-to-r from-[#ffa248] to-[#ffd98a] h-full rounded-full transition-all duration-500 ease-out" 
                style={{ width: `${percentageAll}%` }}
              ></div>
            </div>
          </div>
        )}

        {/* モバイル用カテゴリタブ (デスクトップ時は非表示) */}
        <div className="flex lg:hidden gap-1 w-full px-2">
          {(['amulet', 'stamp', 'rune'] as const).map((tab) => {
            const label = tab === 'amulet' ? 'お守り' : tab === 'stamp' ? 'スタンプ' : 'ルーン石';
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-center text-xs sm:text-sm font-black transition-all cursor-pointer flex items-center justify-center gap-1 ${
                  isActive 
                    ? 'tab-game-active-mobile' 
                    : 'tab-game-inactive-mobile hover:text-white hover:bg-[#4f4785]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* アルバムメインフレーム */}
        <div className="bg-album-paper border-[8px] border-[#3c3566] rounded-3xl p-4 shadow-[0_15px_40px_rgba(0,0,0,0.5)] relative">
          {/* 看板 */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 album-title-board px-10 py-2.5 text-base md:text-lg font-black tracking-widest z-20">
            アルバム
          </div>

          {/* アルバム内部: 所持数表示と設定、グリッド */}
          <div className="mt-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1 pb-3 border-b border-[#c8c2aa]/40">
              <div className="text-[10px] text-[#7c7764] font-bold">
                ※ チェックONで所持。カード枠クリックで詳細。
              </div>
              
              <div className="flex items-center gap-4">
                {/* 表示列数トグル */}
                <div className="flex items-center gap-1 bg-[#ebdcb9] border border-[#c8c2aa] rounded-lg p-0.5 text-xs font-bold text-[#523621]">
                  <button 
                    onClick={() => setColsMode('fixed6')}
                    className={`px-2 py-0.5 rounded transition-all cursor-pointer ${colsMode === 'fixed6' ? 'bg-[#ffa248] text-[#633307] shadow-sm' : 'hover:bg-[#dfd9c1]/50'}`}
                  >
                    6列固定
                  </button>
                  <button 
                    onClick={() => setColsMode('responsive')}
                    className={`px-2 py-0.5 rounded transition-all cursor-pointer ${colsMode === 'responsive' ? 'bg-[#ffa248] text-[#633307] shadow-sm' : 'hover:bg-[#dfd9c1]/50'}`}
                  >
                    自動調整
                  </button>
                </div>

                <div className="text-xs text-[#7b4515] font-black font-mono">
                  所持: {ownedInTab} / {totalInTab} ({percentageInTab}%)
                </div>
              </div>
            </div>

            {!isDataLoaded ? (
              <div className="flex justify-center py-20">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#ffa248]"></div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="bg-[#ebdcb9]/40 border border-dashed border-[#c8c2aa] rounded-2xl py-12 text-center text-[#7c7764] font-bold">
                登録されているデータがありません。
              </div>
            ) : (
              <div className={
                colsMode === 'fixed6'
                  ? "grid grid-cols-6 gap-1.5"
                  : "grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5"
              }>
                {filteredItems.map((item) => {
                  const isOwned = !!ownedItemsMap[`${item.generation}_${item.itemId}`];
                  const isSelected = selectedItemId === item.itemId;
                  const isAmulet = item.type === 'amulet';
                  const hasUpgrade = isAmulet && item.order % 2 === 0;

                  if (isAmulet) {
                    // お守りカード
                    return (
                      <div 
                        key={item.id}
                        onClick={() => setSelectedItemId(item.itemId)}
                        className={`relative flex flex-col rounded-xl overflow-hidden border transition-all duration-200 cursor-pointer ${
                          isSelected 
                            ? 'border-[#ffa248] ring-4 ring-[#ffa248]/30 shadow-xl scale-[1.01]' 
                            : 'border-[#c8c2aa] hover:border-[#a8a28a] hover:shadow-md'
                        }`}
                      >
                        {/* 所持チェックボックス (誤操作防止のため絶対配置) */}
                        <div 
                          className={`absolute z-30 ${colsMode === 'fixed6' ? 'top-1 left-1' : 'top-2 left-2'}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input 
                            type="checkbox"
                            checked={isOwned}
                            onChange={() => toggleOwnership(item)}
                            className={`accent-[#ffa248] cursor-pointer rounded border-[#c8c2aa] ${
                              colsMode === 'fixed6' ? 'w-4.5 h-4.5' : 'w-5 h-5'
                            }`}
                          />
                        </div>

                        {/* 画像エリア (所持時は緑グラデ、未所持時はベージュ) - 枠いっぱいに表示されるようパディングを調整 */}
                        <div 
                          className={`relative aspect-square w-full flex items-center justify-center ${
                            colsMode === 'fixed6' ? 'p-1.5' : 'p-2.5'
                          } overflow-hidden transition-all ${
                            isOwned 
                              ? 'bg-gradient-to-b from-[#64a56c] to-[#47804f]' 
                              : 'bg-[#d6d0b9]'
                          }`}
                        >
                          {/* 通報済み警告ガードの表示 */}
                          {item.report_count && item.report_count >= 1 ? (
                            <div className="absolute inset-0 bg-[#ebe0c5] flex flex-col items-center justify-center text-center p-2 border border-rose-300 rounded-xl z-20">
                              <span className="text-xl">⚠️</span>
                              <span className="text-[10px] text-rose-700 font-extrabold mt-1">画像確認中</span>
                            </div>
                          ) : (
                            <img 
                              key={item.image_url}
                              src={item.image_url} 
                              alt={item.name}
                              className={`w-full h-full object-contain transition-all duration-300 ${
                                isOwned 
                                  ? 'opacity-100 scale-100 drop-shadow-[0_4px_8px_rgba(0,0,0,0.25)]' 
                                  : 'opacity-85 scale-100 drop-shadow-[0_2px_4px_rgba(0,0,0,0.15)]'
                              }`}
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                              }}
                            />
                          )}

                          {/* 強化マーク (プラス画像) */}
                          {hasUpgrade && (
                            <div className={`absolute bottom-1 left-1 flex items-center justify-center ${
                              colsMode === 'fixed6' ? 'w-6 h-6' : 'w-8 h-8'
                            }`}>
                              <img 
                                src={typeof plusIcon === 'string' ? plusIcon : plusIcon.src} 
                                alt="+" 
                                className={`object-contain w-full h-full transition-all duration-200 ${
                                  isOwned 
                                    ? 'opacity-100 drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)]' 
                                    : 'opacity-40'
                                }`} 
                              />
                            </div>
                          )}

                          {/* order番号表示 */}
                          <span className={`absolute bottom-1.5 right-1.5 font-mono font-bold px-1.5 py-0.5 rounded ${
                            colsMode === 'fixed6' ? 'text-[7px]' : 'text-[9px]'
                          } ${
                            isOwned 
                              ? 'bg-[#346039]/60 text-white border border-[#346039]/40' 
                              : 'bg-[#7c7764]/20 text-[#7c7764] border border-[#7c7764]/20'
                          }`}>
                            #{item.order}
                          </span>
                        </div>

                        {/* テキストエリア */}
                        <div className={`p-2 flex-grow flex flex-col justify-between border-t ${
                          colsMode === 'fixed6' ? 'p-1.5' : 'p-3'
                        } ${
                          isOwned 
                            ? 'border-[#346039]/30 bg-[#eff7f0]' 
                            : 'border-[#b3ad97]/30 bg-[#dfd9c1]'
                        }`}>
                          <div className="space-y-1">
                            <div className={`font-bold text-left leading-tight truncate ${
                              colsMode === 'fixed6' ? 'text-[9px]' : 'text-xs sm:text-sm'
                            } ${isOwned ? 'text-[#153018]' : 'text-[#5a5649]'}`}>
                              {item.name}
                            </div>
                            
                            {/* 効果テキストを常時表示 */}
                            <p className={`text-[10px] leading-tight font-semibold mt-1 ${
                              colsMode === 'fixed6' ? 'text-[8px] line-clamp-1' : 'line-clamp-3'
                            } ${isOwned ? 'text-[#346039]/80' : 'text-[#7c7764]'}`}>
                              {item.effect_text}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  } else {
                    // スタンプ・ルーン石専用デザイン (背景透過)
                    return (
                      <div 
                        key={item.id}
                        onClick={() => setSelectedItemId(item.itemId)}
                        className={`relative flex flex-col items-center justify-between rounded-2xl border transition-all duration-200 cursor-pointer ${
                          colsMode === 'fixed6' ? 'p-1' : 'p-3'
                        } ${
                          isSelected 
                            ? 'border-[#ffa248] bg-[#ffa248]/5 ring-4 ring-[#ffa248]/20 shadow-lg scale-[1.01]' 
                            : 'border-transparent hover:bg-black/5'
                        }`}
                      >
                        {/* 所持チェックボックス (誤操作防止のため絶対配置) */}
                        <div 
                          className={`absolute z-30 ${colsMode === 'fixed6' ? 'top-1 right-1' : 'top-2 right-2'}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input 
                            type="checkbox"
                            checked={isOwned}
                            onChange={() => toggleOwnership(item)}
                            className={`accent-[#ffa248] cursor-pointer rounded border-[#c8c2aa] ${
                              colsMode === 'fixed6' ? 'w-4 h-4' : 'w-4.5 h-4.5'
                            }`}
                          />
                        </div>

                        <div className="relative w-full aspect-square flex items-center justify-center p-1">
                          {item.report_count && item.report_count >= 1 ? (
                            <div className="absolute inset-0 bg-[#ebe0c5] flex flex-col items-center justify-center text-center p-1 border border-rose-300 rounded-xl z-20">
                              <span className="text-sm">⚠️</span>
                              <span className="text-[8px] text-rose-700 font-extrabold scale-90">画像確認中</span>
                            </div>
                          ) : (
                            <img 
                              key={item.image_url}
                              src={item.image_url} 
                              alt={item.name}
                              className={`w-full h-full object-contain transition-all duration-300 ${
                                isOwned 
                                  ? 'opacity-100 scale-100 drop-shadow-[0_4px_10px_rgba(0,0,0,0.15)]' 
                                  : 'opacity-60 scale-100'
                              }`}
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                              }}
                            />
                          )}

                          {/* order番号表示 */}
                          <span className={`absolute bottom-0 left-1 font-mono font-bold text-[#7c7764]/70 ${
                            colsMode === 'fixed6' ? 'text-[7px]' : 'text-[9px]'
                          }`}>
                            #{item.order}
                          </span>
                        </div>

                        <div className="w-full text-center mt-2 space-y-1">
                          <div className={`font-bold text-center leading-tight truncate text-[#523621] ${
                            colsMode === 'fixed6' ? 'text-[9px] mt-0.5' : 'text-xs sm:text-sm'
                          }`}>
                            {item.name}
                          </div>

                          {/* 効果テキストを常時表示 (6列固定時は非表示にしてスペース確保) */}
                          {colsMode !== 'fixed6' && (
                            <p className="text-[10px] text-[#7c7764] text-center leading-tight mt-1 line-clamp-2 max-w-[120px] mx-auto font-semibold">
                              {item.effect_text}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  }
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 画像プール用のモーダルUI（お守り詳細パネルとオーバーレイして出す） */}
      {showPoolSelector && activeSelectedItem && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-[#f5ebd7] border-4 border-[#8 clearance-custom-outer-frame] border-[#8a684b] rounded-3xl p-6 max-w-2xl w-full max-h-[85vh] flex flex-col relative shadow-2xl">
            {/* 角丸木枠内のゴールド線 */}
            <div className="absolute inset-1.5 border border-[#8a684b]/30 rounded-2xl pointer-events-none" />

            <div className="flex justify-between items-center border-b border-[#8a684b]/30 pb-3 z-10">
              <div>
                <h3 className="text-sm font-extrabold text-[#523621] uppercase tracking-wide">
                  🖼️ お守り画像の割り当て
                </h3>
                <p className="text-[10px] text-[#7c7764] font-bold">
                  「{activeSelectedItem.name}」に適用する画像をプールから選択、または直接アップロード
                </p>
              </div>
              <button
                onClick={() => setShowPoolSelector(false)}
                className="text-[#8a684b] hover:text-[#523621] text-lg font-black w-8 h-8 rounded-full bg-black/5 flex items-center justify-center cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex-grow overflow-y-auto py-4 space-y-5 z-10">
              {/* 強化リレーション先の画像も更新するチェックボックス */}
              {(() => {
                const chainItems = getUpgradeChainItems(activeSelectedItem);
                if (chainItems.length === 0) return null;
                return (
                  <div className="bg-[#ffa248]/10 border border-[#ffa248]/30 rounded-2xl p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="updateRelatedImagesToggle"
                        checked={updateRelatedImages}
                        onChange={(e) => setUpdateRelatedImages(e.target.checked)}
                        className="accent-[#ffa248] cursor-pointer w-4 h-4"
                      />
                      <label htmlFor="updateRelatedImagesToggle" className="text-[11px] text-[#523621] font-extrabold cursor-pointer select-none">
                        💡 強化リレーション先の画像も更新する
                      </label>
                    </div>
                    <div className="text-[9px] text-[#8a684b] font-bold pl-6 leading-relaxed">
                      対象: {chainItems.map(it => it.name).join('、')}
                    </div>
                  </div>
                );
              })()}

              {/* アップロードフォーム */}
              <div className="bg-[#ebe0c5] border border-[#d6ccb0] rounded-2xl p-4 space-y-3">
                <span className="text-[10px] text-[#8a684b] font-extrabold tracking-wide block">📤 ローカルよりお守り画像を直接アップロード (2MB以下)</span>
                
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleUploadAndAttach}
                    disabled={uploadStage === 'compressing' || uploadStage === 'uploading' || uploadStage === 'saving'}
                    className="block w-full text-xs text-[#523621]
                      file:mr-4 file:py-1.5 file:px-4
                      file:rounded-xl file:border file:border-[#633307]/20
                      file:text-xs file:font-semibold
                      file:bg-gradient-to-b file:from-[#ffd98a] file:to-[#ffa248]
                      file:text-[#633307] file:cursor-pointer
                      hover:file:bg-[#ffe09e] transition"
                  />
                  {uploadStage === 'compressing' && (
                    <span className="text-xs text-[#b06c28] font-bold shrink-0 animate-pulse">WebP圧縮中...</span>
                  )}
                  {uploadStage === 'uploading' && (
                    <span className="text-xs text-[#b06c28] font-bold shrink-0 animate-pulse">Storage送信中...</span>
                  )}
                  {uploadStage === 'saving' && (
                    <span className="text-xs text-[#b06c28] font-bold shrink-0 animate-pulse">DB紐付け中...</span>
                  )}
                </div>
              </div>

              {/* 画像エクスプローラー（画像プール） */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-[#8a684b]/10 pb-2">
                  <span className="text-[10px] text-[#8a684b] font-extrabold tracking-wide">📂 Storage 内に配備済みの画像プールから紐付け</span>
                  
                  {/* is_linked 状態の切り替えトグル */}
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-[#8a684b]">
                    <input
                      type="checkbox"
                      id="showAllImagesToggle"
                      checked={showAllPoolImages}
                      onChange={(e) => setShowAllPoolImages(e.target.checked)}
                      className="accent-[#ffa248] cursor-pointer"
                    />
                    <label htmlFor="showAllImagesToggle" className="cursor-pointer select-none">
                      他ので使用中の紐付け済み画像も表示
                    </label>
                  </div>
                </div>

                {imagePool.length === 0 ? (
                  <div className="text-center py-10 text-[#8a684b] text-xs italic bg-black/5 rounded-xl font-bold">
                    プール（image_pool）に画像データはありません。
                  </div>
                ) : (
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {imagePool
                      .filter(img => showAllPoolImages ? true : !img.is_linked)
                      .map((img) => (
                        <button
                          key={img.id}
                          type="button"
                          onClick={() => handleAttachImage(img)}
                          className={`p-2 bg-white/40 border hover:border-[#ffa248]/80 hover:bg-[#fffcf7] rounded-xl flex flex-col justify-center items-center gap-1 transition-all group cursor-pointer ${
                            img.is_linked ? 'opacity-60 border-[#c8c2aa] border-dashed' : 'border-[#c8c2aa]'
                          }`}
                        >
                          <div className="w-12 h-12 flex items-center justify-center p-1 relative">
                            <img src={img.url} alt={img.fileName} className="w-10 h-10 object-contain text-[8px]" />
                            {img.is_linked && (
                              <span className="absolute bottom-0 right-0 bg-gray-500/80 text-white font-extrabold text-[6px] px-1 rounded scale-90">
                                割当済
                              </span>
                            )}
                          </div>
                          <span className="text-[7px] text-[#8a684b] truncate w-full text-center font-bold">
                            {img.fileName}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>
            
            <div className="border-t border-[#8a684b]/30 pt-3 flex justify-end gap-3 z-10">
              <button
                onClick={() => setShowPoolSelector(false)}
                className="px-4 py-2 bg-gradient-to-b from-white to-[#eae5d0] hover:to-[#dfdacc] text-[#523621] font-black rounded-lg text-xs shadow-sm transition-all border border-[#8a684b]/20 cursor-pointer"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
