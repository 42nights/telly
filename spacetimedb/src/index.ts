// Family-scoped health data. Every table is private: clients read only through the per-sender views
// below, and every reducer checks the caller's family membership itself, independent of the server.
import { type Identity, Timestamp } from "spacetimedb";
import {
	type InferSchema,
	type ReducerCtx,
	SenderError,
	schema,
	t,
	table,
	type ViewCtx,
} from "spacetimedb/server";

const family = table(
	{ name: "family" },
	{
		id: t.u64().primaryKey().autoInc(),
		name: t.string(),
		createdAt: t.timestamp(),
	},
);

const familyMember = table(
	{
		name: "family_member",
		indexes: [
			{
				accessor: "byFamilyMember",
				algorithm: "btree",
				columns: ["familyId", "member"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		member: t.identity().index("btree"),
		addedAt: t.timestamp(),
	},
);

// Only validated signals may drive monitoring; everything else stays visibly unvalidated.
const SampleQuality = t.enum("SampleQuality", {
	Validated: t.unit(),
	Unvalidated: t.unit(),
});

const healthSample = table(
	{ name: "health_sample" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		metric: t.string(),
		value: t.f64(),
		unit: t.string(),
		// When the source measured the value, as reported by the source.
		sourceTime: t.timestamp(),
		// When the database accepted the value; set here, never by the caller.
		receivedAt: t.timestamp(),
		// The device or provider that produced the value, and whether it is synthetic demo data.
		source: t.string(),
		synthetic: t.bool(),
		quality: SampleQuality,
		recordedBy: t.identity(),
	},
);

const alert = table(
	{ name: "alert" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		sampleId: t.option(t.u64()),
		summary: t.string(),
		raisedBy: t.identity(),
		createdAt: t.timestamp(),
	},
);

const message = table(
	{
		name: "message",
		indexes: [
			{
				accessor: "bySenderClientId",
				algorithm: "btree",
				columns: ["familyId", "sender", "clientId"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		sender: t.identity(),
		body: t.string(),
		sentAt: t.timestamp(),
		// The sender's own id for the message, so a retried send stores it once.
		clientId: t.string(),
	},
);

const acknowledgement = table(
	{
		name: "acknowledgement",
		indexes: [
			{
				accessor: "byAlertMember",
				algorithm: "btree",
				columns: ["alertId", "member"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		alertId: t.u64(),
		familyId: t.u64().index("btree"),
		member: t.identity(),
		acknowledgedAt: t.timestamp(),
	},
);

// The identity that published the module. It runs family alert delivery, so it alone reads and
// settles the outbox. It is no family member and reads no family's records.
const operator = table(
	{ name: "operator" },
	{ identity: t.identity().primaryKey() },
);

const ThresholdDirection = t.enum("ThresholdDirection", {
	Above: t.unit(),
	Below: t.unit(),
});

// A family's alert rule. A fresh, validated sample in `unit` strictly beyond `limit` raises an alert.
const alertThreshold = table(
	{
		name: "alert_threshold",
		indexes: [
			{
				accessor: "byFamilyMetric",
				algorithm: "btree",
				columns: ["familyId", "metric"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		metric: t.string(),
		direction: ThresholdDirection,
		limit: t.f64(),
		unit: t.string(),
		// A sample whose source time is older than this when it arrives is stale and raises nothing.
		maxAgeSeconds: t.u32(),
		updatedBy: t.identity(),
		updatedAt: t.timestamp(),
	},
);

// One row per threshold alert, keyed by threshold, source, and source time, so a replayed or
// reordered sample never raises the same alert twice.
const thresholdTrigger = table(
	{ name: "threshold_trigger" },
	{ key: t.string().primaryKey(), alertId: t.u64() },
);

// Provider delivery only. A family member's acknowledgement is separate (`acknowledgement`).
const DeliveryStatus = t.enum("DeliveryStatus", {
	Queued: t.unit(),
	Sent: t.unit(),
	Failed: t.unit(),
	// No delivery transport is configured. The delivery is retried once one is.
	Unavailable: t.unit(),
});

// The outbox: each alert's family delivery, written in the same transaction as the alert.
const alertDelivery = table(
	{ name: "alert_delivery" },
	{
		alertId: t.u64().primaryKey(),
		familyId: t.u64().index("btree"),
		summary: t.string(),
		status: DeliveryStatus,
		attempts: t.u32(),
		// No worker may claim the delivery before this time: a running claim's lease or a retry's backoff.
		notBefore: t.timestamp(),
		lastError: t.option(t.string()),
		updatedAt: t.timestamp(),
	},
);

// A lab report. The markers are the evidence generated from the family's samples: set once at
// creation, never changed. Only the fillable fields change, and only until a member reviews it.
const report = table(
	{ name: "report" },
	{
		// Chosen by the server, so it knows which report it created.
		id: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		// JSON that the server validates against the `@health/contracts` report schemas.
		markers: t.string(),
		fields: t.string(),
		createdBy: t.identity(),
		createdAt: t.timestamp(),
		reviewedBy: t.option(t.identity()),
		reviewedAt: t.option(t.timestamp()),
	},
);

// A FinchNode subject (one consenting patient) whose records the family may read. FinchNode checks
// the patient's consent on every read; this link only says which family asked for the subject.
const finchnodeLink = table(
	{
		name: "finchnode_link",
		indexes: [
			{
				accessor: "byFamilySubject",
				algorithm: "btree",
				columns: ["familyId", "subject"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		subject: t.string(),
		// From the keyless demo or a sandbox key: fictional patient data.
		synthetic: t.bool(),
		linkedBy: t.identity(),
		linkedAt: t.timestamp(),
	},
);

// The wearer's care profile (#26). Each save is a new version, so the history keeps who changed
// it and when. JSON that the server validates against `@health/contracts/care-profile`.
const careProfileVersion = table(
	{ name: "care_profile_version" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		profile: t.string(),
		editedBy: t.identity(),
		editedAt: t.timestamp(),
	},
);

// What an editor writes for one medication or care instruction version.
const careInstructionFields = {
	kind: t.string(),
	name: t.string(),
	instruction: t.string(),
	times: t.array(t.string()),
	reason: t.option(t.string()),
	source: t.string(),
	effectiveDate: t.string(),
};

// A medication or care instruction. A change is a new row; only the verification fields are ever
// set later, once. The server derives verified, unverified, conflicting, and stale from the rows.
const careInstruction = table(
	{ name: "care_instruction" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		...careInstructionFields,
		editedBy: t.identity(),
		editedAt: t.timestamp(),
		verifiedBy: t.option(t.identity()),
		verifiedAt: t.option(t.timestamp()),
	},
);

// Per-recipient sharing: every grant and revoke, in order. A member holds a scope when their latest
// event for it grants it. Membership alone holds no scope.
const careGrantEvent = table(
	{
		name: "care_grant_event",
		indexes: [
			{
				accessor: "byFamilyMember",
				algorithm: "btree",
				columns: ["familyId", "member"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		member: t.identity(),
		scope: t.string(),
		granted: t.bool(),
		changedBy: t.identity(),
		changedAt: t.timestamp(),
	},
);

// One fact about one meal, as its own row: a photo was taken, a food estimate, or an intake
// report. The photo itself is never stored. The server validates `fact` against `MealFact` in
// `@health/contracts/meals` and records a photo or an estimate only as itself, never as eaten food.
const mealFact = table(
	{ name: "meal_fact" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		// The client's id for one meal occasion; it groups the meal's facts.
		mealId: t.string(),
		fact: t.string(),
		recordedBy: t.identity(),
		recordedAt: t.timestamp(),
	},
);

const spacetimedb = schema({
	family,
	familyMember,
	healthSample,
	alert,
	message,
	acknowledgement,
	operator,
	alertThreshold,
	thresholdTrigger,
	alertDelivery,
	report,
	finchnodeLink,
	careProfileVersion,
	careInstruction,
	careGrantEvent,
	mealFact,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const requireMember = (ctx: Ctx, familyId: bigint) => {
	const rows = ctx.db.familyMember.byFamilyMember.filter([
		familyId,
		ctx.sender,
	]);
	if (rows.next().done) throw new SenderError("not a member of this family");
};

const requireText = (field: string, value: string) => {
	if (value.trim() === "") throw new SenderError(`${field} must not be empty`);
};

// The `CareScope` values of `@health/contracts/care-profile`.
const careScopes: Record<string, true> = {
	health_records: true,
	care_plan_edit: true,
	family_access: true,
	location: true,
	media: true,
	clinician_delivery: true,
	purchases: true,
};

/** Whether one member's grant events (from `careGrantEvent.byFamilyMember`) hold `scope` now. */
const holdsCareScope = (
	events: Iterable<{ id: bigint; scope: string; granted: boolean }>,
	scope: string,
) => {
	let latest: { id: bigint; granted: boolean } | undefined;
	for (const event of events)
		if (event.scope === scope && (latest === undefined || event.id > latest.id))
			latest = event;
	return latest?.granted === true;
};

const requireCareScope = (ctx: Ctx, familyId: bigint, scope: string) => {
	requireMember(ctx, familyId);
	const events = ctx.db.careGrantEvent.byFamilyMember.filter([
		familyId,
		ctx.sender,
	]);
	if (!holdsCareScope(events, scope))
		throw new SenderError(`no care access: ${scope}`);
};

const insertAlert = (
	ctx: Ctx,
	familyId: bigint,
	sampleId: bigint | undefined,
	summary: string,
) => {
	const { id } = ctx.db.alert.insert({
		id: 0n,
		familyId,
		sampleId,
		summary,
		raisedBy: ctx.sender,
		createdAt: ctx.timestamp,
	});
	ctx.db.alertDelivery.insert({
		alertId: id,
		familyId,
		summary,
		status: { tag: "Queued" },
		attempts: 0,
		notBefore: ctx.timestamp,
		lastError: undefined,
		updatedAt: ctx.timestamp,
	});
	return id;
};

// A source clock may run slightly ahead of the database; further ahead, the sample is not fresh.
const MAX_CLOCK_AHEAD_MICROS = 60_000_000n;

type StoredSample = {
	id: bigint;
	familyId: bigint;
	metric: string;
	value: number;
	unit: string;
	sourceTime: Timestamp;
	source: string;
	synthetic: boolean;
};

// Rules only: no model or provider takes part, so their outages cannot suppress an alert.
const raiseThresholdAlerts = (ctx: Ctx, sample: StoredSample) => {
	const sourceMicros = sample.sourceTime.microsSinceUnixEpoch;
	const age = ctx.timestamp.microsSinceUnixEpoch - sourceMicros;
	const rules = ctx.db.alertThreshold.byFamilyMetric.filter([
		sample.familyId,
		sample.metric,
	]);
	for (const rule of rules) {
		const fresh =
			age >= -MAX_CLOCK_AHEAD_MICROS &&
			age <= BigInt(rule.maxAgeSeconds) * 1_000_000n;
		const above = rule.direction.tag === "Above";
		const beyond = above
			? sample.value > rule.limit
			: sample.value < rule.limit;
		if (rule.unit !== sample.unit || !fresh || !beyond) continue;
		const key = `${rule.id}/${sample.source}/${sourceMicros}`;
		if (ctx.db.thresholdTrigger.key.find(key) !== null) continue;
		const summary = `${sample.synthetic ? "Synthetic: " : ""}${sample.metric} ${sample.value} ${sample.unit} at ${sample.sourceTime.toISOString()} is ${above ? "above" : "below"} ${rule.limit} ${rule.unit}`;
		const alertId = insertAlert(ctx, sample.familyId, sample.id, summary);
		ctx.db.thresholdTrigger.insert({ key, alertId });
	}
};

export const createFamily = spacetimedb.reducer(
	{ name: t.string() },
	(ctx, { name }) => {
		requireText("name", name);
		const { id } = ctx.db.family.insert({
			id: 0n,
			name,
			createdAt: ctx.timestamp,
		});
		ctx.db.familyMember.insert({
			id: 0n,
			familyId: id,
			member: ctx.sender,
			addedAt: ctx.timestamp,
		});
	},
);

export const addFamilyMember = spacetimedb.reducer(
	{ familyId: t.u64(), member: t.identity() },
	(ctx, { familyId, member }) => {
		requireMember(ctx, familyId);
		const rows = ctx.db.familyMember.byFamilyMember.filter([familyId, member]);
		if (!rows.next().done) return;
		ctx.db.familyMember.insert({
			id: 0n,
			familyId,
			member,
			addedAt: ctx.timestamp,
		});
	},
);

export const recordSample = spacetimedb.reducer(
	{
		familyId: t.u64(),
		metric: t.string(),
		value: t.f64(),
		unit: t.string(),
		sourceTime: t.timestamp(),
		source: t.string(),
		synthetic: t.bool(),
		quality: SampleQuality,
	},
	(ctx, sample) => {
		requireMember(ctx, sample.familyId);
		requireText("metric", sample.metric);
		requireText("unit", sample.unit);
		requireText("source", sample.source);
		if (!Number.isFinite(sample.value))
			throw new SenderError("value must be a finite number");
		const stored = ctx.db.healthSample.insert({
			...sample,
			id: 0n,
			receivedAt: ctx.timestamp,
			recordedBy: ctx.sender,
		});
		if (stored.quality.tag === "Validated") raiseThresholdAlerts(ctx, stored);
	},
);

export const raiseAlert = spacetimedb.reducer(
	{ familyId: t.u64(), sampleId: t.option(t.u64()), summary: t.string() },
	(ctx, { familyId, sampleId, summary }) => {
		requireMember(ctx, familyId);
		requireText("summary", summary);
		if (
			sampleId !== undefined &&
			ctx.db.healthSample.id.find(sampleId)?.familyId !== familyId
		)
			throw new SenderError("sample does not belong to this family");
		insertAlert(ctx, familyId, sampleId, summary);
	},
);

export const sendMessage = spacetimedb.reducer(
	{ familyId: t.u64(), clientId: t.string(), body: t.string() },
	(ctx, { familyId, clientId, body }) => {
		requireMember(ctx, familyId);
		requireText("clientId", clientId);
		requireText("body", body);
		// A client resends after a lost reply; the first stored copy stands.
		for (const sent of ctx.db.message.bySenderClientId.filter([
			familyId,
			ctx.sender,
			clientId,
		])) {
			if (sent.body !== body)
				throw new SenderError("clientId is already used for another message");
			return;
		}
		ctx.db.message.insert({
			id: 0n,
			familyId,
			sender: ctx.sender,
			body,
			sentAt: ctx.timestamp,
			clientId,
		});
	},
);

export const acknowledgeAlert = spacetimedb.reducer(
	{ alertId: t.u64() },
	(ctx, { alertId }) => {
		const found = ctx.db.alert.id.find(alertId);
		// A missing alert fails like another family's alert, so ids reveal nothing.
		if (found === null) throw new SenderError("not a member of this family");
		requireMember(ctx, found.familyId);
		const acks = ctx.db.acknowledgement.byAlertMember.filter([
			alertId,
			ctx.sender,
		]);
		if (!acks.next().done) return;
		ctx.db.acknowledgement.insert({
			id: 0n,
			alertId,
			familyId: found.familyId,
			member: ctx.sender,
			acknowledgedAt: ctx.timestamp,
		});
	},
);

export const setAlertThreshold = spacetimedb.reducer(
	{
		familyId: t.u64(),
		metric: t.string(),
		direction: ThresholdDirection,
		limit: t.f64(),
		unit: t.string(),
		maxAgeSeconds: t.u32(),
	},
	(ctx, rule) => {
		requireMember(ctx, rule.familyId);
		requireText("metric", rule.metric);
		requireText("unit", rule.unit);
		if (!Number.isFinite(rule.limit))
			throw new SenderError("limit must be a finite number");
		if (rule.maxAgeSeconds === 0)
			throw new SenderError("maxAgeSeconds must be positive");
		const row = {
			...rule,
			id: 0n,
			updatedBy: ctx.sender,
			updatedAt: ctx.timestamp,
		};
		// One rule per family, metric, and direction: setting it again replaces it.
		const existing = [
			...ctx.db.alertThreshold.byFamilyMetric.filter([
				rule.familyId,
				rule.metric,
			]),
		].find((r) => r.direction.tag === rule.direction.tag);
		if (existing === undefined) ctx.db.alertThreshold.insert(row);
		else ctx.db.alertThreshold.id.update({ ...row, id: existing.id });
	},
);

export const removeAlertThreshold = spacetimedb.reducer(
	{ thresholdId: t.u64() },
	(ctx, { thresholdId }) => {
		const found = ctx.db.alertThreshold.id.find(thresholdId);
		if (found === null) throw new SenderError("not a member of this family");
		requireMember(ctx, found.familyId);
		ctx.db.alertThreshold.id.delete(thresholdId);
	},
);

export const init = spacetimedb.init((ctx) => {
	ctx.db.operator.insert({ identity: ctx.sender });
});

// Outbox steps for the delivery worker. Times come from the database clock. Sent is final: a late
// failure report never undoes it, and a repeated report changes nothing.
const openDelivery = (ctx: Ctx, alertId: bigint) => {
	if (ctx.db.operator.identity.find(ctx.sender) === null)
		throw new SenderError("not the delivery operator");
	const row = ctx.db.alertDelivery.alertId.find(alertId);
	if (row === null) throw new SenderError("no such delivery");
	return row;
};

const secondsFromNow = (ctx: Ctx, seconds: number) =>
	new Timestamp(
		ctx.timestamp.microsSinceUnixEpoch + BigInt(seconds) * 1_000_000n,
	);

/** Takes a due delivery for `leaseSeconds`. A worker that stops mid-send loses the lease, and the delivery is retried. */
export const claimAlertDelivery = spacetimedb.reducer(
	{ alertId: t.u64(), leaseSeconds: t.u32() },
	(ctx, { alertId, leaseSeconds }) => {
		const row = openDelivery(ctx, alertId);
		const pending =
			row.status.tag === "Queued" || row.status.tag === "Unavailable";
		if (
			!pending ||
			row.notBefore.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch
		)
			throw new SenderError("delivery is not due");
		if (leaseSeconds === 0 || leaseSeconds > 300)
			throw new SenderError("leaseSeconds must be 1 to 300");
		ctx.db.alertDelivery.alertId.update({
			...row,
			status: { tag: "Queued" },
			attempts: row.attempts + 1,
			notBefore: secondsFromNow(ctx, leaseSeconds),
			updatedAt: ctx.timestamp,
		});
	},
);

export const markAlertDeliverySent = spacetimedb.reducer(
	{ alertId: t.u64() },
	(ctx, { alertId }) => {
		const row = openDelivery(ctx, alertId);
		if (row.status.tag === "Sent") return;
		ctx.db.alertDelivery.alertId.update({
			...row,
			status: { tag: "Sent" },
			lastError: undefined,
			updatedAt: ctx.timestamp,
		});
	},
);

/** With `retryAfterSeconds` the delivery stays queued until then; without it, the delivery fails for good. */
export const markAlertDeliveryFailed = spacetimedb.reducer(
	{ alertId: t.u64(), error: t.string(), retryAfterSeconds: t.option(t.u32()) },
	(ctx, { alertId, error, retryAfterSeconds }) => {
		const row = openDelivery(ctx, alertId);
		if (row.status.tag === "Sent") return;
		ctx.db.alertDelivery.alertId.update({
			...row,
			status:
				retryAfterSeconds === undefined ? { tag: "Failed" } : { tag: "Queued" },
			notBefore: secondsFromNow(ctx, retryAfterSeconds ?? 0),
			lastError: error,
			updatedAt: ctx.timestamp,
		});
	},
);

export const markAlertDeliveryUnavailable = spacetimedb.reducer(
	{ alertId: t.u64(), reason: t.string() },
	(ctx, { alertId, reason }) => {
		const row = openDelivery(ctx, alertId);
		if (row.status.tag === "Sent") return;
		ctx.db.alertDelivery.alertId.update({
			...row,
			status: { tag: "Unavailable" },
			notBefore: ctx.timestamp,
			lastError: reason,
			updatedAt: ctx.timestamp,
		});
	},
);

const requireReport = (ctx: Ctx, id: string) => {
	const found = ctx.db.report.id.find(id);
	// A missing report fails like another family's report, so ids reveal nothing.
	if (found === null) throw new SenderError("not a member of this family");
	requireMember(ctx, found.familyId);
	return found;
};

export const createReport = spacetimedb.reducer(
	{
		id: t.string(),
		familyId: t.u64(),
		markers: t.string(),
		fields: t.string(),
	},
	(ctx, created) => {
		requireMember(ctx, created.familyId);
		requireText("id", created.id);
		requireText("markers", created.markers);
		requireText("fields", created.fields);
		if (ctx.db.report.id.find(created.id) !== null)
			throw new SenderError("report id already exists");
		ctx.db.report.insert({
			...created,
			createdBy: ctx.sender,
			createdAt: ctx.timestamp,
			reviewedBy: undefined,
			reviewedAt: undefined,
		});
	},
);

// Changes a draft: new `fields`, a review, or both. Review freezes the report as it then stands.
// Reviewing a reviewed report again, without fields, keeps the first review.
export const updateReport = spacetimedb.reducer(
	{ id: t.string(), fields: t.option(t.string()), review: t.bool() },
	(ctx, { id, fields, review }) => {
		const found = requireReport(ctx, id);
		if (found.reviewedAt !== undefined) {
			if (review && fields === undefined) return;
			throw new SenderError("report is already reviewed");
		}
		if (fields !== undefined) requireText("fields", fields);
		ctx.db.report.id.update({
			...found,
			fields: fields ?? found.fields,
			...(review ? { reviewedBy: ctx.sender, reviewedAt: ctx.timestamp } : {}),
		});
	},
);

export const linkFinchnodeSubject = spacetimedb.reducer(
	{ familyId: t.u64(), subject: t.string(), synthetic: t.bool() },
	(ctx, link) => {
		requireMember(ctx, link.familyId);
		requireText("subject", link.subject);
		const rows = ctx.db.finchnodeLink.byFamilySubject.filter([
			link.familyId,
			link.subject,
		]);
		if (!rows.next().done) return;
		ctx.db.finchnodeLink.insert({
			...link,
			id: 0n,
			linkedBy: ctx.sender,
			linkedAt: ctx.timestamp,
		});
	},
);

export const saveCareProfile = spacetimedb.reducer(
	{ familyId: t.u64(), profile: t.string() },
	(ctx, { familyId, profile }) => {
		requireCareScope(ctx, familyId, "care_plan_edit");
		requireText("profile", profile);
		ctx.db.careProfileVersion.insert({
			id: 0n,
			familyId,
			profile,
			editedBy: ctx.sender,
			editedAt: ctx.timestamp,
		});
	},
);

export const addCareInstruction = spacetimedb.reducer(
	{ familyId: t.u64(), ...careInstructionFields },
	(ctx, added) => {
		requireCareScope(ctx, added.familyId, "care_plan_edit");
		if (added.kind !== "medication" && added.kind !== "care")
			throw new SenderError("kind must be medication or care");
		requireText("name", added.name);
		requireText("instruction", added.instruction);
		requireText("source", added.source);
		requireText("effectiveDate", added.effectiveDate);
		ctx.db.careInstruction.insert({
			...added,
			reason: added.reason,
			id: 0n,
			editedBy: ctx.sender,
			editedAt: ctx.timestamp,
			verifiedBy: undefined,
			verifiedAt: undefined,
		});
	},
);

// Verifying is the only way a version takes effect. An older version cannot be verified over a
// newer verified one, so a verified schedule never silently goes back.
export const verifyCareInstruction = spacetimedb.reducer(
	{ id: t.u64() },
	(ctx, { id }) => {
		const found = ctx.db.careInstruction.id.find(id);
		// A missing instruction fails like another family's, so ids reveal nothing.
		if (found === null) throw new SenderError("not a member of this family");
		requireCareScope(ctx, found.familyId, "care_plan_edit");
		if (found.verifiedAt !== undefined) return;
		const key = found.name.toLowerCase();
		for (const other of ctx.db.careInstruction.familyId.filter(found.familyId))
			if (
				other.id > id &&
				other.verifiedAt !== undefined &&
				other.kind === found.kind &&
				other.name.toLowerCase() === key
			)
				throw new SenderError("a newer version is already verified");
		ctx.db.careInstruction.id.update({
			...found,
			verifiedBy: ctx.sender,
			verifiedAt: ctx.timestamp,
		});
	},
);

// Until anyone has ever held `family_access`, the family's founder (its first member) may change
// grants, so a new family can set up sharing.
const maySetUpSharing = (ctx: Ctx, familyId: bigint) => {
	for (const event of ctx.db.careGrantEvent.familyId.filter(familyId))
		if (event.scope === "family_access" && event.granted) return false;
	let founder: { id: bigint; member: Identity } | undefined;
	for (const m of ctx.db.familyMember.familyId.filter(familyId))
		if (founder === undefined || m.id < founder.id) founder = m;
	return founder?.member.isEqual(ctx.sender) === true;
};

// A `family_access` holder changes grants (see `maySetUpSharing` for a new family).
export const setCareGrant = spacetimedb.reducer(
	{
		familyId: t.u64(),
		member: t.identity(),
		scope: t.string(),
		granted: t.bool(),
	},
	(ctx, grant) => {
		requireMember(ctx, grant.familyId);
		if (careScopes[grant.scope] !== true)
			throw new SenderError("unknown care scope");
		const grantee = ctx.db.familyMember.byFamilyMember.filter([
			grant.familyId,
			grant.member,
		]);
		if (grantee.next().done)
			throw new SenderError("the grantee is not a member of this family");
		const mine = ctx.db.careGrantEvent.byFamilyMember.filter([
			grant.familyId,
			ctx.sender,
		]);
		if (
			!holdsCareScope(mine, "family_access") &&
			!maySetUpSharing(ctx, grant.familyId)
		)
			throw new SenderError("no care access: family_access");
		ctx.db.careGrantEvent.insert({
			...grant,
			id: 0n,
			changedBy: ctx.sender,
			changedAt: ctx.timestamp,
		});
	},
);

export const recordMealFact = spacetimedb.reducer(
	{ familyId: t.u64(), mealId: t.string(), fact: t.string() },
	(ctx, recorded) => {
		requireMember(ctx, recorded.familyId);
		requireText("mealId", recorded.mealId);
		requireText("fact", recorded.fact);
		ctx.db.mealFact.insert({
			...recorded,
			id: 0n,
			recordedBy: ctx.sender,
			recordedAt: ctx.timestamp,
		});
	},
);

// Per-sender reads: each view returns only rows of families the caller belongs to.
export const myFamilies = spacetimedb.view(
	{ name: "my_families", public: true },
	t.array(family.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.family, (m, f) => m.familyId.eq(f.id)),
);

export const myHealthSamples = spacetimedb.view(
	{ name: "my_health_samples", public: true },
	t.array(healthSample.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.healthSample, (m, s) =>
				m.familyId.eq(s.familyId),
			),
);

export const myAlerts = spacetimedb.view(
	{ name: "my_alerts", public: true },
	t.array(alert.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.alert, (m, a) => m.familyId.eq(a.familyId)),
);

export const myMessages = spacetimedb.view(
	{ name: "my_messages", public: true },
	t.array(message.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.message, (m, msg) => m.familyId.eq(msg.familyId)),
);

export const myAcknowledgements = spacetimedb.view(
	{ name: "my_acknowledgements", public: true },
	t.array(acknowledgement.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.acknowledgement, (m, ack) =>
				m.familyId.eq(ack.familyId),
			),
);

export const myAlertThresholds = spacetimedb.view(
	{ name: "my_alert_thresholds", public: true },
	t.array(alertThreshold.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.alertThreshold, (m, rule) =>
				m.familyId.eq(rule.familyId),
			),
);

export const myAlertDeliveries = spacetimedb.view(
	{ name: "my_alert_deliveries", public: true },
	t.array(alertDelivery.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.alertDelivery, (m, d) =>
				m.familyId.eq(d.familyId),
			),
);

// The delivery operator's work queue across families. Empty for every other identity.
// ponytail: scans the whole outbox on each change; index the status when delivery history grows.
export const pendingAlertDeliveries = spacetimedb.view(
	{ name: "pending_alert_deliveries", public: true },
	t.array(
		t.object("PendingDelivery", {
			alertId: t.u64(),
			familyId: t.u64(),
			summary: t.string(),
			status: DeliveryStatus,
			attempts: t.u32(),
			notBefore: t.timestamp(),
			updatedAt: t.timestamp(),
		}),
	),
	(ctx) =>
		ctx.db.operator.identity.find(ctx.sender) === null
			? []
			: [...ctx.db.alertDelivery.iter()]
					.filter(
						(d) => d.status.tag === "Queued" || d.status.tag === "Unavailable",
					)
					.map((d) => ({
						alertId: d.alertId,
						familyId: d.familyId,
						summary: d.summary,
						status: d.status,
						attempts: d.attempts,
						notBefore: d.notBefore,
						updatedAt: d.updatedAt,
					})),
);

export const myReports = spacetimedb.view(
	{ name: "my_reports", public: true },
	t.array(report.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.report, (m, r) => m.familyId.eq(r.familyId)),
);

export const myFinchnodeLinks = spacetimedb.view(
	{ name: "my_finchnode_links", public: true },
	t.array(finchnodeLink.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.finchnodeLink, (m, l) =>
				m.familyId.eq(l.familyId),
			),
);

// Care views (#26): the profile and instructions only for families where the caller holds
// `health_records` now, so a revoke empties them at once. Grants are visible to every member.
const careReader = <Row>(
	ctx: ViewCtx<InferSchema<typeof spacetimedb>>,
	rows: (familyId: bigint) => Iterable<Row>,
): Row[] =>
	[...ctx.db.familyMember.member.filter(ctx.sender)].flatMap((m) =>
		holdsCareScope(
			ctx.db.careGrantEvent.byFamilyMember.filter([m.familyId, ctx.sender]),
			"health_records",
		)
			? [...rows(m.familyId)]
			: [],
	);

export const myCareProfiles = spacetimedb.view(
	{ name: "my_care_profiles", public: true },
	t.array(careProfileVersion.rowType),
	(ctx) =>
		careReader(ctx, (familyId) =>
			ctx.db.careProfileVersion.familyId.filter(familyId),
		),
);

export const myCareInstructions = spacetimedb.view(
	{ name: "my_care_instructions", public: true },
	t.array(careInstruction.rowType),
	(ctx) =>
		careReader(ctx, (familyId) =>
			ctx.db.careInstruction.familyId.filter(familyId),
		),
);

export const myCareGrants = spacetimedb.view(
	{ name: "my_care_grants", public: true },
	t.array(careGrantEvent.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.careGrantEvent, (m, g) =>
				m.familyId.eq(g.familyId),
			),
);

export const myMealFacts = spacetimedb.view(
	{ name: "my_meal_facts", public: true },
	t.array(mealFact.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.mealFact, (m, f) => m.familyId.eq(f.familyId)),
);
