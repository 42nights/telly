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

## Family questions (not in this change)

By captain decision, family questions use the Grok Voice API. The Grok Bot app and a text-only Responses API agent are not used. The voice transport, the session routes, and the short-lived credentials belong to the Grok integration task. The question orchestration and the agent's data tools belong to this area.

- The agent's data tools go through Fetch.ai Agentverse with `callAgentTool(config.fetchAgent, familyId, request, signal)` from PR #65. They never call the tool helper directly.
- An answer gives each value with its source and source time, says when data is synthetic, unvalidated, or stale, and reports missing data as unavailable. NOOP stays not connected.
- A family message that must reach a person outside the app will use the alert outbox seam (`AlertTransport` in `apps/server/src/alerts/outbox.ts`). That keeps delivery durable and keeps "sent" separate from "acknowledged".

Earlier question-route work (an unselected Responses API agent and the `/ask` routes) is kept on branch `fm/telly-grok-ask-wip` for reference only.

## Verification

`bun run db:test` runs `apps/server/src/routes/chat.test.ts` on the real app against a real local SpacetimeDB, with a test-only OIDC issuer on 127.0.0.1.
