# Family chat backend

This document describes the server part of #11: family messages, and the Grokbot family agent. Plan: [`plan.md`](plan.md) (Family, Family agents, Messaging) and [`board.html`](board.html) (flow "How is Mom sleeping?").

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

## Grokbot family agent (not mounted)

`apps/server/src/integrations/grokbot.ts` is a Grok agent adapter. It sends the question and a set of function tools to the xAI Responses API, runs the tools that the model asks for, and returns the final text. It sets `store: false`, a 30 s timeout for each request, request cancellation, and a limit of 4 tool turns. A provider error, an invalid reply, an incomplete reply, or an empty answer is a typed `GrokbotError`. It is never a made-up answer.

No route uses the adapter yet. These items are open:

1. **Provider decision.** See below.
2. **Fetch.ai tool path.** The plan sends the agent's data tools through Fetch.ai Agentverse. PR #65 publishes the tool contract (`@health/contracts/tools`) and the Node caller `callAgentTool(config.fetchAgent, familyId, request, signal)` in `apps/server/src/integrations/fetch.ts`. The agent will call only `callAgentTool`, never the tool helper directly. A live Agentverse round trip needs two approved mailbox connections and the production worker identity.
3. **Credentials.** An approved source for `XAI_API_KEY`. No live xAI round trip has run.

A family message that must reach a person outside the app (Grokbot carries family messages in the plan) will use the alert outbox seam (`AlertTransport` in `apps/server/src/alerts/outbox.ts`) after the provider decision. That keeps delivery durable and keeps "sent" separate from "acknowledged".

The planned route is `POST /ask` (`{ question, timeZone? }`). Its reply holds the answer and, filled by the server from the tool replies, each sample read (source, source time, quality, synthetic flag, stale flag), each alert read, and each metric with no records. `POST /ask/voice` uses the ElevenLabs adapter from #63 to transcribe the question and to speak the answer in the question's language.

## Grokbot provider: decision needed

The plan names "Grokbot" for the family agents. The adapter calls a Grok model through the xAI Responses API. This is not the xAI Grok Bot app. The decision to accept it is open.

Primary sources:

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview) and [Create and manage Bots](https://docs.x.ai/grok-bot/bots): Grok Bot is a desktop and mobile app. Each Bot works on a cloud computer. A person messages the Bot in the app. Access comes with Cursor plans or a SuperGrok subscription.
- [Team Bots](https://docs.x.ai/grok-bot/team-bots): a Bot can call tools through plugins and custom MCP servers ("Remote HTTPS"). The Grok Bot pages document no API that lets a server send a message to a Bot and get the reply.
- [Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses) and [Function calling](https://docs.x.ai/developers/tools/function-calling): `POST https://api.x.ai/v1/responses` with an `XAI_API_KEY`. The model asks for function calls, the server runs them and returns the results, and the model answers.

Functional difference:

| | Grok Bot app | xAI Responses API (this adapter) |
| --- | --- | --- |
| Who starts a conversation | A person in the Grok Bot app | The telly server, for a signed-in family member |
| Where the answer shows | In the Grok Bot app | In the telly phone and web apps |
| Tools | Plugins or an MCP server that the Bot calls | Function tools that the server runs for one family |
| Access | Cursor plan or SuperGrok subscription | xAI API key, billed for each request |
| Memory | The Bot keeps memory across sessions | None; each question is separate, and `store: false` |

Options:

1. Accept the xAI Responses API as the Grokbot family agent.
2. Use a Grok Bot Team Bot that calls a telly MCP tool server. Family chat then happens in the Grok Bot app, not in the telly apps.
3. Block the agent part of #11 until a Grok Bot server API is available.

## Verification

- `bun run db:test` runs `apps/server/src/routes/chat.test.ts` on the real app against a real local SpacetimeDB, with a test-only OIDC issuer on 127.0.0.1.
- `bun test apps/server/src/integrations/grokbot.test.ts` runs the adapter against a local server that speaks the Responses API shape. This is local protocol proof, not a live xAI round trip.
