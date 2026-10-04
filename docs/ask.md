# Family questions API

Backend for family questions ([#86](https://github.com/ayaangazali/telly/issues/86), part of [#11](https://github.com/ayaangazali/telly/issues/11) and [#16](https://github.com/ayaangazali/telly/issues/16)). Gemini answers the question. Its data tools run through Fetch.ai Agentverse. ElevenLabs transcribes and speaks voice questions. Plan: [`docs/plan.md`](plan.md) (Family, Requests) and the board flow "How is Mom sleeping?".

Schemas: `@health/contracts/ask` (`packages/contracts/src/ask.ts`). Routes: `apps/server/src/routes/ask.ts`. Gemini adapter: `apps/server/src/integrations/gemini-chat.ts`. Question logic (tools, evidence, freshness): `apps/server/src/family-agent.ts`.

## Routes

Both routes are under `/api/families/:familyId`. They need a valid bearer token, and the caller must be a member of the family.

| Method and path | Request | Success |
|---|---|---|
| `POST /ask` | JSON `FamilyQuestion { question, timeZone? }`. `question` has 1 to 2000 characters. `timeZone` is an IANA zone; the default is UTC. Other keys are rejected. | `200` JSON `FamilyAnswer { answer, evidence, alerts, unavailable, model, answeredAt }` |
| `POST /ask/voice` | Raw recording, `Content-Type: audio/*`, at most 10 MiB. Optional `?timeZone=`. | `200` JSON `VoiceAnswer { transcript, answer, speech }` |

The server fills `evidence`, `alerts`, and `unavailable` from the records that the tool calls returned, not from the model's text. A sample is `stale` when its source time is more than 24 hours old. `unavailable` names each metric that had no records. Missing data is never an all-clear.

`speech` is `{ status: "ok", languageCode, audio }` (base64 MP3, in the language of the question), or `{ status: "unavailable" | "upstream_error", message }`. The text answer stands when speech fails.

Errors use the `ApiError` JSON body:

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad body, unknown keys, bad time zone, or an empty, oversized, or non-audio recording |
| 401 | `unauthorized` | No valid sign-in token |
| 403 | `forbidden` | The caller is not a member of the family, or the tool route refused the call |
| 503 | `unavailable` | `GEMINI_API_KEY`, the Fetch.ai bridge, `ELEVENLABS_API_KEY` (voice only), or sign-in is not configured |
| 502 | `upstream_error` | Gemini or ElevenLabs failed, sent an invalid reply, or did not answer in time |

When the client disconnects, the server aborts the provider request and answers 499 with no body.

## Provider

- Gemini Interactions API, `POST {GEMINI_BASE_URL}/v1beta/interactions`, model `gemini-3.8-flash`, with function calling ([documentation](https://ai.google.dev/gemini-api/docs/function-calling)).
- Requests set `store: false`. The server sends the whole conversation each round, so Google keeps no copy for later retrieval.
- The tools are the Fetch.ai tool set in `@health/contracts/tools`. Each call goes through `callAgentTool`: bridge, Agentverse, worker, then `POST /api/families/:familyId/tools`. There is no direct database fallback.
- One provider request is bounded at 30 s. The model gets at most 4 tool rounds. Calls are not retried, because each call is billed and has no idempotency key.
- Every reply is validated. An empty, incomplete, or endless answer fails; the server never makes up an answer.
- The server does not log questions, answers, audio, records, or keys. Error messages carry only the failed step and the HTTP status.

## Configuration

These come from `apps/server/.env.schema` (Varlock). The vision route uses the same Gemini values.

- `GEMINI_API_KEY`: server-only.
- `GEMINI_BASE_URL`: the API origin. Set a local test server for isolated proofs.
- `TELLY_FETCH_BRIDGE_URL` and `TELLY_FETCH_BRIDGE_TOKEN`: the Fetch.ai bridge.
- `ELEVENLABS_*`: voice, as in [`voice.md`](voice.md).
