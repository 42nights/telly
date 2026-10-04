import { Schema } from "effect";

const FieldType = Schema.Literals([
	"int",
	"float",
	"flag",
	"text",
	"json",
	"hex",
]);
const Status = Schema.Literals([
	"measured",
	"computed",
	"estimated",
	"raw",
	"metadata",
]);
const Validation = Schema.Literals([
	"confirmed",
	"unvalidated",
	"baseline_dependent",
	"experimental",
	"not_decoded",
	"research_only",
]);
const Metric = Schema.Literals([
	"heart_rate",
	"on_wrist",
	"resting_heart_rate",
	"hrv",
	"respiratory_rate",
	"sleep_duration",
	"sleep_efficiency",
	"daily_steps",
	"daily_strain",
	"skin_temperature",
	"recovery",
]);

const supported = (validation: typeof Validation.Type) =>
	validation === "confirmed" ||
	validation === "unvalidated" ||
	validation === "baseline_dependent";

export const WhoopField = Schema.Struct({
	table: Schema.NonEmptyString,
	column: Schema.NonEmptyString,
	type: FieldType,
	unit: Schema.NullOr(Schema.NonEmptyString),
	device: Schema.NonEmptyString,
	cadence: Schema.NonEmptyString,
	delay: Schema.NonEmptyString,
	status: Status,
	validation: Validation,
	unavailable: Schema.NullOr(Schema.NonEmptyString),
	metric: Schema.NullOr(Metric),
}).check(
	Schema.makeFilter(
		(field) =>
			((field.metric === null ||
				(field.unavailable === null && supported(field.validation))) &&
				(field.status !== "measured" || supported(field.validation))) ||
			`${field.table}.${field.column}: an unavailable or unsupported field is never recorded as a metric, and an unsupported field is never measured`,
	),
);
export type WhoopField = typeof WhoopField.Type;

type Row = readonly [
	column: string,
	type: typeof FieldType.Type,
	unit: string | null,
	status: typeof Status.Type,
	validation: typeof Validation.Type,
	unavailable?: string | null,
	metric?: typeof Metric.Type,
];

type Source = Pick<WhoopField, "table" | "device" | "cadence" | "delay">;

const fields = (source: Source, rows: readonly Row[]) =>
	rows.map(
		([column, type, unit, status, validation, unavailable = null, metric]) => ({
			...source,
			column,
			type,
			unit,
			status,
			validation,
			unavailable,
			metric: metric ?? null,
		}),
	);

const STRAP = "WHOOP 5.0 / MG";
const LIVE = "~1–2 s while connected";
const EVENT = "sent at once while connected; starts a history sync";
const SYNC =
	"next history sync: ~15 min, 90 s after an event, 45–60 min on low refresh";
const AFTER_SYNC = "recomputed on the phone after a history sync";
const NOT_ROWS = "table exists, no rows from the WHOOP 5.0 / MG";
const NO_SPO2 = "no SpO₂ samples from the WHOOP 5.0 / MG";

const deviceId: Row = ["deviceId", "text", null, "metadata", "confirmed"];
const ts: Row = ["ts", "int", "unix s", "metadata", "confirmed"];
const day: Row = ["day", "text", "YYYY-MM-DD", "metadata", "confirmed"];
const synced: Row = ["synced", "flag", null, "metadata", "confirmed"];

const strap = (table: string, cadence: string, delay: string): Source => ({
	table,
	device: STRAP,
	cadence,
	delay,
});

const exported = [
	...fields(strap("battery", "about every 8 min", EVENT), [
		deviceId,
		ts,
		["soc", "float", "%", "measured", "confirmed"],
		[
			"mv",
			"int",
			"mV",
			"measured",
			"unvalidated",
			"not reported by the WHOOP 5.0 / MG",
		],
		synced,
		["charging", "flag", null, "measured", "confirmed"],
	]),
	...fields(strap("dailyMetric", "per day", AFTER_SYNC), [
		deviceId,
		day,
		[
			"totalSleepMin",
			"float",
			"min",
			"computed",
			"unvalidated",
			null,
			"sleep_duration",
		],
		[
			"efficiency",
			"float",
			"fraction 0–1",
			"computed",
			"unvalidated",
			null,
			"sleep_efficiency",
		],
		["deepMin", "float", "min", "computed", "unvalidated"],
		["remMin", "float", "min", "computed", "unvalidated"],
		["lightMin", "float", "min", "computed", "unvalidated"],
		["disturbances", "int", "count", "computed", "unvalidated"],
		[
			"restingHr",
			"int",
			"bpm",
			"computed",
			"unvalidated",
			null,
			"resting_heart_rate",
		],
		["avgHrv", "float", "ms RMSSD", "computed", "unvalidated", null, "hrv"],
		[
			"recovery",
			"float",
			"%",
			"computed",
			"baseline_dependent",
			null,
			"recovery",
		],
		[
			"strain",
			"float",
			"effort 0–100, not clamped to 0–21",
			"computed",
			"unvalidated",
			null,
			"daily_strain",
		],
		["exerciseCount", "int", "count", "computed", "unvalidated"],
		[
			"spo2Pct",
			"float",
			"%",
			"computed",
			"unvalidated",
			"the strap sends no blood-oxygen value",
		],
		["skinTempDevC", "float", "°C", "computed", "baseline_dependent"],
		[
			"respRateBpm",
			"float",
			"breaths/min",
			"estimated",
			"unvalidated",
			null,
			"respiratory_rate",
		],
		["steps", "int", "steps", "computed", "unvalidated", null, "daily_steps"],
		["activeKcalEst", "float", "kcal", "estimated", "unvalidated"],
		["spo2Red", "int", "ADC", "raw", "unvalidated", NO_SPO2],
		["spo2Ir", "int", "ADC", "raw", "unvalidated", NO_SPO2],
		["avgSdnn", "float", "ms SDNN", "computed", "unvalidated"],
		[
			"skinTempC",
			"float",
			"°C",
			"computed",
			"unvalidated",
			null,
			"skin_temperature",
		],
		["sleepHrOnly", "flag", null, "computed", "unvalidated"],
	]),
	...fields(strap("event", "on event", EVENT), [
		deviceId,
		ts,
		["kind", "text", null, "metadata", "confirmed"],
		["payloadJSON", "json", null, "raw", "unvalidated"],
		synced,
	]),
	...fields(strap("gravitySample", "1 Hz", SYNC), [
		deviceId,
		ts,
		["x", "float", "g", "measured", "confirmed"],
		["y", "float", "g", "measured", "confirmed"],
		["z", "float", "g", "measured", "confirmed"],
		synced,
		["dynAccel", "float", "g", "measured", "unvalidated"],
	]),
	...fields(strap("hrSample", "1 Hz", SYNC), [
		deviceId,
		ts,
		["bpm", "int", "bpm", "measured", "confirmed", null, "heart_rate"],
		synced,
	]),
	...fields(strap("liveSession", "per live session", "when the session ends"), [
		deviceId,
		["startTs", "int", "unix s", "metadata", "confirmed"],
		["endTs", "int", "unix s", "metadata", "confirmed"],
		["chargeAtStart", "float", "%", "computed", "baseline_dependent"],
		["floorBpm", "float", "bpm", "metadata", "confirmed"],
		["ceilingBpm", "float", "bpm", "metadata", "confirmed"],
		["inBandSec", "float", "s", "computed", "unvalidated"],
		["belowSec", "float", "s", "computed", "unvalidated"],
		["aboveSec", "float", "s", "computed", "unvalidated"],
		["pushCount", "int", "count", "computed", "confirmed"],
		["easeCount", "int", "count", "computed", "confirmed"],
		["hrSource", "text", null, "metadata", "confirmed"],
	]),
	...fields(strap("metricSeries", "per day", AFTER_SYNC), [
		deviceId,
		day,
		["key", "text", null, "metadata", "confirmed"],
		["value", "float", null, "computed", "unvalidated"],
	]),
	...fields(
		{
			table: "pairedDevice",
			device: "any paired device",
			cadence: "on pairing",
			delay: "when the device is paired or changes",
		},
		[
			["brand", "text", null, "metadata", "confirmed"],
			["model", "text", null, "metadata", "confirmed"],
			["capabilities", "text", "comma list", "metadata", "confirmed"],
			["status", "text", null, "metadata", "confirmed"],
		],
	),
	...fields(strap("ppgHrSample", "1 Hz in 10–40 s bursts", SYNC), [
		deviceId,
		ts,
		["bpm", "float", "bpm", "computed", "unvalidated"],
		["conf", "float", "0–1", "computed", "unvalidated"],
	]),
	...fields(strap("ppgWaveformSample", "1 Hz in bursts", SYNC), [
		deviceId,
		ts,
		["samplesHex", "hex", "24 deltas", "raw", "confirmed"],
		["burstIndex", "int", null, "raw", "unvalidated"],
		["baseCode", "int", "ADC", "raw", "confirmed"],
	]),
	...fields(strap("rrInterval", "every beat, up to 4 per second", SYNC), [
		deviceId,
		ts,
		["rrMs", "int", "ms", "measured", "confirmed"],
		["seq", "int", null, "metadata", "confirmed"],
		synced,
		["ord", "int", null, "metadata", "confirmed"],
		["srcChannel", "int", null, "metadata", "unvalidated"],
		["tsSuspect", "flag", null, "metadata", "unvalidated"],
	]),
	...fields(strap("scoreInputProvenance", "per day", AFTER_SYNC), [
		deviceId,
		day,
		["key", "text", null, "metadata", "confirmed"],
		["sourceId", "text", null, "metadata", "confirmed"],
	]),
	...fields(strap("skinTempSample", "1 Hz", SYNC), [
		deviceId,
		ts,
		["raw", "int", "0.01 °C", "raw", "confirmed"],
		synced,
		["aux1Raw", "int", "0.1 °C", "raw", "unvalidated"],
		["aux2Raw", "int", "0.1 °C", "raw", "unvalidated"],
	]),
	...fields(strap("sleepSession", "per sleep", AFTER_SYNC), [
		deviceId,
		["startTs", "int", "unix s", "computed", "unvalidated"],
		["endTs", "int", "unix s", "computed", "unvalidated"],
		["efficiency", "float", null, "computed", "unvalidated"],
		["restingHr", "int", "bpm", "computed", "unvalidated"],
		["avgHrv", "float", "ms", "computed", "unvalidated"],
		["stagesJSON", "json", null, "computed", "unvalidated"],
		["userEdited", "flag", null, "metadata", "confirmed"],
		["startTsAdjusted", "int", "unix s", "metadata", "confirmed"],
		["motionJSON", "json", null, "computed", "unvalidated"],
		["sleepStateJSON", "json", null, "raw", "unvalidated"],
		["stagingSparse", "flag", null, "computed", "unvalidated"],
	]),
	...fields(strap("sleepStateSample", "1 Hz", SYNC), [
		deviceId,
		ts,
		["state", "int", "code 0–3", "raw", "unvalidated"],
		["rawByte", "int", null, "raw", "unvalidated"],
	]),
	...fields(strap("stepSample", "1 Hz", SYNC), [
		deviceId,
		ts,
		["counter", "int", "count", "raw", "unvalidated"],
		["activityClass", "int", "class 0–2", "raw", "unvalidated"],
	]),
	...fields(strap("v18AuxSample", "1 Hz", SYNC), [
		deviceId,
		ts,
		["fieldsHex", "hex", null, "raw", "not_decoded"],
	]),
];

const catalogOnly = [
	...fields(strap("live.heartRate", "~1 Hz", LIVE), [
		["bpm", "int", "bpm", "measured", "confirmed"],
		["skinContact", "flag", null, "raw", "unvalidated"],
	]),
	...fields(strap("live.rrInterval", "every beat", LIVE), [
		["rrMs", "int", "ms", "measured", "confirmed"],
	]),
	...fields(strap("live.battery", "every 60 s, 30 s while charging", LIVE), [
		["soc", "float", "%", "measured", "confirmed", "kept in memory only"],
	]),
	...fields(strap("collector.imu", "100 Hz in 1 s buffers", LIVE), [
		[
			"accel",
			"float",
			"g",
			"raw",
			"confirmed",
			"only in a user-started Raw Data Collector session, saved as capture files",
		],
		[
			"gyro",
			"float",
			"°/s",
			"raw",
			"confirmed",
			"only in a user-started Raw Data Collector session, saved as capture files",
		],
	]),
	...fields(
		{
			table: "live.ecg",
			device: "WHOOP MG",
			cadence: "~100 Hz, unresolved",
			delay: LIVE,
		},
		[
			[
				"waveform",
				"hex",
				null,
				"raw",
				"experimental",
				"not stored, seen on one device",
			],
		],
	),
	...fields(strap("respSample", "1 Hz", SYNC), [
		["raw", "int", "ADC", "raw", "unvalidated", NOT_ROWS],
	]),
	...fields(strap("spo2Sample", "1 Hz", SYNC), [
		["red", "int", "ADC", "raw", "unvalidated", NOT_ROWS],
		["ir", "int", "ADC", "raw", "unvalidated", NOT_ROWS],
	]),
	...fields(strap("v18AuxSample.fieldsHex", "1 Hz", SYNC), [
		[
			"spo2Byte",
			"int",
			null,
			"raw",
			"research_only",
			"byte position and meaning not validated",
		],
	]),
	...fields(strap("opticalBlock", "1 Hz", SYNC), [
		[
			"samples",
			"int",
			"5 × 2 channels",
			"raw",
			"unvalidated",
			"decoded, not stored; wavelengths unknown",
		],
	]),
	...fields(strap("hardwareStepCounter", "1 Hz", SYNC), [
		[
			"count",
			"int",
			"count",
			"raw",
			"not_decoded",
			"documented only, not decoded",
		],
		[
			"softwareOverride",
			"flag",
			null,
			"raw",
			"not_decoded",
			"documented only, not decoded",
		],
	]),
	...fields(strap("hourly", "hourly", "computed on read"), [
		[
			"stress",
			"int",
			"0–3",
			"computed",
			"unvalidated",
			"computed on read in Healer S.I., not exported",
		],
	]),
	...fields(
		{
			table: "appleStepHour",
			device: "iPhone, Apple Health",
			cadence: "hourly",
			delay: "on Apple Health import",
		},
		[["steps", "int", "steps", "measured", "unvalidated", "not in the export"]],
	),
	...fields(strap("metricSeries.key", "per day", AFTER_SYNC), [
		["sleep_performance", "float", "%", "computed", "unvalidated"],
		["rhr_primary_session", "float", "bpm", "computed", "unvalidated"],
		["vitality", "float", null, "computed", "unvalidated"],
		["body_age", "float", "years", "computed", "unvalidated"],
		["*", "float", null, "computed", "unvalidated"],
	]),
	...fields(strap("event.kind", "on event", EVENT), [
		["DOUBLE_TAP", "int", "unix s", "measured", "confirmed"],
		["WRIST_ON", "int", "unix s", "measured", "confirmed", null, "on_wrist"],
		["WRIST_OFF", "int", "unix s", "measured", "confirmed", null, "on_wrist"],
		["BATTERY_LEVEL", "int", "unix s", "measured", "confirmed"],
		["CHARGING_ON", "int", "unix s", "measured", "confirmed"],
		["CHARGING_OFF", "int", "unix s", "measured", "confirmed"],
		["BATTERY_PACK_CONNECTED", "int", "unix s", "measured", "confirmed"],
		["BATTERY_PACK_REMOVED", "int", "unix s", "measured", "confirmed"],
		["0x6D(109)", "int", "unix s", "raw", "confirmed"],
		["STRAP_CONDITION_REPORT", "int", "unix s", "raw", "unvalidated"],
		["BLE_REALTIME_HR_ON", "int", "unix s", "metadata", "confirmed"],
		["BLE_REALTIME_HR_OFF", "int", "unix s", "metadata", "confirmed"],
		["STRAP_DRIVEN_ALARM_SET", "int", "unix s", "metadata", "unvalidated"],
		["STRAP_DRIVEN_ALARM_EXECUTED", "int", "unix s", "metadata", "unvalidated"],
		["APP_DRIVEN_ALARM_EXECUTED", "int", "unix s", "metadata", "unvalidated"],
		["STRAP_DRIVEN_ALARM_DISABLED", "int", "unix s", "metadata", "unvalidated"],
		["HAPTICS_FIRED", "int", "unix s", "metadata", "unvalidated"],
		["HAPTICS_TERMINATED", "int", "unix s", "metadata", "unvalidated"],
		[
			"ACCELEROMETER_SATURATION_DETECTED",
			"int",
			"unix s",
			"measured",
			"unvalidated",
		],
		["RTC_LOST", "int", "unix s", "metadata", "confirmed"],
		["BOOT", "int", "unix s", "metadata", "confirmed"],
		["SET_RTC", "int", "unix s", "metadata", "confirmed"],
		["0x6E, 0x7B, 0x78, …", "int", "unix s", "raw", "not_decoded"],
	]),
	...fields(strap("sleepSession.stagesJSON", "per sleep", AFTER_SYNC), [
		["start", "int", "unix s", "computed", "unvalidated"],
		["end", "int", "unix s", "computed", "unvalidated"],
		["stage", "text", "wake | light | deep | rem", "computed", "unvalidated"],
	]),
	...fields(strap("sleepSession.motionJSON", "per epoch", AFTER_SYNC), [
		["[]", "float", null, "computed", "unvalidated"],
	]),
	...fields(strap("sleepSession.sleepStateJSON", "per epoch", AFTER_SYNC), [
		["[]", "json", null, "raw", "unvalidated"],
	]),
];

export const whoopCatalog = Schema.decodeSync(Schema.Array(WhoopField))([
	...exported,
	...catalogOnly,
]);
