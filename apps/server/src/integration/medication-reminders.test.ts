// Proves the medication path through the real server and the real SpacetimeDB: a new user signs in,
// creates a family, turns on medicine memory, checks a picture of the medicine (Gemini is a fake
// that returns one labelled box), remembers where it was seen, sets up the medication instruction,
// then saves reminder settings, creates a medication reminder, acknowledges one occurrence and
// snoozes the other, and a second family member reads the same states. Only Gemini and the OIDC
// issuer are fake. All records are synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import {
	CareAccess,
	CareInstructions,
	type NewCareInstruction,
} from "@health/contracts/care-profile";
import { MedicineMemory } from "@health/contracts/medicine-memory";
import {
	Reminder,
	ReminderHistory,
	type ReminderInput,
	ReminderOccurrenceDetail,
	ReminderSettings,
	Reminders,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import {
	type ObjectDetectionRequest,
	ObjectDetections,
} from "@health/contracts/vision";
import { GEMINI_VISION_MODEL } from "../integrations/gemini";
import {
	addMember,
	createFamily,
	errorOf,
	integration,
	json,
	startIntegration,
	type User,
} from "./harness";

const it = integration ? await startIntegration() : undefined;
const harness = () => {
	if (it === undefined) throw new Error("integration is off");
	return it;
};

// A 640 × 480 PNG header: the server reads only the size before it sends the image to Gemini.
const png = Buffer.alloc(24);
png.write("89504e470d0a1a0a0000000d49484452", "hex");
png.writeUInt32BE(640, 16);
png.writeUInt32BE(480, 20);

const LABEL = "Synthetic Lisinopril";
// `HH:MM` in UTC, 2 and 4 hours from now: no prompt is due while the test runs.
const times = [2, 4].map((hours) =>
	new Date(Date.now() + hours * 3_600_000).toISOString().slice(11, 16),
);
const settings: ReminderSettings = {
	timeZone: "UTC",
	quietHours: null,
	repeatEveryMinutes: 15,
	maxPrompts: 3,
	snoozeMinutes: 30,
};
const instruction: NewCareInstruction = {
	kind: "medication",
	name: LABEL,
	instruction: "1 tablet by mouth",
	times,
	reason: null,
	source: "pharmacy label",
	effectiveDate: new Date().toISOString().slice(0, 10),
};

describe.skipIf(!integration)("medication reminders", () => {
	let owner: User;
	let member: User;
	let family: { id: string; path: string };
	let detections: ObjectDetections;
	let instructionId: string;
	let reminder: Reminder;
	let acknowledged: ReminderOccurrenceDetail;
	let snoozed: ReminderOccurrenceDetail;

	beforeAll(async () => {
		const { signIn } = harness();
		const run = crypto.randomUUID();
		owner = await signIn(`medication-owner-${run}`);
		member = await signIn(`medication-member-${run}`);
		family = await createFamily(owner, "Medication");
	});

	test("the creator turns on medicine memory and reads it back", async () => {
		const places = ["kitchen counter", "bedside table"];
		const saved = await json(
			MedicineMemory,
			await owner.call("PUT", `${family.path}/medicine-memory`, {
				enabled: true,
				places,
			}),
		);
		expect(saved.permission).toMatchObject({ places, setBy: owner.identity });
		const reread = await json(
			MedicineMemory,
			await owner.call("GET", `${family.path}/medicine-memory`),
		);
		expect(reread).toEqual(saved);
	});

	test("a picture check finds the labelled container through Gemini", async () => {
		const { providers, calls } = harness();
		providers.gemini = (request) =>
			new URL(request.url).pathname === "/v1beta/interactions"
				? Response.json({
						status: "completed",
						steps: [
							{
								type: "model_output",
								content: [
									{
										type: "text",
										text: JSON.stringify({
											detections: [
												{
													box_2d: [100, 200, 500, 400],
													category: "medicine",
													label: LABEL,
													label_readable: true,
													confidence: 0.92,
												},
											],
										}),
									},
								],
							},
						],
					})
				: undefined;
		const frame = {
			id: "frame-1",
			capturedAt: new Date().toISOString(),
			width: 640,
			height: 480,
			crop: { x: 0, y: 0, width: 640, height: 480 },
			rotation: 0,
		} as const;
		const image = { type: "image/png", data: png.toString("base64") } as const;
		detections = await json(
			ObjectDetections,
			await owner.call("POST", `${family.path}/vision/object-detections`, {
				frame,
				image,
			} satisfies ObjectDetectionRequest),
		);
		expect(detections.frame).toEqual(frame);
		expect(detections.model).toBe(GEMINI_VISION_MODEL);
		expect(detections.detections).toEqual([
			{
				category: "medicine",
				label: LABEL,
				confidence: 0.92,
				needsVerification: false,
				box: { x: 128, y: 48, width: 128, height: 192 },
			},
		]);
		const sent = calls.filter((c) => c.path === "/v1beta/interactions");
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
			model: GEMINI_VISION_MODEL,
			store: false,
			input: [
				{ type: "text" },
				{ type: "image", mime_type: image.type, data: image.data },
			],
		});
	});

	test("the creator remembers where the found container is; a re-read keeps it", async () => {
		const [found] = detections.detections;
		expect(found).toBeDefined();
		if (found === undefined) return;
		const sighting = {
			container: LABEL,
			place: "kitchen counter, by the kettle",
			seenAt: detections.frame.capturedAt,
			source: "camera_check",
			confidence: found.confidence,
			labelRead: found.label !== null,
		} as const;
		const saved = await json(
			MedicineMemory,
			await owner.call(
				"POST",
				`${family.path}/medicine-memory/sightings`,
				sighting,
			),
		);
		const { seenAt, ...rest } = sighting;
		expect(saved.sightings).toEqual([
			expect.objectContaining({
				...rest,
				familyId: family.id,
				savedBy: owner.identity,
				notFoundAt: null,
			}),
		]);
		// The database stores microseconds, so the same instant may come back with more digits.
		expect(Date.parse(saved.sightings[0]?.seenAt ?? "")).toBe(
			Date.parse(seenAt),
		);
		const reread = await json(
			MedicineMemory,
			await owner.call("GET", `${family.path}/medicine-memory`),
		);
		expect(reread.sightings).toEqual(saved.sightings);
	});

	// #188: a new family's founder holds every care scope from the start.
	test("the creator adds a medication instruction to the family's plan", async () => {
		// Its own name, so the instruction the reminder uses below never depends on this test.
		const first = { ...instruction, name: "Synthetic Metformin" };
		const added = await owner.call(
			"POST",
			`${family.path}/care-instructions`,
			first,
		);
		expect(added.status).toBe(204);
		const plan = await json(
			CareInstructions,
			await owner.call("GET", `${family.path}/care-instructions`),
		);
		expect(plan.instructions.find((i) => i.name === first.name)).toMatchObject(
			first,
		);
	});

	test("after the founder grants their own care scopes, they add and verify the instruction", async () => {
		for (const scope of ["health_records", "care_plan_edit"] as const) {
			const granted = await owner.call("POST", `${family.path}/care-access`, {
				identity: owner.identity,
				scope,
				granted: true,
			});
			expect(granted.status).toBe(204);
		}
		const access = await json(
			CareAccess,
			await owner.call("GET", `${family.path}/care-access`),
		);
		expect(access.mine).toEqual(
			expect.arrayContaining(["care_plan_edit", "health_records"]),
		);

		const added = await owner.call(
			"POST",
			`${family.path}/care-instructions`,
			instruction,
		);
		expect(added.status).toBe(204);
		const unverified = (
			await json(
				CareInstructions,
				await owner.call("GET", `${family.path}/care-instructions`),
			)
		).instructions.find((i) => i.name === instruction.name);
		expect(unverified).toMatchObject({
			...instruction,
			verification: "unverified",
		});
		instructionId = unverified?.id ?? "";

		const verified = await owner.call(
			"POST",
			`${family.path}/care-instructions/${instructionId}/verify`,
		);
		expect(verified.status).toBe(204);
		const plan = await json(
			CareInstructions,
			await owner.call("GET", `${family.path}/care-instructions`),
		);
		expect(plan.instructions.find((i) => i.id === instructionId)).toMatchObject(
			{
				verification: "verified",
				verifiedBy: owner.identity,
			},
		);
	});

	test("reminder settings come first, then save and read back", async () => {
		const empty = await json(
			SavedReminderSettings,
			await owner.call("GET", `${family.path}/reminder-settings`),
		);
		expect(empty.settings).toBeNull();
		expect(
			await errorOf(
				await owner.call("POST", `${family.path}/reminders`, {
					kind: "medication",
					subjectId: null,
					title: "Too early",
					times,
				} satisfies ReminderInput),
			),
		).toEqual([409, "conflict"]);

		const saved = await json(
			ReminderSettings,
			await owner.call("PUT", `${family.path}/reminder-settings`, settings),
		);
		expect(saved).toEqual(settings);
		const reread = await json(
			SavedReminderSettings,
			await owner.call("GET", `${family.path}/reminder-settings`),
		);
		expect(reread.settings).toEqual(settings);
	});

	test("a medication reminder schedules one occurrence per time", async () => {
		const input: ReminderInput = {
			kind: "medication",
			subjectId: instructionId,
			title: `${LABEL}, 1 tablet`,
			times,
		};
		const created = await owner.call("POST", `${family.path}/reminders`, input);
		expect(created.status).toBe(201);
		reminder = await json(Reminder, created);
		expect(reminder).toMatchObject({
			...input,
			familyId: family.id,
			createdBy: owner.identity,
		});
		const saved = await json(
			Reminders,
			await owner.call("GET", `${family.path}/reminders`),
		);
		expect(saved.reminders).toEqual([reminder]);

		const occurrences = await ownOccurrences(owner);
		expect(occurrences).toHaveLength(2);
		for (const { occurrence, events } of occurrences) {
			expect(occurrence).toMatchObject({
				kind: "medication",
				subjectId: instructionId,
				title: input.title,
				state: "scheduled",
				promptDue: false,
				prompts: 0,
			});
			expect(Date.parse(occurrence.scheduledFor)).toBeGreaterThan(Date.now());
			expect(events.map((e) => [e.state, e.actor])).toEqual([
				["scheduled", "scheduler"],
			]);
		}
		expect(
			occurrences.map((o) => o.occurrence.scheduledFor.slice(11, 16)).sort(),
		).toEqual([...times].sort());
	});

	test("the wearer acknowledges one occurrence and snoozes the other; a re-read keeps both", async () => {
		const [first, second] = await ownOccurrences(owner);
		expect(second).toBeDefined();
		if (first === undefined || second === undefined) return;
		acknowledged = await json(
			ReminderOccurrenceDetail,
			await owner.call(
				"POST",
				`${family.path}/reminder-occurrences/${first.occurrence.id}/answers`,
				{
					clientId: crypto.randomUUID(),
					source: "web",
					response: "okay",
					wording: "Okay, I see it",
				},
			),
		);
		expect(acknowledged.occurrence.state).toBe("acknowledged");
		// Seen is not done: follow-up prompts stay scheduled.
		expect(acknowledged.occurrence.nextPromptAt).toBe(
			first.occurrence.nextPromptAt,
		);
		expect(acknowledged.events.at(-1)).toMatchObject({
			state: "acknowledged",
			response: "okay",
			actor: owner.identity,
			source: "web",
			wording: "Okay, I see it",
		});

		const before = Date.now();
		snoozed = await json(
			ReminderOccurrenceDetail,
			await owner.call(
				"POST",
				`${family.path}/reminder-occurrences/${second.occurrence.id}/answers`,
				{
					clientId: crypto.randomUUID(),
					source: "web",
					response: "later",
					wording: "Later",
				},
			),
		);
		expect(snoozed.occurrence).toMatchObject({ state: "deferred", prompts: 0 });
		const next = Date.parse(snoozed.occurrence.nextPromptAt ?? "");
		expect(next).toBeGreaterThanOrEqual(
			before + (settings.snoozeMinutes - 1) * 60_000,
		);
		expect(next).toBeLessThanOrEqual(
			Date.now() + (settings.snoozeMinutes + 1) * 60_000,
		);
		expect(snoozed.events.at(-1)).toMatchObject({
			state: "deferred",
			response: "later",
			actor: owner.identity,
		});

		for (const detail of [acknowledged, snoozed])
			expect(
				await json(
					ReminderOccurrenceDetail,
					await owner.call(
						"GET",
						`${family.path}/reminder-occurrences/${detail.occurrence.id}`,
					),
				),
			).toEqual(detail);
	});

	test("a second family member sees the acknowledged and snoozed states, not the owner's medicine", async () => {
		await addMember(owner, family.path, member);
		const seen = await ownOccurrences(member);
		expect(seen).toEqual(
			expect.arrayContaining(
				[acknowledged, snoozed].map((d) => expect.objectContaining(d)),
			),
		);
		expect(seen).toHaveLength(2);
		const memory = await json(
			MedicineMemory,
			await member.call("GET", `${family.path}/medicine-memory`),
		);
		expect(memory).toMatchObject({
			personId: member.identity,
			people: [member.identity],
			sightings: [],
		});
		expect(
			await errorOf(
				await member.call(
					"GET",
					`${family.path}/medicine-memory?person=${owner.identity}`,
				),
			),
		).toEqual([403, "forbidden"]);
	});

	/** This reminder's occurrences as `user` reads them, soonest first. */
	const ownOccurrences = async (user: User) =>
		(
			await json(
				ReminderHistory,
				await user.call("GET", `${family.path}/reminder-occurrences`),
			)
		).occurrences
			.filter((d) => d.occurrence.reminderId === reminder.id)
			.sort((a, b) =>
				a.occurrence.scheduledFor.localeCompare(b.occurrence.scheduledFor),
			);
});
