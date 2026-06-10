# VM2026 Web Push Worker

Den har Workern tar emot web push-prenumerationer, sparar dem i Cloudflare KV och kan skicka notiser till alla prenumeranter.

## Setup

1. Installera beroenden:

```powershell
npm install
```

2. Skapa en KV namespace:

```powershell
npx wrangler kv namespace create PUSH_SUBSCRIPTIONS
```

Kopiera `id` till `workers/push/wrangler.toml`.

3. Skapa VAPID-nycklar:

```powershell
npx web-push generate-vapid-keys
```

4. Lagg in secrets:

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY --config workers/push/wrangler.toml
npx wrangler secret put VAPID_PRIVATE_KEY --config workers/push/wrangler.toml
npx wrangler secret put ADMIN_PUSH_TOKEN --config workers/push/wrangler.toml
```

5. Deploya:

```powershell
npm run push:deploy
```

6. Koppla en Cloudflare route till Workern, till exempel:

```text
vm2026.info/api/push*
```

Klientsidan anropar `/api/push`, sa route och site maste ligga pa samma doman.
