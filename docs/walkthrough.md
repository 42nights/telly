# Hackathon walkthrough

Issue [#51](https://github.com/ayaangazali/telly/issues/51). Plan: [docs/board.html#flows](board.html#flows) (October 3 backlog flows) and [docs/plan.md](plan.md).

The walkthrough follows one synthetic wearer, Rosa, through five moments:

1. A conversation in Spanish and English.
2. A scheduled medication and a search for the bottle.
3. A meal photo and a separate intake report.
4. A family handoff on the contact ladder.
5. A report.

All data is synthetic. No call, message, purchase, emergency dispatch, or hospital delivery leaves the computer.

Tested revision: `main` at `8d94219d`. This change adds only this document, its screenshots, the script, and one board link.

## Run it

```bash
bun install
bun run --filter server build
bun run walkthrough            # exits 0 and prints "walkthrough: ok"
```

`apps/server/scripts/walkthrough.ts` starts its own stack on 127.0.0.1:

| Port | Process |
| --- | --- |
| `WALKTHROUGH_PORT` (default 45510) | An in-memory SpacetimeDB with the `spacetimedb/` module published |
| `+1` | A test-only OIDC issuer with a key made for this run |
| `+2` | The built server (`apps/server/dist`) under Node |

The script does not set provider keys (Gemini, ElevenLabs, Fetch.ai bridge, FinchNode, R2). Each provider step must reply `503 unavailable`. That outage is the failure path of this walkthrough.

The script sends each request through the real HTTP routes and the real module reducers. It stops at the first check that fails. When it ends, it stops its processes and deletes its temporary directory.

For screenshots, keep the stack and start the web app on the next port:

```bash
KEEP=1 bun run walkthrough
cd apps/web && VITE_SERVER_URL=http://127.0.0.1:45512 VITE_OIDC_ISSUER=http://127.0.0.1:45511 \
  VITE_OIDC_CLIENT_ID=telly-walkthrough bunx vite dev --host 127.0.0.1 --port 45513 --strictPort
```

Then open `http://127.0.0.1:45513`. In the browser, set `sessionStorage["telly.session.token"]` to the output of `curl http://127.0.0.1:45511/token?user=rosa` (or `priya`). The screenshots use this token injection. They do not show the sign-in screen. The sign-in flow has its own proof on [#4](https://github.com/ayaangazali/telly/issues/4).

## The people

| Name | Role | Ladder position |
| --- | --- | --- |
| Rosa | The wearer. She speaks Spanish. She uses the phone, with glasses disconnected. | — |
| Sam | Family | Contact 1. He does not answer. |
| Priya | Family. She writes in English. | Contact 2. She accepts. |

## What each step proves

The IDs below are from the recorded run (database IDs begin at 1 in each new run).

| Step | Real requests and checks | Result |
| --- | --- | --- |
| 0. Setup | `GET /api/sources` | NOOP is `not_connected`. No glasses or device supplies data. |
| | 3 samples with `synthetic: true`, `quality: unvalidated`, source `walkthrough-synthetic` | Samples 1, 2, and 3 |
| 1. Conversation | `POST /voice/transcriptions?languageCode=es` | 503: "ElevenLabs is not configured" |
| | `POST /ask` "¿Dónde están mis pastillas?" | 503: "Fetch.ai tool routing is not configured" |
| | Rosa `POST /messages` in Spanish; Priya replies in English | Messages 1 and 2, stored verbatim. Telly does not translate them. |
| 2. Medication | `PUT /reminder-settings`, `POST /reminders` for the next minute | The database timer makes occurrence 1 due |
| | Delivery from the phone, then the answer "okay" ("Vale") | State `acknowledged` ("Seen, not done"), not taken |
| | `POST /vision/medicine-detections` | 503: "Medicine detection is not configured" |
| | A sighting at "kitchen counter", then `not-found` | The old place is marked outdated (stale location) |
| | A new sighting at "bedside table" | Recovery: the last-seen place is current again |
| | The answer "unsure" ("No me acuerdo si la tomé") | State `unresolved`. No `self_reported_complete` or `caregiver_confirmed` event exists. |
| 3. Meal | `POST /meals/walkthrough-lunch/estimates` with a photo | `photo_taken` is recorded, then 503: "Meal estimates are not configured" |
| | `GET /meals` | Intake `not_reported`: the photo did not set intake |
| | `POST /meals/walkthrough-lunch/intake` "some" ("Comí la mitad") | Intake `reported` |
| 4. Family handoff | `PUT /care/ladder` (Sam, then Priya, 10 s to answer) and `POST /care/needs` with samples 1–3 | Need 1. Its summary names occurrence 1. |
| | Wait 10 s | Sam `no_answer`. The need stays `open` and goes to Priya. |
| | Priya `accept` | Need `accepted`, not resolved |
| | Priya `help_confirmed` | Need `resolved` |
| 5. Report | `POST /reports` | Each measured marker is one of samples 1–3, and each is synthetic |
| | Fields, then review | The observations name occurrence 1, meal `walkthrough-lunch`, need 1, and messages 1 and 2 |
| | `POST /reports/:id/submit` | 503: "Hospital delivery is unavailable: Finchnode has no report delivery API" |

The same IDs connect the conversation, the family screens, and the report. Samples 1–3 are in the care need facts and the report markers. Occurrence 1 is in the need summary, the family reminder history, and the report notes. Need 1 and the meal ID are in the report notes.

None of these events is recorded as care that was done:
- An acknowledgment stays "Seen, not done".
- A found bottle records no dose.
- A meal photo sets no intake.
- An answered or accepted request is not resolved until a person confirms the help.

## Capability states

| Capability | State in this walkthrough | Note |
| --- | --- | --- |
| Server routes and SpacetimeDB reducers | Working | A private in-memory database, the real module |
| Sign-in | Fixture-backed | A test-only issuer. The live app uses Google (see [docs/deploy.md](deploy.md)). |
| Family chat in two languages | Working | Stored verbatim. Telly does not translate. |
| Voice: ElevenLabs transcription and speech | Unavailable here (503). Unverified on the live app. | Typed text is the recovery. |
| Family answers: Gemini through Fetch.ai | Unavailable here (503). Unverified on the live app. | — |
| Medication reminders and the database scheduler | Working | — |
| Medicine detection: Gemini vision | Unavailable here (503) | Headless Chrome has no camera ("No camera found"). |
| Medicine last-seen place | Fixture-backed | The sightings are synthetic records with `source: camera_check`. No camera check ran. |
| Meal estimate: Gemini | Unavailable here (503) | The intake report is the recovery. |
| Meal intake report | Working | — |
| Contact ladder | Simulated | In-app notices only. Calls are simulated. Nothing leaves the app. |
| Emergency help | Simulated, not run | The home screen shows "Practice mode · calls are simulated" |
| Report: generate, fill, and review | Working | Markers show "Demo value, not measured" |
| Hospital delivery | Unavailable (503) | A mock destination. The decision is `telly-report-delivery`. |
| Report PDF | Unavailable here | No R2 bucket in the local stack |
| NOOP adapter | Not connected | `/api/sources` and the family screen show "NOOP not connected" |
| Meta glasses, home speaker, and WHOOP | Deferred | Optional device demos, not run |

## Failure and recovery

| Failure | What the user sees | Recovery | Still unresolved |
| --- | --- | --- | --- |
| Provider outage (ElevenLabs, Gemini, Fetch.ai bridge) | 503 with a plain reason; "Meal estimates are not available right now. You can still say how much you ate below." | Typed message, tap answers, intake report | Nothing is estimated or translated |
| Stale location | "It's not there" marks the kitchen counter as outdated (`notFoundAt`). The screen says that a place is "where it was seen before, not where it is now." | A new sighting at the bedside table | — |
| Contact no-answer | Sam: "Message · No answer" | The ladder goes to Priya, who accepts and confirms help | — |
| Uncertain dose | Reminder history: "Unresolved · No me acuerdo si la tomé" | A person takes over through the care need | The dose stays `unresolved`. Nobody recorded it as taken. |
| Hospital delivery | "Hospital delivery is unavailable: Finchnode has no report delivery API" | The report stays reviewed and "not sent" | Delivery path (`telly-report-delivery`) |

## Screenshots

Captured in headless Chrome (the fleet `chrome` tier) at 1440 px (desktop) and 390 px (phone), against the local stack above.

| Moment | Desktop | Phone |
| --- | --- | --- |
| Home: the medication prompt stays until Rosa answers; emergency is practice mode | [hud-desktop](walkthrough/hud-desktop.png) | [hud-phone](walkthrough/hud-phone.png) |
| Conversation: Spanish and English, then the ladder notices | [chat-desktop](walkthrough/chat-desktop.png) | [chat-phone](walkthrough/chat-phone.png) |
| Medication history: "Seen, not done", then "Unresolved" | [family-desktop](walkthrough/family-desktop.png) | [family-reminders-phone](walkthrough/family-reminders-phone.png) |
| Last-seen place after the bottle moved | [medicine-desktop](walkthrough/medicine-desktop.png) | [medicine-phone](walkthrough/medicine-phone.png) |
| Meal: estimate outage, then "Saved: some" | [meal-outage-desktop](walkthrough/meal-outage-desktop.png), [meal-intake-desktop](walkthrough/meal-intake-desktop.png) | [meal-phone](walkthrough/meal-phone.png) |
| Family handoff: Sam no answer, Priya accepted, help confirmed | [care-desktop](walkthrough/care-desktop.png) | [care-phone](walkthrough/care-phone.png) |
| Report: demo markers, notes with the IDs, send confirmation, delivery unavailable | [report-markers-desktop](walkthrough/report-markers-desktop.png), [report-notes-desktop](walkthrough/report-notes-desktop.png), [report-send-dialog-desktop](walkthrough/report-send-dialog-desktop.png), [report-send-desktop](walkthrough/report-send-desktop.png) | [reports-phone](walkthrough/reports-phone.png) |
| Live app, signed out | [live-hud-desktop](walkthrough/live-hud-desktop.png) | [live-hud-phone](walkthrough/live-hud-phone.png) |

The meal screenshots come from the web form. That form makes its own meal ID, which is different from `walkthrough-lunch` in the script.

## Live app

The live API passed these signed-out checks on 2026-10-04:
- `https://api.saintess.tech/health` gives 200.
- `/api/sources` gives `noop: not_connected`.
- `/api/families` gives 401.

`https://app.saintess.tech/hud` loads signed out. It shows "Sign in to use Talk" and "Practice mode · calls are simulated".

This walkthrough did not run the signed-in steps on the live app. Google sign-in there was in Testing mode at that time, and the walkthrough needs three family members. To repeat it live, you need ID tokens for three Google accounts.

## Gaps found

- The web app has no screen that shows a meal's photo, estimate, and intake facts to the family. Only the report notes and `GET /meals` show them.
- At 390 px, the Family window is wider than the screen and its right edge is cut off.
- The chat header shows "Gemini" when Gemini is not available.
- The ladder notices in chat show the sender as "Member" and a short ID, not as Telly.
