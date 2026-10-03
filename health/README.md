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
