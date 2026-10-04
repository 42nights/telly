# Shared keys in the Telly Cloudflare account

Plan: [board section 08](board.html#keys) (`#keys`, `#key-rules`, `#key-operations`). Issue: #23.

The team keeps the server keys in the Secrets Store of one shared Telly Cloudflare account. Each teammate signs in as an individual account member with MFA. Nobody uses a shared password or the Global API Key.

Never put a key value in this repository, an issue, a PR, a log, CI output, an agent prompt, or a `VITE_*` / `EXPO_PUBLIC_*` variable. Compare copies by sha256 only.

## Key names

The server keys are the items in `apps/server/.env.schema` without `@public`. The scripts read that list from the schema, so a new key needs only a schema item.

| Key | Used for | Without it |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini chat, medicine detection, family questions | Those routes answer `unavailable` |
| `ELEVENLABS_API_KEY` | ElevenLabs transcription and speech | Voice routes answer `unavailable` |
| `TELLY_FETCH_BRIDGE_TOKEN` | Fetch.ai bridge calls | Agent tool calls answer `unavailable` |
| `FINCHNODE_API_KEY` | FinchNode `api` mode | Only `off` or `demo` mode works |
| `RIVER_API_KEY` | The Gemma cue model on River | The cue route answers `unavailable` |
| `ALERT_OPERATOR_TOKEN` | The alert outbox | Deliveries stay queued |

The teammate who holds the provider account owns its key. Record the owner and key name on the issue, never the value.

## How the server gets the keys

Secrets Store gives values only to a Worker binding; the dashboard and the API return metadata. Cloudflare bindings do not reach the Node server. So the one retrieval path is:

1. The Worker `telly-secrets` (`apps/server/scripts/cloudflare-keys-worker.ts`) binds every Telly secret and answers `GET` with `NAME=value` lines.
2. A Cloudflare Access app protects its hostname. Only the service token `telly-secrets-pull` gets in. The Worker also verifies the Access JWT: issuer, audience, expiry, signature, and the token's client id. Anything else gets `403`.
3. `bun run secrets:pull` writes the lines to a mode-600 env file, plus `TELLY_REQUIRED_KEYS` with each key it wrote.
4. The server loads that file. If a key in `TELLY_REQUIRED_KEYS` is missing or empty, startup fails and names the key, never the value.

Varlock redacts the keys in logs, because every server key is `@sensitive`. Redaction is not encryption: the process and the host administrators can still read the keys.

## One-time account setup (account administrator)

1. Invite each teammate under **Manage Account → Members** with only the roles they need. Each teammate turns on MFA.
2. Create the account Secrets Store (**Secrets Store → Create store**) if it does not exist.
3. Pick the Worker hostname: a route on a Telly zone, or the account's `workers.dev` subdomain.
4. Create the service token `telly-secrets-pull` (**Zero Trust → Access → Service credentials → Service Tokens**). Give its client id and secret to the server operator by hand; never through chat, an issue, or a repository.
5. Create the self-hosted Access app `telly-secrets` on the Worker hostname. Its only policy: action **Service Auth**, include only the service token `telly-secrets-pull`.

## Upload keys (each teammate)

1. Create your own API token under **My Profile → API Tokens**, for the Telly account only, with:
   - Account › Secrets Store › Edit
   - Account › Workers Scripts › Edit
   - Account › Access: Apps and Policies › Read
   - Account › Access: Service Tokens › Read
   - Account › Access: Organizations, Identity Providers, and Groups › Read
2. Write it to `~/.config/telly/cloudflare.env` at mode 600:

   ```bash
   mkdir -p ~/.config/telly && chmod 700 ~/.config/telly
   install -m 600 /dev/null ~/.config/telly/cloudflare.env
   "${EDITOR:-nano}" ~/.config/telly/cloudflare.env   # CLOUDFLARE_ACCOUNT_ID=…, CLOUDFLARE_API_TOKEN=…
   ```

3. Put the keys you upload in a private mode-600 env file, one `NAME=value` per line, then run:

   ```bash
   bun run secrets:push /path/to/keys.env
   ```

The script uploads only server keys and lists every other name as skipped. It refuses an empty value and a value that needs quotes. It refuses to overwrite a same-named secret that it did not create (comment `telly`). Then it redeploys the Worker with a binding for every Telly secret, including the ones that other teammates uploaded, and lists their names and change times.

Anyone who can deploy the Worker can make it read the secrets, so give the Workers Scripts permission only to teammates who upload keys.

## Retrieve keys (server operator)

1. Write the pull credentials to `~/.config/telly/secrets-pull.env` at mode 600, in the same way as the upload token:

   ```text
   TELLY_SECRETS_URL=https://<worker hostname>/
   TELLY_SECRETS_ACCESS_CLIENT_ID=…
   TELLY_SECRETS_ACCESS_CLIENT_SECRET=…
   ```

2. Pull, then start the server:

   ```bash
   bun run secrets:pull                       # writes apps/server/.env.local
   bun run secrets:pull /run/secrets/telly.env  # or a host path for a deployment
   ```

On an HTTP status other than `200`, or on any invalid line, the existing file stays unchanged. The pull replaces the whole file, so keep local non-secret settings in `apps/server/.env`.

Existing environment variables override the file. Remove a stale injected key before you rotate it; otherwise it hides the pulled value, and an empty one stops startup.

## Rotate a key

1. Issue a replacement key in the provider console.
2. Upload it: `bun run secrets:push /path/to/keys.env`.
3. Pull it on each server: `bun run secrets:pull`.
4. Restart the server.
5. Make one real request that uses the key, and look for a success.
6. Revoke the old key in the provider console.

If a key is exposed, revoke it immediately. Removing it from a comment or from Git history does not make it safe.

## Revoke server access

Delete the service token `telly-secrets-pull` in Zero Trust. Retrieval then stops for every host. Create a new token with the same name and put it in the Access app policy. Run `bun run secrets:push` again so that the Worker accepts its client id, then give the new credentials to the remaining servers. A lost host still holds the keys that it pulled, so rotate each of them.
