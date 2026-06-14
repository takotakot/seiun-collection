import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcvite from '@tailwindcss/vite';
import { loadEnv } from 'vite';

// 本番ビルド時の環境変数チェック（Failsafe）
if (process.env.IS_PRD_BUILD === 'true') {
  const env = loadEnv(process.env.NODE_ENV || 'production', process.cwd(), 'PUBLIC_');
  
  const useEmulator = env.PUBLIC_FIREBASE_USE_EMULATOR;
  const projectId = env.PUBLIC_FIREBASE_PROJECT_ID;
  const apiKey = env.PUBLIC_FIREBASE_API_KEY;

  if (useEmulator === 'true' || useEmulator !== 'false') {
    throw new Error('❌ [Build Error] 本番ビルド(build:prd)では PUBLIC_FIREBASE_USE_EMULATOR を "false" に設定する必要があります。');
  }

  if (!projectId || projectId === 'demo-seiun-collection-app') {
    throw new Error(`❌ [Build Error] 本番のプロジェクトIDが設定されていません。現在の設定: "${projectId || '未指定'}"`);
  }

  if (!apiKey || apiKey === 'dummy-api-key-for-local-dev-only') {
    throw new Error('❌ [Build Error] 本番の PUBLIC_FIREBASE_API_KEY が設定されていません。');
  }
}

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcvite()]
  }
});
