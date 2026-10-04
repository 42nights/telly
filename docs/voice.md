# Voice backend contract

Backend for voice and text requests ([#16](https://github.com/ayaangazali/telly/issues/16), [#63](https://github.com/ayaangazali/telly/issues/63)). Plan: [`docs/plan.md`](plan.md) (Requests, Voice) and the board's ElevenLabs card: "Speak reminders and agent replies in the user's language."

Schemas: `packages/contracts/src/voice.ts`. Adapter: `apps/server/src/integrations/elevenlabs.ts`. Routes: `apps/server/src/routes/voice.ts`.

## Routes

Both routes are under `/api/families/:familyId` and need the family identity and authorization of that prefix.

| Method and path | Request | Success |
|---|---|---|
| `POST /voice/transcriptions` | Raw recording, `Content-Type: audio/*`, 1 byte to 10 MiB. Optional `?languageCode=` hint. | `200` JSON `VoiceTranscript { text, languageCode, languageProbability }` |
| `POST /voice/speech` | JSON `SpeechRequest { text, languageCode? }`. `text` has 1 to 2000 characters and is not blank. | `200` `audio/mpeg`, `Cache-Control: no-store` |

`languageCode` is ISO 639-1 (`en`, `es`), or ISO 639-3 when no ISO 639-1 code exists (`fil`). Transcription reports the detected language in this form. To reply in the user's language, send that code (or the wearer's stored preference) with the reply text to `/voice/speech`. Without a code, the provider infers the language from the text.

Errors use the `ApiError` JSON body:

| Status | `error` | Cause |
|---|---|---|
| 400, 413, 415 | `invalid_request` | Bad body, bad language code, empty or oversized recording, or a body that is not `audio/*` |
| 503 | `unavailable` | `ELEVENLABS_API_KEY` is not set. No audio is returned. |
| 502 | `upstream_error` | ElevenLabs failed, sent an invalid reply, or did not answer within 30 s |

## Provider

- Transcription: `POST https://api.elevenlabs.io/v1/speech-to-text`, model `scribe_v2`.
- Speech: `POST https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, model `eleven_flash_v2_5`. This model enforces `language_code`.
- Every reply is validated: the transcript against its schema, and speech as non-empty `audio/mpeg` of at most 10 MiB.
- A client disconnect aborts the provider request. Calls are not retried, because each call is billed and has no idempotency key.
- Audio stays in memory for one request. The server does not store or log audio, transcripts, or keys. Error messages carry only the operation and the HTTP status.

## Configuration

Set in `apps/server/.env.schema` (Varlock):

- `ELEVENLABS_API_KEY`: optional and sensitive. Keep it on the server only.
- `ELEVENLABS_VOICE_ID`: the voice for spoken replies. The default is the premade voice `JBFqnCBsd6RMkjVDRZzb`.

## Adapter for request orchestration

`elevenLabsVoice(config)` returns a `Voice` with `transcribe(audio, languageCode?)` and `synthesize({ text, languageCode? })`. Both return an `Effect` that fails with `VoiceError { reason: "unavailable" | "upstream_error", message }`.
