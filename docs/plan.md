# Health app plan

This file summarizes the approved plan for the new health application in this repository.
The full planning board is archived as [`board.html`](board.html). GitHub issues track all implementation work.
The product name is not decided yet.

## Product

The app helps a person with memory loss and their family. Alzheimer's care is the first focus.

- **Medicine:** find a medicine box in a phone or browser camera frame and draw a marker and an arrow on that frame.
- **Requests:** accept voice or text requests. Reply with screen text and multilingual audio.
- **Family:** send family messages and health alerts. Family members ask questions about available health records.
- **Reports:** generate, review, fill, and send a lab report to the hospital.
- **Monitoring:** detect falls and breathing problems only from validated signals. Show missing signals as "unavailable", never as "all clear".

Phone and web are the primary interfaces. Every feature works without glasses.
Meta Ray-Ban Display glasses are an optional input and output adapter. They never gate startup or a feature.
A 3D home map is not required.

## Architecture

| Part | Technology | Role |
| --- | --- | --- |
| Web HUD and family dashboard | React, Vite, TanStack Router | Camera markers, requests, messages, alerts, reports |
| Phone app | Expo (React Native) | Camera, microphone, screen markers, family app |
| Service | Node, Hono, Effect 4 | HTTP routing (Hono), service logic and resources (Effect) |
| Data | SpacetimeDB | Health data, alerts, messages, acknowledgements |
| Contracts | Effect Schema in `@health/contracts` | One source for request and response shapes |
| Model training | Gemma on River AI | Health cues; inference runs in the cloud, not on the glasses |
| Family agents | Grokbot | Family chat agents |
| Tool routing | Fetch.ai Agentverse (required) | Routes agent tool requests to the service API |
| Voice | ElevenLabs (required) | Multilingual speech |
| Vision | Gemini | Object detection for medicine boxes |
| Messaging | Grokbot | Carries family messages (Muse is not used) |
| Reports | Finchnode | Hospital report handoff |
| WHOOP data | NOOP (friend-owned) | Only the NOOP-to-server connection is stubbed |

### NOOP boundary

NOOP is the existing WHOOP app in this repository. A teammate owns its integration.
The new server stubs only the NOOP-to-server connection. It returns `{"status":"not_connected","source":"noop"}`.
The stub does no transport, ingestion, or database write. It supplies no readings and no WHOOP-derived nudges.
Clients show "NOOP not connected". Other data sources stay available with their own provenance.

### Rules that apply to every change

- Clients import only `@health/contracts`. Only the server imports database code.
- Decode every external value (network replies, provider replies, device events) with a shared schema.
- Provider keys stay on the server. `VITE_*` and `EXPO_PUBLIC_*` values are public.
- Persist an alert and its pending delivery together. Keep queued, sent, failed, and acknowledged states separate.
- A model outage must not suppress a valid alert. Keep model explanations outside threshold evaluation.
- Never commit secrets, real health records beyond the existing WHOOP reference samples, recordings, or model weights.

## Repository layout

The new application lives in [`health/`](../health), generated with Better-T-Stack.
It is not at the repository root for two reasons. A root `packages/` folder collides with NOOP's `Packages/` on case-insensitive file systems (macOS). Sentrux cannot exclude paths, so one folder keeps its gate on the new app only.

```text
health/
  apps/web/             Web HUD and family dashboard
  apps/native/          Expo phone app
  apps/server/          Node + Hono + Effect service
  packages/contracts/   Shared Effect Schema contracts
  packages/config/      Shared strict TypeScript configuration
  packages/ui/          Generated shadcn/ui components for the web app
```

Issues add `health/spacetimedb/` (database module), `health/packages/db/` (generated bindings, server-only), `health/agents/fetch/` (Python Agentverse worker), and `health/training/gemma/` (Python training).

## Owners

| Person | GitHub | Areas |
| --- | --- | --- |
| Jerry | `undeemed` | Workspace and CI, phone app, family dashboard, Gemma training and inference, Grokbot family conversations, service reliability, optional glasses bridge |
| Ayaan | `ayaangazali` | SpacetimeDB, threshold alerts and durable delivery, data quality, NOOP connection boundary, Fetch.ai Agentverse, Finchnode handoff, River setup |
| Mahesh | `maheshwarmurugesan` | Web HUD, Gemini vision and medicine markers, ElevenLabs voice, lab-report UI, optional square glasses layout |

## Build order

1. Workspace, contracts, CI, and issue templates.
2. Database module and generated server bindings.
3. Phone and web flows against the contracts, with no paired device.
4. Real providers, then the synthetic sample-to-alert smoke test.
5. Deployment to the approved target.
6. Optional glasses adapter, verified on hardware separately.

## Coordination

Work is issue-first. See [`health/CONTRIBUTING.md`](../health/CONTRIBUTING.md) for the claim, progress, and handoff rules.
