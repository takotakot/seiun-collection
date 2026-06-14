#!/bin/bash
# ローカルエミュレータ上の Firestore（port: 8080）および Storage（port: 9199）に対してマスタデータと画像プールをシーディングします。
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export FIREBASE_STORAGE_EMULATOR_HOST="127.0.0.1:9199"

echo "1. 画像プールの転送と初期化を開始します..."
node admin-tools/seed-pool.js

echo ""
echo "2. マスタデータの投入および自動アタッチを開始します..."
node admin-tools/seed.js
