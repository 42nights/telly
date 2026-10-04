# WHOOP data

Every reading Ayaan's WHOOP 5.0 / MG has given Healer S.I. so far, one JSON file per table. Each file
is an array of row objects with the same columns as the app's database. Use it to seed the website.

Exported 2026-10-04 from `~/telly-host/live.sqlite`, the Mac copy that the phone keeps up to date.
It holds readings from 2026-09-28 17:12 to 2026-10-04 01:17 (Pacific). There are gaps wherever the
phone was not syncing. The WHOOP cloud API was never connected, so there is no data from before the
band was paired.

To refresh, run `sh data/whoop/export.sh`. It reads `~/telly-host/live.sqlite`, or the database
path you pass as the first argument.

To put this history in a Telly family, open Setup → WHOOP → Connect for that family. Copy the
`url=` part of the NOOP link (`https://api.saintess.tech/api/noop/ingest?k=…`), then run
`bun data/whoop/push.ts '<that URL>'`. The script sends the daily scores, band events, and heart
rate through the ingest that NOOP's live push uses. A second run adds nothing.

## Reading it

- `ts`, `startTs` and `endTs` are Unix seconds (UTC). `day` is a local `YYYY-MM-DD`.
- `deviceId` `my-whoop` marks raw band readings. `my-whoop-noop` marks scores the app computed
  from them (`dailyMetric`, most of `metricSeries`).
- `strain` is stored 0–100. Multiply by 0.21 for the WHOOP 0–21 scale (29.6 stored = 6.2).
- `ppgWaveformSample.samplesHex` and `v18AuxSample.fieldsHex` are raw bytes, hex-encoded.
- `pairedDevice` leaves out the Bluetooth peripheral id. AI coach chats are not included.

| File | What it holds |
|---|---|
| `dailyMetric` | One row per day: sleep, recovery, strain, resting HR, HRV |
| `metricSeries` | Daily extra scores, such as VO2 max estimate, fitness age and sleep performance |
| `sleepSession` | Each sleep, with stages, motion and state as JSON strings |
| `liveSession` | Live heart-rate zone sessions |
| `scoreInputProvenance` | Which source fed each daily score |
| `hrSample` | Heart rate, about once a second |
| `rrInterval` | Beat-to-beat intervals in ms (HRV source) |
| `ppgHrSample` | Optical heart rate with confidence |
| `ppgWaveformSample` | Raw optical waveform bursts |
| `skinTempSample` | Raw skin temperature readings |
| `gravitySample` | Accelerometer x, y, z |
| `stepSample` | Step counter and activity class |
| `sleepStateSample` | The band's sleep state per second |
| `v18AuxSample` | Other raw band fields |
| `battery` | Battery level and charging |
| `event` | Band events (wrist on/off, charging, and others) |
| `pairedDevice` | The band's model and capabilities |
