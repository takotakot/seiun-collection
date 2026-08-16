export PATH="$HOME/.nodenv/shims:$PATH"
cd web && PUBLIC_FIREBASE_USE_EMULATOR="false" PUBLIC_FIREBASE_PROJECT_ID="seiun-collection-prd" npm run build:prd
cd ..
firebase --project=seiun-collection-prd deploy --only hosting
