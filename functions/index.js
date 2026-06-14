import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp();

const db = getFirestore();
const auth = getAuth();

/**
 * 日次で稼働し、最終活動日時が187日以上前であるユーザー情報を
 * Auth および Firestore サブコレクションも含め、一括かつ再帰的（recursiveDelete）に削除するクリーンアップ関数。
 */
export const cleanupInactiveUsers = onSchedule('every day 04:00', async (event) => {
  logger.info('不活動アカウント自動削除バッチ（cleanupInactiveUsers）を開始します。', { structuredData: true });

  const now = Date.now();
  const LIMIT_DAYS = 187;
  const LIMIT_MS = LIMIT_DAYS * 24 * 60 * 60 * 1000;
  const expirationThreshold = new Date(now - LIMIT_MS);

  logger.info(`不活動判定のしきい値時刻: ${expirationThreshold.toISOString()}`);

  try {
    // 最終活動日時がしきい値よりも古いドキュメントを抽出する
    const usersSnapshot = await db.collection('users')
      .where('last_active_at', '<', expirationThreshold)
      .get();

    logger.info(`不活動判定されたユーザー候補数: ${usersSnapshot.size}件`);

    if (usersSnapshot.empty) {
      logger.info('クリーンアップの対象となる不活動ユーザーはいませんでした。');
      return;
    }

    let deletedCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      logger.info(`ユーザー [${userId}] の詳細削除プロセスを開始します...`);

      // 1. Firebase Auth からのアカウント削除
      try {
        await auth.deleteUser(userId);
        logger.info(`Authアカウント削除完了: ${userId}`);
      } catch (authError) {
        if (authError.code === 'auth/user-not-found') {
          logger.warn(`Authアカウントは既に存在しません: ${userId}`);
        } else {
          logger.error(`Authアカウント [${userId}] の削除に失敗しました:`, authError);
          // Firestore 側の不整合を直すためにFirestore削除は続行する
        }
      }

      // 2. Firestore から該当ユーザーに紐づくすべてのデータ（ユーザー本体 ＆ collections サブコレクション）をrecursiveDeleteで一括削除
      try {
        const userDocRef = db.collection('users').doc(userId);
        await db.recursiveDelete(userDocRef);
        logger.info(`Firestoreデータの一括再帰削除完了: ${userId}`);
        deletedCount++;
      } catch (firestoreError) {
        logger.error(`Firestoreデータ [${userId}] の再帰削除に失敗しました:`, firestoreError);
      }
    }

    logger.info(`不活動アカウントのクリーンアップバッチが正常に完了しました。削除完了ユーザー数: ${deletedCount}件`);
  } catch (error) {
    logger.error('不活動アカウントの削除プロセス中に致命的なエラーが発生しました:', error);
  }
});
