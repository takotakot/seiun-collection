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
  Timestamp
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';

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

  // 2. マスターデータの取得 ( items コレクション )
  // 第4世代のみを主軸として扱う（概要.mdに準拠）
  useEffect(() => {
    const fetchItems = async () => {
      try {
        const itemsSnap = await getDocs(collection(db, 'items'));
        const loadedItems: Item[] = [];
        itemsSnap.forEach((doc) => {
          const data = doc.data() as Item;
          if (data.generation === 4) {
            loadedItems.push(data);
          }
        });
        // 並び順（order）でソート
        loadedItems.sort((a, b) => a.order - b.order);
        setItems(loadedItems);
        setIsDataLoaded(true);
      } catch (err) {
        console.error('マスターデータ読み込みエラー:', err);
      }
    };
    fetchItems();
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

        // 新しいデータをセット
        transaction.set(commentDocRef, {
          content: commentText.trim(),
          updated_at: serverTimestamp(),
          updated_by: user.uid,
          updated_by_name: user.displayName || '名無しプレイヤー',
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

  const activeSelectedItem = items.find(it => it.itemId === selectedItemId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* 左〜中: 各世代のアルバム表示 */}
      <div className="lg:col-span-2 space-y-6">
        {/* ログイン・ユーザーヘッダー */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {user ? (
              <>
                {user.photoURL ? (
                  <img src={user.photoURL} alt="avatar" className="w-10 h-10 rounded-full border border-yellow-500/50" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-yellow-600/30 text-yellow-500 flex items-center justify-center font-bold">
                    {user.displayName?.charAt(0) || '👤'}
                  </div>
                )}
                <div>
                  <div className="text-sm font-bold text-white">{user.displayName || '雀士プロダクト'}</div>
                  <div className="text-xs text-gray-400">ログイン中 (Google Auth)</div>
                </div>
              </>
            ) : (
              <div>
                <div className="text-sm font-bold text-gray-300">進捗状況をリアルタイム同期しましょう</div>
                <div className="text-xs text-gray-500">ログインすると、アイテムチェックと攻略メモの編集が可能になります。</div>
              </div>
            )}
          </div>
          <div>
            {user ? (
              <button 
                onClick={handleLogout}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-lg text-sm font-medium transition-colors cursor-pointer"
              >
                ログアウト
              </button>
            ) : (
              <button 
                onClick={handleLogin}
                className="px-5 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-gray-950 font-bold rounded-lg text-sm shadow-md hover:shadow-yellow-600/10 transition-colors flex items-center gap-2 cursor-pointer"
              >
                Googleでログイン
              </button>
            )}
          </div>
        </div>

        {/* 全体プログレスバー */}
        {isDataLoaded && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
            <div className="flex justify-between items-center text-sm">
              <span className="font-bold text-yellow-500 flex items-center gap-1.5">
                👑 第4世代 コンプリート率
              </span>
              <span className="font-semibold tabular-nums text-white">
                [ {ownedAll} / {totalAll} ({percentageAll}%) ]
              </span>
            </div>
            <div className="w-full bg-gray-950 rounded-full h-3 overflow-hidden border border-gray-800">
              <div 
                className="bg-gradient-to-r from-yellow-600 to-amber-400 h-full rounded-full transition-all duration-500 ease-out" 
                style={{ width: `${percentageAll}%` }}
              ></div>
            </div>
          </div>
        )}

        {/* カテゴリタブ */}
        <div className="flex gap-2 p-1 bg-gray-900/80 rounded-xl border border-gray-800">
          {(['amulet', 'stamp', 'rune'] as const).map((tab) => {
            const label = tab === 'amulet' ? '🧿 お守り' : tab === 'stamp' ? '💮 スタンプ' : '🌀 ルーン';
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-center text-sm font-bold rounded-lg transition-colors cursor-pointer ${
                  isActive 
                    ? 'bg-yellow-600 text-gray-950 font-black shadow-lg shadow-yellow-600/10' 
                    : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* アルバムグリッド */}
        {!isDataLoaded ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-500"></div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="bg-gray-900 border border-dashed border-gray-800 rounded-2xl py-12 text-center text-gray-500">
            このカテゴリに登録されている第4世代のデータはありません。
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-1">
              <div className="text-xs text-gray-400 font-medium">
                ※ アイテムアイコンをクリックすることで所持/未所持をトグルできます
              </div>
              <div className="text-xs text-yellow-500 font-bold tabular-nums">
                所持: {ownedInTab} / {totalInTab} ({percentageInTab}%)
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 max-[450px]:grid-cols-2 md:grid-cols-4 gap-4">
              {filteredItems.map((item) => {
                const isOwned = !!ownedItemsMap[`${item.generation}_${item.itemId}`];
                const isSelected = selectedItemId === item.itemId;

                return (
                  <div 
                    key={item.id}
                    className={`relative group bg-gray-900 rounded-2xl overflow-hidden border transition-all duration-200 flex flex-col ${
                      isSelected 
                        ? 'border-yellow-500 ring-2 ring-yellow-500/20 shadow-xl' 
                        : 'border-gray-800 hover:border-gray-700 hover:shadow-lg'
                    }`}
                  >
                    {/* アイコン画像エリア (トグル切り替え可能) */}
                    <div 
                      onClick={() => toggleOwnership(item)}
                      className="relative aspect-square w-full bg-gray-950 flex items-center justify-center p-4 cursor-pointer overflow-hidden group-hover:opacity-95"
                    >
                      {/* 背景のグロー演出/色分け */}
                      <div className={`absolute inset-0 opacity-10 bg-gradient-to-tr ${
                        item.type === 'amulet' ? 'from-indigo-600 via-purple-600 to-blue-500' :
                        item.type === 'stamp' ? 'from-rose-600 via-pink-600 to-orange-500' :
                        'from-emerald-600 via-teal-600 to-cyan-500'
                      }`} />

                      {/* 画像 (未所持の場合は明るさを落とす。南京錠などの画像はつけず暗転のみ) */}
                      <img 
                        src={item.image_url} 
                        alt={item.name}
                        className={`w-20 h-20 sm:w-24 sm:h-24 object-contain transition-all duration-300 ${
                          isOwned 
                            ? 'opacity-100 scale-100 drop-shadow-[0_0_12px_rgba(234,179,8,0.3)]' 
                            : 'opacity-25 grayscale brightness-50 scale-95 hover:opacity-40'
                        }`}
                        onError={(e) => {
                          // もしStorage画像がない場合用のテキスト代替
                          e.currentTarget.style.display = 'none';
                        }}
                      />

                      {/* 所持リボン（画像右上） */}
                      {isOwned && (
                        <span className="absolute top-2 right-2 bg-yellow-500 text-gray-950 font-black text-[10px] px-2 py-0.5 rounded-full shadow-md z-10 scale-90 sm:scale-100">
                          所持
                        </span>
                      )}

                      {/* order番号表示（画像左下） */}
                      <span className="absolute bottom-2 left-2 text-[10px] font-mono font-semibold text-gray-500 bg-gray-900/80 px-1.5 py-0.5 rounded border border-gray-800">
                        #{item.order}
                      </span>
                    </div>

                    {/* テキストカード下半分 */}
                    <div className="p-3 flex-grow flex flex-col justify-between border-t border-gray-800 bg-gray-900">
                      <div className="space-y-1">
                        <button 
                          onClick={() => setSelectedItemId(item.itemId)}
                          className="font-bold text-sm text-left text-white leading-tight hover:text-yellow-500 transition-colors block w-full truncate focus:outline-none"
                        >
                          {item.name}
                        </button>
                        <p className="text-[11px] text-gray-400 line-clamp-2 min-h-[32px] leading-relaxed">
                          {item.effect_text}
                        </p>
                      </div>

                      <div className="pt-3 border-t border-gray-800/60 mt-2 flex items-center justify-between">
                        <button
                          onClick={() => setSelectedItemId(item.itemId)}
                          className="text-[11px] font-semibold text-yellow-600 hover:text-yellow-500 flex items-center gap-1 cursor-pointer"
                        >
                          詳細・メモ 
                          <span>➔</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 右側: 選択したアイテムの詳細 ＆ 共有攻略メモ（Wiki） */}
      <div className="space-y-6">
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 shadow-xl sticky top-24">
          {!selectedItemId ? (
            <div className="text-center py-20 text-gray-500 space-y-3">
              <span className="text-4xl block">🔍</span>
              <p className="text-sm font-medium">アイテムをクリックして、詳細表示や全員で共有できる攻略メモを書き込みましょう！</p>
            </div>
          ) : !activeSelectedItem ? (
            <div className="text-center py-20 text-gray-500">
              選択されたアイテムのデータが見つかりません。
            </div>
          ) : (
            <div className="space-y-6">
              {/* アイテムヘッダー部分 */}
              <div className="flex items-center gap-4 border-b border-gray-800 pb-5">
                <div className="w-16 h-16 rounded-2xl bg-gray-950 flex items-center justify-center p-2 border border-gray-800 relative shadow-inner">
                  <img src={activeSelectedItem.image_url} alt={activeSelectedItem.name} className="w-12 h-12 object-contain" />
                </div>
                <div className="space-y-1 min-w-0">
                  <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
                    {activeSelectedItem.type === 'amulet' ? 'お守り' : activeSelectedItem.type === 'stamp' ? 'スタンプ' : 'ルーン'}
                  </span>
                  <h2 className="font-black text-lg text-white truncate leading-snug">{activeSelectedItem.name}</h2>
                </div>
              </div>

              {/* ゲーム内の効果テキスト */}
              <div className="bg-gray-950/80 border border-gray-800/80 rounded-2xl p-4 space-y-2">
                <span className="text-[10px] text-gray-500 font-extrabold uppercase tracking-wide block">効果・説明文</span>
                <p className="text-sm text-gray-300 leading-relaxed font-medium">{activeSelectedItem.effect_text}</p>
              </div>

              {/* 強化ツリー（相互参照） */}
              {(activeSelectedItem.upgrade_from || activeSelectedItem.upgrade_to) && (
                <div className="bg-yellow-500/5 rounded-2xl border border-yellow-500/10 p-4 space-y-2 text-xs">
                  <span className="text-[10px] text-yellow-500/70 font-extrabold uppercase tracking-wide block">💡 強化リレーション</span>
                  <div className="flex flex-col gap-2">
                    {activeSelectedItem.upgrade_from && (
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">強化元:</span>
                        {findItemByItemId(activeSelectedItem.upgrade_from) ? (
                          <button 
                            onClick={() => setSelectedItemId(activeSelectedItem.upgrade_from!)}
                            className="text-yellow-600 hover:underline hover:text-yellow-500 font-semibold"
                          >
                            {findItemByItemId(activeSelectedItem.upgrade_from)!.name}
                          </button>
                        ) : (
                          <span className="text-gray-500 font-mono text-[11px]">{activeSelectedItem.upgrade_from}</span>
                        )}
                      </div>
                    )}
                    {activeSelectedItem.upgrade_to && (
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">強化先:</span>
                        {findItemByItemId(activeSelectedItem.upgrade_to) ? (
                          <button 
                            onClick={() => setSelectedItemId(activeSelectedItem.upgrade_to!)}
                            className="text-yellow-600 hover:underline hover:text-yellow-500 font-semibold"
                          >
                            {findItemByItemId(activeSelectedItem.upgrade_to)!.name}
                          </button>
                        ) : (
                          <span className="text-gray-500 font-mono text-[11px]">{activeSelectedItem.upgrade_to}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 共有攻略メモ（Wiki）セクション */}
              <div className="space-y-4 border-t border-gray-800 pt-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-extrabold text-white flex items-center gap-1.5">
                    📝 ユーザー共有攻略メモ (Wiki)
                  </h3>
                  {activeComment && activeComment.version > 0 && (
                    <span className="text-[10px] bg-gray-800 text-gray-400 font-mono px-2 py-0.5 rounded border border-gray-700">
                      Ver. {activeComment.version}
                    </span>
                  )}
                </div>

                {/* 前回の更新者メタ情報 */}
                {activeComment && activeComment.updated_by_name && (
                  <div className="text-[11px] text-gray-500">
                    最終更新: <span className="font-bold text-gray-400">{activeComment.updated_by_name}</span> 
                    {activeComment.updated_at && (
                      <span> ({new Date(activeComment.updated_at.toMillis ? activeComment.updated_at.toMillis() : activeComment.updated_at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })})</span>
                    )}
                  </div>
                )}

                {/* 編集フォーム */}
                {user ? (
                  <div className="space-y-3">
                    <textarea
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="このお守りの組み合わせや有効な戦術、使い方など、みんなで共有する攻略メモを書き込みましょう。（Markdown対応予定）"
                      className="w-full h-32 bg-gray-950 border border-gray-800 hover:border-gray-700 focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500/20 text-gray-200 placeholder-gray-600 rounded-xl p-3 text-sm focus:outline-none transition-all resize-none leading-relaxed"
                    />

                    {errorMessage && (
                      <div className="bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs p-3 rounded-lg leading-relaxed">
                        {errorMessage}
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-3">
                      {saveStatus === 'success' && (
                        <span className="text-xs text-green-500 font-bold flex items-center gap-1">
                          ✓ 保存しました！
                        </span>
                      )}
                      <button
                        onClick={handleSaveComment}
                        disabled={saveStatus === 'saving'}
                        className="px-5 py-2.5 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-gray-950 font-black rounded-lg text-xs shadow-md transition-all cursor-pointer"
                      >
                        {saveStatus === 'saving' ? '保存中...' : '攻略メモを更新する'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bg-gray-950/80 border border-gray-800 rounded-2xl p-4 text-center space-y-3">
                    <p className="text-xs text-gray-400 leading-relaxed">
                      このアイテムの攻略メモ（Wiki）を閲覧しています。ログインすると、あなたも共同編集に参加できます。
                    </p>
                    {activeComment && activeComment.content ? (
                      <div className="text-left py-2.5 px-3 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                        {activeComment.content}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-600 italic">
                        現在、攻略メモはありません。
                      </p>
                    )}
                    <button
                      onClick={handleLogin}
                      className="inline-block px-4 py-2 bg-gray-800 hover:bg-gray-700 text-yellow-500 font-bold rounded-lg text-xs border border-gray-700 transition-colors cursor-pointer"
                    >
                      ログインして編集に参加
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
