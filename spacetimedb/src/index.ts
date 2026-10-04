// Family-scoped health data. Every table is private: clients read only through the per-sender views
// below, and every reducer checks the caller's family membership itself, independent of the server.
import { type Identity, Timestamp } from "spacetimedb";
import {
	type Infer,
	type InferSchema,
	type ReducerCtx,
	ScheduleAt,
	SenderError,
	schema,
	t,
	table,
	type ViewCtx,
} from "spacetimedb/server";
import { afterQuietHours, nextLocalTime } from "./local-time";

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

// An alert's family message uses this client id prefix plus the alert id. Members cannot use it.
const ALERT_CLIENT_ID = "alert-";

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

const TripStep = t.enum("TripStep", {
	// The wearer was asked "Are you heading out now?".
	Asked: t.unit(),
	// The wearer confirmed and stated a plan. A later `Leaving` in the same trip is a changed plan.
	Leaving: t.unit(),
	Cancelled: t.unit(),
	Arrived: t.unit(),
});

// A leaving-home check-in, one row per step. Rows are never changed, so an earlier plan stays in
// the history and a later one never gets overwritten. No location is stored.
const tripEvent = table(
	{ name: "trip_event" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		// Chosen by the server for the `Asked` row, so it knows which trip it started.
		tripId: t.string().index("btree"),
		step: TripStep,
		// What started or changed the trip: `manual` or `departure_signal`.
		source: t.string(),
		purpose: t.option(t.string()),
		destination: t.option(t.string()),
		// The wearer's choice of family notices, set on `Leaving`.
		notifyDeparture: t.bool(),
		notifyArrival: t.bool(),
		by: t.identity(),
		at: t.timestamp(),
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

const HomePoint = t.object("HomePoint", {
	latitude: t.f64(),
	longitude: t.f64(),
});

// One person's home for automatic trips (#302), in one family. Only that person reads it. Their
// location reports start a trip after `AWAY_DWELL_MICROS` clearly outside `radiusMeters`, and end
// it at the first report inside.
const homeWatch = table(
	{
		name: "home_watch",
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
		home: t.option(HomePoint),
		radiusMeters: t.u32(),
		autoTrip: t.bool(),
		// The first report clearly outside the radius since the last one inside.
		outsideSince: t.option(t.timestamp()),
		// When the current trip started; unset at home.
		awaySince: t.option(t.timestamp()),
		// How far the latest reported fix was from home, for the person's own status.
		distanceMeters: t.option(t.f64()),
		updatedAt: t.timestamp(),
	},
);

const AwayKind = t.enum("AwayKind", { Left: t.unit(), Back: t.unit() });

// A trip start or end. The people the sharer shares location with see it (`my_away_events`).
// Rows are never changed; the last revoked share deletes them with the location.
// ponytail: two rows per trip are kept until then; prune by age if the list grows large.
const awayEvent = table(
	{
		name: "away_event",
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
		kind: AwayKind,
		// The person pressed "I'm going out" or "I'm home"; otherwise the location decided.
		manual: t.bool(),
		fix: t.option(LocationFix),
		at: t.timestamp(),
	},
);

// One fact about one meal (#33), as its own row: a photo was taken, a food estimate, an intake
// report, or caregiver help. The photo itself is never stored. The server validates `fact` against
// `MealFact` in `@health/contracts/meal-facts` and records a photo or an estimate only as itself.
// Meal facts are health records (#26 `health_records`); photo facts also need `media`.
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

// A family's permission to remember where medicine containers were last seen (issue #29). Without
// this row no sighting is stored, and removing it deletes the family's sightings.
const medicineMemory = table(
	{ name: "medicine_memory" },
	{
		familyId: t.u64().primaryKey(),
		// Agreed familiar places to search when a container is not where it was last seen.
		places: t.array(t.string()),
		setBy: t.identity(),
		setAt: t.timestamp(),
	},
);

// Where a medicine container was last seen: one row per family and container description. Only a
// newer camera observation that the person confirmed changes it; `notFoundAt` marks it outdated.
const medicineSighting = table(
	{ name: "medicine_sighting" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		container: t.string(),
		place: t.string(),
		// When the camera captured the frame the container was found in.
		seenAt: t.timestamp(),
		source: t.string(),
		confidence: t.f64(),
		labelRead: t.bool(),
		savedBy: t.identity(),
		notFoundAt: t.option(t.timestamp()),
	},
);

// The family contact ladder (issue #30). A care need goes to one contact at a time, in order, then
// the backup. Only a contact's acceptance and then confirmed help close it; a sent message never does.
const NeedKind = t.enum("NeedKind", {
	Alert: t.unit(),
	Help: t.unit(),
	CallReminder: t.unit(),
});

// What one contact's notice may carry: only that the need exists, its summary, or its facts too.
const ContactDetail = t.enum("ContactDetail", {
	Minimal: t.unit(),
	Summary: t.unit(),
	Facts: t.unit(),
});

const ContactStep = t.object("ContactStep", {
	member: t.identity(),
	name: t.string(),
	// IANA time zone, such as "America/Chicago". The server shows each attempt in the contact's time.
	timeZone: t.string(),
	detail: ContactDetail,
	// Need kinds that this contact gets a (simulated) call for; every other kind is a message.
	callFor: t.array(NeedKind),
});

const contactLadder = table(
	{ name: "contact_ladder" },
	{
		familyId: t.u64().primaryKey(),
		contacts: t.array(ContactStep),
		backup: t.option(ContactStep),
		// How long a contact has to accept before the next one is contacted.
		answerSeconds: t.u32(),
		// How long an accepted need may wait for confirmed help before the ladder continues.
		followUpSeconds: t.u32(),
		updatedBy: t.identity(),
		updatedAt: t.timestamp(),
	},
);

// A fact copied from the family's records, never typed in by a person.
const NeedFact = t.object("NeedFact", {
	text: t.string(),
	source: t.string(),
	observedAt: t.timestamp(),
	uncertainty: t.string(),
});

const NeedStatus = t.enum("NeedStatus", {
	Open: t.unit(),
	Accepted: t.unit(),
	// Help confirmed by the member who accepted. The only closed state.
	Resolved: t.unit(),
	// Every contact declined or did not respond. It stays visible.
	Unresolved: t.unit(),
});

const careNeed = table(
	{
		name: "care_need",
		indexes: [
			{
				accessor: "byRaiserClientId",
				algorithm: "btree",
				columns: ["familyId", "raisedBy", "clientId"],
			},
		],
	},
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		kind: NeedKind,
		summary: t.string(),
		facts: t.array(NeedFact),
		alertId: t.option(t.u64()),
		// The first contact is not notified before this time (a reminder's due time).
		dueAt: t.timestamp(),
		// The ladder as it stood when the need opened, backup last; later edits do not change it.
		steps: t.array(ContactStep),
		// The last step is the ladder's backup contact.
		hasBackup: t.bool(),
		answerSeconds: t.u32(),
		followUpSeconds: t.u32(),
		status: NeedStatus,
		// Index into `steps` of the current (or last) contact.
		step: t.u32(),
		acceptedBy: t.option(t.identity()),
		followUpBy: t.option(t.timestamp()),
		raisedBy: t.identity(),
		clientId: t.string(),
		createdAt: t.timestamp(),
		updatedAt: t.timestamp(),
	},
);

const AttemptChannel = t.enum("AttemptChannel", {
	Call: t.unit(),
	Message: t.unit(),
});

const AttemptStatus = t.enum("AttemptStatus", {
	// Waiting for the need's due time.
	Queued: t.unit(),
	// Message posted, or simulated call ringing.
	Sent: t.unit(),
	// The contact's app showed the message.
	Delivered: t.unit(),
	// The contact answered the call; that alone accepts nothing.
	Answered: t.unit(),
	Accepted: t.unit(),
	Declined: t.unit(),
	NoAnswer: t.unit(),
	// Accepted, but help was not confirmed before the follow-up time.
	FollowUpExpired: t.unit(),
});

// At most one attempt per need and step, so a retried step never calls anyone twice.
const contactAttempt = table(
	{ name: "contact_attempt" },
	{
		key: t.string().primaryKey(),
		needId: t.u64().index("btree"),
		familyId: t.u64().index("btree"),
		step: t.u32(),
		member: t.identity(),
		channel: AttemptChannel,
		status: AttemptStatus,
		// The notice at the contact's allowed detail.
		body: t.string(),
		createdAt: t.timestamp(),
		updatedAt: t.timestamp(),
	},
);

const LadderTimerPurpose = t.enum("LadderTimerPurpose", {
	Send: t.unit(),
	AnswerDue: t.unit(),
	FollowUpDue: t.unit(),
});

// Ladder deadlines, run by the database itself, so they survive a server restart.
const ladderTimer = table(
	{ name: "ladder_timer" },
	{
		scheduledId: t.u64().primaryKey().autoInc(),
		scheduledAt: t.scheduleAt(),
		needId: t.u64(),
		step: t.u32(),
		purpose: LadderTimerPurpose,
	},
);

// The reminder lifecycle (issue #28). Kinds, states, responses, and sources are the strings of
// `@health/contracts/reminders`; local times are minutes after local midnight.

// The wearer's prompt rules: the settings row's columns and the reducer's arguments.
const promptRules = () => ({
	timeZone: t.string(),
	quietStart: t.option(t.u16()),
	quietEnd: t.option(t.u16()),
	repeatEveryMinutes: t.u32(),
	maxPrompts: t.u32(),
	snoozeMinutes: t.u32(),
});

// One row per family.
const reminderSettings = table(
	{ name: "reminder_settings" },
	{
		familyId: t.u64().primaryKey(),
		...promptRules(),
		updatedBy: t.identity(),
		updatedAt: t.timestamp(),
	},
);

const reminder = table(
	{ name: "reminder" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		kind: t.string(),
		subjectId: t.option(t.string()),
		title: t.string(),
		times: t.array(t.u16()),
		// Chosen by the server, so it finds the reminder it created.
		clientId: t.string().unique(),
		createdBy: t.identity(),
		createdAt: t.timestamp(),
	},
);

// One scheduled time of one reminder. `slot` (reminder and time) makes scheduling it idempotent.
// Prompts have ended when `nextPromptAt` is none.
const reminderOccurrence = table(
	{ name: "reminder_occurrence" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		reminderId: t.u64().index("btree"),
		slot: t.string().unique(),
		kind: t.string(),
		subjectId: t.option(t.string()),
		title: t.string(),
		minuteOfDay: t.u16(),
		scheduledFor: t.timestamp(),
		state: t.string(),
		promptDue: t.bool(),
		prompts: t.u32(),
		nextPromptAt: t.option(t.timestamp()),
	},
);

// Append-only. A missing actor is the database scheduler.
const reminderEvent = table(
	{ name: "reminder_event" },
	{
		id: t.u64().primaryKey().autoInc(),
		occurrenceId: t.u64().index("btree"),
		familyId: t.u64().index("btree"),
		state: t.string(),
		response: t.option(t.string()),
		at: t.timestamp(),
		actor: t.option(t.identity()),
		source: t.string(),
		wording: t.option(t.string()),
	},
);

// Each handled client request, keyed by occurrence, sender, and client id, so a retry records nothing new.
const reminderRequest = table(
	{ name: "reminder_request" },
	{ key: t.string().primaryKey(), fingerprint: t.string() },
);

// Prompt deadlines, run by the database itself. A timer whose `dueAt` no longer matches the
// occurrence's `nextPromptAt` was replaced and does nothing.
const reminderTimer = table(
	{ name: "reminder_timer" },
	{
		scheduledId: t.u64().primaryKey().autoInc(),
		scheduledAt: t.scheduleAt(),
		occurrenceId: t.u64(),
		dueAt: t.timestamp(),
	},
);

// Home-speaker handoff settings (issue #46), one row per family. No row means off.
const speakerSettings = table(
	{ name: "speaker_settings" },
	{
		familyId: t.u64().primaryKey(),
		enabled: t.bool(),
		room: t.string(),
		sharedRoomKinds: t.array(t.string()),
		updatedBy: t.identity(),
		updatedAt: t.timestamp(),
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

// An activity the family agreed with the wearer, from a named source such as a physiotherapist's
// handout (#41). The app never writes exercise steps and never picks one from a health reading.
// Only a verified plan is offered to the wearer; a plan never changes after it is created.
const exercisePlan = table(
	{ name: "exercise_plan" },
	{
		// Chosen by the server, so it knows which plan it created.
		id: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		// JSON that the server validates against the `@health/contracts/exercise` schemas.
		plan: t.string(),
		createdBy: t.identity(),
		createdAt: t.timestamp(),
		verifiedBy: t.option(t.identity()),
		verifiedAt: t.option(t.timestamp()),
	},
);

// One wearer answer or control in one exercise session. Ids are chosen by the client, so an event
// sent again after a lost reply is stored once.
const exerciseEvent = table(
	{ name: "exercise_event" },
	{
		id: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		planId: t.string(),
		sessionId: t.string().index("btree"),
		kind: t.string(),
		// Why a `stopped` session stopped; empty for every other kind.
		reason: t.option(t.string()),
		actor: t.identity(),
		at: t.timestamp(),
	},
);

// A food-delivery proposal's status (#43). The provider is simulated; no row means a real order.
const OrderStatus = t.enum("OrderStatus", {
	Proposed: t.unit(),
	Approved: t.unit(),
	Replaced: t.unit(),
	Placed: t.unit(),
	Uncertain: t.unit(),
	Failed: t.unit(),
	Delivered: t.unit(),
	Eaten: t.unit(),
});

// Append-only: each row is one status change of one proposal. The first row (`Proposed`) holds the
// proposal as JSON that the server validates against `@health/contracts/delivery`.
const deliveryEvent = table(
	{ name: "delivery_event" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64().index("btree"),
		// Chosen by the server; also the provider's idempotency key for the order.
		proposalId: t.string().index("btree"),
		status: OrderStatus,
		proposal: t.option(t.string()),
		note: t.string(),
		actor: t.identity(),
		at: t.timestamp(),
	},
);

// A proposed visit (#44). `visit` is fixed when it is suggested. A request and a provider
// confirmation each keep who recorded them and when, so a suggestion or a request is never a
// booking. Nothing here contacts a provider: every step is a member's record.
const appointment = table(
	{ name: "appointment" },
	{
		// Chosen by the server, so it knows which appointment it created.
		id: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		// JSON that the server validates against the `@health/contracts` appointment schemas.
		visit: t.string(),
		prep: t.string(),
		// "model" or "member": who proposed the visit.
		source: t.string(),
		suggestedBy: t.identity(),
		suggestedAt: t.timestamp(),
		requestedBy: t.option(t.identity()),
		requestedAt: t.option(t.timestamp()),
		// The provider's confirmation as a member received it (JSON).
		confirmation: t.option(t.string()),
		confirmedBy: t.option(t.identity()),
		confirmedAt: t.option(t.timestamp()),
		cancelledBy: t.option(t.identity()),
		cancelledAt: t.option(t.timestamp()),
		// The summary a member reviewed (JSON); replaced by each new review.
		summary: t.option(t.string()),
		summaryReviewedBy: t.option(t.identity()),
		summaryReviewedAt: t.option(t.timestamp()),
	},
);

// A member's consent to send an appointment's reviewed summary to one clinician. `explicit` covers
// one send of the summary as reviewed at approval; `standing` covers repeated sends at the agreed
// frequency. Sends are simulated: no clinician delivery path is approved.
const clinicianShare = table(
	{ name: "clinician_share" },
	{
		id: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		appointmentId: t.string(),
		// JSON: the recipient and the chosen summary sections.
		recipient: t.string(),
		sections: t.string(),
		// "explicit" (frequency "once") or "standing" (frequency "weekly" or "monthly").
		consent: t.string(),
		frequency: t.string(),
		approvedBy: t.identity(),
		approvedAt: t.timestamp(),
		// For explicit consent: the summary review it covers.
		approvedSummaryAt: t.option(t.timestamp()),
		revokedBy: t.option(t.identity()),
		revokedAt: t.option(t.timestamp()),
		sends: t.u32(),
		lastSentAt: t.option(t.timestamp()),
	},
);

// The wearer's agreed kitchen abilities and food dislikes (#42): one current row per family, with
// who saved it last. JSON that the server validates against `CookingProfile` in
// `@health/contracts/cooking`.
const cookingProfile = table(
	{ name: "cooking_profile" },
	{
		familyId: t.u64().primaryKey(),
		profile: t.string(),
		editedBy: t.identity(),
		editedAt: t.timestamp(),
	},
);

// Report email (#8), one row per family. Only a `family_access` holder changes it. No row means off.
const reportEmailSettings = table(
	{ name: "report_email_settings" },
	{
		familyId: t.u64().primaryKey(),
		// Email each report automatically when a member marks it as reviewed.
		enabled: t.bool(),
		// Empty when no address is set.
		recipient: t.string(),
		updatedBy: t.identity(),
		updatedAt: t.timestamp(),
	},
);

// The latest email of one report. The server picks `sendId` per attempt; only that attempt settles it.
const reportEmail = table(
	{ name: "report_email" },
	{
		reportId: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		sendId: t.string(),
		recipient: t.string(),
		// "queued", "sent", or "failed".
		status: t.string(),
		reason: t.option(t.string()),
		automatic: t.bool(),
		requestedBy: t.identity(),
		updatedAt: t.timestamp(),
	},
);

// One-time join codes (onboarding). Only the code's SHA-256 is stored; the code itself is shown
// once to the member who made it. One person may join with it, before `expiresAt`.
const familyInvite = table(
	{ name: "family_invite" },
	{
		codeHash: t.string().primaryKey(),
		familyId: t.u64().index("btree"),
		createdBy: t.identity(),
		createdAt: t.timestamp(),
		expiresAt: t.timestamp(),
		usedBy: t.option(t.identity()),
		usedAt: t.option(t.timestamp()),
	},
);

// The family's WHOOP push token (SHA-256 only). NOOP pushes with the token, and the server's NOOP
// ingest identity records the samples into this family. One per family; a new token replaces it.
const familyPushToken = table(
	{ name: "family_push_token" },
	{
		familyId: t.u64().primaryKey(),
		tokenHash: t.string().unique(),
		ingest: t.identity().index("btree"),
		createdBy: t.identity(),
		createdAt: t.timestamp(),
	},
);

// Who deleted which family, and when (`deleteFamily`). It keeps no name and no health data.
const familyDeletion = table(
	{ name: "family_deletion" },
	{
		id: t.u64().primaryKey().autoInc(),
		familyId: t.u64(),
		deletedBy: t.identity(),
		deletedAt: t.timestamp(),
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
	homeWatch,
	awayEvent,
	medicineMemory,
	medicineSighting,
	contactLadder,
	careNeed,
	contactAttempt,
	ladderTimer,
	reminderSettings,
	reminder,
	reminderOccurrence,
	reminderEvent,
	reminderRequest,
	reminderTimer,
	speakerSettings,
	mealFact,
	careProfileVersion,
	careInstruction,
	careGrantEvent,
	tripEvent,
	exercisePlan,
	exerciseEvent,
	deliveryEvent,
	appointment,
	clinicianShare,
	cookingProfile,
	reportEmailSettings,
	reportEmail,
	familyInvite,
	familyPushToken,
	familyDeletion,
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

type Need = Infer<typeof careNeed.rowType>;
type Contact = Infer<typeof ContactStep>;
type NewNeed = Pick<
	Need,
	"familyId" | "kind" | "summary" | "facts" | "alertId" | "dueAt" | "clientId"
>;

const kindLabel = {
	Alert: "a health alert",
	Help: "a request for help",
	CallReminder: "a call reminder",
} as const;

const sampleFact = (
	sample: Infer<typeof healthSample.rowType>,
): Infer<typeof NeedFact> => ({
	text: `${sample.metric} ${sample.value} ${sample.unit}`,
	source: sample.source,
	observedAt: sample.sourceTime,
	uncertainty: `${sample.synthetic ? "synthetic demo data, " : ""}${sample.quality.tag === "Validated" ? "validated" : "unvalidated"} signal`,
});

// The notice for one contact, with only the detail that contact may receive.
const notice = (need: Need, contact: Contact) => {
	const lines = [
		`Telly asks ${contact.name} to take on ${kindLabel[need.kind.tag]}. Open Care in Telly to accept or decline.`,
	];
	if (contact.detail.tag !== "Minimal") lines.push(need.summary);
	if (contact.detail.tag === "Facts")
		for (const fact of need.facts)
			lines.push(
				`${fact.text} (${fact.source}, ${fact.observedAt.toISOString()}, ${fact.uncertainty})`,
			);
	return lines.join("\n");
};

// Ladder progress in the family chat (the #11 messages), from the database identity. It names
// people and the kind of need only; the facts stay in each contact's own notice.
const postCareMessage = (
	ctx: Ctx,
	familyId: bigint,
	clientId: string,
	body: string,
) => {
	const sender = ctx.databaseIdentity;
	const sent = ctx.db.message.bySenderClientId.filter([
		familyId,
		sender,
		clientId,
	]);
	if (!sent.next().done) return;
	ctx.db.message.insert({
		id: 0n,
		familyId,
		sender,
		body,
		sentAt: ctx.timestamp,
		clientId,
	});
};

const attemptKey = (needId: bigint, step: number) => `${needId}/${step}`;

const scheduleLadder = (
	ctx: Ctx,
	needId: bigint,
	step: number,
	purpose: Infer<typeof LadderTimerPurpose>["tag"],
	at: Timestamp,
) =>
	ctx.db.ladderTimer.insert({
		scheduledId: 0n,
		scheduledAt: ScheduleAt.time(at.microsSinceUnixEpoch),
		needId,
		step,
		purpose: { tag: purpose },
	});

const setAttemptStatus = (
	ctx: Ctx,
	attempt: Infer<typeof contactAttempt.rowType>,
	status: Infer<typeof AttemptStatus>["tag"],
) =>
	ctx.db.contactAttempt.key.update({
		...attempt,
		status: { tag: status },
		updatedAt: ctx.timestamp,
	});

// Posts the message or rings the simulated call, then gives the contact `answerSeconds` to accept.
const sendAttempt = (ctx: Ctx, need: Need, step: number) => {
	const attempt = ctx.db.contactAttempt.key.find(attemptKey(need.id, step));
	const contact = need.steps[step];
	if (attempt?.status.tag !== "Queued" || contact === undefined) return;
	setAttemptStatus(ctx, attempt, "Sent");
	const how =
		attempt.channel.tag === "Call" ? "Calling (simulated)" : "Message for";
	postCareMessage(
		ctx,
		need.familyId,
		`care-${attempt.key}`,
		`${how} ${contact.name}: Telly needs someone to take on ${kindLabel[need.kind.tag]}. Open Care in Telly to respond.`,
	);
	scheduleLadder(
		ctx,
		need.id,
		step,
		"AnswerDue",
		secondsFromNow(ctx, need.answerSeconds),
	);
};

// Moves the need to `step`: one attempt per step, so a repeated step contacts nobody twice. Past
// the last contact, the need is unresolved and stays visible.
const contactStep = (ctx: Ctx, need: Need, step: number) => {
	const contact = need.steps[step];
	const status = contact === undefined ? "Unresolved" : "Open";
	ctx.db.careNeed.id.update({
		...need,
		status: { tag: status },
		step,
		acceptedBy: undefined,
		followUpBy: undefined,
		updatedAt: ctx.timestamp,
	});
	if (contact === undefined) {
		postCareMessage(
			ctx,
			need.familyId,
			`care-${need.id}-unresolved-${step}`,
			`Nobody has taken on ${kindLabel[need.kind.tag]} yet. It stays open in Care.`,
		);
		return;
	}
	const key = attemptKey(need.id, step);
	if (ctx.db.contactAttempt.key.find(key) !== null) return;
	const call = contact.callFor.some((kind) => kind.tag === need.kind.tag);
	ctx.db.contactAttempt.insert({
		key,
		needId: need.id,
		familyId: need.familyId,
		step,
		member: contact.member,
		channel: { tag: call ? "Call" : "Message" },
		status: { tag: "Queued" },
		body: notice(need, contact),
		createdAt: ctx.timestamp,
		updatedAt: ctx.timestamp,
	});
	if (need.dueAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch)
		scheduleLadder(ctx, need.id, step, "Send", need.dueAt);
	else sendAttempt(ctx, need, step);
};

const openNeed = (ctx: Ctx, fields: NewNeed) => {
	const ladder = ctx.db.contactLadder.familyId.find(fields.familyId);
	const steps =
		ladder === null
			? []
			: ladder.backup === undefined
				? ladder.contacts
				: [...ladder.contacts, ladder.backup];
	const need = ctx.db.careNeed.insert({
		...fields,
		id: 0n,
		steps,
		hasBackup: ladder?.backup !== undefined,
		answerSeconds: ladder?.answerSeconds ?? 0,
		followUpSeconds: ladder?.followUpSeconds ?? 0,
		status: { tag: "Open" },
		step: 0,
		acceptedBy: undefined,
		followUpBy: undefined,
		raisedBy: ctx.sender,
		createdAt: ctx.timestamp,
		updatedAt: ctx.timestamp,
	});
	contactStep(ctx, need, 0);
};

// A family with a contact ladder gets a care need for each alert. While an alert need is still
// open or accepted, a new alert adds its facts there instead of contacting everyone again.
const alertNeed = (
	ctx: Ctx,
	familyId: bigint,
	alertId: bigint,
	sampleId: bigint | undefined,
	summary: string,
) => {
	if (ctx.db.contactLadder.familyId.find(familyId) === null) return;
	const sample =
		sampleId === undefined ? null : ctx.db.healthSample.id.find(sampleId);
	const facts = sample === null ? [] : [sampleFact(sample)];
	for (const need of ctx.db.careNeed.familyId.filter(familyId)) {
		if (
			need.kind.tag !== "Alert" ||
			(need.status.tag !== "Open" && need.status.tag !== "Accepted")
		)
			continue;
		ctx.db.careNeed.id.update({
			...need,
			facts: [...need.facts, ...facts],
			updatedAt: ctx.timestamp,
		});
		return;
	}
	openNeed(ctx, {
		familyId,
		kind: { tag: "Alert" },
		summary,
		facts,
		alertId,
		dueAt: ctx.timestamp,
		clientId: `alert-${alertId}`,
	});
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
	alertNeed(ctx, familyId, id, sampleId, summary);
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

/** The family's first member. */
const founderOf = (ctx: Ctx, familyId: bigint) => {
	let founder: { id: bigint; member: Identity } | undefined;
	for (const m of ctx.db.familyMember.familyId.filter(familyId))
		if (founder === undefined || m.id < founder.id) founder = m;
	return founder?.member;
};

// The founder holds every care scope, so a new family works without a sharing step (#188). A scope
// the member already has an event for (granted or revoked) keeps its latest choice.
const grantEveryCareScope = (ctx: Ctx, familyId: bigint, member: Identity) => {
	const decided = new Set<string>();
	for (const event of ctx.db.careGrantEvent.byFamilyMember.filter([
		familyId,
		member,
	]))
		decided.add(event.scope);
	for (const scope of Object.keys(careScopes))
		if (!decided.has(scope))
			ctx.db.careGrantEvent.insert({
				id: 0n,
				familyId,
				member,
				scope,
				granted: true,
				changedBy: ctx.sender,
				changedAt: ctx.timestamp,
			});
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
		grantEveryCareScope(ctx, id, ctx.sender);
	},
);

// One-time repair for families created before #188: each founder gets every scope they have no
// event for, as `createFamily` now does. A scope the founder granted or revoked stays as it is. The
// founder could already grant these through `maySetUpSharing`. Only the operator calls it; a second
// call changes nothing. Deletes nothing.
export const backfillFounderCareGrants = spacetimedb.reducer((ctx) => {
	if (ctx.db.operator.identity.find(ctx.sender) === null)
		throw new SenderError("not the delivery operator");
	for (const family of ctx.db.family.iter()) {
		const founder = founderOf(ctx, family.id);
		if (founder !== undefined) grantEveryCareScope(ctx, family.id, founder);
	}
});

/** Adds `member` with no care grants, unless they already belong to the family. */
const addMemberIfAbsent = (ctx: Ctx, familyId: bigint, member: Identity) => {
	const rows = ctx.db.familyMember.byFamilyMember.filter([familyId, member]);
	if (!rows.next().done) return;
	ctx.db.familyMember.insert({
		id: 0n,
		familyId,
		member,
		addedAt: ctx.timestamp,
	});
};

export const addFamilyMember = spacetimedb.reducer(
	{ familyId: t.u64(), member: t.identity() },
	(ctx, { familyId, member }) => {
		requireMember(ctx, familyId);
		addMemberIfAbsent(ctx, familyId, member);
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
		// Validated samples raise alerts, and so do real WHOOP readings through NOOP (`noop:` sources):
		// a captain decision for the demo. They stay labelled unvalidated everywhere they are shown.
		if (
			stored.quality.tag === "Validated" ||
			(!stored.synthetic && stored.source.startsWith("noop:"))
		)
			raiseThresholdAlerts(ctx, stored);
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
		if (clientId.startsWith(ALERT_CLIENT_ID))
			throw new SenderError(`clientId must not start with ${ALERT_CLIENT_ID}`);
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

/**
 * The in-app family delivery: the operator posts the alert to its family's message thread. The
 * client id is the delivery's idempotency key, so a resend after a lost report posts nothing new.
 */
export const postAlertMessage = spacetimedb.reducer(
	{ alertId: t.u64() },
	(ctx, { alertId }) => {
		const { familyId, summary } = openDelivery(ctx, alertId);
		const clientId = `${ALERT_CLIENT_ID}${alertId}`;
		const posted = ctx.db.message.bySenderClientId.filter([
			familyId,
			ctx.sender,
			clientId,
		]);
		if (!posted.next().done) return;
		ctx.db.message.insert({
			id: 0n,
			familyId,
			sender: ctx.sender,
			body: summary,
			sentAt: ctx.timestamp,
			clientId,
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

// Debounce: an unanswered question stays open for 30 minutes and a confirmed trip for 12 hours. A
// departure signal within 30 minutes of the family's last trip step asks nothing.
const ASK_OPEN_MICROS = 30n * 60_000_000n;
const TRIP_OPEN_MICROS = 12n * 3_600_000_000n;
const SIGNAL_QUIET_MICROS = 30n * 60_000_000n;

const tripNotice = (
	ctx: Ctx,
	familyId: bigint,
	clientId: string,
	body: string,
) =>
	ctx.db.message.insert({
		id: 0n,
		familyId,
		sender: ctx.sender,
		body,
		sentAt: ctx.timestamp,
		clientId,
	});

type TripRow = Infer<typeof tripEvent.rowType>;

// ponytail: scans the family's trip history per step; index by time if it grows large.
const tripHistory = (ctx: Ctx, familyId: bigint): TripRow[] =>
	[...ctx.db.tripEvent.familyId.filter(familyId)].sort((a, b) =>
		a.id < b.id ? -1 : 1,
	);

const TripPlan = t.object("TripPlan", {
	purpose: t.string(),
	destination: t.option(t.string()),
	notifyDeparture: t.bool(),
	notifyArrival: t.bool(),
});
type TripPlan = Infer<typeof TripPlan>;

/** Whether a new question may start: no trip is open and a departure signal is not repeating. */
const mayAsk = (ctx: Ctx, latest: TripRow | undefined, source: string) => {
	if (latest === undefined) return true;
	const age =
		ctx.timestamp.microsSinceUnixEpoch - latest.at.microsSinceUnixEpoch;
	if (latest.step.tag === "Asked" && age < ASK_OPEN_MICROS) return false;
	if (latest.step.tag === "Leaving" && age < TRIP_OPEN_MICROS) return false;
	return !(source === "departure_signal" && age < SIGNAL_QUIET_MICROS);
};

/** A stated plan. The first one sends the departure notice when the wearer chose it. */
const leave = (
	ctx: Ctx,
	trip: TripRow[],
	plan: TripPlan | undefined,
	record: () => void,
) => {
	if (plan === undefined) throw new SenderError("purpose is required");
	requireText("purpose", plan.purpose);
	const last = trip[trip.length - 1];
	if (
		last?.step.tag === "Leaving" &&
		last.purpose === plan.purpose &&
		last.destination === plan.destination &&
		last.notifyDeparture === plan.notifyDeparture &&
		last.notifyArrival === plan.notifyArrival
	)
		return; // a resend
	const first = !trip.some((e) => e.step.tag === "Leaving");
	record();
	if (first && plan.notifyDeparture && last !== undefined)
		tripNotice(
			ctx,
			last.familyId,
			`trip-${last.tripId}-left`,
			`I'm leaving home: ${plan.purpose}${plan.destination === undefined ? "" : ` (${plan.destination})`}.`,
		);
};

/** `Cancelled` or `Arrived`. Arrival sends the arrival notice when the wearer chose it. */
const endTrip = (
	ctx: Ctx,
	last: TripRow,
	arrived: boolean,
	record: () => void,
) => {
	if (arrived && last.step.tag !== "Leaving")
		throw new SenderError("the trip has not started");
	record();
	if (arrived && last.notifyArrival)
		tripNotice(
			ctx,
			last.familyId,
			`trip-${last.tripId}-arrived`,
			`I arrived: ${last.destination ?? last.purpose ?? "my trip"}.`,
		);
};

/**
 * One step of a leaving-home check-in. `Asked` starts a trip unless one is open or a departure
 * signal repeats within the quiet time; then it records nothing. `Leaving` needs the plan. The
 * chosen family notices are family messages, written in the same transaction as the step.
 */
export const recordTripEvent = spacetimedb.reducer(
	{
		familyId: t.u64(),
		tripId: t.string(),
		step: TripStep,
		source: t.string(),
		plan: t.option(TripPlan),
	},
	(ctx, { familyId, tripId, step, source, plan }) => {
		requireMember(ctx, familyId);
		requireText("tripId", tripId);
		if (source !== "manual" && source !== "departure_signal")
			throw new SenderError("source must be manual or departure_signal");
		const history = tripHistory(ctx, familyId);
		const trip = history.filter((e) => e.tripId === tripId);
		const last = trip[trip.length - 1];
		const record = () => {
			ctx.db.tripEvent.insert({
				id: 0n,
				familyId,
				tripId,
				step,
				source,
				purpose: plan?.purpose,
				destination: plan?.destination,
				notifyDeparture: plan?.notifyDeparture === true,
				notifyArrival: plan?.notifyArrival === true,
				by: ctx.sender,
				at: ctx.timestamp,
			});
		};
		if (step.tag === "Asked") {
			// A resend of the question finds its trip and records nothing.
			if (
				last === undefined &&
				mayAsk(ctx, history[history.length - 1], source)
			)
				record();
			return;
		}
		if (last === undefined) throw new SenderError("no such trip");
		if (step.tag !== "Leaving" && last.step.tag === step.tag) return; // a resend
		if (last.step.tag === "Cancelled" || last.step.tag === "Arrived")
			throw new SenderError("the trip has ended");
		if (step.tag === "Leaving") return leave(ctx, trip, plan, record);
		endTrip(ctx, last, step.tag === "Arrived", record);
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

// Whether a fact comes from a photo: the photo was taken, or an estimate was made from it.
const fromPhoto = (fact: string) => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fact);
	} catch {
		throw new SenderError("fact must be JSON");
	}
	if (typeof parsed !== "object" || parsed === null || !("type" in parsed))
		throw new SenderError("fact must have a type");
	if (parsed.type === "photo_taken") return true;
	return (
		parsed.type === "food_estimate" &&
		"estimate" in parsed &&
		typeof parsed.estimate === "object" &&
		parsed.estimate !== null &&
		"source" in parsed.estimate &&
		parsed.estimate.source === "photo"
	);
};

export const recordMealFact = spacetimedb.reducer(
	{ familyId: t.u64(), mealId: t.string(), fact: t.string() },
	(ctx, recorded) => {
		requireCareScope(ctx, recorded.familyId, "health_records");
		requireText("mealId", recorded.mealId);
		if (fromPhoto(recorded.fact))
			requireCareScope(ctx, recorded.familyId, "media");
		ctx.db.mealFact.insert({
			...recorded,
			id: 0n,
			recordedBy: ctx.sender,
			recordedAt: ctx.timestamp,
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
		for (const row of ctx.db.awayEvent.byFamilySharer.filter([
			familyId,
			ctx.sender,
		]))
			ctx.db.awayEvent.id.delete(row.id);
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
		if (fix !== undefined) followHome(ctx, familyId, fix);
	},
);

/** A trip starts after this long clearly outside the home radius, so a short walk past it is none. */
const AWAY_DWELL_MICROS = 60_000_000n;
// The `HOME_RADIUS` bounds of `@health/contracts/location`.
const MIN_HOME_RADIUS = 100;
const MAX_HOME_RADIUS = 5000;
const EARTH_RADIUS_METERS = 6_371_000;

type Point = { latitude: number; longitude: number };

/** Great-circle (haversine) distance in meters. */
const distanceMeters = (a: Point, b: Point) => {
	const rad = Math.PI / 180;
	const h =
		Math.sin(((b.latitude - a.latitude) * rad) / 2) ** 2 +
		Math.cos(a.latitude * rad) *
			Math.cos(b.latitude * rad) *
			Math.sin(((b.longitude - a.longitude) * rad) / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
};

const homeWatchOf = (ctx: Ctx, familyId: bigint) =>
	ctx.db.homeWatch.byFamilySharer.filter([familyId, ctx.sender]).next().value;

const recordAway = (
	ctx: Ctx,
	familyId: bigint,
	kind: "Left" | "Back",
	manual: boolean,
	fix: Infer<typeof LocationFix> | undefined,
) =>
	ctx.db.awayEvent.insert({
		id: 0n,
		familyId,
		sharer: ctx.sender,
		kind: { tag: kind },
		manual,
		fix,
		at: ctx.timestamp,
	});

type HomeWatchRow = Infer<typeof homeWatch.rowType>;
type HomeStep = {
	readonly change: Partial<HomeWatchRow>;
	readonly event?: "Left" | "Back";
};

/** A fix inside forgets a pending departure, and ends a trip that has been outside. */
const insideStep = ({ outsideSince, awaySince }: HomeWatchRow): HomeStep =>
	outsideSince === undefined
		? { change: {} }
		: {
				change: { outsideSince: undefined, awaySince: undefined },
				...(awaySince === undefined ? {} : { event: "Back" }),
			};

/** A fix clearly outside starts the dwell; one after the dwell starts the trip. */
const outsideStep = (
	{ outsideSince, awaySince }: HomeWatchRow,
	now: Ctx["timestamp"],
): HomeStep => {
	if (outsideSince === undefined) return { change: { outsideSince: now } };
	const dwelt =
		now.microsSinceUnixEpoch - outsideSince.microsSinceUnixEpoch >=
		AWAY_DWELL_MICROS;
	return awaySince === undefined && dwelt
		? { change: { awaySince: outsideSince }, event: "Left" }
		: { change: {} };
};

/**
 * Records how far one fix is from the sender's home and, with automatic trips on, moves the trip.
 * A fix is inside when its center is within the radius and its accuracy is no wider than the
 * radius; it is clearly outside only when even the near edge of its accuracy circle is beyond the
 * radius, so GPS jitter at home starts no trip. Fixes in between change nothing. A manual trip
 * ends only after a fix clearly outside.
 */
const followHome = (
	ctx: Ctx,
	familyId: bigint,
	fix: Infer<typeof LocationFix>,
) => {
	const watch = homeWatchOf(ctx, familyId);
	if (watch?.home === undefined) return;
	const distance = distanceMeters(watch.home, fix);
	const { autoTrip, radiusMeters: radius } = watch;
	const step: HomeStep = !autoTrip
		? { change: {} }
		: distance <= radius && fix.accuracyMeters <= radius
			? insideStep(watch)
			: distance - fix.accuracyMeters > radius
				? outsideStep(watch, ctx.timestamp)
				: { change: {} };
	ctx.db.homeWatch.id.update({
		...watch,
		...step.change,
		distanceMeters: distance,
		updatedAt: ctx.timestamp,
	});
	if (step.event !== undefined)
		recordAway(ctx, familyId, step.event, false, fix);
};

const upsertHomeWatch = (
	ctx: Ctx,
	familyId: bigint,
	change: Partial<Infer<typeof homeWatch.rowType>>,
) => {
	const existing = homeWatchOf(ctx, familyId);
	const row = {
		id: 0n,
		familyId,
		sharer: ctx.sender,
		home: undefined,
		radiusMeters: 200,
		autoTrip: false,
		outsideSince: undefined,
		awaySince: undefined,
		distanceMeters: undefined,
		...existing,
		...change,
		updatedAt: ctx.timestamp,
	};
	if (existing === undefined) ctx.db.homeWatch.insert(row);
	else ctx.db.homeWatch.id.update(row);
};

/**
 * Sets the sender's home, the radius that counts as home, and whether their location reports start
 * and end trips. Moving home forgets a pending departure; an open trip stays open.
 */
export const setHome = spacetimedb.reducer(
	{
		familyId: t.u64(),
		home: t.option(HomePoint),
		radiusMeters: t.u32(),
		autoTrip: t.bool(),
	},
	(ctx, { familyId, home, radiusMeters, autoTrip }) => {
		requireMember(ctx, familyId);
		if (radiusMeters < MIN_HOME_RADIUS || radiusMeters > MAX_HOME_RADIUS)
			throw new SenderError(
				`radiusMeters must be ${MIN_HOME_RADIUS} to ${MAX_HOME_RADIUS}`,
			);
		if (
			home !== undefined &&
			!(Math.abs(home.latitude) <= 90 && Math.abs(home.longitude) <= 180)
		)
			throw new SenderError("coordinates out of range");
		// A pending departure and the last distance were measured from the old home; an open trip
		// keeps its evidence.
		const existing = homeWatchOf(ctx, familyId);
		const moved =
			existing?.home?.latitude !== home?.latitude ||
			existing?.home?.longitude !== home?.longitude;
		upsertHomeWatch(ctx, familyId, {
			home,
			radiusMeters,
			autoTrip,
			...(existing?.awaySince === undefined ? { outsideSince: undefined } : {}),
			...(moved ? { distanceMeters: undefined } : {}),
		});
	},
);

/** "I'm going out" (`away`) or "I'm home". Pressing it again changes nothing. */
export const setAway = spacetimedb.reducer(
	{ familyId: t.u64(), away: t.bool() },
	(ctx, { familyId, away }) => {
		requireMember(ctx, familyId);
		if ((homeWatchOf(ctx, familyId)?.awaySince !== undefined) === away) return;
		upsertHomeWatch(ctx, familyId, {
			outsideSince: undefined,
			awaySince: away ? ctx.timestamp : undefined,
		});
		recordAway(ctx, familyId, away ? "Left" : "Back", true, undefined);
	},
);

export const setMedicineMemory = spacetimedb.reducer(
	{ familyId: t.u64(), enabled: t.bool(), places: t.array(t.string()) },
	(ctx, { familyId, enabled, places }) => {
		requireMember(ctx, familyId);
		if (!enabled) {
			ctx.db.medicineMemory.familyId.delete(familyId);
			ctx.db.medicineSighting.familyId.delete(familyId);
			return;
		}
		for (const place of places) requireText("place", place);
		const row = { familyId, places, setBy: ctx.sender, setAt: ctx.timestamp };
		if (ctx.db.medicineMemory.familyId.find(familyId) === null)
			ctx.db.medicineMemory.insert(row);
		else ctx.db.medicineMemory.familyId.update(row);
	},
);

// A remembered place must come from a recent frame, so an old picture cannot pass as a new sighting.
const MAX_SIGHTING_AGE_MICROS = 15n * 60_000_000n;

export const rememberMedicine = spacetimedb.reducer(
	{
		familyId: t.u64(),
		container: t.string(),
		place: t.string(),
		seenAt: t.timestamp(),
		source: t.string(),
		confidence: t.f64(),
		labelRead: t.bool(),
	},
	(ctx, seen) => {
		requireMember(ctx, seen.familyId);
		if (ctx.db.medicineMemory.familyId.find(seen.familyId) === null)
			throw new SenderError("medicine memory is off for this family");
		requireText("container", seen.container);
		requireText("place", seen.place);
		requireText("source", seen.source);
		if (!(seen.confidence >= 0 && seen.confidence <= 1))
			throw new SenderError("confidence must be between 0 and 1");
		const age =
			ctx.timestamp.microsSinceUnixEpoch - seen.seenAt.microsSinceUnixEpoch;
		if (age < -MAX_CLOCK_AHEAD_MICROS || age > MAX_SIGHTING_AGE_MICROS)
			throw new SenderError("seenAt must be a current observation");
		const key = seen.container.trim().toLowerCase();
		const row = { ...seen, savedBy: ctx.sender, notFoundAt: undefined };
		for (const old of ctx.db.medicineSighting.familyId.filter(seen.familyId)) {
			if (old.container.trim().toLowerCase() !== key) continue;
			if (old.seenAt.microsSinceUnixEpoch > seen.seenAt.microsSinceUnixEpoch)
				throw new SenderError("a newer sighting is already stored");
			ctx.db.medicineSighting.id.update({ ...row, id: old.id });
			return;
		}
		ctx.db.medicineSighting.insert({ ...row, id: 0n });
	},
);

// The person looked at the remembered place and the container was not there. The place stays as
// the last sighting, marked outdated, until a new sighting replaces it.
export const markMedicineNotFound = spacetimedb.reducer(
	{ id: t.u64() },
	(ctx, { id }) => {
		const found = ctx.db.medicineSighting.id.find(id);
		if (found === null) throw new SenderError("not a member of this family");
		requireMember(ctx, found.familyId);
		ctx.db.medicineSighting.id.update({ ...found, notFoundAt: ctx.timestamp });
	},
);

const MAX_CONTACTS = 5;

export const setContactLadder = spacetimedb.reducer(
	{
		familyId: t.u64(),
		contacts: t.array(ContactStep),
		backup: t.option(ContactStep),
		answerSeconds: t.u32(),
		followUpSeconds: t.u32(),
	},
	(ctx, ladder) => {
		requireMember(ctx, ladder.familyId);
		if (ladder.contacts.length === 0 || ladder.contacts.length > MAX_CONTACTS)
			throw new SenderError(`a ladder has 1 to ${MAX_CONTACTS} contacts`);
		if (ladder.answerSeconds < 10 || ladder.answerSeconds > 86_400)
			throw new SenderError("answerSeconds must be 10 to 86400");
		if (ladder.followUpSeconds < 10 || ladder.followUpSeconds > 604_800)
			throw new SenderError("followUpSeconds must be 10 to 604800");
		const seen = new Set<string>();
		for (const contact of [
			...ladder.contacts,
			...(ladder.backup === undefined ? [] : [ladder.backup]),
		]) {
			requireText("name", contact.name);
			requireText("timeZone", contact.timeZone);
			const member = ctx.db.familyMember.byFamilyMember.filter([
				ladder.familyId,
				contact.member,
			]);
			if (member.next().done)
				throw new SenderError("every contact must be a member of this family");
			const hex = contact.member.toHexString();
			if (seen.has(hex))
				throw new SenderError("a member appears in the ladder once");
			seen.add(hex);
		}
		const row = {
			...ladder,
			backup: ladder.backup,
			updatedBy: ctx.sender,
			updatedAt: ctx.timestamp,
		};
		if (ctx.db.contactLadder.familyId.find(ladder.familyId) === null)
			ctx.db.contactLadder.insert(row);
		else ctx.db.contactLadder.familyId.update(row);
	},
);

// A member asks for help or sets a call reminder. Facts come only from the family's own samples.
export const openCareNeed = spacetimedb.reducer(
	{
		familyId: t.u64(),
		clientId: t.string(),
		kind: NeedKind,
		summary: t.string(),
		sampleIds: t.array(t.u64()),
		dueAt: t.option(t.timestamp()),
	},
	(ctx, { familyId, clientId, kind, summary, sampleIds, dueAt }) => {
		requireMember(ctx, familyId);
		requireText("clientId", clientId);
		requireText("summary", summary);
		if (kind.tag === "Alert")
			throw new SenderError("alerts open their own care need");
		// A client resends after a lost reply; the first stored need stands.
		for (const prior of ctx.db.careNeed.byRaiserClientId.filter([
			familyId,
			ctx.sender,
			clientId,
		])) {
			if (prior.summary !== summary)
				throw new SenderError("clientId is already used for another need");
			return;
		}
		const facts = sampleIds.map((id) => {
			const sample = ctx.db.healthSample.id.find(id);
			if (sample?.familyId !== familyId)
				throw new SenderError("sample does not belong to this family");
			return sampleFact(sample);
		});
		openNeed(ctx, {
			familyId,
			kind,
			summary,
			facts,
			alertId: undefined,
			dueAt: dueAt ?? ctx.timestamp,
			clientId,
		});
	},
);

const NeedResponse = t.enum("NeedResponse", {
	Seen: t.unit(),
	Answer: t.unit(),
	Accept: t.unit(),
	Decline: t.unit(),
	ConfirmHelp: t.unit(),
});

// Attempt states in which the contact can still accept or decline.
const WAITING: Record<string, true> = {
	Sent: true,
	Delivered: true,
	Answered: true,
};

type Attempt = Infer<typeof contactAttempt.rowType>;

const confirmHelp = (ctx: Ctx, need: Need) => {
	const acceptedByMe = need.acceptedBy?.isEqual(ctx.sender) === true;
	if (need.status.tag === "Resolved" && acceptedByMe) return;
	if (need.status.tag !== "Accepted" || !acceptedByMe)
		throw new SenderError("only the member who accepted can confirm help");
	ctx.db.careNeed.id.update({
		...need,
		status: { tag: "Resolved" },
		followUpBy: undefined,
		updatedAt: ctx.timestamp,
	});
	postCareMessage(
		ctx,
		need.familyId,
		`care-${need.id}-resolved`,
		`${need.steps[need.step]?.name} confirmed help with ${kindLabel[need.kind.tag]}.`,
	);
};

// Accepting stops the ladder: nobody else is contacted unless help is not confirmed in time.
const accept = (ctx: Ctx, need: Need, attempt: Attempt) => {
	setAttemptStatus(ctx, attempt, "Accepted");
	const followUpBy = secondsFromNow(ctx, need.followUpSeconds);
	ctx.db.careNeed.id.update({
		...need,
		status: { tag: "Accepted" },
		acceptedBy: ctx.sender,
		followUpBy,
		updatedAt: ctx.timestamp,
	});
	scheduleLadder(ctx, need.id, need.step, "FollowUpDue", followUpBy);
	postCareMessage(
		ctx,
		need.familyId,
		`care-${attempt.key}-accepted`,
		`${need.steps[need.step]?.name} accepted ${kindLabel[need.kind.tag]}. Telly contacts nobody else unless help is not confirmed in time.`,
	);
};

const currentAttempt = (ctx: Ctx, need: Need) => {
	const attempt = ctx.db.contactAttempt.key.find(
		attemptKey(need.id, need.step),
	);
	if (attempt === null || !attempt.member.isEqual(ctx.sender))
		throw new SenderError("not the current contact for this need");
	return attempt;
};

// "Seen" and "Answer" record transport progress only; neither accepts the need.
const markProgress = (ctx: Ctx, attempt: Attempt, answered: boolean) => {
	const status = attempt.status.tag;
	if (!answered) {
		if (status === "Sent") setAttemptStatus(ctx, attempt, "Delivered");
		return;
	}
	if (attempt.channel.tag !== "Call")
		throw new SenderError("this contact was sent a message, not a call");
	if (status === "Sent" || status === "Delivered")
		setAttemptStatus(ctx, attempt, "Answered");
};

/** The current contact answers the need; the member who accepted it confirms help. Repeats are no-ops. */
export const respondToCareNeed = spacetimedb.reducer(
	{ needId: t.u64(), response: NeedResponse },
	(ctx, { needId, response }) => {
		const need = ctx.db.careNeed.id.find(needId);
		// A missing need fails like another family's need, so ids reveal nothing.
		if (need === null) throw new SenderError("not a member of this family");
		requireMember(ctx, need.familyId);
		if (response.tag === "ConfirmHelp") return confirmHelp(ctx, need);
		const attempt = currentAttempt(ctx, need);
		if (response.tag === "Seen" || response.tag === "Answer")
			return markProgress(ctx, attempt, response.tag === "Answer");
		const status = attempt.status.tag;
		if (response.tag === "Accept" && status === "Accepted") return;
		if (need.status.tag !== "Open" || WAITING[status] !== true)
			throw new SenderError("this need is not waiting for you");
		if (response.tag === "Accept") return accept(ctx, need, attempt);
		setAttemptStatus(ctx, attempt, "Declined");
		contactStep(ctx, need, need.step + 1);
	},
);

export const runLadderTimer = spacetimedb.reducer(
	{ onSchedule: ladderTimer },
	{ timer: ladderTimer.rowType },
	(ctx, { timer }) => {
		if (!ctx.sender.isEqual(ctx.databaseIdentity))
			throw new SenderError("only the database runs ladder timers");
		const need = ctx.db.careNeed.id.find(timer.needId);
		if (need === null || need.step !== timer.step) return;
		const attempt = ctx.db.contactAttempt.key.find(
			attemptKey(need.id, timer.step),
		);
		if (attempt === null) return;
		switch (timer.purpose.tag) {
			case "Send":
				if (need.status.tag === "Open") sendAttempt(ctx, need, timer.step);
				return;
			case "AnswerDue":
				if (need.status.tag !== "Open" || WAITING[attempt.status.tag] !== true)
					return;
				if (attempt.status.tag !== "Answered")
					setAttemptStatus(ctx, attempt, "NoAnswer");
				contactStep(ctx, need, timer.step + 1);
				return;
			case "FollowUpDue":
				if (need.status.tag !== "Accepted") return;
				setAttemptStatus(ctx, attempt, "FollowUpExpired");
				postCareMessage(
					ctx,
					need.familyId,
					`care-${attempt.key}-expired`,
					`${need.steps[timer.step]?.name} has not confirmed help with ${kindLabel[need.kind.tag]}. Telly is asking the next contact.`,
				);
				contactStep(ctx, need, timer.step + 1);
				return;
		}
	},
);

// Reminder lifecycle (issue #28). The database runs every prompt on its own timers, so a server
// restart neither loses nor repeats one. Silence only ever ends an occurrence `unresolved`.

const REMINDER_KINDS = [
	"medication",
	"meal",
	"hydration",
	"appointment",
	"charging",
	"routine",
];
const REMINDER_RESPONSES = [
	"okay",
	"dismissed",
	"done",
	"already_did_it",
	"later",
	"not_now",
	"stop",
	"help",
	"unsure",
	"repeat",
];
const CLIENT_SOURCES = ["phone", "web", "glasses"];
// A home speaker only delivers: it cannot hear an answer (#46). The server records its deliveries.
const DELIVERY_SOURCES = [...CLIENT_SOURCES, "speaker"];
const SPEAKER_ROOMS = ["private", "shared"];
const COMPLETE_STATES = ["self_reported_complete", "caregiver_confirmed"];
const MINUTES_PER_DAY = 24 * 60;

type ReminderSettingsRow = Infer<typeof reminderSettings.rowType>;
type ReminderRow = Infer<typeof reminder.rowType>;
type OccurrenceRow = Infer<typeof reminderOccurrence.rowType>;

const toMs = (at: Timestamp) => Number(at.microsSinceUnixEpoch / 1000n);
const fromMs = (ms: number) => new Timestamp(BigInt(ms) * 1000n);

const quietHours = (s: ReminderSettingsRow) =>
	s.quietStart === undefined || s.quietEnd === undefined
		? undefined
		: { start: s.quietStart, end: s.quietEnd };

const requireReminderSettings = (ctx: Ctx, familyId: bigint) => {
	const found = ctx.db.reminderSettings.familyId.find(familyId);
	if (found === null) throw new SenderError("save the reminder settings first");
	return found;
};

/** The prompt time `minutes` from now, held until quiet hours end. */
const promptAfter = (ctx: Ctx, s: ReminderSettingsRow, minutes: number) =>
	fromMs(
		afterQuietHours(
			toMs(ctx.timestamp) + minutes * 60_000,
			quietHours(s),
			s.timeZone,
		),
	);

const scheduleReminderTimer = (ctx: Ctx, occurrenceId: bigint, at: Timestamp) =>
	ctx.db.reminderTimer.insert({
		scheduledId: 0n,
		scheduledAt: ScheduleAt.time(at.microsSinceUnixEpoch),
		occurrenceId,
		dueAt: at,
	});

const recordReminderEvent = (
	ctx: Ctx,
	occurrence: OccurrenceRow,
	state: string,
	answer: {
		response?: string | undefined;
		source: string;
		wording?: string | undefined;
	},
) =>
	ctx.db.reminderEvent.insert({
		id: 0n,
		occurrenceId: occurrence.id,
		familyId: occurrence.familyId,
		state,
		response: answer.response,
		at: ctx.timestamp,
		actor: answer.source === "scheduler" ? undefined : ctx.sender,
		source: answer.source,
		wording: answer.wording,
	});

// A meal or drink check-in that ends unresolved asks the family contact ladder for help (#32), the
// same way an alert does: only when the family has a ladder. An occurrence ends unresolved at most
// once, so this opens at most one need per check-in.
const mealCheckInNeed = (
	ctx: Ctx,
	occurrence: OccurrenceRow,
	wording: string | undefined,
) => {
	if (occurrence.kind !== "meal" && occurrence.kind !== "hydration") return;
	if (ctx.db.contactLadder.familyId.find(occurrence.familyId) === null) return;
	const why = wording ?? `no answer after ${occurrence.prompts} prompts`;
	openNeed(ctx, {
		familyId: occurrence.familyId,
		kind: { tag: "Help" },
		summary: `${occurrence.title}: ${why}`.slice(0, 500),
		facts: [],
		alertId: undefined,
		dueAt: ctx.timestamp,
		clientId: `reminder-${occurrence.id}`,
	});
};

/** Schedules the reminder's next occurrence at local `minute` after `afterMs`, once per slot. */
const scheduleOccurrence = (
	ctx: Ctx,
	r: ReminderRow,
	minute: number,
	afterMs: number,
) => {
	const s = requireReminderSettings(ctx, r.familyId);
	const at = nextLocalTime(afterMs, minute, s.timeZone);
	const slot = `${r.id}:${at}`;
	if (ctx.db.reminderOccurrence.slot.find(slot) !== null) return;
	const firstPrompt = fromMs(afterQuietHours(at, quietHours(s), s.timeZone));
	const occurrence = ctx.db.reminderOccurrence.insert({
		id: 0n,
		familyId: r.familyId,
		reminderId: r.id,
		slot,
		kind: r.kind,
		subjectId: r.subjectId,
		title: r.title,
		minuteOfDay: minute,
		scheduledFor: fromMs(at),
		state: "scheduled",
		promptDue: false,
		prompts: 0,
		nextPromptAt: firstPrompt,
	});
	recordReminderEvent(ctx, occurrence, "scheduled", { source: "scheduler" });
	scheduleReminderTimer(ctx, occurrence.id, firstPrompt);
};

const requireOccurrence = (ctx: Ctx, occurrenceId: bigint) => {
	const found = ctx.db.reminderOccurrence.id.find(occurrenceId);
	// A missing occurrence fails like another family's, so ids reveal nothing.
	if (found === null) throw new SenderError("not a member of this family");
	requireMember(ctx, found.familyId);
	return found;
};

const requireClientSource = (source: string) => {
	if (!CLIENT_SOURCES.includes(source))
		throw new SenderError("source must be phone, web, or glasses");
};

const requireWording = (wording: string | undefined) => {
	if (wording !== undefined && wording.length > 2000)
		throw new SenderError("wording must be at most 2000 characters");
};

/**
 * True when the sender already sent `clientId` for this occurrence with the same `fingerprint`: a
 * retry after a lost reply, which records nothing new. The same id with other content fails.
 */
const seenRequest = (
	ctx: Ctx,
	occurrenceId: bigint,
	clientId: string,
	fingerprint: string,
) => {
	requireText("clientId", clientId);
	const key = `${occurrenceId}:${ctx.sender.toHexString()}:${clientId}`;
	const seen = ctx.db.reminderRequest.key.find(key);
	if (seen === null) {
		ctx.db.reminderRequest.insert({ key, fingerprint });
		return false;
	}
	if (seen.fingerprint !== fingerprint)
		throw new SenderError("clientId is already used for another request");
	return true;
};

export const setReminderSettings = spacetimedb.reducer(
	{ familyId: t.u64(), ...promptRules() },
	(ctx, settings) => {
		requireMember(ctx, settings.familyId);
		try {
			new Intl.DateTimeFormat("en", { timeZone: settings.timeZone });
		} catch {
			throw new SenderError("timeZone is not a known IANA time zone");
		}
		if (
			(settings.quietStart === undefined) !==
			(settings.quietEnd === undefined)
		)
			throw new SenderError("quiet hours need both a start and an end");
		if (
			(settings.quietStart ?? 0) >= MINUTES_PER_DAY ||
			(settings.quietEnd ?? 0) >= MINUTES_PER_DAY
		)
			throw new SenderError("quiet hours must be times of day");
		for (const minutes of [settings.repeatEveryMinutes, settings.snoozeMinutes])
			if (minutes < 1 || minutes > 240)
				throw new SenderError(
					"repeat spacing and snooze must be 1 to 240 minutes",
				);
		if (settings.maxPrompts < 1 || settings.maxPrompts > 10)
			throw new SenderError("maxPrompts must be 1 to 10");
		const row = {
			...settings,
			quietStart: settings.quietStart,
			quietEnd: settings.quietEnd,
			updatedBy: ctx.sender,
			updatedAt: ctx.timestamp,
		};
		if (ctx.db.reminderSettings.familyId.find(settings.familyId) === null)
			ctx.db.reminderSettings.insert(row);
		else ctx.db.reminderSettings.familyId.update(row);
	},
);

export const createReminder = spacetimedb.reducer(
	{
		familyId: t.u64(),
		clientId: t.string(),
		kind: t.string(),
		subjectId: t.option(t.string()),
		title: t.string(),
		times: t.array(t.u16()),
	},
	(ctx, input) => {
		requireMember(ctx, input.familyId);
		requireReminderSettings(ctx, input.familyId);
		requireText("clientId", input.clientId);
		requireText("title", input.title);
		if (!REMINDER_KINDS.includes(input.kind))
			throw new SenderError("kind is not a reminder kind");
		if (
			input.times.length === 0 ||
			input.times.length > 12 ||
			input.times.some((minute) => minute >= MINUTES_PER_DAY)
		)
			throw new SenderError("times must be 1 to 12 times of day");
		// The server resends after a lost reply; the first stored reminder stands.
		if (ctx.db.reminder.clientId.find(input.clientId) !== null) return;
		const created = ctx.db.reminder.insert({
			...input,
			subjectId: input.subjectId,
			id: 0n,
			createdBy: ctx.sender,
			createdAt: ctx.timestamp,
		});
		for (const minute of new Set(input.times))
			scheduleOccurrence(ctx, created, minute, toMs(ctx.timestamp));
	},
);

/** Stops the reminder. Occurrences that are not yet due go with it; every other one stays as history. */
export const deleteReminder = spacetimedb.reducer(
	{ reminderId: t.u64() },
	(ctx, { reminderId }) => {
		const found = ctx.db.reminder.id.find(reminderId);
		if (found === null) throw new SenderError("not a member of this family");
		requireMember(ctx, found.familyId);
		ctx.db.reminder.id.delete(reminderId);
		const now = ctx.timestamp.microsSinceUnixEpoch;
		for (const occurrence of [
			...ctx.db.reminderOccurrence.reminderId.filter(reminderId),
		]) {
			if (
				occurrence.state !== "scheduled" ||
				occurrence.prompts > 0 ||
				occurrence.scheduledFor.microsSinceUnixEpoch <= now
			)
				continue;
			for (const event of [
				...ctx.db.reminderEvent.occurrenceId.filter(occurrence.id),
			])
				ctx.db.reminderEvent.id.delete(event.id);
			ctx.db.reminderOccurrence.id.delete(occurrence.id);
		}
	},
);

/** A device showed or spoke the due prompt. Without a due prompt it records nothing. */
export const recordReminderDelivery = spacetimedb.reducer(
	{ occurrenceId: t.u64(), clientId: t.string(), source: t.string() },
	(ctx, { occurrenceId, clientId, source }) => {
		const occurrence = requireOccurrence(ctx, occurrenceId);
		if (!DELIVERY_SOURCES.includes(source))
			throw new SenderError("source must be phone, web, glasses, or speaker");
		if (seenRequest(ctx, occurrenceId, clientId, `delivery:${source}`)) return;
		if (!occurrence.promptDue) return;
		recordReminderEvent(ctx, occurrence, "delivered", { source });
		ctx.db.reminderOccurrence.id.update({
			...occurrence,
			state: "delivered",
			promptDue: false,
		});
	},
);

/** The wearer's answer. See `ReminderResponse` in `@health/contracts/reminders` for each state. */
export const answerReminder = spacetimedb.reducer(
	{
		occurrenceId: t.u64(),
		clientId: t.string(),
		source: t.string(),
		response: t.string(),
		wording: t.option(t.string()),
	},
	(ctx, { occurrenceId, clientId, source, response, wording }) => {
		const occurrence = requireOccurrence(ctx, occurrenceId);
		requireClientSource(source);
		requireWording(wording);
		if (!REMINDER_RESPONSES.includes(response))
			throw new SenderError("response is not a reminder response");
		const fingerprint = `answer:${source}:${response}:${wording ?? ""}`;
		if (seenRequest(ctx, occurrenceId, clientId, fingerprint)) return;
		const answer = (state: string, change: Partial<OccurrenceRow>) => {
			recordReminderEvent(ctx, occurrence, state, {
				response,
				source,
				wording,
			});
			ctx.db.reminderOccurrence.id.update({ ...occurrence, ...change, state });
		};
		const end = { promptDue: false, nextPromptAt: undefined };
		if (response === "done" || response === "already_did_it") {
			// A dose or meal is recorded once, however often it is reported.
			if (COMPLETE_STATES.includes(occurrence.state)) return;
			return answer("self_reported_complete", end);
		}
		if (occurrence.nextPromptAt === undefined)
			throw new SenderError("prompts have ended for this occurrence");
		const settings = requireReminderSettings(ctx, occurrence.familyId);
		switch (response) {
			case "okay":
			case "dismissed":
				// Seen, not done: follow-up prompts continue.
				return answer("acknowledged", { promptDue: false });
			case "later":
			case "not_now": {
				const next = promptAfter(
					ctx,
					settings,
					response === "later"
						? settings.snoozeMinutes
						: settings.repeatEveryMinutes,
				);
				answer("deferred", {
					promptDue: false,
					prompts: 0,
					nextPromptAt: next,
				});
				scheduleReminderTimer(ctx, occurrenceId, next);
				return;
			}
			case "stop":
				return answer("declined", end);
			case "repeat":
				return answer(occurrence.state, { promptDue: true });
			default:
				// `help` and `unsure`: a person takes over; prompting again could cause a second dose.
				answer("unresolved", end);
				mealCheckInNeed(ctx, occurrence, wording);
				return;
		}
	},
);

/** A family member confirms the task was done. Separate from the wearer's own report; once per occurrence. */
export const confirmReminder = spacetimedb.reducer(
	{
		occurrenceId: t.u64(),
		clientId: t.string(),
		source: t.string(),
		wording: t.option(t.string()),
	},
	(ctx, { occurrenceId, clientId, source, wording }) => {
		const occurrence = requireOccurrence(ctx, occurrenceId);
		requireClientSource(source);
		requireWording(wording);
		const fingerprint = `confirm:${source}:${wording ?? ""}`;
		if (seenRequest(ctx, occurrenceId, clientId, fingerprint)) return;
		if (occurrence.state === "caregiver_confirmed") return;
		recordReminderEvent(ctx, occurrence, "caregiver_confirmed", {
			source,
			wording,
		});
		ctx.db.reminderOccurrence.id.update({
			...occurrence,
			state: "caregiver_confirmed",
			promptDue: false,
			nextPromptAt: undefined,
		});
	},
);

/**
 * Gives the next prompt, or ends the occurrence `unresolved` after `maxPrompts` prompts that no answer
 * settled. The first run also schedules the reminder's next occurrence for the same time of day.
 */
export const runReminderTimer = spacetimedb.reducer(
	{ onSchedule: reminderTimer },
	{ timer: reminderTimer.rowType },
	(ctx, { timer }) => {
		if (!ctx.sender.isEqual(ctx.databaseIdentity))
			throw new SenderError("only the database runs reminder timers");
		const occurrence = ctx.db.reminderOccurrence.id.find(timer.occurrenceId);
		if (
			occurrence?.nextPromptAt?.microsSinceUnixEpoch !==
			timer.dueAt.microsSinceUnixEpoch
		)
			return;
		const owner = ctx.db.reminder.id.find(occurrence.reminderId);
		if (owner !== null)
			scheduleOccurrence(
				ctx,
				owner,
				occurrence.minuteOfDay,
				Math.max(toMs(occurrence.scheduledFor), toMs(ctx.timestamp)),
			);
		const settings = requireReminderSettings(ctx, occurrence.familyId);
		if (occurrence.prompts >= settings.maxPrompts) {
			// Silence settles nothing and never dispatches help. Only a meal or drink check-in asks
			// the family ladder (#32); every other kind stays visibly open and contacts nobody.
			recordReminderEvent(ctx, occurrence, "unresolved", {
				source: "scheduler",
			});
			ctx.db.reminderOccurrence.id.update({
				...occurrence,
				state: "unresolved",
				promptDue: false,
				nextPromptAt: undefined,
			});
			mealCheckInNeed(ctx, occurrence, undefined);
			return;
		}
		const next = promptAfter(ctx, settings, settings.repeatEveryMinutes);
		ctx.db.reminderOccurrence.id.update({
			...occurrence,
			promptDue: true,
			prompts: occurrence.prompts + 1,
			nextPromptAt: next,
		});
		scheduleReminderTimer(ctx, occurrence.id, next);
	},
);

export const setSpeakerSettings = spacetimedb.reducer(
	{
		familyId: t.u64(),
		enabled: t.bool(),
		room: t.string(),
		sharedRoomKinds: t.array(t.string()),
	},
	(ctx, settings) => {
		requireMember(ctx, settings.familyId);
		if (!SPEAKER_ROOMS.includes(settings.room))
			throw new SenderError("room must be private or shared");
		if (settings.sharedRoomKinds.some((k) => !REMINDER_KINDS.includes(k)))
			throw new SenderError("sharedRoomKinds must be reminder kinds");
		const row = {
			...settings,
			sharedRoomKinds: [...new Set(settings.sharedRoomKinds)],
			updatedBy: ctx.sender,
			updatedAt: ctx.timestamp,
		};
		if (ctx.db.speakerSettings.familyId.find(settings.familyId) === null)
			ctx.db.speakerSettings.insert(row);
		else ctx.db.speakerSettings.familyId.update(row);
	},
);

/** A care or cooking profile save: a `care_plan_edit` holder with non-empty text. */
const requireProfileEdit = (ctx: Ctx, familyId: bigint, profile: string) => {
	requireCareScope(ctx, familyId, "care_plan_edit");
	requireText("profile", profile);
};

export const saveCareProfile = spacetimedb.reducer(
	{ familyId: t.u64(), profile: t.string() },
	(ctx, { familyId, profile }) => {
		requireProfileEdit(ctx, familyId, profile);
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
// grants. Families from before #188 start this way; `createFamily` now grants `family_access`.
const maySetUpSharing = (ctx: Ctx, familyId: bigint) => {
	for (const event of ctx.db.careGrantEvent.familyId.filter(familyId))
		if (event.scope === "family_access" && event.granted) return false;
	return founderOf(ctx, familyId)?.isEqual(ctx.sender) === true;
};

// A `family_access` holder changes grants (see `maySetUpSharing` for an older family).
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

const requireExercisePlan = (ctx: Ctx, id: string) => {
	const found = ctx.db.exercisePlan.id.find(id);
	// A missing plan fails like another family's plan, so ids reveal nothing.
	if (found === null) throw new SenderError("not a member of this family");
	requireMember(ctx, found.familyId);
	return found;
};

export const createExercisePlan = spacetimedb.reducer(
	{ id: t.string(), familyId: t.u64(), plan: t.string() },
	(ctx, created) => {
		requireMember(ctx, created.familyId);
		requireText("id", created.id);
		requireText("plan", created.plan);
		if (ctx.db.exercisePlan.id.find(created.id) !== null)
			throw new SenderError("exercise plan id already exists");
		ctx.db.exercisePlan.insert({
			...created,
			createdBy: ctx.sender,
			createdAt: ctx.timestamp,
			verifiedBy: undefined,
			verifiedAt: undefined,
		});
	},
);

// A member confirms the plan matches its source. Verifying again keeps the first verification.
export const verifyExercisePlan = spacetimedb.reducer(
	{ id: t.string() },
	(ctx, { id }) => {
		const found = requireExercisePlan(ctx, id);
		if (found.verifiedAt !== undefined) return;
		ctx.db.exercisePlan.id.update({
			...found,
			verifiedBy: ctx.sender,
			verifiedAt: ctx.timestamp,
		});
	},
);

// The wearer's answer opens a session: `declined` or `started`. Only a started session takes
// controls, and `stopped` or `completed` ends it. No answer records nothing, so silence is never a
// completed exercise.
const exerciseControls = ["paused", "resumed", "repeated", "slowed", "help"];
const exerciseEnds = ["stopped", "completed"];
const stopReasons = ["wearer", "pain", "dizziness", "distress"];

export const recordExerciseEvent = spacetimedb.reducer(
	{
		id: t.string(),
		planId: t.string(),
		sessionId: t.string(),
		kind: t.string(),
		reason: t.option(t.string()),
	},
	(ctx, event) => {
		const plan = requireExercisePlan(ctx, event.planId);
		requireText("id", event.id);
		requireText("sessionId", event.sessionId);
		const resent = ctx.db.exerciseEvent.id.find(event.id);
		if (resent !== null) {
			if (
				resent.planId !== event.planId ||
				resent.sessionId !== event.sessionId ||
				resent.kind !== event.kind ||
				resent.reason !== event.reason
			)
				throw new SenderError("id is already used for another event");
			return;
		}
		if (plan.verifiedAt === undefined)
			throw new SenderError("the exercise plan is not verified");
		const stopped = event.kind === "stopped";
		if (
			stopped !== (event.reason !== undefined) ||
			(stopped && !stopReasons.includes(event.reason ?? ""))
		)
			throw new SenderError(
				"only a stop has a reason: wearer, pain, dizziness, or distress",
			);
		const earlier = [...ctx.db.exerciseEvent.sessionId.filter(event.sessionId)];
		if (earlier.some((e) => e.planId !== event.planId))
			throw new SenderError("the session belongs to another plan");
		const opened = earlier.some((e) => e.kind === "started");
		const ended = earlier.some(
			(e) => e.kind === "declined" || exerciseEnds.includes(e.kind),
		);
		const allowed =
			event.kind === "declined" || event.kind === "started"
				? earlier.length === 0
				: [...exerciseControls, ...exerciseEnds].includes(event.kind) &&
					opened &&
					!ended;
		if (!allowed)
			throw new SenderError(`${event.kind} is not allowed in this session now`);
		ctx.db.exerciseEvent.insert({
			...event,
			reason: event.reason,
			familyId: plan.familyId,
			actor: ctx.sender,
			at: ctx.timestamp,
		});
	},
);

type OrderStatusTag = Infer<typeof OrderStatus>["tag"];

// The statuses each status may follow. A retry after `Uncertain` or `Failed` may record either again.
const ORDER_STEPS: Record<OrderStatusTag, readonly OrderStatusTag[]> = {
	Proposed: [],
	Approved: ["Proposed"],
	Replaced: ["Proposed", "Approved", "Failed"],
	Placed: ["Approved", "Uncertain", "Failed"],
	Uncertain: ["Approved", "Uncertain", "Failed"],
	Failed: ["Approved", "Uncertain", "Failed"],
	Delivered: ["Placed"],
	Eaten: ["Delivered"],
};

export const recordDeliveryEvent = spacetimedb.reducer(
	{
		familyId: t.u64(),
		proposalId: t.string(),
		status: OrderStatus,
		proposal: t.option(t.string()),
		note: t.string(),
	},
	(ctx, event) => {
		requireMember(ctx, event.familyId);
		requireText("proposalId", event.proposalId);
		let last: Infer<typeof deliveryEvent.rowType> | undefined;
		for (const row of ctx.db.deliveryEvent.proposalId.filter(event.proposalId))
			if (last === undefined || row.id > last.id) last = row;
		if (last !== undefined && last.familyId !== event.familyId)
			throw new SenderError("proposal id already exists");
		if ((event.status.tag === "Proposed") !== (event.proposal !== undefined))
			throw new SenderError("only a new proposal carries proposal JSON");
		if (event.status.tag === "Proposed") {
			if (last !== undefined)
				throw new SenderError("proposal id already exists");
			requireText("proposal", event.proposal ?? "");
		} else if (
			last === undefined ||
			!ORDER_STEPS[event.status.tag].includes(last.status.tag)
		)
			throw new SenderError(
				`a ${last?.status.tag ?? "missing"} proposal cannot become ${event.status.tag}`,
			);
		ctx.db.deliveryEvent.insert({
			...event,
			id: 0n,
			proposal: event.proposal,
			actor: ctx.sender,
			at: ctx.timestamp,
		});
	},
);

const requireAppointment = (ctx: Ctx, id: string) => {
	const found = ctx.db.appointment.id.find(id);
	// A missing appointment fails like another family's, so ids reveal nothing.
	if (found === null) throw new SenderError("not a member of this family");
	requireMember(ctx, found.familyId);
	if (found.cancelledAt !== undefined)
		throw new SenderError("appointment is cancelled");
	return found;
};

export const suggestAppointment = spacetimedb.reducer(
	{
		id: t.string(),
		familyId: t.u64(),
		visit: t.string(),
		prep: t.string(),
		source: t.string(),
	},
	(ctx, suggested) => {
		requireMember(ctx, suggested.familyId);
		requireText("id", suggested.id);
		requireText("visit", suggested.visit);
		requireText("prep", suggested.prep);
		if (suggested.source !== "model" && suggested.source !== "member")
			throw new SenderError("source must be model or member");
		if (ctx.db.appointment.id.find(suggested.id) !== null)
			throw new SenderError("appointment id already exists");
		ctx.db.appointment.insert({
			...suggested,
			suggestedBy: ctx.sender,
			suggestedAt: ctx.timestamp,
			requestedBy: undefined,
			requestedAt: undefined,
			confirmation: undefined,
			confirmedBy: undefined,
			confirmedAt: undefined,
			cancelledBy: undefined,
			cancelledAt: undefined,
			summary: undefined,
			summaryReviewedBy: undefined,
			summaryReviewedAt: undefined,
		});
	},
);

export const updateAppointmentPrep = spacetimedb.reducer(
	{ id: t.string(), prep: t.string() },
	(ctx, { id, prep }) => {
		const found = requireAppointment(ctx, id);
		requireText("prep", prep);
		ctx.db.appointment.id.update({ ...found, prep });
	},
);

// A member's explicit request. It records intent only; nothing reaches the provider.
export const requestAppointment = spacetimedb.reducer(
	{ id: t.string() },
	(ctx, { id }) => {
		const found = requireAppointment(ctx, id);
		if (found.requestedAt !== undefined)
			throw new SenderError("appointment is already requested");
		ctx.db.appointment.id.update({
			...found,
			requestedBy: ctx.sender,
			requestedAt: ctx.timestamp,
		});
	},
);

// Only a requested appointment takes the provider's confirmation: a suggestion never skips ahead.
export const confirmAppointment = spacetimedb.reducer(
	{ id: t.string(), confirmation: t.string() },
	(ctx, { id, confirmation }) => {
		const found = requireAppointment(ctx, id);
		if (found.requestedAt === undefined)
			throw new SenderError("only a requested appointment can be confirmed");
		if (found.confirmedAt !== undefined)
			throw new SenderError("appointment is already confirmed");
		requireText("confirmation", confirmation);
		ctx.db.appointment.id.update({
			...found,
			confirmation,
			confirmedBy: ctx.sender,
			confirmedAt: ctx.timestamp,
		});
	},
);

export const cancelAppointment = spacetimedb.reducer(
	{ id: t.string() },
	(ctx, { id }) => {
		const found = requireAppointment(ctx, id);
		ctx.db.appointment.id.update({
			...found,
			cancelledBy: ctx.sender,
			cancelledAt: ctx.timestamp,
		});
	},
);

export const reviewAppointmentSummary = spacetimedb.reducer(
	{ id: t.string(), summary: t.string() },
	(ctx, { id, summary }) => {
		const found = requireAppointment(ctx, id);
		requireText("summary", summary);
		ctx.db.appointment.id.update({
			...found,
			summary,
			summaryReviewedBy: ctx.sender,
			summaryReviewedAt: ctx.timestamp,
		});
	},
);

const frequencies: Record<string, string[]> = {
	explicit: ["once"],
	standing: ["weekly", "monthly"],
};
// Keep in step with `shareIntervalDays` in apps/server/src/routes/appointments.ts.
const intervalMicros: Record<string, bigint> = {
	weekly: 7n * 86_400_000_000n,
	monthly: 30n * 86_400_000_000n,
};

// Approving and sending a clinician update need the `clinician_delivery` care scope (#26) as well
// as the per-update consent.
export const approveClinicianShare = spacetimedb.reducer(
	{
		id: t.string(),
		appointmentId: t.string(),
		recipient: t.string(),
		sections: t.string(),
		consent: t.string(),
		frequency: t.string(),
	},
	(ctx, share) => {
		const found = requireAppointment(ctx, share.appointmentId);
		requireCareScope(ctx, found.familyId, "clinician_delivery");
		requireText("id", share.id);
		requireText("recipient", share.recipient);
		requireText("sections", share.sections);
		if (found.summaryReviewedAt === undefined)
			throw new SenderError("review the summary before sharing it");
		if (!frequencies[share.consent]?.includes(share.frequency))
			throw new SenderError("consent and frequency do not match");
		if (ctx.db.clinicianShare.id.find(share.id) !== null)
			throw new SenderError("share id already exists");
		ctx.db.clinicianShare.insert({
			...share,
			familyId: found.familyId,
			approvedBy: ctx.sender,
			approvedAt: ctx.timestamp,
			approvedSummaryAt:
				share.consent === "explicit" ? found.summaryReviewedAt : undefined,
			revokedBy: undefined,
			revokedAt: undefined,
			sends: 0,
			lastSentAt: undefined,
		});
	},
);

const requireShare = (ctx: Ctx, id: string) => {
	const found = ctx.db.clinicianShare.id.find(id);
	if (found === null) throw new SenderError("not a member of this family");
	requireMember(ctx, found.familyId);
	if (found.revokedAt !== undefined) throw new SenderError("share is revoked");
	return found;
};

// Records one simulated send, only inside the consent: once for explicit consent, and no sooner
// than the agreed interval for a standing arrangement.
export const sendClinicianShare = spacetimedb.reducer(
	{ id: t.string() },
	(ctx, { id }) => {
		const share = requireShare(ctx, id);
		requireCareScope(ctx, share.familyId, "clinician_delivery");
		const found = requireAppointment(ctx, share.appointmentId);
		if (share.consent === "explicit") {
			if (share.sends > 0)
				throw new SenderError("explicit consent covers one send");
			if (
				found.summaryReviewedAt?.microsSinceUnixEpoch !==
				share.approvedSummaryAt?.microsSinceUnixEpoch
			)
				throw new SenderError("the summary changed after approval");
		} else if (
			share.lastSentAt !== undefined &&
			ctx.timestamp.microsSinceUnixEpoch <
				share.lastSentAt.microsSinceUnixEpoch +
					(intervalMicros[share.frequency] ?? 0n)
		)
			throw new SenderError("not due yet at the agreed frequency");
		ctx.db.clinicianShare.id.update({
			...share,
			sends: share.sends + 1,
			lastSentAt: ctx.timestamp,
		});
	},
);

// Any member may withdraw consent; stopping a share never needs more access than starting one.
export const revokeClinicianShare = spacetimedb.reducer(
	{ id: t.string() },
	(ctx, { id }) => {
		const share = requireShare(ctx, id);
		ctx.db.clinicianShare.id.update({
			...share,
			revokedBy: ctx.sender,
			revokedAt: ctx.timestamp,
		});
	},
);

export const saveCookingProfile = spacetimedb.reducer(
	{ familyId: t.u64(), profile: t.string() },
	(ctx, { familyId, profile }) => {
		requireProfileEdit(ctx, familyId, profile);
		const row = {
			familyId,
			profile,
			editedBy: ctx.sender,
			editedAt: ctx.timestamp,
		};
		if (ctx.db.cookingProfile.familyId.find(familyId) === null)
			ctx.db.cookingProfile.insert(row);
		else ctx.db.cookingProfile.familyId.update(row);
	},
);

// The members of every family the caller belongs to. Procedural: on the host, a semijoin of
// `family_member` with itself returned no rows (auth.test.ts).
export const myFamilyMembers = spacetimedb.view(
	{ name: "my_family_members", public: true },
	t.array(familyMember.rowType),
	(ctx) =>
		[...ctx.db.familyMember.member.filter(ctx.sender)].flatMap((mine) => [
			...ctx.db.familyMember.familyId.filter(mine.familyId),
		]),
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

export const myTripEvents = spacetimedb.view(
	{ name: "my_trip_events", public: true },
	t.array(tripEvent.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.tripEvent, (m, e) => m.familyId.eq(e.familyId)),
);

// Only for families where the caller holds `health_records` now (#26).
export const myMealFacts = spacetimedb.view(
	{ name: "my_meal_facts", public: true },
	t.array(mealFact.rowType),
	(ctx) =>
		careReader(ctx, (familyId) => ctx.db.mealFact.familyId.filter(familyId)),
);

export const myMedicineMemory = spacetimedb.view(
	{ name: "my_medicine_memory", public: true },
	t.array(medicineMemory.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.medicineMemory, (m, r) =>
				m.familyId.eq(r.familyId),
			),
);

export const myMedicineSightings = spacetimedb.view(
	{ name: "my_medicine_sightings", public: true },
	t.array(medicineSighting.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.medicineSighting, (m, s) =>
				m.familyId.eq(s.familyId),
			),
);

export const myContactLadders = spacetimedb.view(
	{ name: "my_contact_ladders", public: true },
	t.array(contactLadder.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.contactLadder, (m, l) =>
				m.familyId.eq(l.familyId),
			),
);

export const myCareNeeds = spacetimedb.view(
	{ name: "my_care_needs", public: true },
	t.array(careNeed.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.careNeed, (m, n) => m.familyId.eq(n.familyId)),
);

export const myContactAttempts = spacetimedb.view(
	{ name: "my_contact_attempts", public: true },
	t.array(contactAttempt.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.contactAttempt, (m, a) =>
				m.familyId.eq(a.familyId),
			),
);

export const myReminderSettings = spacetimedb.view(
	{ name: "my_reminder_settings", public: true },
	t.array(reminderSettings.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.reminderSettings, (m, s) =>
				m.familyId.eq(s.familyId),
			),
);

export const myReminders = spacetimedb.view(
	{ name: "my_reminders", public: true },
	t.array(reminder.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.reminder, (m, r) => m.familyId.eq(r.familyId)),
);

export const myReminderOccurrences = spacetimedb.view(
	{ name: "my_reminder_occurrences", public: true },
	t.array(reminderOccurrence.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.reminderOccurrence, (m, o) =>
				m.familyId.eq(o.familyId),
			),
);

export const myReminderEvents = spacetimedb.view(
	{ name: "my_reminder_events", public: true },
	t.array(reminderEvent.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.reminderEvent, (m, e) =>
				m.familyId.eq(e.familyId),
			),
);

// Shares to the caller that let the caller see the sharer's location now: the caller also holds
// the `location` care scope (#26) in that family. A revoked share or scope drops out at once.
const visibleShares = (ctx: ViewCtx<InferSchema<typeof spacetimedb>>) =>
	[...ctx.db.locationShare.viewer.filter(ctx.sender)].filter((share) =>
		holdsCareScope(
			ctx.db.careGrantEvent.byFamilyMember.filter([share.familyId, ctx.sender]),
			"location",
		),
	);

// The caller's own locations, and those of people who share theirs with the caller.
export const myLocations = spacetimedb.view(
	{ name: "my_locations", public: true },
	t.array(location.rowType),
	(ctx) => [
		...ctx.db.location.sharer.filter(ctx.sender),
		...visibleShares(ctx).flatMap((share) => [
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

// The caller's own home settings. Nobody else reads a home position.
export const myHomeWatch = spacetimedb.view(
	{ name: "my_home_watch", public: true },
	t.array(homeWatch.rowType),
	(ctx) => [...ctx.db.homeWatch.sharer.filter(ctx.sender)],
);

// Trip starts and ends: the caller's own, and those of people who share their location with the
// caller, under the rule of `my_locations`. A share shows no event from before it began.
export const myAwayEvents = spacetimedb.view(
	{ name: "my_away_events", public: true },
	t.array(awayEvent.rowType),
	(ctx) => [
		...ctx.db.awayEvent.sharer.filter(ctx.sender),
		...visibleShares(ctx).flatMap((share) =>
			[
				...ctx.db.awayEvent.byFamilySharer.filter([
					share.familyId,
					share.sharer,
				]),
			].filter(
				(event) =>
					event.at.microsSinceUnixEpoch >= share.sharedAt.microsSinceUnixEpoch,
			),
		),
	],
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

export const myExercisePlans = spacetimedb.view(
	{ name: "my_exercise_plans", public: true },
	t.array(exercisePlan.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.exercisePlan, (m, p) =>
				m.familyId.eq(p.familyId),
			),
);

export const myExerciseEvents = spacetimedb.view(
	{ name: "my_exercise_events", public: true },
	t.array(exerciseEvent.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.exerciseEvent, (m, e) =>
				m.familyId.eq(e.familyId),
			),
);

export const mySpeakerSettings = spacetimedb.view(
	{ name: "my_speaker_settings", public: true },
	t.array(speakerSettings.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.speakerSettings, (m, s) =>
				m.familyId.eq(s.familyId),
			),
);

export const myDeliveryEvents = spacetimedb.view(
	{ name: "my_delivery_events", public: true },
	t.array(deliveryEvent.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.deliveryEvent, (m, e) =>
				m.familyId.eq(e.familyId),
			),
);

export const myAppointments = spacetimedb.view(
	{ name: "my_appointments", public: true },
	t.array(appointment.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.appointment, (m, a) => m.familyId.eq(a.familyId)),
);

export const myClinicianShares = spacetimedb.view(
	{ name: "my_clinician_shares", public: true },
	t.array(clinicianShare.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.clinicianShare, (m, s) =>
				m.familyId.eq(s.familyId),
			),
);

// Like the care profile, only for families where the caller holds `health_records` now.
export const myCookingProfiles = spacetimedb.view(
	{ name: "my_cooking_profiles", public: true },
	t.array(cookingProfile.rowType),
	(ctx) =>
		careReader(ctx, (familyId) => {
			const row = ctx.db.cookingProfile.familyId.find(familyId);
			return row === null ? [] : [row];
		}),
);

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A queued send older than this lost its server, so a member may send again.
const EMAIL_STALE_MS = 2 * 60_000;

export const setReportEmailSettings = spacetimedb.reducer(
	{ familyId: t.u64(), enabled: t.bool(), recipient: t.string() },
	(ctx, settings) => {
		requireMember(ctx, settings.familyId);
		const mine = ctx.db.careGrantEvent.byFamilyMember.filter([
			settings.familyId,
			ctx.sender,
		]);
		if (
			!holdsCareScope(mine, "family_access") &&
			!maySetUpSharing(ctx, settings.familyId)
		)
			throw new SenderError("no care access: family_access");
		if (
			(settings.enabled || settings.recipient !== "") &&
			!(
				settings.recipient.length <= 254 &&
				EMAIL_ADDRESS.test(settings.recipient)
			)
		)
			throw new SenderError("recipient must be an email address");
		const row = {
			...settings,
			updatedBy: ctx.sender,
			updatedAt: ctx.timestamp,
		};
		if (ctx.db.reportEmailSettings.familyId.find(settings.familyId) === null)
			ctx.db.reportEmailSettings.insert(row);
		else ctx.db.reportEmailSettings.familyId.update(row);
	},
);

// Queues an email of a reviewed report to the family's address. An automatic send happens at most
// once per report and only while the setting is on; otherwise it does nothing.
export const queueReportEmail = spacetimedb.reducer(
	{ reportId: t.string(), sendId: t.string(), automatic: t.bool() },
	(ctx, { reportId, sendId, automatic }) => {
		const found = requireReport(ctx, reportId);
		requireText("sendId", sendId);
		if (found.reviewedAt === undefined)
			throw new SenderError("review the report before you email it");
		const settings = ctx.db.reportEmailSettings.familyId.find(found.familyId);
		const existing = ctx.db.reportEmail.reportId.find(reportId);
		if (automatic && (settings?.enabled !== true || existing !== null)) return;
		if (settings === null || settings.recipient === "")
			throw new SenderError("set a report email address in Settings first");
		if (
			existing?.status === "queued" &&
			toMs(ctx.timestamp) - toMs(existing.updatedAt) < EMAIL_STALE_MS
		)
			throw new SenderError("this report email is already being sent");
		const row = {
			reportId,
			familyId: found.familyId,
			sendId,
			recipient: settings.recipient,
			status: "queued",
			reason: undefined,
			automatic,
			requestedBy: ctx.sender,
			updatedAt: ctx.timestamp,
		};
		if (existing === null) ctx.db.reportEmail.insert(row);
		else ctx.db.reportEmail.reportId.update(row);
	},
);

// Records the result of the queued attempt `sendId`. A failure carries its reason.
export const settleReportEmail = spacetimedb.reducer(
	{ reportId: t.string(), sendId: t.string(), failure: t.option(t.string()) },
	(ctx, { reportId, sendId, failure }) => {
		const row = ctx.db.reportEmail.reportId.find(reportId);
		if (row === null) throw new SenderError("not a member of this family");
		requireMember(ctx, row.familyId);
		if (row.sendId !== sendId || row.status !== "queued") return;
		ctx.db.reportEmail.reportId.update({
			...row,
			status: failure === undefined ? "sent" : "failed",
			reason: failure,
			updatedAt: ctx.timestamp,
		});
	},
);

// Onboarding: one-time join codes and the family's WHOOP push token.
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INVITE_MAX_MICROS = 7n * 24n * 3_600n * 1_000_000n;

export const createFamilyInvite = spacetimedb.reducer(
	{ familyId: t.u64(), codeHash: t.string(), expiresAt: t.timestamp() },
	(ctx, { familyId, codeHash, expiresAt }) => {
		requireMember(ctx, familyId);
		if (!SHA256_HEX.test(codeHash))
			throw new SenderError("codeHash must be 64 lowercase hex characters");
		// The server's clock may run slightly ahead of the database's.
		const ahead =
			expiresAt.microsSinceUnixEpoch - ctx.timestamp.microsSinceUnixEpoch;
		if (ahead <= 0n || ahead > INVITE_MAX_MICROS + MAX_CLOCK_AHEAD_MICROS)
			throw new SenderError("expiresAt must be within the next 7 days");
		ctx.db.familyInvite.insert({
			codeHash,
			familyId,
			createdBy: ctx.sender,
			createdAt: ctx.timestamp,
			expiresAt,
			usedBy: undefined,
			usedAt: undefined,
		});
	},
);

export const myReportEmailSettings = spacetimedb.view(
	{ name: "my_report_email_settings", public: true },
	t.array(reportEmailSettings.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.reportEmailSettings, (m, s) =>
				m.familyId.eq(s.familyId),
			),
);

export const myReportEmails = spacetimedb.view(
	{ name: "my_report_emails", public: true },
	t.array(reportEmail.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.reportEmail, (m, e) => m.familyId.eq(e.familyId)),
);

// A member who joins again succeeds (a reloaded join page) and leaves the invite unchanged.
export const joinFamilyByInvite = spacetimedb.reducer(
	{ codeHash: t.string() },
	(ctx, { codeHash }) => {
		const invalid = new SenderError("this invite is unknown, used, or expired");
		const invite = ctx.db.familyInvite.codeHash.find(codeHash);
		if (invite === null) throw invalid;
		const rows = ctx.db.familyMember.byFamilyMember.filter([
			invite.familyId,
			ctx.sender,
		]);
		if (!rows.next().done) return;
		if (
			invite.usedAt !== undefined ||
			invite.expiresAt.microsSinceUnixEpoch <=
				ctx.timestamp.microsSinceUnixEpoch
		)
			throw invalid;
		addMemberIfAbsent(ctx, invite.familyId, ctx.sender);
		ctx.db.familyInvite.codeHash.update({
			...invite,
			usedBy: ctx.sender,
			usedAt: ctx.timestamp,
		});
	},
);

// Same gate as `setCareGrant`: a `family_access` holder, or the founder of a new family. The new
// token revokes the old one, and the ingest identity becomes a member with no care grants.
export const setFamilyPushToken = spacetimedb.reducer(
	{ familyId: t.u64(), tokenHash: t.string(), ingest: t.identity() },
	(ctx, { familyId, tokenHash, ingest }) => {
		requireMember(ctx, familyId);
		const mine = ctx.db.careGrantEvent.byFamilyMember.filter([
			familyId,
			ctx.sender,
		]);
		if (
			!holdsCareScope(mine, "family_access") &&
			!maySetUpSharing(ctx, familyId)
		)
			throw new SenderError("no care access: family_access");
		if (!SHA256_HEX.test(tokenHash))
			throw new SenderError("tokenHash must be 64 lowercase hex characters");
		const row = {
			familyId,
			tokenHash,
			ingest,
			createdBy: ctx.sender,
			createdAt: ctx.timestamp,
		};
		if (ctx.db.familyPushToken.familyId.find(familyId) === null)
			ctx.db.familyPushToken.insert(row);
		else ctx.db.familyPushToken.familyId.update(row);
		addMemberIfAbsent(ctx, familyId, ingest);
	},
);

// Invites of the caller's families, so a joiner finds the family of the code they used.
export const myFamilyInvites = spacetimedb.view(
	{ name: "my_family_invites", public: true },
	t.array(familyInvite.rowType),
	(ctx) =>
		ctx.from.familyMember
			.where((m) => m.member.eq(ctx.sender))
			.rightSemijoin(ctx.from.familyInvite, (m, i) =>
				m.familyId.eq(i.familyId),
			),
);

// The push tokens that name the caller as their ingest identity. Empty for family members.
export const myPushTokens = spacetimedb.view(
	{ name: "my_push_tokens", public: true },
	t.array(t.object("PushToken", { familyId: t.u64(), tokenHash: t.string() })),
	(ctx) =>
		[...ctx.db.familyPushToken.ingest.filter(ctx.sender)].map(
			({ familyId, tokenHash }) => ({ familyId, tokenHash }),
		),
);

// Any member may rename the family; the id, members, and records stay as they are.
export const renameFamily = spacetimedb.reducer(
	{ familyId: t.u64(), name: t.string() },
	(ctx, { familyId, name }) => {
		requireMember(ctx, familyId);
		requireText("name", name);
		const found = ctx.db.family.id.find(familyId);
		if (found === null) throw new SenderError("not a member of this family");
		ctx.db.family.id.update({ ...found, name });
	},
);

/**
 * Deletes a family and every row it owns, for good. Only a `family_access` holder may, and only
 * with the family's exact name, so a wrong id deletes nothing. The server deletes the family's
 * stored files first. `familyDeletion` records who did it and when.
 */
export const deleteFamily = spacetimedb.reducer(
	{ familyId: t.u64(), name: t.string() },
	(ctx, { familyId, name }) => {
		requireCareScope(ctx, familyId, "family_access");
		if (ctx.db.family.id.find(familyId)?.name !== name)
			throw new SenderError("the name does not match this family");
		const { db } = ctx;
		// Rows keyed by another table's id go first, while those ids can still be read.
		const ids = (rows: Iterable<{ id: bigint }>) =>
			new Set([...rows].map((row) => row.id));
		const alerts = ids(db.alert.familyId.filter(familyId));
		const needs = ids(db.careNeed.familyId.filter(familyId));
		const occurrences = ids(db.reminderOccurrence.familyId.filter(familyId));
		// ponytail: full scans of these key-only tables; index them if they grow large.
		for (const row of [...db.thresholdTrigger.iter()])
			if (alerts.has(row.alertId)) db.thresholdTrigger.key.delete(row.key);
		for (const row of [...db.ladderTimer.iter()])
			if (needs.has(row.needId))
				db.ladderTimer.scheduledId.delete(row.scheduledId);
		for (const row of [...db.reminderTimer.iter()])
			if (occurrences.has(row.occurrenceId))
				db.reminderTimer.scheduledId.delete(row.scheduledId);
		// The key starts with the occurrence id (`seenRequest`).
		for (const row of [...db.reminderRequest.iter()])
			if (occurrences.has(BigInt(row.key.slice(0, row.key.indexOf(":")))))
				db.reminderRequest.key.delete(row.key);
		for (const index of [
			db.familyMember.familyId,
			db.healthSample.familyId,
			db.alert.familyId,
			db.message.familyId,
			db.acknowledgement.familyId,
			db.alertThreshold.familyId,
			db.alertDelivery.familyId,
			db.report.familyId,
			db.finchnodeLink.familyId,
			db.tripEvent.familyId,
			db.location.familyId,
			db.locationShare.familyId,
			db.homeWatch.familyId,
			db.awayEvent.familyId,
			db.mealFact.familyId,
			db.medicineMemory.familyId,
			db.medicineSighting.familyId,
			db.contactLadder.familyId,
			db.careNeed.familyId,
			db.contactAttempt.familyId,
			db.reminderSettings.familyId,
			db.reminder.familyId,
			db.reminderOccurrence.familyId,
			db.reminderEvent.familyId,
			db.speakerSettings.familyId,
			db.careProfileVersion.familyId,
			db.careInstruction.familyId,
			db.careGrantEvent.familyId,
			db.exercisePlan.familyId,
			db.exerciseEvent.familyId,
			db.deliveryEvent.familyId,
			db.appointment.familyId,
			db.clinicianShare.familyId,
			db.cookingProfile.familyId,
			db.reportEmailSettings.familyId,
			db.reportEmail.familyId,
			db.familyInvite.familyId,
			db.familyPushToken.familyId,
		])
			index.delete(familyId);
		db.family.id.delete(familyId);
		db.familyDeletion.insert({
			id: 0n,
			familyId,
			deletedBy: ctx.sender,
			deletedAt: ctx.timestamp,
		});
	},
);
