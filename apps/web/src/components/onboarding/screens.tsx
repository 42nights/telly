// Onboarding screens 2 and 3 (.lavish/onboarding-plan.html#wf-2, #wf-3). A field is pre-filled only
// from a real source, and it names that source; "Set up by hand" pre-fills nothing.
import { Family } from "@health/contracts";
import { CareAccess, CareProfileRecord } from "@health/contracts/care-profile";
import type { Me } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { apiRequest, familyPath } from "@/lib/api";
import { useFamily } from "@/lib/family";

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
	const [zoneSeed] = useState(() =>
		seeded ? Intl.DateTimeFormat().resolvedOptions().timeZone : "",
	);
	const [languageSeed] = useState(() => (seeded ? navigator.language : ""));
	const [name, setName] = useState("");
	const [familyName, setFamilyName] = useState<string | null>(null);
	const [zone, setZone] = useState(zoneSeed);
	const [language, setLanguage] = useState(languageSeed);
	const [created, setCreated] = useState<Family | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
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
			select(made.id);
			reload();
		}
		const access = await apiRequest(
			CareAccess,
			familyPath(made.id, "/care-access"),
		);
		if (access.kind !== "ready") return failureText(access);
		for (const scope of FOUNDER_SCOPES) {
			if (access.value.mine.includes(scope)) continue;
			const grant = await apiRequest(
				null,
				familyPath(made.id, "/care-access"),
				{
					method: "POST",
					body: { identity: me.identity, scope, granted: true },
				},
			);
			if (grant.kind !== "ready") return failureText(grant);
		}
		const profilePath = familyPath(made.id, "/care-profile");
		const record = await apiRequest(CareProfileRecord, profilePath);
		if (record.kind !== "ready") return failureText(record);
		// Only these three change; every other field keeps what the profile already holds.
		const saved = await apiRequest(null, profilePath, {
			method: "PUT",
			body: {
				...record.value.profile,
				preferredName: name.trim(),
				timeZone: zone === "" ? null : zone,
				language: language.trim() === "" ? null : language.trim(),
			},
		});
		if (saved.kind !== "ready") return failureText(saved);
		onDone(made);
		return null;
	};

	return (
		<form
			className="grid gap-3 p-2"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				setError(await save());
				setBusy(false);
			}}
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
			<div
				className={`grid gap-1 ${zone !== "" && zone === zoneSeed ? seededClass : ""}`}
			>
				<label htmlFor="who-zone" className="font-bold">
					Time zone
				</label>
				<TimeZoneSelect id="who-zone" value={zone} onChange={setZone} />
				{zone !== "" && zone === zoneSeed && <Source>this device</Source>}
			</div>
			<div
				className={`grid gap-1 ${language !== "" && language === languageSeed ? seededClass : ""}`}
			>
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
				{language !== "" && language === languageSeed && (
					<Source>this device</Source>
				)}
			</div>
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
			{error !== null && <p role="alert">{error}</p>}
			<Button
				type="submit"
				className="win95-primary h-11 w-full"
				disabled={busy || name.trim() === "" || family.trim() === ""}
			>
				{busy ? "Saving…" : "Next"}
			</Button>
		</form>
	);
}
