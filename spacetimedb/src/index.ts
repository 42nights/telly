// Family-scoped health data. Every table is private: clients read only through the per-sender views
// below, and every reducer checks the caller's family membership itself, independent of the server.
import { type Infer, Timestamp } from "spacetimedb";
import {
	type InferSchema,
	type ReducerCtx,
	SenderError,
	schema,
	t,
	table,
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

// What a person's device last said about its position. `NoFix` covers a timeout or no signal.
const LocationStatus = t.enum("LocationStatus", {
	Fix: t.unit(),
	GpsDenied: t.unit(),
	NoFix: t.unit(),
});

// One position from a device; `fixTime` is when the device took it, by the device clock.
const LocationFix = t.object("LocationFix", {
	latitude: t.f64(),
	longitude: t.f64(),
	accuracyMeters: t.f64(),
	fixTime: t.timestamp(),
});

// A person's latest location report in one family: one row per sharer, replaced by each report,
// so no trail is kept. `fix` is the last good fix; a later GPS-denied or no-fix report changes
// only `status` and `reportedAt`, so the fix stays readable as the last known location.
const location = table(
	{
		name: "location",
		indexes: [
			{
				accessor: "byFamilySharer",
				algorithm: "btree",
				columns: ["familyId", "sharer"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		sharer: t.identity().index("btree"),
		status: LocationStatus,
		fix: t.option(LocationFix),
		// When the database accepted the latest report.
		reportedAt: t.timestamp(),
	},
);

// One person allows one other family member to see their location. Deleting it revokes access.
const locationShare = table(
	{
		name: "location_share",
		indexes: [
			{
				accessor: "byFamilySharer",
				algorithm: "btree",
				columns: ["familyId", "sharer"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		sharer: t.identity().index("btree"),
		viewer: t.identity().index("btree"),
		sharedAt: t.timestamp(),
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
	location,
	locationShare,
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

const sharesOf = (ctx: Ctx, familyId: bigint) => [
	...ctx.db.locationShare.byFamilySharer.filter([familyId, ctx.sender]),
];

/** Lets one other member of the family see the sender's location. Sharing twice changes nothing. */
export const shareLocation = spacetimedb.reducer(
	{ familyId: t.u64(), viewer: t.identity() },
	(ctx, { familyId, viewer }) => {
		requireMember(ctx, familyId);
		if (viewer.isEqual(ctx.sender))
			throw new SenderError("viewer must be another family member");
		const member = ctx.db.familyMember.byFamilyMember.filter([
			familyId,
			viewer,
		]);
		if (member.next().done)
			throw new SenderError("viewer is not a member of this family");
		if (sharesOf(ctx, familyId).some((s) => s.viewer.isEqual(viewer))) return;
		ctx.db.locationShare.insert({
			id: 0n,
			familyId,
			sharer: ctx.sender,
			viewer,
			sharedAt: ctx.timestamp,
		});
	},
);

/** Stops one member seeing the sender's location. After the last revoke the stored location is deleted. */
export const revokeLocationShare = spacetimedb.reducer(
	{ familyId: t.u64(), viewer: t.identity() },
	(ctx, { familyId, viewer }) => {
		requireMember(ctx, familyId);
		const shares = sharesOf(ctx, familyId);
		for (const share of shares)
			if (share.viewer.isEqual(viewer))
				ctx.db.locationShare.id.delete(share.id);
		if (shares.some((s) => !s.viewer.isEqual(viewer))) return;
		for (const row of ctx.db.location.byFamilySharer.filter([
			familyId,
			ctx.sender,
		]))
			ctx.db.location.id.delete(row.id);
	},
);

const requireValidFix = (ctx: Ctx, fix: Infer<typeof LocationFix>) => {
	if (!(Math.abs(fix.latitude) <= 90 && Math.abs(fix.longitude) <= 180))
		throw new SenderError("coordinates out of range");
	if (!(fix.accuracyMeters > 0 && Number.isFinite(fix.accuracyMeters)))
		throw new SenderError("accuracyMeters must be positive");
	if (
		fix.fixTime.microsSinceUnixEpoch >
		ctx.timestamp.microsSinceUnixEpoch + MAX_CLOCK_AHEAD_MICROS
	)
		throw new SenderError("fixTime is in the future");
};

/**
 * Stores the sender's latest location report. Refused while the sender shares with nobody, so
 * nothing is collected without a share. A report without a fix keeps the last fix.
 */
export const reportLocation = spacetimedb.reducer(
	{ familyId: t.u64(), status: LocationStatus, fix: t.option(LocationFix) },
	(ctx, { familyId, status, fix }) => {
		requireMember(ctx, familyId);
		if (sharesOf(ctx, familyId).length === 0)
			throw new SenderError("location is not shared with anyone");
		if ((status.tag === "Fix") !== (fix !== undefined))
			throw new SenderError("a fix is required exactly when status is Fix");
		if (fix !== undefined) requireValidFix(ctx, fix);
		const existing = ctx.db.location.byFamilySharer
			.filter([familyId, ctx.sender])
			.next().value;
		const row = {
			id: existing?.id ?? 0n,
			familyId,
			sharer: ctx.sender,
			status,
			fix: fix ?? existing?.fix,
			reportedAt: ctx.timestamp,
		};
		if (existing === undefined) ctx.db.location.insert(row);
		else ctx.db.location.id.update(row);
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

// The caller's own locations, and those of people who share theirs with the caller. A revoked
// share drops the row at once.
export const myLocations = spacetimedb.view(
	{ name: "my_locations", public: true },
	t.array(location.rowType),
	(ctx) => [
		...ctx.db.location.sharer.filter(ctx.sender),
		...[...ctx.db.locationShare.viewer.filter(ctx.sender)].flatMap((share) => [
			...ctx.db.location.byFamilySharer.filter([share.familyId, share.sharer]),
		]),
	],
);

// Shares the caller gave or received.
export const myLocationShares = spacetimedb.view(
	{ name: "my_location_shares", public: true },
	t.array(locationShare.rowType),
	(ctx) => [
		...ctx.db.locationShare.sharer.filter(ctx.sender),
		...ctx.db.locationShare.viewer.filter(ctx.sender),
	],
);
