# Emergency help and the suspected-event check-in

This document describes #34: Call emergency help, Call my family, and the check-in after an "ouch" or a possible fall. Plan: [`plan.md`](plan.md) (Product: Family, Monitoring; rules "Show missing data as unavailable") and [`board.html`](board.html).

**Every emergency call is simulated.** No code in this repository places a real call. A connected call never means that the care record reached a dispatcher. Live calling is outside #34.

## Routes

The routes are relative to `/api/families/:familyId`. They are behind sign-in and the family membership check. The contracts are in `@health/contracts/emergency` (`packages/contracts/src/emergency.ts`). Both routes reply with `EmergencyOutcome`.

| Route | Request | Outcome |
| --- | --- | --- |
| `POST /emergency` | `{ kind: "help", report, wearer, location }` | `dispatch` at once. There are no questions, and the route does not wait for wearable data. |
| `POST /emergency` | `{ kind: "family", report }` | `family`: a family alert only, with no dispatch. |
| `POST /emergency` | `{ kind: "event", event }` with `ouch` or `possible_fall` | `check_in` with a short prompt. |
| `POST /emergency` | `{ kind: "event", event }` with `missed_reminder` or `unheard_vibration` | `none` (`not_an_emergency`). These events alone never dispatch. |
| `POST /emergency/check-in` | `CheckIn { event, reply, wearer, location }` for `ouch` or `possible_fall` only | See the next table. Other event kinds fail with 400. |

| Check-in reply | Outcome |
| --- | --- |
| `no_response` | `dispatch`, responsiveness `not_responding` |
| Speech by `other` (a television or another voice) | `check_in` again, reason `other_voice`. It does not dispatch and does not cancel. |
| Wearer asks for help ("yes", "I'm not ok", "it hurts") | `dispatch`, responsiveness `responding` |
| Wearer denies ("no, I'm fine") | `none` (`denied`). The family gets an alert. |
| Wearer reply not clear | `check_in` again, reason `unclear` |

A `none` outcome always has `safety: "unconfirmed"`. Missing or normal wearable data cannot confirm that the wearer is safe.

## Dispatch and handoff

- `dispatch` runs the simulated call and the family alert together, so neither waits for the other. The reply has `call.simulated: true`, the states (`connecting`, then `connected` or `failed`), and `recordDelivered: false`.
- The handoff has the name, the callback number, the event, the wearer's exact words, and the responsiveness. When the device sends no name, the handoff uses the care profile's preferred name. A null value shows "Not on file". The handoff also has the location: `current` or `last_known` (a fix older than 120 s) with its accuracy and age, or `denied` or `unavailable`.
- Care facts come from the #26 care profile, read as the caller. Conditions and allergies are as saved: null is unknown, and `[]` is none recorded. Medications are the verified medication instructions only. Without `health_records` access, or when the profile cannot be read, `care` is `unavailable` with the reason. A care read never holds back the call.
- The family alert uses the existing `raise_alert` reducer, so the #5 outbox delivers it. A failed alert shows as `failed` and never stops the call.
- During a real approved call, the dispatcher's instructions come first. The web panel says so.

## Web

The wearer's home (`/hud`) has an Emergency panel labeled "Practice mode · calls are simulated". A typed or spoken request goes to `emergencyIntent` (`apps/web/src/components/wearer/logic.ts`) before the medicine finder and Gemini.

- An urgent request, such as "help", "call 911", "I fell", or "I can't breathe", starts the simulated dispatch. The rule is `urgentRequest` from `@health/contracts/ask`, the same rule that the server's `/ask` route uses. The request also opens the help panel from #106. That panel has phone-dialer links, and the wearer chooses whether to call.
- "Ouch" alone starts a 30 s check-in. When the check-in gets no reply, the panel sends `no_response`.

Automatic fall detection is not a source. It waits for a validated signal (#6). The panel has no "test fall" button.

## Verification

`bun run db:test` runs `apps/server/src/routes/emergency.test.ts` against a local SpacetimeDB with a fake dispatcher. It covers explicit help, a television "ouch", a denial, a suspected fall with no reply and a denied location, an old fix, a failed call, a missed reminder, an unheard vibration, Call my family, and the care facts with and without `health_records` access. It asserts zero outbound requests.
