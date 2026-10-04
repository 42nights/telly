# Health app plan

This file summarizes the approved plan for the new health application in this repository.
The full planning board is [`board.html`](board.html). GitHub issues track all implementation work.
The product name is not decided yet.

## Product

The app helps a person with memory loss and their family. Alzheimer's care is the first focus.

- **Medicine:** find a medicine box in a phone or browser camera frame and draw a marker and an arrow on that frame.
- **Requests:** accept voice or text requests. Reply with screen text and multilingual audio.
- **Family:** send family messages and health alerts. Family members ask questions about available health records.
- **Reports:** generate, review, and fill a lab report. Send it to the hospital after a delivery path is chosen; Finchnode only reads records.
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
| Family agents | Gemini | Family chat agents; their data tools run through Fetch.ai |
| Tool routing | Fetch.ai Agentverse (required) | Routes agent tool requests to the service API |
| Voice | ElevenLabs (required) | Multilingual speech |
| Vision | Gemini | Object detection for medicine boxes |
| Messaging | SpacetimeDB | Stores family messages (Muse is not used) |
| Reports | Finchnode | Reads lab results for reports (read only; no delivery API) |
| iMessage | Photon Spectrum Cloud (Free plan) | Answers allowlisted senders (`TELLY_IMESSAGE_SENDERS`); synthetic demo family only |
| WHOOP data | NOOP (friend-owned) | Only the NOOP-to-server connection is stubbed |

### NOOP boundary

NOOP is the existing WHOOP app. Its source and documentation are in [`noop/`](../noop), separate from the new application. A teammate owns its integration.
The new server stubs only the NOOP-to-server connection. It returns `{"status":"not_connected","source":"noop"}`.
The stub does no transport, ingestion, or database write. It supplies no readings and no WHOOP-derived nudges.
Clients show "NOOP not connected". Other data sources stay available with their own provenance.
The [WHOOP capability catalog](../noop/whoop/health-fields.html) lists every field that NOOP collects, as typed placeholders. It is a reference, not a connection; #27 owns its typed contract.

### Rules that apply to every change

- Clients import only `@health/contracts`. Only the server imports database code.
- Decode every external value (network replies, provider replies, device events) with a shared schema.
- Provider keys stay on the server. `VITE_*` and `EXPO_PUBLIC_*` values are public.
- Persist an alert and its pending delivery together. Keep queued, sent, failed, and acknowledged states separate.
- A model outage must not suppress a valid alert. Keep model explanations outside threshold evaluation.
- Never commit secrets, real health records beyond the existing WHOOP reference samples, recordings, or model weights.

## Repository layout

The new application is the Bun workspace at the repository root, generated with Better-T-Stack.
NOOP is a separate project in `noop/`. The new application does not import or build NOOP source.

```text
apps/web/             Web HUD and family dashboard
apps/native/          Expo phone app
apps/server/          Node + Hono + Effect service
packages/contracts/   Shared Effect Schema contracts
packages/config/      Shared strict TypeScript configuration
packages/ui/          Generated shadcn/ui components for the web app
noop/                 NOOP (separate project)
```

Issues add `spacetimedb/` (database module), `packages/db/` (generated bindings, server-only), `agents/fetch/` (Python Agentverse worker), and `training/gemma/` (Python training).

## Owners

| Person | GitHub | Areas |
| --- | --- | --- |
| Jerry | `undeemed` | Workspace and CI, web HUD, Gemini vision and medicine markers, ElevenLabs voice, lab-report UI, phone app, family dashboard, Gemini family conversations, SpacetimeDB, threshold alerts and durable delivery, data quality, Fetch.ai Agentverse, Finchnode lab results, River setup, Gemma training and inference, service reliability |
| Ayaan | `ayaangazali` | NOOP connection boundary, optional Meta glasses SDK bridge and square layout |

On 2026-10-04 every issue that Mahesh (`maheshwarmurugesan`) owned was reassigned to `undeemed`. Mahesh wrote the October 3 backlog (#25–#51). The same day, Ayaan's scope narrowed to NOOP and the Meta glasses SDK, and his other issues moved to `undeemed`.

## Build order

1. Workspace, contracts, CI, and issue templates.
2. Database module and generated server bindings.
3. Phone and web flows against the contracts, with no paired device.
4. Real providers, then the synthetic sample-to-alert smoke test.
5. Deployment to the approved target.
6. Optional glasses adapter, verified on hardware separately.

Step 5 deploys to the team's Cloudflare account, with SpacetimeDB Maincloud and Google sign-in (decided 2026-10-04). Data retention, hospital delivery, the River base model and spend, live NOOP data, Photon iMessage access, and public source or agent publication are separate open decisions.

## Planning board

[`board.html`](board.html) is one static HTML file with no build step and no network data.
Open it directly in a browser, or serve the folder: `python3 -m http.server 45500 -d docs`, then go to `http://127.0.0.1:45500/board.html`.

- **Flows:** each demo flow and each October 3 backlog flow links its GitHub issues. "Flow details" shows the trigger, required context, prompt, allowed replies, next action, failure, sharing, and completion.
- **Placeholders:** wireframe values in `{braces}` are typed placeholders, not readings. People and messages are synthetic. Thresholds are family-set, not clinical.
- **Reports:** dated lab results (Finchnode, read only) stay separate from wearable observations.
- **WHOOP:** the board links the catalog and separates confirmed BLE capability, unavailable data, unvalidated data, and deferred hardware research.

## Coordination

Work is issue-first. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the claim, progress, and handoff rules.
