# Family chat backend

This document describes the server part of #11: family messages and questions to the Grokbot family agent. Plan: [`plan.md`](plan.md) (Family, Family agents, Messaging) and [`board.html`](board.html) (flow "How is Mom sleeping?").

## Routes

All routes are relative to `/api/families/:familyId`. They are behind the API core sign-in and the family membership check. Contracts are in `@health/contracts/chat` (`packages/contracts/src/chat.ts`).

| Route | Request | Reply |
| --- | --- | --- |
| `GET /messages?after=<id>` | Optional cursor: a message id | `FamilyMessages`: the messages after `after`, oldest first, at most 200 |
| `POST /messages` | `SendFamilyMessage { clientId, body }` | 201 `FamilyMessage` |
| `POST /ask` | `FamilyQuestion { question, timeZone? }` | `FamilyAnswer { answer, evidence, alerts, unavailable, model, answeredAt }` |
| `POST /ask/voice?timeZone=` | Raw recording, `audio/*`, at most 10 MiB | `VoiceAnswer { transcript, answer, speech }` |

Errors use `ApiError`:

- 400 `invalid_request`: the body, cursor, time zone, or recording is not valid, or a `clientId` is used again for a different body.
- 401 `unauthorized` and 403 `forbidden`: from the API core sign-in and membership check. The database also refuses writes from non-members.
- 503 `unavailable`: Grokbot, Fetch.ai tool routing, or ElevenLabs transcription is not configured or not reachable.
- 502 `upstream_error`: a provider sent an error, an invalid reply, or no answer.

### Messages

The client makes a `clientId` (letters, digits, `_`, `-`, at most 128) one time for each message. It sends the same `clientId` again after a lost reply. The database module keeps the first stored copy, so the message is stored one time. To catch up after a disconnect, the client reads `GET /messages?after=<last id>`.

### Questions

The Grokbot agent gets the question and the closed Fetch.ai tool set from `@health/contracts/tools` (`health_samples`, `alerts`). Every tool call goes through the Fetch.ai Agentverse caller (`AgentToolCaller` in `apps/server/src/family-agent.ts`). The agent never reads records around Fetch.ai.

The server fills `evidence`, `alerts`, and `unavailable` from the tool replies, not from the model text:

- `evidence`: each sample with its source, source time, receive time, quality, synthetic flag, and `stale` (source time more than 24 hours old).
- `unavailable`: each metric that the agent looked for and that has no records.

The instructions tell the model to use only tool results, to give the source and time of each value, to report missing data as unavailable, and to give no WHOOP data. NOOP stays not connected.

A family question does not send a notification, so it does not wake the wearer.

### Voice questions

`POST /ask/voice` uses the ElevenLabs adapter from #63: it transcribes the recording, answers the transcript, and speaks the answer in the detected language. When speech fails, the reply keeps the text answer and sets `speech.status` to `unavailable` or `upstream_error`.

## Configuration

| Name | Use |
| --- | --- |
| `XAI_API_KEY` | Server-only xAI API key. Unset: questions answer 503 `unavailable`. |
| `GROKBOT_MODEL` | xAI model id. Default `grok-4.7`. |
| `XAI_BASE_URL` | xAI API base URL. Default `https://api.x.ai/v1`. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Voice, from #63. |

## Grokbot provider: decision needed

The plan names "Grokbot" for the family agents. The adapter (`apps/server/src/integrations/grokbot.ts`) calls a Grok model through the xAI Responses API. This is not the xAI Grok Bot app. The decision to accept it is open.

Primary sources:

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview) and [Create and manage Bots](https://docs.x.ai/grok-bot/bots): Grok Bot is a desktop and mobile app. Each Bot works on a cloud computer. A person messages the Bot in the app. Access comes with Cursor plans or a SuperGrok subscription.
- [Team Bots](https://docs.x.ai/grok-bot/team-bots): a Bot can call out to tools through plugins and custom MCP servers ("Remote HTTPS"). The Grok Bot pages document no API that lets a server send a message to a Bot and get the reply.
- [Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses) and [Function calling](https://docs.x.ai/developers/tools/function-calling): `POST https://api.x.ai/v1/responses` with an `XAI_API_KEY`. The model asks for function calls, the server runs them and returns the results, and the model answers. `store: false` keeps no copy for later retrieval.

Functional difference:

| | Grok Bot app | xAI Responses API (this adapter) |
| --- | --- | --- |
| Who starts a conversation | A person in the Grok Bot app | The telly server, for a signed-in family member |
| Where the answer shows | In the Grok Bot app | In the telly phone and web apps, through `POST /ask` |
| Tools | Plugins or an MCP server that the Bot calls | Function tools that the server runs for one family |
| Access | Cursor plan or SuperGrok subscription | xAI API key, billed for each request |
| Memory | The Bot keeps memory across sessions | None; each question is separate, and `store: false` |

Options:

1. Accept the xAI Responses API as the Grokbot family agent.
2. Use a Grok Bot Team Bot that calls a telly MCP tool server. Family chat then happens in the Grok Bot app, not in the telly apps.
3. Block #11 until a Grok Bot server API is available.

## Open prerequisites

- An approved source for `XAI_API_KEY`. No live xAI round trip has run.
- A Node caller from the server to the Fetch.ai uAgents worker (owner: Fetch.ai backend, #7), and approved Agentverse access. Until then, `POST /ask` and `POST /ask/voice` answer 503 `unavailable`.
- The Grokbot provider decision above.

## Verification

`bun run db:test` runs `apps/server/src/routes/chat.test.ts` against a real local SpacetimeDB. The OIDC issuer, the xAI server, the ElevenLabs server, and the Fetch.ai caller in that test are local stand-ins. The tests prove the routes, authorization, idempotency, evidence, and errors. They do not prove a live provider round trip.
