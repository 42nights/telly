# Fall and breathing signal validation

Issue: [#6](https://github.com/ayaangazali/telly/issues/6).
Plan: [`docs/plan.md`](plan.md) (Product: Monitoring) and the "Monitoring", "Breathing", and "Permissions" rules in [`docs/board.html`](board.html).

## Status

No non-glasses signal is validated for fall or breathing detection.
Every fall and breathing sample from a phone or a WHOOP strap stays `quality: unvalidated`.
By the rule in `packages/contracts/src/index.ts` (`drivesMonitoring`), an `unvalidated` sample does not drive monitoring, with one exception. A real WHOOP reading through NOOP (a `noop:` source) drives threshold monitoring and alerts: a captain decision for the demo (2026-10-04). It is still labelled unvalidated, it is still not validated for fall or breathing detection, and Gemini mentions that label once, then may use it for advice like any other reading.
`GET /api/families/:familyId/monitoring` therefore shows these thresholds as `unavailable`, never in range.

Synthetic tests and the committed WHOOP export below do not prove detection.
A physical-device session with real, labelled events is necessary before any sample can be `validated` (see [Validation gate](#validation-gate)).

## Evidence from the committed WHOOP export

Source: `noop/whoop/data`, exported by `noop/whoop/data/export.sh` from one strap.

- Device: WHOOP 5.0 / MG (`pairedDevice.json`). The phone model and OS are not in the export.
- Window: 2026-09-29 09:47:25 to 10:47:25 UTC, 3,601 one-second rows.
- Conditions: the wearer was mostly still. The step counter reports activity class 0 (still) for 3,446 of 3,601 s. The export has no event labels.

| Signal | Cadence and coverage in the export | Result |
|---|---|---|
| Gravity and movement (`gravitySample`) | 1 Hz, no gaps. Arrives only on sync, 90 s to 15 min late (`health-fields.html`). | Not usable for live fall detection: too late and too slow for an impact. |
| Movement over 2.5 g (`gravitySample.dynAccel`) | 3 seconds in the hour (2.78 g, 6.47 g, 2.91 g), during activity class 0 or 1 | The signal varies, but there are no labels. These spikes cannot be scored as true or false falls. |
| Accelerometer saturated (event 42) | 0 events in 83 days of events | No evidence that it fires on an impact. |
| Wrist on / off (events 9 / 10) | 37 events in 83 days | On-body state is available for the strap. Arrival delay is about 2 s (catalog value, not measured here). |
| R-R intervals (`rrInterval`) | 4,536 beats. 26 gaps longer than 10 s, 1,794 s in total (longest 375 s) | No beats for about half of a still hour. A breathing estimate from R-R would be unavailable for that time. |
| Respiratory rate (`dailyMetric.respRateBpm`) | One value per day. Present on 1 of 3 days (12.6 /min on 2026-09-29) | A daily estimate from R-R. It cannot detect a breathing problem when it occurs. |
| 100 Hz accelerometer and gyroscope | Not in the export. NOOP streams it only during a user-started Raw Data Collector session. | The only fall candidate with enough rate. Not recorded and not validated. |

Phone sensors: `apps/native` has no motion-sensor dependency, and no app code reads `DeviceMotionEvent`.
No phone motion data exists to validate.

Reproduce the numbers from the repository root:

```sh
cd noop/whoop/data
jq '[.[]|select(.dynAccel>2.5)]|map(.dynAccel)' gravitySample.json
jq '[.[].ts]|[range(1;length) as $i|.[$i]-.[$i-1]|select(.>10)]|{gaps:length,seconds:add,longest:max}' rrInterval.json
jq -c 'map([.day,.respRateBpm])' dailyMetric.json
jq '[.[]|select(.activityClass==0)]|length' stepSample.json
jq '[.[]|select(.kind|test("WRIST"))]|length' event.json
```

## Detector definitions

These values are the starting values for the device session. The session results can change them.
Each family's alert rule (`AlertThresholdInput`: metric, direction, limit, unit, `maxAgeSeconds`) stays the only threshold that raises an alert.
The values below decide only whether a sample can be `validated`.

### Fall

- Source: the 100 Hz accelerometer stream from a worn device. The strap is preferred, because it reports wrist on / off. A phone cannot prove that it is on the person.
- Detection: all three stages in one continuous stream:
  1. Free fall: total acceleration below 0.3 g for at least 0.3 s.
  2. Impact: total acceleration above 2.5 g within 1 s after the free fall.
  3. Stillness: total acceleration between 0.8 g and 1.2 g for 10 s after the impact.
- Confidence: the fraction of expected samples present in the 12 s window from free fall to the end of stillness. A detection needs at least 0.95. Less is no detection, and the window counts as unavailable.
- Freshness: the newest motion sample is at most 2 s old. Data that arrives on sync (the 1 Hz history) is never fresh enough.
- Sample: metric `fall`, value `1`, unit `event`, `sourceTime` at the impact.
- Unavailable: the device is off the wrist or not on the person, the stream is stopped, the app is in the background or suspended, or motion permission is not granted.

### Breathing

- Source: no non-glasses source measures breathing. The only candidate is a respiratory rate estimated from R-R intervals.
- Estimate: one rate per 60 s window.
- Confidence: R-R intervals cover at least 90 % of the window, with no gap longer than 3 s.
- Freshness: the window ends at most 60 s before the evaluation.
- Sample: metric `respiratory_rate`, unit `/min`.
- Limits: this estimate cannot show apnea, an emergency, or a heart attack. The daily `respRateBpm` value is never a live breathing sample.

## Validation gate

A source can send `quality: validated` for a metric only after one recorded session passes the checks below.
Record these test notes with the results: device model, OS and version, app build, body position of the device, and room conditions.

Fall session:

- At least 20 simulated falls onto a crash mat by an adult tester, in at least 3 directions (forward, backward, sideways).
- At least 8 h of normal activity with the device worn, including sitting down hard, stairs, and taking the device off.
- Pass: at least 18 of the 20 falls detected, at most 1 false detection in the 8 h, and the device off the person or the app in the background shows `unavailable`.

Breathing session:

- At least 3 paced-breathing blocks (for example 8, 15, and 25 breaths/min, counted against a metronome), each at least 3 min, at rest.
- Pass: the 60 s estimate is within 2 breaths/min of the paced rate for at least 90 % of the windows that meet the confidence rule, and windows that fail it show `unavailable`.

Until a session passes, the server and clients must not present a phone or strap reading as an automatic fall or breathing detection.
A manual alert, a spoken "I fell", or a synthetic sample is not detection.
