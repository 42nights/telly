# Voice contract and web client

Backend for voice and text requests ([#16](https://github.com/ayaangazali/telly/issues/16), [#63](https://github.com/ayaangazali/telly/issues/63)). Plan: [`docs/plan.md`](plan.md) (Requests, Voice) and the board's ElevenLabs card: "Speak reminders and agent replies in the user's language."

Schemas: `@health/contracts/voice` (`packages/contracts/src/voice.ts`). Adapter: `apps/server/src/integrations/elevenlabs.ts`. Routes: `apps/server/src/routes/voice.ts`, mounted in `apps/server/src/app.ts`.

## Routes

Both routes are under `/api/families/:familyId`. They need a valid bearer token, and the caller must be a member of the family.

| Method and path | Request | Success |
|---|---|---|
| `POST /voice/transcriptions` | Raw recording, `Content-Type: audio/*`, 1 byte to 10 MiB. Optional `?languageCode=` hint. | `200` JSON `VoiceTranscript { text, languageCode, languageProbability }` |
| `POST /voice/speech` | JSON `SpeechRequest { text, languageCode? }`, at most 16 KiB. `text` has 1 to 2000 characters and is not blank. Other keys are rejected. | `200` `audio/mpeg`, `Cache-Control: no-store` |

`languageCode` is ISO 639-1 (`en`, `es`), or ISO 639-3 when no ISO 639-1 code exists (`fil`). Transcription reports the detected language in this form. To reply in the user's language, send that code (or the wearer's stored preference) with the reply text to `/voice/speech`. Without a code, the provider infers the language from the text.

Errors use the `ApiError` JSON body:

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad body, bad language code, empty or oversized recording, or a body that is not `audio/*` |
| 401 | `unauthorized` | No valid sign-in token |
| 403 | `forbidden` | The caller is not a member of the family |
| 503 | `unavailable` | `ELEVENLABS_API_KEY` is not set, or sign-in is not configured. No audio is returned. |
| 502 | `upstream_error` | ElevenLabs failed, sent an invalid reply, or did not answer within 30 s |

When the client disconnects, the server aborts the provider request and answers 499 with no body.

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
- `ELEVENLABS_API_URL`: the API server. The default is `https://api.elevenlabs.io`. Set a data-residency server, or a local test server for isolated proofs.

## Adapter for request orchestration

`elevenLabsVoice(config)` returns a `Voice` with `transcribe(audio, languageCode?)` and `synthesize({ text, languageCode? })`. Both return an `Effect` that fails with `VoiceError { reason: "unavailable" | "upstream_error", message }`.

## Web client (wearer home)

`apps/web/src/components/wearer/request.tsx`, `answer.tsx`, and `speech.tsx` use these routes on the wearer home (`/hud`). The phone uses the same web app.

- **Talk:** the recording goes to `POST /ask/voice`. The screen shows the transcript and the heard language ("You said (heard in Spanish)"). The answer plays once in that language. Each request is detected again, so a language change in the middle of a conversation changes the reply language.
- **Typed:** the question goes to `POST /ask`. The answer plays once through `POST /voice/speech` without `languageCode`, so the provider uses the language of the answer text. Gemini answers in the language of the question.
- **Controls:** Stop ends the voice at once. Say it again and Slower (0.75×, browser playback rate) replay the kept audio and make no new provider call. Ask something else also stops the voice.
- **Failures:** Cancel while the answer loads puts the typed text back in the box. A failed request keeps the typed text or the recording in memory, and Try again sends it again. When speech fails, the text answer stays and the reason shows.
- **No microphone or sound:** a denied or missing microphone shows the reason, and the text box stays. A blocked sound keeps the text answer.
- **Not yet:** the wearer's stored language preference (care profile, #26) and urgent-help routing (#34) are owned by those issues. The family tools are read-only, so a spoken "okay" cannot complete a medication or meal record.
