# Deployment

Issue #2. Target (captain decision `telly-cd-target`): the 42nights Cloudflare account.

| Part | Where |
| --- | --- |
| Web app and API | Worker `telly`. The web app is at `https://app.saintess.tech`; the API is at `https://api.saintess.tech`. Both are custom domains of the Worker. `https://telly.jerry-2c0.workers.dev` also answers. `/health` and `/api/*` go to the Node API in one Cloudflare Container (`telly-api`); every other path serves the web app. |
| Landing page | `https://saintess.tech`, also a custom domain of the Worker `telly`. On `LANDING_HOST` the Worker serves the static files in `deploy/cloudflare/landing/`, including `/privacy` and `/terms` for the Google OAuth consent screen, and sends any other path (an app route) to `https://app.saintess.tech`. |
| Domain | Zone `saintess.tech` on 42nights (Free plan), registered at get.tech with the zone's Cloudflare nameservers. A zone redirect rule sends `www.saintess.tech` to `https://saintess.tech` (301). |
| Fetch.ai tools | The live worker and bridge run on the team host ([agents/fetch/README.md](../agents/fetch/README.md#live-api)). The API calls the bridge at `TELLY_FETCH_BRIDGE_URL`, the host's Tailscale Funnel, which exposes only `POST /tool-call`. The bridge reaches the worker through Agentverse mailboxes. |
| Database | SpacetimeDB Maincloud, database `telly` (`wss://maincloud.spacetimedb.com`), published by the captain's SpacetimeDB login. |
| Sign-in | Google (`https://accounts.google.com`), OAuth client `telly-web` in the Google Cloud project `Telly`. Its redirect URIs are `/sign-in` on each web host and `/api/sign-in/callback` on each API host. The consent screen is in Testing mode: only listed test users can sign in. |
| Keys | The shared key store (docs/cloudflare-keys.md). The container pulls only the keys in `TELLY_PULL_KEYS` at start. |
| Reports bucket | R2 bucket `telly-reports` on 42nights, private. Its bucket-only token is `TELLY_R2_*` in the shared key store. |

Public settings are in `deploy/cloudflare/settings.env`. Nothing secret is in the repository or in the build artifact.

## Deploy

CI (`.github/workflows/health-deploy.yml`) builds one artifact, deploys it, and smoke-checks it on each push to `main`. It needs, set by the repository owner:

- variables `HEALTH_SERVER_URL`: `https://api.saintess.tech`, and `HEALTH_WEB_URL`: `https://app.saintess.tech`
- secrets `TELLY_DEPLOY_CLOUDFLARE_API_TOKEN` and `TELLY_SECRETS_PULL_TOKEN`: copy them from the shared key store by hand.
- optional secret `SPACETIMEDB_TOKEN`: a SpacetimeDB login token that owns the Maincloud database `telly`. With it, the deploy job publishes the module before the Worker (never with `--delete-data`). Without it, the host auto-deploy below publishes the module.

Until the secrets are set (#184), CI skips the deploy. From an operator machine, release the checked-out commit with one command. It publishes the SpacetimeDB module to Maincloud without deleting data, then builds, packs, and deploys the Worker. It needs `bun`, `jq`, `crane`, and `spacetime` on `PATH` and the credential files named at the top of `deploy/cloudflare/release.sh`:

```bash
sh deploy/cloudflare/release.sh
```

If the module change needs a data wipe or breaks clients, the publish stops at its prompt and the Worker is not deployed. Never add `--delete-data`.

`deploy/cloudflare/deploy.sh` writes the image tag once, with the entrypoint set, and checks the entrypoint before it deploys. It then waits for the container rollout to finish and fails unless `/health` answers 200 within 2 minutes. Until the rollout finishes, the old instances still answer, so a check before that proves nothing.

`https://app.saintess.tech/version.txt` shows the live commit. Each deploy restarts the container with the new image and settings, and the container pulls its keys again. The first request after a deploy can take about 35 seconds.

### Auto-deploy from the operator host

The systemd user timer `telly-autodeploy` checks `origin/main` every 60 s. When main moved, `deploy/cloudflare/autodeploy.sh` runs `release.sh` from its own clone (`~/.local/share/telly-autodeploy/telly`), one run at a time. It does not retry a failed commit. It needs `gh` signed in.

- It waits while the commit's `health-deploy` run is unfinished. If that run's `deploy` job succeeded, it publishes only the module (`TELLY_RELEASE_PART=module`), so CI and the host never deploy the same Worker twice.
- After a healthy release it keeps the artifact. If a release fails and `/health` is not 200, it deploys that last healthy artifact again.
- State is in `~/.local/state/telly-autodeploy/`: `deployed`, `failed`, and `good.tar.gz`.

```bash
# install (crane in ~/.local/share/telly-autodeploy/bin or on PATH)
git clone https://github.com/ayaangazali/telly.git ~/.local/share/telly-autodeploy/telly
cp deploy/cloudflare/autodeploy.sh ~/.local/share/telly-autodeploy/
cp deploy/cloudflare/telly-autodeploy.service deploy/cloudflare/telly-autodeploy.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now telly-autodeploy.timer
# stop / start / logs
systemctl --user stop telly-autodeploy.timer
systemctl --user start telly-autodeploy.timer
journalctl --user -u telly-autodeploy.service -f
```

## Care grants backfill (#188)

Families created before #188 have no care grants, so their routes answer 403. After you publish the module with #188, run this once with the login that first published database `telly` (the module's operator):

```bash
spacetime call --server maincloud telly backfill_founder_care_grants
```

It gives the founder of each family that has no grant event every care scope. It deletes nothing, and a second call changes nothing.

## Rollback

Re-run the deploy and smoke jobs of the last good workflow run. They redeploy that run's artifact, and the same artifact and base image give the same image tag. On the operator host, deploy a kept artifact: `sh deploy/cloudflare/deploy.sh ~/.local/state/telly-autodeploy/good.tar.gz` with the two secrets in your environment. A Worker rollback alone (`wrangler rollback`) does not change the container image.
