// Onboarding screens 2 and 3 (.lavish/onboarding-plan.html#wf-2, #wf-3). A field is pre-filled only
// from a real source, and it names that source; "Set up by hand" pre-fills nothing.
import { Family } from "@health/contracts";
import { CareAccess, CareProfileRecord } from "@health/contracts/care-profile";
import type { Me } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { apiRequest, familyPath } from "@/lib/api";
import { useFamily } from "@/lib/family";

import { checklistKey } from "./checklist";
import { failureText, inviteCode } from "./logic";

export type Mode = "seeded" | "hand";

const field = "win95-inset win95-field h-11 w-full bg-card px-2";
const seededClass = "border-l-4 border-[#006400] pl-1.5";

/** The small "source: …" line under a seeded value. */
export function Source({ children }: { children: string }) {
	return (
		<small className="text-xs">
			<b>source:</b> {children}
		</small>
	);
}

/** Every IANA zone this browser knows, with `current` kept even when the list lacks it. */
export function TimeZoneSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (zone: string) => void;
}) {
	// Older browsers lack the list; they still show "Not set" and the current zone.
	const zones =
		typeof Intl.supportedValuesOf === "function"
			? Intl.supportedValuesOf("timeZone")
			: [];
	return (
		<select
			id={id}
			className={field}
			value={value}
			onChange={(event) => onChange(event.target.value)}
		>
			<option value="">Not set</option>
			{value !== "" && !zones.includes(value) && (
				<option value={value}>{value}</option>
			)}
			{zones.map((zone) => (
				<option key={zone} value={zone}>
					{zone}
				</option>
			))}
		</select>
	);
}

/** Screen 2: the Google profile greeting and the three ways in. */
export function WelcomeScreen({
	me,
	onStart,
}: {
	me: Me;
	onStart: (mode: Mode) => void;
}) {
	const navigate = useNavigate();
	const [joining, setJoining] = useState(false);
	const [pasted, setPasted] = useState("");
	const [error, setError] = useState<string | null>(null);
	const name = me.givenName ?? me.name;
	return (
		<div className="grid gap-3 p-2">
			<div
				className={`flex items-center gap-2 ${name !== null || me.picture !== null ? seededClass : ""}`}
			>
				{me.picture === null ? (
					<div aria-hidden className="win95-inset size-10 shrink-0 bg-card" />
				) : (
					<img
						alt="Your Google profile"
						className="size-10 shrink-0"
						referrerPolicy="no-referrer"
						src={me.picture}
					/>
				)}
				<div className="grid">
					<b className="text-base">{name === null ? "Hi" : `Hi ${name}`}</b>
					{(name !== null || me.picture !== null) && (
						<Source>Google profile</Source>
					)}
				</div>
			</div>
			<p>Are you setting up Telly for someone, or joining a family?</p>
			<Button
				type="button"
				className="win95-primary grid h-auto min-h-11 w-full py-2"
				onClick={() => onStart("seeded")}
			>
				Start with real data
				<small className="font-normal">
					We fill in what we can from real sources. You check each one.
				</small>
			</Button>
			<Button
				type="button"
				className="h-11 w-full"
				onClick={() => onStart("hand")}
			>
				Set up by hand
			</Button>
			<Button
				type="button"
				className="h-11 w-full"
				aria-expanded={joining}
				onClick={() => setJoining(!joining)}
			>
				I have an invite link
			</Button>
			{joining && (
				<form
					className="grid gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						const code = inviteCode(pasted);
						if (code === null)
							return setError("Paste the whole link or the code.");
						void navigate({ to: "/join/$code", params: { code } });
					}}
				>
					<label htmlFor="invite-link" className="font-bold">
						Invite link or code
					</label>
					<input
						id="invite-link"
						className={field}
						value={pasted}
						onChange={(event) => setPasted(event.target.value)}
					/>
					{error !== null && <p role="alert">{error}</p>}
					<Button type="submit" className="h-11 w-full">
						Open invite
					</Button>
				</form>
			)}
		</div>
	);
}

const FOUNDER_SCOPES = [
	"family_access",
	"health_records",
	"care_plan_edit",
] as const;

/** Gives the founder each care plan permission they do not hold yet. */
async function grantFounderScopes(
	familyId: string,
	identity: Me["identity"],
): Promise<string | null> {
	const path = familyPath(familyId, "/care-access");
	const access = await apiRequest(CareAccess, path);
	if (access.kind !== "ready") return failureText(access);
	for (const scope of FOUNDER_SCOPES) {
		if (access.value.mine.includes(scope)) continue;
		const grant = await apiRequest(null, path, {
			method: "POST",
			body: { identity, scope, granted: true },
		});
		if (grant.kind !== "ready") return failureText(grant);
	}
	return null;
}

/** Saves the name, time zone, and language; every other field keeps what the profile holds. */
async function saveProfile(
	familyId: string,
	fields: {
		preferredName: string;
		timeZone: string | null;
		language: string | null;
	},
): Promise<string | null> {
	const path = familyPath(familyId, "/care-profile");
	const record = await apiRequest(CareProfileRecord, path);
	if (record.kind !== "ready") return failureText(record);
	const saved = await apiRequest(null, path, {
		method: "PUT",
		body: { ...record.value.profile, ...fields },
	});
	return saved.kind === "ready" ? null : failureText(saved);
}

/** A field that holds a value from this device, marked and sourced while it still holds that seed. */
function DeviceField({
	value,
	seed,
	children,
}: {
	value: string;
	seed: string;
	children: ReactNode;
}) {
	const seeded = value !== "" && value === seed;
	return (
		<div className={`grid gap-1 ${seeded ? seededClass : ""}`}>
			{children}
			{seeded && <Source>this device</Source>}
		</div>
	);
}

/** A form whose submit button runs `save`, shows "Saving…" meanwhile, and then its refusal. */
export function SaveForm({
	label,
	ready,
	save,
	className,
	"aria-label": ariaLabel,
	children,
}: {
	label: string;
	ready: boolean;
	/** Resolves to the refusal text, or null when saved. */
	save: () => Promise<string | null>;
	className: string;
	"aria-label"?: string;
	children: ReactNode;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<form
			aria-label={ariaLabel}
			className={className}
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				const refused = await save();
				setBusy(false);
				setError(refused);
			}}
		>
			{children}
			{error !== null && <p role="alert">{error}</p>}
			<Button
				type="submit"
				className="win95-primary h-11 w-full"
				disabled={busy || !ready}
			>
				{busy ? "Saving…" : label}
			</Button>
		</form>
	);
}

/**
 * Screen 3: creates the family, gives its founder the care plan permissions (as the Care plan's
 * "Set up sharing" does), and saves the name, time zone, and language into the care profile.
 */
export function WhoScreen({
	me,
	mode,
	onDone,
}: {
	me: Me;
	mode: Mode;
	onDone: (family: Family) => void;
}) {
	const { select, reload } = useFamily();
	const seeded = mode === "seeded";
	const [seed] = useState(() =>
		seeded
			? {
					zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					language: navigator.language,
				}
			: { zone: "", language: "" },
	);
	const [name, setName] = useState("");
	const [familyName, setFamilyName] = useState<string | null>(null);
	const [zone, setZone] = useState(seed.zone);
	const [language, setLanguage] = useState(seed.language);
	const [created, setCreated] = useState<Family | null>(null);
	// Built from the typed name until the user edits it; "by hand" builds nothing.
	const family =
		familyName ??
		(seeded && name.trim() !== "" ? `${name.trim()}'s family` : "");
	const you = [me.name, me.email].filter((v) => v !== null).join(" · ");

	const save = async (): Promise<string | null> => {
		let made = created;
		if (made === null) {
			const result = await apiRequest(Family, "/api/families", {
				method: "POST",
				body: { name: family.trim() },
			});
			if (result.kind !== "ready") return failureText(result);
			made = result.value;
			setCreated(made);
			localStorage.setItem(checklistKey(made.id), new Date().toISOString());
			select(made.id);
			reload();
		}
		const refused =
			(await grantFounderScopes(made.id, me.identity)) ??
			(await saveProfile(made.id, {
				preferredName: name.trim(),
				timeZone: zone === "" ? null : zone,
				language: language.trim() === "" ? null : language.trim(),
			}));
		if (refused === null) onDone(made);
		return refused;
	};

	return (
		<SaveForm
			className="grid gap-3 p-2"
			label="Next"
			ready={name.trim() !== "" && family.trim() !== ""}
			save={save}
		>
			<div className="grid gap-1">
				<label htmlFor="who-name">
					<b>Their name</b> (what they like to be called)
				</label>
				<input
					id="who-name"
					className={field}
					required
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>
			<div className="grid gap-1">
				<label htmlFor="who-family" className="font-bold">
					Family name
				</label>
				<input
					id="who-family"
					className={field}
					required
					disabled={created !== null}
					value={family}
					onChange={(event) => setFamilyName(event.target.value)}
				/>
			</div>
			<DeviceField value={zone} seed={seed.zone}>
				<label htmlFor="who-zone" className="font-bold">
					Time zone
				</label>
				<TimeZoneSelect id="who-zone" value={zone} onChange={setZone} />
			</DeviceField>
			<DeviceField value={language} seed={seed.language}>
				<label htmlFor="who-language" className="font-bold">
					Language
				</label>
				<input
					id="who-language"
					className={field}
					placeholder="Not set"
					value={language}
					onChange={(event) => setLanguage(event.target.value)}
				/>
			</DeviceField>
			{seeded && you !== "" && (
				<div className={`grid gap-1 ${seededClass}`}>
					<b>You</b>
					<span className="win95-inset bg-card px-2 py-2">{you}</span>
					<Source>Google profile</Source>
				</div>
			)}
			<p className="text-xs">
				We make {family === "" ? "the family" : `“${family}”`} with you as the
				first member and give you the care plan permissions.
			</p>
		</SaveForm>
	);
}
