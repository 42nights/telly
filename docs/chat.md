# Family chat backend

This document describes the server part of #11: family messages, and the plan for family questions. Plan: [`plan.md`](plan.md) (Family, Family agents, Messaging) and [`board.html`](board.html) (flow "How is Mom sleeping?").

## Family messages (mounted)

The routes are relative to `/api/families/:familyId`. They are behind the API core sign-in and the family membership check (`FamilyEnv` in `apps/server/src/http.ts`). The contracts are in `@health/contracts/chat` (`packages/contracts/src/chat.ts`).

| Route | Request | Reply |
| --- | --- | --- |
| `GET /messages?after=<id>` | Optional cursor: a message id | `FamilyMessages`: the messages after `after`, oldest first, at most 200 |
| `POST /messages` | `SendFamilyMessage { clientId, body }` | 201 `FamilyMessage` |

Errors use `ApiError`:

- 400 `invalid_request`: the body or the cursor is not valid, or the `clientId` is already used for a different body.
- 401 `unauthorized`: no valid sign-in.
- 403 `forbidden`: the caller is not a member of the family. The database module also refuses the write.

The client makes a `clientId` (letters, digits, `_`, `-`, at most 128) one time for each message. After a lost reply, it sends the same `clientId` again. The database module (`sendMessage` in `spacetimedb/src/index.ts`) keeps the first stored copy, so the message is stored one time. To catch up after a disconnect, the client reads `GET /messages?after=<last id>`.

## Family questions

By captain decision, Gemini is the only chat model for family questions, and ElevenLabs stays for speech. Grok is not used. The Gemini adapter and the question routes (`POST /ask`, `POST /ask/voice`) are described in [`ask.md`](ask.md). The provider-independent family tools belong to this area.

- `familyTools(fetchAgent, familyId, now, timeZone?)` in `apps/server/src/family-tools.ts` gives the chat adapter `rules` (instructions that keep the answer tied to the records), `tools` (JSON Schema function specs from `@health/contracts/tools`), `run(name, args, signal?)`, and `cited()` (`CitedRecords` in `@health/contracts/chat`: each sample read with source and a `stale` flag, each alert read, and each metric with no records). Every `run` goes through Fetch.ai Agentverse with `callAgentTool` from PR #65. Bad arguments return `{ error }` to the model without a call. A Fetch.ai or server failure rejects with `ApiFailure`, so the answer stops instead of continuing without the data.
- An answer gives each value with its source and source time, says when data is synthetic, unvalidated, or stale, and reports missing data as unavailable. NOOP stays not connected.
- A family message that must reach a person outside the app will use the alert outbox seam (`AlertTransport` in `apps/server/src/alerts/outbox.ts`). That keeps delivery durable and keeps "sent" separate from "acknowledged".

Earlier question-route work with Grok is not the selected provider. It is kept on branch `fm/telly-grok-ask-wip` for reference only.

## Verification

`bun run db:test` runs `apps/server/src/routes/chat.test.ts` on the real app against a real local SpacetimeDB, with a test-only OIDC issuer on 127.0.0.1.
