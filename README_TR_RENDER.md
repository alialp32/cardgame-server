# OnCartOkey Node Backend - Render + Railway

## Environment variables
- `DATABASE_URL` = Railway Public Network connection URL
- `JWT_SECRET` = güçlü bir gizli anahtar
- `GOOGLE_WEB_CLIENT_ID` = `202054668701-4d7tdcqsu69qsgvs38283qmcah2drjbc.apps.googleusercontent.com`
- `NODE_ENV` = `production`
- `APP_TOKEN_TTL_DAYS` kullanmıyor; JWT ile çalışıyor

## Render
Build Command:
`npm install`

Start Command:
`npm start`

## Routes
- `GET /health`
- `GET /db-test`
- `POST /auth/login`
- `POST /auth/google`
- mevcut `/tables`, `/admin` ve WebSocket akışı korunur.

## Google login request body
```json
{
  "idToken": "GOOGLE_ID_TOKEN"
}
```

## Not
Render tek port açtığı için HTTP ve WebSocket aynı server üstünde çalışacak şekilde güncellendi.
