# Healer S.I.

Healer S.I. is an application for a person with memory loss and their family. Alzheimer's care is the first focus. The repository is named `telly`.

The repository has two separate projects:

- The **health application** at the repository root: a web HUD and family dashboard, an Expo phone app, and a Node server (Hono for HTTP, Effect 4 for service logic).
- The **Healer S.I. WHOOP app**, an on-device WHOOP companion based on [NOOP](https://github.com/ryanbr/noop), in [`noop/`](noop). Read [`noop/README.md`](noop/README.md) for the WHOOP app itself. The health application does not use its source code.

This software is not a medical device. It makes no medical safety claims.

## Status

The repository has a runnable workspace and contracts. The product features are not built yet.

Done:

- A Bun workspace with a web app, a phone app, a server, and shared packages.
- Shared Effect Schema API contracts in `@health/contracts`.
- The server answers `GET /health` and `GET /api/sources`.
- A stub for the Healer S.I.-to-server connection. `GET /api/sources` reports Healer S.I. as `not_connected`, and the clients show "Healer S.I. not connected". The stub has no transport, ingestion, or database write. It returns no readings and no WHOOP-based nudges.
- CI checks: lint, types, tests, Fallow, Sentrux, and a build and runtime smoke test of the server.

Not done (each item has a GitHub issue):

- Database (SpacetimeDB) and generated server bindings.
- Medicine markers, voice and text requests, family messages and alerts, lab reports, and fall and breathing detection.
- Provider integrations: Gemini, ElevenLabs, Grokbot, Fetch.ai Agentverse, Finchnode, and Gemma on River AI. No provider is connected.
- Deployment. No hosted instance exists.
- The optional Meta Ray-Ban Display glasses adapter.
- Namespace CI runners ([#21](https://github.com/ayaangazali/telly/issues/21)). The Namespace Runners app is installed and `HEALTH_RUNNER` is set to `nscloud-ubuntu-24.04-amd64-2x4`. The first passing Namespace run is still to be recorded on #21.

The product scope, owners, and build order are in [`docs/plan.md`](docs/plan.md). Open work is in the [GitHub issues](https://github.com/ayaangazali/telly/issues).

## Requirements

- [Bun](https://bun.sh) 1.4.2 (the version in `package.json`).
- Node.js 24 for the server build and the smoke test.
- [Sentrux](https://github.com/sentrux/sentrux) only for `bun run check:structure`.
- Expo Go on a phone, or an iOS or Android simulator, for the phone app.

## Run

Run all commands from the repository root.

```bash
bun install
bun run dev
```

- Web app: <http://localhost:3001>
- Server: <http://localhost:3000> (`GET /health`, `GET /api/sources`)
- Phone app: open it in Expo Go. On a physical phone, set `EXPO_PUBLIC_SERVER_URL` in `apps/native/.env` to the LAN address of your computer (for example `http://192.168.1.20:3000`). Then start the server with `HOST=0.0.0.0`.

To start one app only, use `bun run dev:web`, `bun run dev:server`, or `bun run dev:native`.

Each app keeps its environment schema in `.env.schema`. Varlock generates `src/env.ts` during `bun install`. Run `bun run env:generate` after you change a schema. Keep secrets in ignored env files, never in Git.

## Check

```bash
bun run lint              # Biome, no writes
bun run check-types       # TypeScript in every package
bun run test              # Behavior tests
bun run check:quality     # Fallow: unused code, duplication, complexity, import boundaries
bun run check:structure   # Sentrux rules and regression gate
bun run --filter server build && bun run smoke   # Real server responses under Node
bun run build             # Production build of every app
```

`bun run check` runs Biome and writes fixes.

### CI on Namespace

The `check` and `structure` jobs in `.github/workflows/health.yml` run on the runner that the repository variable `HEALTH_RUNNER` names. When it is unset, they run on `ubuntu-latest`. `changes` and `required` always run on `ubuntu-latest`, so `health / required` reports even when no Namespace runner is available. Tracked in #21.

To connect (repository owner only, because the Namespace Runners app needs `Administration: Read and write` on the repository):

1. Sign in at [cloud.namespace.so](https://cloud.namespace.so) on the Developer plan. Do not start a paid plan.
2. Open [GitHub runners](https://cloud.namespace.so/workspace/ghrunners), install the Namespace Runners app, and select only `ayaangazali/telly`.
3. Set the repository variable: `gh variable set HEALTH_RUNNER --body nscloud-ubuntu-24.04-amd64-2x4 -R ayaangazali/telly`.
4. Run the workflow: `gh workflow run health.yml -R ayaangazali/telly`. Each `check` and `structure` log must show a Namespace runner.

Use Linux AMD64 with Ubuntu 24.04: the Sentrux release is an x86-64 binary, and its fallback installs `libgtk-3-0t64`, which exists only on Ubuntu 24.04. The 2x4 shape (2 vCPU, 4 GB) is the smallest standard shape. The largest local process (`check-types`) peaks at about 1.5 GB. If a job runs out of memory, use `nscloud-ubuntu-24.04-amd64-4x8`.

To return to GitHub-hosted runners, delete the variable: `gh variable delete HEALTH_RUNNER -R ayaangazali/telly`.

## Layout

```text
apps/
  web/          Web HUD and family dashboard (React, Vite, TanStack Router)
  native/       Phone app (Expo, React Native)
  server/       Server (Node, Hono, Effect); src/integrations/noop.ts is the Healer S.I. stub
packages/
  contracts/    Shared Effect Schema API contracts
  config/       Shared strict TypeScript configuration
  ui/           shadcn/ui components for the web app
docs/           Plan and planning board
noop/           Healer S.I., a separate project (see noop/README.md)
```

Clients import only `@health/contracts`, and the web app also imports `@health/ui`. Only the server can import database code. Fallow and Sentrux enforce these rules in CI.

## Contributing

Work is issue-first. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the claim, progress, and handoff rules.

Healer S.I. keeps its own license and contributor rules. See [`noop/README.md`](noop/README.md).
