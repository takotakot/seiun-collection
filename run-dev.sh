#!/bin/bash
# Astro 開発サーバー（エミュレータ接続用環境付き）を起動します。
export PUBLIC_FIREBASE_USE_EMULATOR="true"
cd web && npm run dev
