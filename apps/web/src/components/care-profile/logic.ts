// The care profile form (#26) as plain text boxes: one item per line. An empty box means unknown;
// the single word "none" means someone confirmed there are none. Never guess between the two.
import { CareProfile } from "@health/contracts/care-profile";
import { Exit, Schema } from "effect";

export type ProfileForm = Record<keyof CareProfile, string>;

const NONE = "none";

const lines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

/** `null` for an empty box, `[]` for "none", otherwise one item per line. */
const known = <T>(text: string, item: (line: string) => T): T[] | null => {
	const items = lines(text);
	if (items.length === 0) return null;
	if (items.length === 1 && items[0]?.toLowerCase() === NONE) return [];
	return items.map(item);
};

/** `a; b; c` → `["a", "b" or null, "c" or null]`. */
const parts = (line: string) => {
	const [first = "", ...rest] = line.split(";").map((part) => part.trim());
	return [first, ...rest.map((part) => (part === "" ? null : part))] as const;
};

const text = (items: readonly string[] | null) =>
	items === null ? "" : items.length === 0 ? NONE : items.join("\n");

const optional = (value: string) => (value.trim() === "" ? null : value.trim());

export const toForm = (profile: CareProfile): ProfileForm => ({
	preferredName: profile.preferredName ?? "",
	language: profile.language ?? "",
	timeZone: profile.timeZone ?? "",
	accessibilityNeeds: text(profile.accessibilityNeeds),
	diagnoses: text(profile.diagnoses),
	allergies: text(profile.allergies),
	dietaryRestrictions: text(profile.dietaryRestrictions),
	fluidRestrictions: text(profile.fluidRestrictions),
	activityRestrictions: text(profile.activityRestrictions),
	routines: text(
		profile.routines?.map((r) =>
			r.time === null ? r.name : `${r.name}; ${r.time}`,
		) ?? null,
	),
	contacts: text(
		profile.contacts?.map((c) =>
			[c.name, c.relationship ?? "", c.phone ?? ""]
				.join("; ")
				.replace(/[; ]+$/, ""),
		) ?? null,
	),
	familiarDestinations: text(
		profile.familiarDestinations?.map((d) =>
			d.address === null ? d.name : `${d.name}; ${d.address}`,
		) ?? null,
	),
	devices: text(profile.devices),
	declinedPrompts: profile.declinedPrompts.join("\n"),
});

/** The profile the form describes, or `null` when a box does not match its format. */
export const fromForm = (form: ProfileForm): CareProfile | null => {
	const decoded = Schema.decodeUnknownExit(CareProfile)({
		preferredName: optional(form.preferredName),
		language: optional(form.language),
		timeZone: optional(form.timeZone),
		accessibilityNeeds: known(form.accessibilityNeeds, String),
		diagnoses: known(form.diagnoses, String),
		allergies: known(form.allergies, String),
		dietaryRestrictions: known(form.dietaryRestrictions, String),
		fluidRestrictions: known(form.fluidRestrictions, String),
		activityRestrictions: known(form.activityRestrictions, String),
		routines: known(form.routines, (line) => {
			const [name, time = null] = parts(line);
			return { name, time };
		}),
		contacts: known(form.contacts, (line) => {
			const [name, relationship = null, phone = null] = parts(line);
			return { name, relationship, phone };
		}),
		familiarDestinations: known(form.familiarDestinations, (line) => {
			const [name, address = null] = parts(line);
			return { name, address };
		}),
		devices: known(form.devices, String),
		declinedPrompts: lines(form.declinedPrompts),
	});
	return Exit.isSuccess(decoded) ? decoded.value : null;
};
