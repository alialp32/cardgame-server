# Auth + Google Link + Promo

Bu sürümde aşağıdaki backend endpointleri eklendi:

- `GET /auth/methods`
- `POST /auth/google/link`
- `POST /app/promo/redeem`
- `POST /app/promo/bootstrap` (yalnızca admin)

## Notlar

- `POST /auth/google` artık aynı e-postalı yerel hesabı otomatik bağlamaz.
- Yerel hesap ile aynı Google e-postası varsa kullanıcıdan önce normal giriş yapıp Hesap Merkezi'nden Google bağlaması istenir.
- Promo tabloları sunucu açılışında `CREATE TABLE IF NOT EXISTS` ile hazırlanır.
- DB kullanıcısının tablo oluşturma yetkisi yoksa promo bootstrap başarısız olabilir. Bu durumda SQL dosyasını elle çalıştır.

## Örnek istekler

### Auth methods

```bash
curl -H "Authorization: Bearer TOKEN" https://YOUR_HOST/auth/methods
```

### Google link

```bash
curl -X POST https://YOUR_HOST/auth/google/link \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"idToken":"GOOGLE_ID_TOKEN"}'
```

### Promo redeem

```bash
curl -X POST https://YOUR_HOST/app/promo/redeem \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"HOSGELDIN500"}'
```
