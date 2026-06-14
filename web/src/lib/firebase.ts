import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getAuth, connectAuthEmulator } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY || "dummy-api-key-for-local-dev-only",
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN || "demo-seiun-collection-app.firebaseapp.com",
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID || "demo-seiun-collection-app",
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET || "demo-seiun-collection-app.appspot.com",
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "1234567890",
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID || "1:1234567890:web:abcdef123456"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);
const auth = getAuth(app);

// 必要に応じて Firestore / Auth のエミュレータに接続する
if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
  // もし明示的にエミュレータを使う環境変数がある場合、または接続テスト用
  if (import.meta.env.PUBLIC_FIREBASE_USE_EMULATOR === 'true') {
    try {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099');
      console.log('Firebase emulators connected');
    } catch (e) {
      console.warn('Emulator connection warning:', e);
    }
  }
}

export { app, db, auth };
