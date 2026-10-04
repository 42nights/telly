# health

The health app: web HUD and family dashboard, Expo phone app, and a Node server (Hono for HTTP, Effect 4 for service logic). The plan is [`docs/plan.md`](../docs/plan.md); work is coordinated through GitHub issues as described in [`CONTRIBUTING.md`](CONTRIBUTING.md). Every feature works without glasses.

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack) 3.44.2 (`--frontend tanstack-router native-bare --backend hono --runtime node --addons biome --package-manager bun`), then extended with shared contracts, Effect, and the CI gates.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **React Native** - Build mobile apps using React
- **Expo** - Tools for React Native development
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **Hono** - Lightweight, performant server framework
- **Node.js** - Runtime environment
- **Biome** - Linting and formatting

## Getting Started

First, install the dependencies:

```bash
bun install
```

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
Use the Expo Go app to run the mobile application. On a physical phone, set `EXPO_PUBLIC_SERVER_URL` in `apps/native/.env` to your computer's LAN address (for example `http://192.168.1.20:3000`), and start the server with `HOST=0.0.0.0`.
The API is running at [http://localhost:3000](http://localhost:3000): `GET /health` and `GET /api/sources`.

The NOOP-to-server connection is a stub: `GET /api/sources` reports NOOP as `not_connected`, and the clients show "NOOP not connected". It never returns readings or WHOOP-based nudges.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@health/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Environment Configuration

Each app owns its environment schema in `.env.schema`. Varlock generates `src/env.ts` during installation; run `bun run env:generate` after changing a schema. Commit schemas, and keep secrets in ignored env files or your deployment platform.

Import the generated `ENV` accessor in application code. Shared database and auth packages receive configuration or initialized clients from the application. See [Varlock's monorepo guide](https://varlock.dev/guides/monorepos/).

Bun's automatic env loading is disabled in `bunfig.toml`; the framework integration or server bootstrap loads Varlock. Node deployments must include Varlock and its dependencies alongside the app schema.

Run standalone Node/Bun tools that use Varlock from the owning app directory so they load that app's schema and env files. `env:generate` only generates TypeScript files; it does not initialize environment values in a subsequent command.

## Git Hooks and Formatting

- Run checks: `bun run check`

## CI on Namespace

The `check` and `structure` jobs in `.github/workflows/health.yml` run on the runner that the repository variable `HEALTH_RUNNER` names. When it is unset, they run on `ubuntu-latest`. `changes` and `required` always run on `ubuntu-latest`, so `health / required` reports even when no Namespace runner is available. Tracked in #21.

Status: not connected. No Namespace workflow run has passed yet.

To connect (repository owner only, because the Namespace Runners app needs `Administration: Read and write` on the repository):

1. Sign in at [cloud.namespace.so](https://cloud.namespace.so) on the Developer plan. Do not start a paid plan.
2. Open [GitHub runners](https://cloud.namespace.so/workspace/ghrunners), install the Namespace Runners app, and select only `ayaangazali/telly`.
3. Set the repository variable: `gh variable set HEALTH_RUNNER --body nscloud-ubuntu-24.04-amd64-2x4 -R ayaangazali/telly`.
4. Run the workflow: `gh workflow run health.yml -R ayaangazali/telly`. Each `check` and `structure` log must show a Namespace runner.

Use Linux AMD64 with Ubuntu 24.04: the Sentrux release is an x86-64 binary, and its fallback installs `libgtk-3-0t64`, which exists only on Ubuntu 24.04. The 2x4 shape (2 vCPU, 4 GB) is the smallest standard shape. The largest local process (`check-types`) peaks at about 1.5 GB. If a job runs out of memory, use `nscloud-ubuntu-24.04-amd64-4x8`.

To return to GitHub-hosted runners, delete the variable: `gh variable delete HEALTH_RUNNER -R ayaangazali/telly`.

## Project Structure

```
health/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   ├── native/      # Mobile application (React Native, Expo)
│   └── server/      # Backend API (Hono + Effect); src/integrations/noop.ts is the NOOP stub
├── packages/
│   ├── contracts/   # Effect Schema API contracts, shared by every app
│   ├── config/      # Strict shared TypeScript configuration
│   ├── ui/          # Shared shadcn/ui components and styles (web only)
```

Clients import only `@health/contracts` (and the web app `@health/ui`). Only the server may import database code. Fallow and Sentrux enforce these boundaries in CI.

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:server`: Start only the server
- `bun run check-types`: Check TypeScript types across all apps
- `bun run dev:native`: Start the React Native/Expo development server
- `bun run check`: Run Biome formatting and linting (writes fixes)
- `bun run lint`: Biome in CI mode (no writes)
- `bun run test`: Behavior tests (`bun test`)
- `bun run smoke`: Run the built server under Node and check its real responses (run `bun run --filter server build` first)
- `bun run check:quality`: Fallow (unused code, duplication, complexity, import boundaries)
- `bun run check:structure`: Sentrux rules and regression gate (needs the `sentrux` binary)
