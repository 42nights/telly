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
Name the variable and where it lives (for example "`GEMINI_API_KEY` in the server's Cloudflare
secrets"), never its value.

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
bun run db:test        # family-access tests on an isolated local SpacetimeDB (needs the spacetime CLI)
```

CI (`.github/workflows/health.yml`) runs these as parallel jobs. The single required status is
`health / required`. It fails if any check fails, is cancelled, or is skipped while the app changed.

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
  files outside `noop/` to a temporary directory and runs there. If a change makes the structure
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
