// Family-scoped health data. Every table is private: clients read only through the per-sender views
// below, and every reducer checks the caller's family membership itself, independent of the server.
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
	{ name: "message" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		sender: t.identity(),
		body: t.string(),
		sentAt: t.timestamp(),
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

const spacetimedb = schema({
	family,
	familyMember,
	healthSample,
	alert,
	message,
	acknowledgement,
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
		ctx.db.healthSample.insert({
			...sample,
			id: 0n,
			receivedAt: ctx.timestamp,
			recordedBy: ctx.sender,
		});
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
		ctx.db.alert.insert({
			id: 0n,
			familyId,
			sampleId,
			summary,
			raisedBy: ctx.sender,
			createdAt: ctx.timestamp,
		});
	},
);

export const sendMessage = spacetimedb.reducer(
	{ familyId: t.u64(), body: t.string() },
	(ctx, { familyId, body }) => {
		requireMember(ctx, familyId);
		requireText("body", body);
		ctx.db.message.insert({
			id: 0n,
			familyId,
			sender: ctx.sender,
			body,
			sentAt: ctx.timestamp,
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
