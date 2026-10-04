# Contributing to the health app

These rules apply to the health app at the repository root and to the health issues. NOOP is a
separate project in `noop/`; its own rules are in `noop/AGENTS.md` and `noop/docs/CONTRIBUTING.md`.
The plan is [`docs/plan.md`](docs/plan.md).

## Issue-first coordination

GitHub issues are the message board for people and their agents. Every change starts from an issue.

1. **Find or open an issue.** Use the "Health task" template. One issue is one bounded task, with an
   owner, affected paths, acceptance criteria, dependencies, and verification.
2. **Claim before you edit.** Comment `claim: <who>, <paths>` and assign yourself. Do not edit paths
   that another open, claimed issue lists. To share a file such as `packages/contracts`, agree in both
   issues first and record who owns the change.
3. **Post progress on the issue.** Comment when you start, when you are blocked (say on what), and
   when you hand off (state what is done, what is not, and how to continue). Agents post the same way.
4. **Open a pull request that references the issue** with `Refs #N`. Leave issue closure to the owner
   or a maintainer; do not use auto-closing keywords.
5. **Post the verification on the issue** before you close it: the commands you ran and what you saw.

Never put secret values, real health records, or personal data in issues, comments, logs, or commits.
Name the variable and where it lives (for example "`GEMINI_API_KEY` in the shared Telly Cloudflare
Secrets Store"), never its value.

## Provider keys

The plan is [board section 08](docs/board.html#keys). Issue #23 owns the key upload and the server
retrieval path. Issue #2 owns the Node host. Issue #49 owns the target record and these rules.

- **Target.** All Telly provider keys go in one account-level Cloudflare Secrets Store in the shared
  Telly Cloudflare account. Before the first write, post on #49 the account label, account ID, store
  ID, scopes, and environment (development or production). Do not create a second store or an
  unrelated Worker.
- **Access.** Use your own Cloudflare member login with MFA, or a scoped API token with Account
  Secrets Store Edit. Do not use a shared password or a Global API Key. Use only keys that the
  project gives you; do not copy other credentials from your machine.
- **Names.** Store each key under its server variable name in `apps/server/.env.schema`, such as
  `GEMINI_API_KEY`. Never put a key in a `VITE_*` or `EXPO_PUBLIC_*` variable or in sample data.
- **Write.** Run `bunx wrangler secrets-store secret create <store-id> --name <NAME> --scopes workers
  --remote` and type the value at the prompt. To replace a value, use `secret update <store-id>
  --secret-id <id> --remote`. Never use `--value`: it puts the value in shell history.
- **Verify.** Run `bunx wrangler secrets-store secret list <store-id> --remote`. It shows the name, ID,
  scopes, status, and created and modified times, never the value. A write is complete only when its
  name shows `active` with a modified time after the write started. If the command fails or the list
  does not agree, post the write as failed on the issue, with the key name and the error. Do not retry
  in a different store or environment.
- **Node runtime.** Cloudflare bindings do not reach the Node server, and the Secrets Store API
  returns metadata only. The server reads keys from its process environment or from ignored
  `apps/server/.env.*` files, which varlock checks against `.env.schema`. The operator gets the
  values through the #23 retrieval path into a file with mode 600 on the host, then restarts the
  server. Storing a key does not deploy or approve a host.
- **Rotate.** Issue a replacement key. Update only that secret, in the selected store and
  environment, and the host file. Restart, verify one real provider request, then revoke the old
  key. If a key is exposed, revoke it immediately.

## Before you push

Run from the repository root:

```bash
bun install
bun run check          # Biome format + lint, writes fixes
bun run check-types    # strict TypeScript across every workspace
bun run test           # behavior tests
bun run check:quality  # Fallow
bun run check:structure  # Sentrux, on the app only (needs the sentrux binary; CI runs it anyway)
bun run db:generate    # after a spacetimedb/ change; commit packages/db with it (needs the spacetime CLI)
bun run db:test        # family-access, connection-recovery, and server-lifecycle tests on an isolated local SpacetimeDB (needs the spacetime CLI)
bun run db:drill       # crash-restart and backup/restore drill on isolated local data (needs the spacetime CLI)
```

CI (`.github/workflows/health.yml`) runs these as parallel jobs. The single required status is
`health / required`. It fails unless change detection, every picked check, and `structure` succeed.
When no check covers the changed files, the one check `no app code changed` lists them and passes.

For work that depends on an open pull request, use a stack (`gh stack`). Run `gh stack init`, then
`gh stack add <branch>` for each next branch, and `gh stack submit` to open the pull requests. Health
CI runs on each pull request in the stack. To update the stack, run `gh stack sync`. Do not rebase,
retarget, or force-push stack branches by hand. Only firstmate merges a stack, with
`gh stack merge --merge --yes`. Never squash a stack.

## Rules the gates enforce

- **Types:** `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are on. Do not use
  `any`, unchecked casts, or `@ts-ignore` to get past an error.
- **Contracts:** request and response shapes live once, in `packages/contracts` (Effect Schema).
  Clients decode every response with `loadDecoded`; the server's replies use `satisfies <Contract>`.
- **Boundaries:** `apps/web` imports only `@health/contracts` and `@health/ui`. `apps/native` imports
  only `@health/contracts`. Only `apps/server` may import database code (`packages/db`). Contracts and
  database code import no app. Fallow (`.fallowrc.json`) checks package and relative imports; Sentrux
  (`.sentrux/rules.toml`) checks relative imports, cycles, and god files.
- **No dead code:** Fallow fails on unused files, exports, and dependencies, and on duplicated blocks.
  Delete what you do not use; do not add suppressions to make the check pass.
- **Sentrux baseline:** `bun run check:structure` fails when the structure gets worse than
  `.sentrux/baseline.json`. Sentrux cannot exclude paths, so `scripts/check-structure.sh` copies the
  files outside `noop/`, except the generated `packages/db/src/types/reducers.ts` (one import per
  reducer), to a temporary directory and runs there. If a change makes the structure
  legitimately different, run `sh scripts/check-structure.sh --save` and commit the new baseline in
  the same pull request, with the reason in the description. Never move the baseline only to turn a
  red check green. The script reads tracked and untracked, not ignored, files.
- **Tests:** keep the suite small. Add a test only for a real boundary: family access, data quality,
  durable delivery, or a contract that must reject bad input. Do not test wording, wiring, or
  configuration.

## Product rules

- Every feature works on the phone and the web without glasses. Glasses (Meta DAT) are an optional
  adapter and never gate startup or a feature.
- The NOOP-to-server connection stays a stub (`apps/server/src/integrations/noop.ts`) until the
  friend who owns NOOP hands it off. Never return readings, zeros, or WHOOP-based nudges from it.
- Show missing data as unavailable, never as "all clear".
- Provider keys stay on the server. `VITE_*` and `EXPO_PUBLIC_*` values are public.
