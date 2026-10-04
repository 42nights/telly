# Deployment

Issue #2. Target (captain decision `telly-cd-target`): the 42nights Cloudflare account.

| Part | Where |
| --- | --- |
| Web app and API | Worker `telly`, `https://saintess.tech` (custom domain). `https://telly.jerry-2c0.workers.dev` also answers. `/health` and `/api/*` go to the Node API in one Cloudflare Container (`telly-api`); every other path serves the web app. |
| Domain | Zone `saintess.tech` on 42nights (Free plan), registered at get.tech with the zone's Cloudflare nameservers. `saintess.tech` and `www.saintess.tech` are custom domains of the Worker `telly`. A zone redirect rule sends `www` to `https://saintess.tech` (301). |
| Database | SpacetimeDB Maincloud, database `telly` (`wss://maincloud.spacetimedb.com`), published by the captain's SpacetimeDB login. |
| Sign-in | Google (`https://accounts.google.com`), OAuth client `telly-web` in the Google Cloud project `Telly`. Its redirect URIs are `/sign-in` and `/api/sign-in/callback` on each web host. The consent screen is in Testing mode: only listed test users can sign in. |
| Keys | The shared key store (docs/cloudflare-keys.md). The container pulls only the keys in `TELLY_PULL_KEYS` at start. |
| Reports bucket | R2 bucket `telly-reports` on 42nights, private. Its bucket-only token is `TELLY_R2_*` in the shared key store. |

Public settings are in `deploy/cloudflare/settings.env`. Nothing secret is in the repository or in the build artifact.

## Deploy

CI (`.github/workflows/health-deploy.yml`) builds one artifact, deploys it, and smoke-checks it on each push to `main`. It needs, set by the repository owner:

- variables `HEALTH_SERVER_URL` and `HEALTH_WEB_URL`: `https://saintess.tech`
- secrets `TELLY_DEPLOY_CLOUDFLARE_API_TOKEN` and `TELLY_SECRETS_PULL_TOKEN`: copy them from the shared key store by hand.

From an operator machine, with the two secrets in your environment and `crane`, `jq`, and `bun` installed:

```bash
bun run --filter server build
set -a; . deploy/cloudflare/settings.env; set +a
NODE_ENV=production VITE_SERVER_URL="$HEALTH_SERVER_URL" VITE_OIDC_ISSUER="$OIDC_ISSUER" \
  VITE_OIDC_CLIENT_ID="$OIDC_AUDIENCE" bun run --filter web build
sh scripts/pack-health.sh health.tar.gz
sh deploy/cloudflare/deploy.sh health.tar.gz
node apps/server/scripts/smoke.ts https://saintess.tech
```

Each deploy restarts the container with the new image and settings. The first request after a deploy can take about 35 seconds.

## Rollback

Re-run the deploy and smoke jobs of the last good workflow run. They redeploy that run's artifact. Its image tag is the artifact digest, so it is the same image.
