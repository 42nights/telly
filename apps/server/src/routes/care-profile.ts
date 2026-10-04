// Care profile, care instructions, and per-recipient sharing (#26), mounted at
// `/api/families/:familyId`. The module's views return the profile and instructions only to
// members who hold `health_records`, and its reducers check every grant again, so a revoke stops
// the next read here. The scope checks below only turn an empty view into an honest `403`.
import {
	type CareAccess,
	type CareGrantChange,
	type CareInstruction,
	type CareInstructions,
	CareProfile,
	type CareProfileRecord,
	type CarePrompt,
	type CareScope,
	NewCareGrant,
	NewCareInstruction,
} from "@health/contracts/care-profile";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { Identity } from "spacetimedb";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";

type Ctx = Context<FamilyEnv>;

const ProfileJson = Schema.fromJsonString(CareProfile);

/** Before the first save: everything unknown, nothing declined. */
const unknownProfile: CareProfile = {
	preferredName: null,
	language: null,
	timeZone: null,
	accessibilityNeeds: null,
	diagnoses: null,
	allergies: null,
	dietaryRestrictions: null,
	fluidRestrictions: null,
	activityRestrictions: null,
	routines: null,
	contacts: null,
	familiarDestinations: null,
	devices: null,
	declinedPrompts: [],
};

const newestFirst = (a: { id: bigint }, b: { id: bigint }) =>
	a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

const readAccess = (c: Ctx): CareAccess => {
	const history = [...c.var.db.connection.db.myCareGrants.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort(newestFirst)
		.map(
			(row): CareGrantChange => ({
				identity: row.member.toHexString(),
				// The module accepts only `CareScope` values.
				scope: row.scope as CareScope,
				granted: row.granted,
				changedBy: row.changedBy.toHexString(),
				changedAt: row.changedAt.toISOString(),
			}),
		);
	const latest = new Map<string, CareGrantChange>();
	for (const change of history) {
		const key = `${change.identity}:${change.scope}`;
		if (!latest.has(key)) latest.set(key, change);
	}
	const grants = [...latest.values()].filter((change) => change.granted);
	return {
		mine: grants
			.filter((grant) => grant.identity === c.var.db.identity)
			.map((grant) => grant.scope),
		grants,
		history,
	};
};

/** Answers `forbidden` unless the caller holds `scope` in this family now. Other features reuse it. */
export const requireScope = (c: Ctx, scope: CareScope) => {
	if (!readAccess(c).mine.includes(scope))
		throw new ApiFailure(
			"forbidden",
			`Your care access in this family does not include ${scope}`,
		);
};

export const readProfile = (c: Ctx): CareProfileRecord => {
	requireScope(c, "health_records");
	const versions = [...c.var.db.connection.db.myCareProfiles.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort(newestFirst);
	const current = versions[0];
	return {
		familyId: c.var.familyId.toString(),
		profile:
			current === undefined
				? unknownProfile
				: Schema.decodeUnknownSync(ProfileJson)(current.profile),
		editedBy: current?.editedBy.toHexString() ?? null,
		editedAt: current?.editedAt.toISOString() ?? null,
		history: versions.map((row) => ({
			editedBy: row.editedBy.toHexString(),
			editedAt: row.editedAt.toISOString(),
		})),
	};
};

/**
 * Every version, newest first. Versions of one instruction share kind and name (case-insensitive).
 * The verified version with the highest id is in effect; the module refuses to verify an older one.
 */
export const readInstructions = (c: Ctx, timeZone: string | null) => {
	const rows = [...c.var.db.connection.db.myCareInstructions.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort(newestFirst);
	const keyOf = (row: { kind: string; name: string }) =>
		`${row.kind}:${row.name.toLowerCase()}`;
	const inEffect = new Map<string, bigint>();
	for (const row of rows)
		if (row.verifiedAt !== undefined && !inEffect.has(keyOf(row)))
			inEffect.set(keyOf(row), row.id);
	return rows.map((row): CareInstruction => {
		const current = inEffect.get(keyOf(row));
		return {
			id: row.id.toString(),
			familyId: row.familyId.toString(),
			// The server writes only `NewCareInstruction` values.
			kind: row.kind as CareInstruction["kind"],
			name: row.name,
			instruction: row.instruction,
			times: row.times,
			timeZone,
			reason: row.reason ?? null,
			source: row.source,
			effectiveDate: row.effectiveDate,
			editedBy: row.editedBy.toHexString(),
			editedAt: row.editedAt.toISOString(),
			verification:
				current === undefined
					? "unverified"
					: current === row.id
						? "verified"
						: row.verifiedAt === undefined && row.id > current
							? "conflicting"
							: "stale",
			verifiedBy: row.verifiedBy?.toHexString() ?? null,
			verifiedAt: row.verifiedAt?.toISOString() ?? null,
		};
	});
};

/** The care facts the caller may read, or `null` without `health_records`. */
export const readCareFacts = (c: Ctx) => {
	try {
		const { profile } = readProfile(c);
		return { profile, instructions: readInstructions(c, profile.timeZone) };
	} catch (error) {
		if (error instanceof ApiFailure && error.code === "forbidden") return null;
		throw error;
	}
};

export const listFact = (
	label: string,
	items: readonly string[] | null,
): string =>
	items === null
		? `${label}: unknown.`
		: items.length === 0
			? `${label}: none recorded.`
			: `${label}: ${items.join("; ")}.`;

/** What the wearer hears about instructions: verified text verbatim, otherwise "ask your caregiver". */
const instructionLines = (instructions: readonly CareInstruction[]) => {
	const lines = new Map<string, string>();
	for (const item of instructions) {
		// One line per instruction and state, newest first; stale versions say nothing.
		const key = `${item.verification}:${item.kind}:${item.name.toLowerCase()}`;
		if (lines.has(key) || item.verification === "stale") continue;
		lines.set(
			key,
			item.verification === "verified"
				? `${item.name}: your saved instruction says “${item.instruction}”${item.times.length === 0 ? "" : ` at ${item.times.join(", ")}`}. Source: ${item.source}, from ${item.effectiveDate}.`
				: item.verification === "conflicting"
					? `A change to ${item.name} is not verified yet. Ask your caregiver before you change anything.`
					: `${item.name} is in your plan, but nobody has verified its instruction. Please ask your caregiver.`,
		);
	}
	return lines.size === 0
		? ["Your medicines and care instructions: none saved."]
		: [...lines.values()];
};

/** The wearer's prompt: saved facts and verified instructions only, with unknowns said aloud. */
const carePrompt = (
	profile: CareProfile,
	instructions: readonly CareInstruction[],
): string[] => [
	profile.preferredName === null
		? "Your preferred name is not saved."
		: `Your name: ${profile.preferredName}.`,
	`Your language: ${profile.language ?? "unknown"}.`,
	listFact("Accessibility needs", profile.accessibilityNeeds),
	listFact("Conditions", profile.diagnoses),
	listFact("Allergies", profile.allergies),
	listFact("Food restrictions", profile.dietaryRestrictions),
	listFact("Drink restrictions", profile.fluidRestrictions),
	listFact("Activity restrictions", profile.activityRestrictions),
	listFact(
		"Routines",
		profile.routines?.map((r) =>
			r.time === null ? r.name : `${r.name} at ${r.time}`,
		) ?? null,
	),
	listFact(
		"People to call, in order",
		profile.contacts?.map((p) =>
			p.relationship === null ? p.name : `${p.name} (${p.relationship})`,
		) ?? null,
	),
	listFact(
		"Familiar places",
		profile.familiarDestinations?.map((d) => d.name) ?? null,
	),
	listFact("Your devices", profile.devices),
	...instructionLines(instructions),
	...(profile.declinedPrompts.length === 0
		? []
		: [
				`You chose not to get these reminders: ${profile.declinedPrompts.join(", ")}.`,
			]),
];

const instructionId = (c: Ctx) => {
	const id = c.req.param("instructionId") ?? "";
	if (!/^[0-9]{1,20}$/.test(id))
		throw new ApiFailure("not_found", "No such care instruction");
	return BigInt(id);
};

export const careProfileRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/care-profile", (c) =>
			c.json(readProfile(c) satisfies CareProfileRecord),
		)
		.put("/care-profile", async (c) => {
			const profile = await decodeBody(c, CareProfile);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.saveCareProfile({
					familyId: c.var.familyId,
					profile: Schema.encodeSync(ProfileJson)(profile),
				}),
			);
			return c.body(null, 204);
		})
		.get("/care-profile/prompt", (c) => {
			const { profile } = readProfile(c);
			const lines = carePrompt(profile, readInstructions(c, profile.timeZone));
			return c.json({ lines } satisfies CarePrompt);
		})
		.get("/care-instructions", (c) => {
			const { profile } = readProfile(c);
			return c.json({
				instructions: readInstructions(c, profile.timeZone),
			} satisfies CareInstructions);
		})
		.post("/care-instructions", async (c) => {
			const added = await decodeBody(c, NewCareInstruction);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.addCareInstruction({
					...added,
					times: [...added.times],
					reason: added.reason ?? undefined,
					familyId: c.var.familyId,
				}),
			);
			return c.body(null, 204);
		})
		.post("/care-instructions/:instructionId/verify", async (c) => {
			const id = instructionId(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.verifyCareInstruction({ id }),
			);
			return c.body(null, 204);
		})
		.get("/care-access", (c) => c.json(readAccess(c) satisfies CareAccess))
		.post("/care-access", async (c) => {
			const grant = await decodeBody(c, NewCareGrant);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.setCareGrant({
					familyId: c.var.familyId,
					member: Identity.fromString(grant.identity),
					scope: grant.scope,
					granted: grant.granted,
				}),
			);
			return c.body(null, 204);
		});
