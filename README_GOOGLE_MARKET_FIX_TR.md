# Google Login + Market düzeltme paketi

Bu pakette aşağıdaki backend eksikleri kapatıldı:

- `POST /auth/google` doğrudan Google girişini doğrular.
- Aynı e-postalı mevcut hesap için otomatik Google bağlama desteği eklendi.
- `GET /app/store` market katalog uç noktası eklendi.
- `POST /app/store/google/verify` Google Play satın alma doğrulama ucu eklendi.
- Satın alma token'ı için idempotent kayıt tablosu eklendi.

## Render / Railway ortam değişkenleri

Zorunlu:

- `JWT_SECRET`
- `GOOGLE_WEB_CLIENT_ID=202054668701-4d7tdcqsu69qsgvs38283qmcah2drjbc.apps.googleusercontent.com`
- `GOOGLE_PLAY_PACKAGE_NAME=com.oncartokey.app`

Google Play doğrulama için aşağıdakilerden biri zorunlu:

### Tek JSON ile

- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={...tam servis hesabı json...}`

### Ayrı alanlar ile

- `GOOGLE_SERVICE_ACCOUNT_EMAIL=...`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n`

Opsiyonel:

- `GOOGLE_AUTO_LINK_EXISTING_EMAIL=true`
- `STORE_PACKAGES_JSON=[{"productId":"chips_100","chips":100,"title":"100 Çip","priceText":"₺29,99"}, ...]`

## Değiştirilecek dosyalar

- `package.json`
- `src/server.js`
- `src/http/auth.js`
- `src/http/app_actions.js`
- `src/db/store.js` (yeni)
- `src/shared/google_identity.js` (yeni)
- `src/shared/google_play.js` (yeni)

## Deploy notları

1. Dosyaları repoya koy.
2. `npm install` çalıştır.
3. Render ortam değişkenlerini gir.
4. Google Play servis hesabına Play Console > API access üzerinden uygulama erişimi ver.
5. Kapalı test cihazı lisans test kullanıcısı olsun.
