# Conditional HealthKit import

Server side of [#47](https://github.com/ayaangazali/telly/issues/47). Plan: the board's "HealthKit · conditional bridge" card in [Why each integration exists](board.html#integration-reasons): "Aggregate other phone health sources. Do not force WHOOP through this bridge." [`plan.md`](plan.md) keeps WHOOP data on the NOOP path.

Schemas: `@health/contracts/healthkit` (`packages/contracts/src/healthkit.ts`). Mapping: `apps/server/src/integrations/healthkit.ts`. Route: `apps/server/src/routes/healthkit.ts`.

**Status:** the server import works. No phone reads HealthKit yet. The fixtures in `apps/server/src/routes/healthkit.test.ts` are synthetic. They are not evidence of a real HealthKit integration. See [Device verification](#device-verification).

## Route

`POST /api/families/:familyId/healthkit/samples` needs a valid sign-in, and the caller must be a member of the family.

Request (`HealthKitImport`, at most 500 samples, other keys are rejected):

- `access`: `unavailable`, `denied`, or `requested`. See [Permission states](#permission-states).
- `synthetic`: `true` for demo fixtures. Every recorded sample keeps this value.
- `samples`: `HealthKitSample` items. Each item has the HealthKit UUID, the type, the value and its `HKUnit` string, the start and end dates, the source bundle and name, the device model and manufacturer, and the `HKMetadataKeyExternalUUID` value. The device name is not sent, because people put their names in device names.

Reply `200` (`HealthKitImportResult`):

- `samples`: one outcome for each sent sample, in order. The outcome is `recorded`, `duplicate`, or `whoop_origin`. `sampleId` is the stored row; it is `null` for `whoop_origin`.
- `metrics`: one state for each accepted type. See [Permission states](#permission-states).

`400 invalid_request`: the body does not match the schema, a sample uses a unit other than its type's `HKUnit`, or the batch has samples without `access: requested`. A rejected batch records nothing.

## Accepted types

The server accepts only discrete vital-sign quantity samples. The phone must read each type in the given `HKUnit`.

| HealthKit type | Read unit | Stored metric | Stored unit | WHOOP/NOOP counterpart |
|---|---|---|---|---|
| `HeartRate` | `count/min` | `heart_rate` | `bpm` | `heart_rate` (`bpm`), one per minute from the strap |
| `RestingHeartRate` | `count/min` | `resting_heart_rate` | `bpm` | `resting_heart_rate` (`bpm`), daily |
| `HeartRateVariabilitySDNN` | `ms` | `hrv_sdnn` | `ms` | `hrv` is RMSSD, a different measure, so the metrics stay separate |
| `RespiratoryRate` | `count/min` | `respiratory_rate` | `breaths/min` | `respiratory_rate`, estimated from R-R intervals (the strap has no breathing sensor) |
| `OxygenSaturation` | `%` (a fraction, 0.97) | `oxygen_saturation` | `%` (97) | None: the strap sends no SpO₂ value |

Every stored HealthKit sample has `quality: unvalidated`. It cannot raise a threshold alert or show "all clear". Validation is a monitoring decision ([#6](https://github.com/ayaangazali/telly/issues/6)). The source time is the sample's start date.

### Gaps against the WHOOP/NOOP catalog

The reference is `noop/whoop/health-fields.html`.

| Data | HealthKit | Why it is not imported |
|---|---|---|
| Steps, active energy | `StepCount`, `ActiveEnergyBurned` | Cumulative types. Raw samples from an iPhone and a watch overlap, so a sum counts steps twice. A correct total needs an on-device `HKStatisticsCollectionQuery`. |
| Sleep duration, stages, efficiency | `SleepAnalysis` (category type) | Category intervals, not quantity samples. No contract exists for stages. |
| Skin temperature | `AppleSleepingWristTemperature` (watch-only), `BodyTemperature` | Different measures from the strap's skin temperature. |
| Falls | `NumberOfTimesFallen` | A count that arrives late. It is not a fall event, so it cannot drive fall monitoring. |
| Recovery, strain, body age | None | WHOOP and NOOP scores only. |
| Wrist on or off, battery, double tap | None | Strap events only. |
| Live heart rate, R-R intervals, motion | None for live reads | HealthKit does not stream to other apps. Watch heart-rate samples arrive in batches. |

## Provenance and duplicates

- **Source:** `healthkit:<bundle>` or `healthkit:<bundle>:<device model>`, for example `healthkit:com.apple.health.<id>:Watch7,1`. The source shows the app that wrote the sample, and the device when there is one.
- **WHOOP origin:** the server records no WHOOP data from HealthKit. WHOOP data enters only through the NOOP path, so the same strap reading never counts twice. The outcome is `whoop_origin` when one of these is true:
  - The external UUID starts with `noop:`. NOOP's Health write-back sets `noop:<kind>:<identity>` on vitals, sleep, and workouts.
  - The source bundle has a `noop`, `noopapp`, or `whoop` segment. This includes NOOP's heart-rate stream, which has no external UUID, and the WHOOP app.
  - The device manufacturer contains `WHOOP`.
- **Same reading again:** a sample with the same source, metric, unit, value, and source time as a stored sample is a `duplicate`. The reply gives the stored `sampleId`. A resent batch records nothing new.
- **Limit:** the sample table has no column for the HealthKit UUID. Two imports of the same sample at the same time can both record it. Add a unique source-sample id to the table before HealthKit becomes a live source.

## Permission states

iOS never tells an app that a person denied a read type. A denied type reads as empty. `authorizationStatus(for:)` reports only write access, and `getRequestStatusForAuthorization` reports only whether the permission sheet was shown. So the phone reports one of three `access` values:

| `access` | Phone condition |
|---|---|
| `unavailable` | The device has no HealthKit: web, Android, or `HKHealthStore.isHealthDataAvailable()` is false. Or the build has no HealthKit entitlement. |
| `denied` | The authorization request failed, or Health data is restricted on the device |
| `requested` | The permission sheet was answered |

The server then gives each metric one state. A missing value is never a zero or "all clear".

| State | Meaning |
|---|---|
| `unavailable`, `denied` | The same as `access`. No new HealthKit reading can arrive. |
| `no_sample` | Access was requested, and no HealthKit sample is stored. The person can have denied this type, or no device recorded it. |
| `stale` | The newest HealthKit sample is older than 24 hours (the same window as the family tools). |
| `fresh` | The newest HealthKit sample is 24 hours old or newer. |

Each state includes the newest stored HealthKit sample, or `null`.

## Background behavior

- A phone needs the `com.apple.developer.healthkit` entitlement and an `NSHealthShareUsageDescription` text. NOOP's own HealthKit bridge reports a missing entitlement on free-signed builds. A SideStore install can therefore have no HealthKit access.
- Health data is encrypted while the phone is locked. Reads then fail, so an upload can lag behind the measurement.
- Background reads need an `HKObserverQuery` and `enableBackgroundDelivery(for:frequency:)`, plus the `com.apple.developer.healthkit.background-delivery` entitlement. iOS limits some types, such as steps, to hourly delivery, and it can delay any delivery.
- Use an `HKAnchoredObjectQuery` for incremental reads. The source time stays the sample's own time, and the stale state shows any lag.

## Without HealthKit

The import is optional. The web app and the phone app do not call it, and every other feature works without it. `GET /api/sources` and the NOOP stub (`{"status":"not_connected","source":"noop"}`) do not change.

## Device verification

These steps need an approved iPhone, an Apple ID with a HealthKit entitlement, and a HITL session:

1. Add a HealthKit reader to the phone app. It needs a native module and a development build; the current Expo app has neither.
2. Request read access for the five accepted types. Record the `access` value for each permission choice.
3. Check that Apple Watch samples include the device model, and record the bundle ids of the WHOOP app and the installed NOOP build.
4. Import once with real access and once after a denial. Confirm the `no_sample` and `whoop_origin` results.

Until then, cross-device demos use the synthetic fixtures. Android (Health Connect) and Fitbit are a separate future path; this import does not cover them.
