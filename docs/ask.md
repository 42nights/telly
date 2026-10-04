# Family questions API

Backend for family questions ([#86](https://github.com/ayaangazali/telly/issues/86), part of [#11](https://github.com/ayaangazali/telly/issues/11) and [#16](https://github.com/ayaangazali/telly/issues/16)). Gemini answers the question. Its data tools run through Fetch.ai Agentverse. ElevenLabs transcribes and speaks voice questions. Plan: [`docs/plan.md`](plan.md) (Family, Requests) and the board flow "How is Mom sleeping?".

Schemas: `@health/contracts/ask` (`packages/contracts/src/ask.ts`). Routes: `apps/server/src/routes/ask.ts`. Gemini adapter: `apps/server/src/integrations/gemini-chat.ts`. Family tools (tool list, evidence, freshness): `familyTools` in `apps/server/src/family-tools.ts`, described in [`chat.md`](chat.md).

## Routes

Both routes are under `/api/families/:familyId`. They need a valid bearer token, and the caller must be a member of the family.

| Method and path | Request | Success |
|---|---|---|
| `POST /ask` | JSON `FamilyQuestion { question, timeZone?, attachments? }`, at most about 10.7 MiB. `question` has 1 to 2000 characters. `timeZone` is an IANA zone; the default is UTC. Other keys are rejected. | `200` JSON `FamilyAnswer { answer, evidence, alerts, unavailable, model, answeredAt, followUps }` |
| `POST /ask/voice` | Raw recording, `Content-Type: audio/*`, at most 10 MiB. Optional `?timeZone=`. No attachments. | `200` JSON `VoiceAnswer { transcript, answer, speech }` |

`attachments` is a list of 0 to 4 `QuestionAttachment { name, mimeType, data }`:

- `name` has 1 to 200 characters.
- `mimeType` is `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, or `text/plain`.
- `data` is the file in base64. Each decoded file is at most 5 MiB (`ATTACHMENT_MAX_BYTES`). All decoded files together are at most 8 MiB (`ATTACHMENTS_MAX_TOTAL_BYTES`).

The files go to Gemini inline with the question, for this question only. The server does not store or log them.

`followUps` has 0 to 3 short questions that Gemini made from this answer. The server trims each item, removes empty items, items longer than 200 characters, and duplicates, and keeps the first 3. A reply without a valid list gives `[]`, and the answer stands. The server and the UI never write follow-ups. Voice answers get `followUps` the same way.

The server fills `evidence`, `alerts`, and `unavailable` from the records that the tool calls returned, not from the model's text. A sample is `stale` when its source time is more than 24 hours old. `unavailable` names each metric that had no records. Missing data is never an all-clear.

`speech` is `{ status: "ok", languageCode, audio }` (base64 MP3, in the language of the question), or `{ status: "unavailable" | "upstream_error", message }`. The text answer stands when speech fails.

Errors use the `ApiError` JSON body:

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad body, unknown keys, bad time zone, more than 4 files, an unsupported file type, a file over 5 MiB, files over 8 MiB in total, or an empty, oversized, or non-audio recording |
| 401 | `unauthorized` | No valid sign-in token |
| 403 | `forbidden` | The caller is not a member of the family, or the tool route refused the call |
| 503 | `unavailable` | `GEMINI_API_KEY`, the Fetch.ai bridge, `ELEVENLABS_API_KEY` (voice only), or sign-in is not configured |
| 502 | `upstream_error` | Gemini or ElevenLabs failed, sent an invalid reply, or did not answer in time |

When the client disconnects, the server aborts the provider request and answers 499 with no body.

## Provider

- Gemini Interactions API, `POST {GEMINI_BASE_URL}/v1beta/interactions`, model `gemini-3.8-flash`, with function calling ([documentation](https://ai.google.dev/gemini-api/docs/function-calling)).
- The final answer is structured output: JSON `{ answer, follow_ups }` from a JSON schema in `response_format` ([structured outputs with tools](https://ai.google.dev/gemini-api/docs/structured-output)). An answer that is not valid JSON or has an empty `answer` fails.
- Attachments go in the `user_input` step: PDF as `document`, images as `image`, and plain text as a `text` part with the file name.
- Requests set `store: false`. The server sends the whole conversation each round, so Google keeps no copy for later retrieval.
- The tools come from `familyTools` (the Fetch.ai tool set in `@health/contracts/tools`). Each call goes through `callAgentTool`: bridge, Agentverse, worker, then `POST /api/families/:familyId/tools`. There is no direct database fallback.
- One provider request is bounded at 30 s. The model gets at most 4 tool rounds. Calls are not retried, because each call is billed and has no idempotency key.
- Every reply is validated. An empty, incomplete, or endless answer fails; the server never makes up an answer.
- The server does not log questions, files, answers, audio, records, or keys. Error messages carry only the failed step and the HTTP status.

## Configuration

These come from `apps/server/.env.schema` (Varlock). The vision route uses the same Gemini values.

- `GEMINI_API_KEY`: server-only.
- `GEMINI_BASE_URL`: the API origin. Set a local test server for isolated proofs.
- `TELLY_FETCH_BRIDGE_URL` and `TELLY_FETCH_BRIDGE_TOKEN`: the Fetch.ai bridge.
- `ELEVENLABS_*`: voice, as in [`voice.md`](voice.md).
