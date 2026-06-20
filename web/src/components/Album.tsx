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
  const [colsMode, setColsMode] = useState<'responsive' | 'fixed6'>('responsive');

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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
      {/* 左カラム (1/3幅) : コントロール・詳細/攻略メモ・カテゴリタブ */}
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
                  <img src={activeSelectedItem.image_url} alt={activeSelectedItem.name} className="w-10 h-10 object-contain" />
                </div>
                <div className="space-y-1 min-w-0">
                  <span className="text-[9px] tracking-wider font-extrabold px-1.5 py-0.5 rounded bg-[#ffa248] text-[#633307] border border-[#633307]/20">
                    {activeSelectedItem.type === 'amulet' ? 'お守り' : activeSelectedItem.type === 'stamp' ? 'スタンプ' : 'ルーン石'}
                  </span>
                  <h2 className="font-black text-sm sm:text-base text-[#523621] truncate leading-snug">{activeSelectedItem.name}</h2>
                </div>
              </div>

              {/* ゲーム内の効果テキスト */}
              <div className="bg-[#ebe0c5] border border-[#d6ccb0] rounded-2xl p-3.5 space-y-1 shadow-inner">
                <span className="text-[9px] text-[#8a684b] font-extrabold tracking-wide block">効果・説明文</span>
                <p className="text-xs text-[#523621] leading-relaxed font-bold">{activeSelectedItem.effect_text}</p>
              </div>

              {/* 強化ツリー（相互参照） */}
              {(activeSelectedItem.upgrade_from || activeSelectedItem.upgrade_to) && (
                <div className="bg-[#ffa248]/10 rounded-2xl border border-[#ffa248]/30 p-3 space-y-1.5 text-[11px]">
                  <span className="text-[9px] text-[#b06c28] font-extrabold tracking-wide block">💡 強化リレーション</span>
                  <div className="flex flex-col gap-1.5">
                    {activeSelectedItem.upgrade_from && (
                      <div className="flex items-center justify-between">
                        <span className="text-[#8a684b] font-bold">強化元:</span>
                        {findItemByItemId(activeSelectedItem.upgrade_from) ? (
                          <button 
                            onClick={() => setSelectedItemId(activeSelectedItem.upgrade_from!)}
                            className="text-[#b06c28] hover:underline font-black text-left"
                          >
                            {findItemByItemId(activeSelectedItem.upgrade_from)!.name}
                          </button>
                        ) : (
                          <span className="text-[#8a684b] font-mono text-[10px]">{activeSelectedItem.upgrade_from}</span>
                        )}
                      </div>
                    )}
                    {activeSelectedItem.upgrade_to && (
                      <div className="flex items-center justify-between">
                        <span className="text-[#8a684b] font-bold">強化先:</span>
                        {findItemByItemId(activeSelectedItem.upgrade_to) ? (
                          <button 
                            onClick={() => setSelectedItemId(activeSelectedItem.upgrade_to!)}
                            className="text-[#b06c28] hover:underline font-black text-left"
                          >
                            {findItemByItemId(activeSelectedItem.upgrade_to)!.name}
                          </button>
                        ) : (
                          <span className="text-[#8a684b] font-mono text-[10px]">{activeSelectedItem.upgrade_to}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

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

                {/* 前回の更新者メタ情報 */}
                {activeComment && activeComment.updated_by_name && (
                  <div className="text-[10px] text-[#8a684b] font-bold">
                    最終更新: <span className="text-[#523621]">{activeComment.updated_by_name}</span> 
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
          <div className="text-xs text-indigo-300 font-bold mb-1 font-game">カテゴリ切り替え</div>
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

      {/* 右カラム (2/3幅) : アルバムフレーム・プログレスバー */}
      <div className="lg:col-span-2 space-y-6 order-1 lg:order-2">
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
        <div className="bg-album-paper border-[8px] border-[#3c3566] rounded-3xl p-5 sm:p-8 shadow-[0_15px_40px_rgba(0,0,0,0.5)] relative">
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
                    onClick={() => setColsMode('responsive')}
                    className={`px-2 py-0.5 rounded transition-all cursor-pointer ${colsMode === 'responsive' ? 'bg-[#ffa248] text-[#633307] shadow-sm' : 'hover:bg-[#dfd9c1]/50'}`}
                  >
                    自動調整
                  </button>
                  <button 
                    onClick={() => setColsMode('fixed6')}
                    className={`px-2 py-0.5 rounded transition-all cursor-pointer ${colsMode === 'fixed6' ? 'bg-[#ffa248] text-[#633307] shadow-sm' : 'hover:bg-[#dfd9c1]/50'}`}
                  >
                    6列固定
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
                  : "grid grid-cols-2 min-[450px]:grid-cols-3 md:grid-cols-4 gap-4"
              }>
                {filteredItems.map((item) => {
                  const isOwned = !!ownedItemsMap[`${item.generation}_${item.itemId}`];
                  const isSelected = selectedItemId === item.itemId;
                  const isAmulet = item.type === 'amulet';
                  const hasUpgrade = !!(item.upgrade_from || item.upgrade_to);

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

                        {/* 画像エリア (所持時は緑グラデ、未所持時はベージュ) */}
                        <div 
                          className={`relative aspect-square w-full flex items-center justify-center p-3 overflow-hidden transition-all ${
                            isOwned 
                              ? 'bg-gradient-to-b from-[#64a56c] to-[#47804f]' 
                              : 'bg-[#d6d0b9]'
                          }`}
                        >
                          {/* 未所持のハテナマーク */}
                          {!isOwned && (
                            <div className={`absolute inset-0 flex items-center justify-center text-white/90 font-black select-none ${
                              colsMode === 'fixed6' ? 'text-4xl' : 'text-6xl'
                            }`}>
                              ?
                            </div>
                          )}

                          <img 
                            src={item.image_url} 
                            alt={item.name}
                            className={`object-contain transition-all duration-300 ${
                              colsMode === 'fixed6'
                                ? 'w-10 h-10 sm:w-11 sm:h-11'
                                : 'w-20 h-20 sm:w-22 sm:h-22'
                            } ${
                              isOwned 
                                ? 'opacity-100 scale-100 drop-shadow-[0_4px_8px_rgba(0,0,0,0.25)]' 
                                : 'opacity-10 grayscale brightness-75 scale-95'
                            }`}
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />

                          {/* 強化マーク (上矢印) */}
                          {hasUpgrade && (
                            <div className={`absolute bottom-1.5 left-1.5 flex items-center justify-center rounded-lg border-2 shadow-sm ${
                              colsMode === 'fixed6' ? 'w-5 h-5 border-[#633307]/50' : 'w-6 h-6'
                            } ${
                              isOwned 
                                ? 'bg-[#ffa248] border-[#633307] text-[#633307]' 
                                : 'bg-[#b8b39e] border-[#7c7764] text-[#7c7764]'
                            }`}>
                              <span className={`font-black ${colsMode === 'fixed6' ? 'text-[10px]' : 'text-xs'}`}>↑</span>
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
                          <img 
                            src={item.image_url} 
                            alt={item.name}
                            className={`object-contain transition-all duration-300 ${
                              colsMode === 'fixed6'
                                ? 'w-10 h-10'
                                : item.type === 'stamp' ? 'w-18 h-18 sm:w-20 sm:h-20' : 'w-20 h-20 sm:w-22 sm:h-22'
                            } ${
                              isOwned 
                                ? 'opacity-100 scale-100 drop-shadow-[0_4px_10px_rgba(0,0,0,0.15)]' 
                                : 'opacity-25 grayscale brightness-50 scale-95'
                            }`}
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />

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
    </div>
  );
}
