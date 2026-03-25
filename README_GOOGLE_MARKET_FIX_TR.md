# Cardgame server Google login + market fix v2

Bu pakette hazır gelen dosyalar:

- `package.json`
- `src/server.js`
- `src/http/auth.js`
- `src/http/app_actions.js`
- `src/db/store.js`
- `src/shared/google_identity.js`
- `src/shared/google_play.js`

## Zorunlu ortam değişkenleri

- `JWT_SECRET`
- `GOOGLE_WEB_CLIENT_ID`
- `GOOGLE_PLAY_PACKAGE_NAME=com.oncartokey.app`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={...tam service account json...}`

## Notlar

- `npm install` çalıştırılmadan deploy etmeyin.
- `google-auth-library` bağımlılığı bu pakette gerekiyor.
- Market verify logları bilinçli olarak eklendi. Render loglarında `[STORE_VERIFY]` diye aratın.
- Service account Play Console tarafında yetkili olmalı.
