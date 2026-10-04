# Family questions API

Backend for family questions ([#86](https://github.com/ayaangazali/telly/issues/86), part of [#11](https://github.com/ayaangazali/telly/issues/11) and [#16](https://github.com/ayaangazali/telly/issues/16)). Gemini answers the question. Its data tools run through Fetch.ai Agentverse when the bridge is configured, and otherwise on the asking member's own database connection. ElevenLabs transcribes and speaks voice questions. Plan: [`docs/plan.md`](plan.md) (Family, Requests) and the board flow "How is Mom sleeping?".

Schemas: `@health/contracts/ask` (`packages/contracts/src/ask.ts`). Routes: `apps/server/src/routes/ask.ts`. Gemini adapter: `apps/server/src/integrations/gemini-chat.ts`. Family tools (tool list, evidence, freshness): `familyTools` in `apps/server/src/family-tools.ts`, described in [`chat.md`](chat.md).

## Routes

Both routes are under `/api/families/:familyId`. They need a valid bearer token, and the caller must be a member of the family.

| Method and path | Request | Success |
|---|---|---|
| `POST /ask` | JSON `FamilyQuestion { question, timeZone?, attachments?, asker? }`, at most about 10.7 MiB. `question` has 1 to 2000 characters. `timeZone` is an IANA zone; the default is UTC. `asker` is `"wearer"` or not given. Other keys are rejected. | `200` JSON `FamilyAnswer { answer, evidence, alerts, unavailable, model, answeredAt, followUps, urgent }` |
| `POST /ask/voice` | Raw recording, `Content-Type: audio/*`, at most 10 MiB. Optional `?timeZone=` and `?asker=wearer`. No attachments. | `200` JSON `VoiceAnswer { transcript, answer, speech }` |

`attachments` is a list of 0 to 4 `QuestionAttachment { name, mimeType, data }`:

- `name` has 1 to 200 characters.
- `mimeType` is `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, or `text/plain`.
- `data` is the file in base64. Each decoded file is at most 5 MiB (`ATTACHMENT_MAX_BYTES`). All decoded files together are at most 8 MiB (`ATTACHMENTS_MAX_TOTAL_BYTES`).

The files go to Gemini inline with the question, for this question only. The server does not store or log them.

`followUps` has 0 to 3 short questions that Gemini made from this answer. The server trims each item, removes empty items, items longer than 200 characters, and duplicates, and keeps the first 3. A reply without a valid list gives `[]`, and the answer stands. The server and the UI never write follow-ups. Voice answers get `followUps` the same way. An urgent answer has `followUps: []`.

The server fills `evidence`, `alerts`, and `unavailable` from the records that the tool calls returned, not from the model's text. A sample is `stale` when its source time is more than 24 hours old. `unavailable` names each metric that had no records. Missing data is never an all-clear.

`speech` is `{ status: "ok", languageCode, audio }` (base64 MP3, in the language of the question), or `{ status: "unavailable" | "upstream_error", message }`. The text answer stands when speech fails.

Errors use the `ApiError` JSON body:

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad body, unknown keys, bad time zone, more than 4 files, an unsupported file type, a file over 5 MiB, files over 8 MiB in total, or an empty, oversized, or non-audio recording |
| 401 | `unauthorized` | No valid sign-in token |
| 403 | `forbidden` | The caller is not a member of the family, or the tool route refused the call |
| 503 | `unavailable` | `GEMINI_API_KEY`, `ELEVENLABS_API_KEY` (voice only), or sign-in is not configured |
| 502 | `upstream_error` | Gemini or ElevenLabs failed, sent an invalid reply, or did not answer in time |

When the client disconnects, the server aborts the provider request and answers 499 with no body.

## Wearer questions and urgent requests

This part is for [#35](https://github.com/ayaangazali/telly/issues/35). Plan: [`plan.md`](plan.md) (Requests, Family).

- **Urgent first:** `urgentRequest(text)` in `@health/contracts/ask` finds an explicit help request or a serious symptom in English or Spanish. Examples are "help me", "call an ambulance", "I fell", "my chest hurts", and "I can't breathe". Such a question gets `urgent: true` at once, with a fixed reply in the language of the words, and `model: "none"`. Gemini, Fetch.ai, and the records are not used, so the reply comes even when they are not configured. Clients run the same check before any other route and open the help flow. A match is not a diagnosis.
- **Wearer rules:** `asker: "wearer"` adds calm-support rules to the Gemini instructions. The assistant says that it is an assistant and never a relative. It answers repeated questions patiently and never tests, corrects, embarrasses, or argues with the wearer. It repeats names, routines, and plans only when the tools return them, and otherwise says that the fact is not saved. It says back a reported feeling and offers more conversation or a call to a family member. It does not call a feeling anxiety unless the wearer did, and it does not promise that all is well. Saved care facts come with [#26](https://github.com/ayaangazali/telly/issues/26). Until then, the only facts are the family's health records.
- **Wearer screen:** `/hud` shows "Call family" and "I need help now" under each answer or failure. The help panel shows the emergency number first, then family. Calls open the phone's dialer through `tel:` links. The app does not call anyone and does not simulate a dispatch. The family number is saved on the device in Settings. Stop, Say it again, and Slower speech come from the voice work ([`voice.md`](voice.md)).

## Provider

- Gemini Interactions API, `POST {GEMINI_BASE_URL}/v1beta/interactions`, model `gemini-3.8-flash`, with function calling ([documentation](https://ai.google.dev/gemini-api/docs/function-calling)).
- The final answer is structured output: JSON `{ answer, follow_ups }` from a JSON schema in `response_format` ([structured outputs with tools](https://ai.google.dev/gemini-api/docs/structured-output)). An answer that is not valid JSON or has an empty `answer` fails.
- Attachments go in the `user_input` step: PDF as `document`, images as `image`, and plain text as a `text` part with the file name.
- Requests set `store: false`. The server sends the whole conversation each round, so Google keeps no copy for later retrieval.
- The tools come from `familyTools` (the Fetch.ai tool set in `@health/contracts/tools`). With `TELLY_FETCH_BRIDGE_URL` set, each call goes through `callAgentTool`: bridge, Agentverse, worker, then `POST /api/families/:familyId/tools`. Without it, each call runs `runTool` (the code behind that route) on the asking member's own database connection, so it reads only that member's families. The Cloudflare deployment has no bridge (the host bridge serves the synthetic demo backend), so production uses the database path.
- One provider request is bounded at 30 s, and one question (all rounds and retries) at 45 s, so a voice reply with transcription and speech comes before a phone gives up at about 60 s. The model gets at most 4 tool rounds.
- An overloaded call (HTTP 429 or 503: nothing ran, nothing is billed) goes at once to `gemini-3.5-flash`, then to both models again after 1 s and after 3 s. Only the refused round is sent again: finished tool rounds and their tool calls are kept. When every try is refused, or the 45 s pass, the answer fails with `upstream_error` and the message "The assistant is busy right now. Try again in a minute", followed by the cause. Other failures are not retried, because each call is billed and has no idempotency key.
- Every reply is validated. An empty, incomplete, or endless answer fails; the server never makes up an answer.
- The server does not log questions, files, answers, audio, records, or keys. Error messages carry only the failed step and the HTTP status.

## Configuration

These come from `apps/server/.env.schema` (Varlock). The vision route uses the same Gemini values.

- `GEMINI_API_KEY`: server-only.
- `GEMINI_BASE_URL`: the API origin. Set a local test server for isolated proofs.
- `TELLY_FETCH_BRIDGE_URL` and `TELLY_FETCH_BRIDGE_TOKEN`: the Fetch.ai bridge. Optional: without them, the tools read the database directly.
- `ELEVENLABS_*`: voice, as in [`voice.md`](voice.md).
