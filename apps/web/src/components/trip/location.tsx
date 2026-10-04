// Shared location display and per-person sharing (issue #40). A location always shows its label,
// accuracy, fix time, and report time; nothing here says the person is safe.
import type { FamilyRecords } from "@health/contracts";
import { IdentityHex } from "@health/contracts/families";
import {
	describeLocation,
	FamilyLocations,
	type SharedLocation,
} from "@health/contracts/location";
import { Button } from "@health/ui/components/button";
import { Schema } from "effect";
import { useState } from "react";

import { clock } from "@/components/family/logic";
import { ApiNotice, Tip } from "@/components/win95";
import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";
import { memberLabel } from "@/lib/members";

import { mapUrl } from "./logic";

const isIdentity = Schema.is(IdentityHex);

/** One person's latest location with its label, accuracy, and times. */
export function LocationCard({
	location,
	now,
	name,
}: {
	location: SharedLocation;
	now: number;
	name: string;
}) {
	const label = describeLocation(location, now);
	const warn = label.kind !== "current";
	return (
		<article className="win95-inset grid gap-1 bg-card p-2">
			<h4 className="font-bold">{name}</h4>
			<p
				className={warn ? "font-bold" : undefined}
				data-kind={label.kind}
				role={warn ? "status" : undefined}
			>
				{label.text}
			</p>
			{label.fix !== null && (
				<>
					<p>
						{label.fix.latitude.toFixed(5)}, {label.fix.longitude.toFixed(5)} ·
						within {Math.round(label.fix.accuracyMeters)} m · taken{" "}
						{clock(label.fix.fixTime)}
					</p>
					<a
						className="justify-self-start underline"
						href={mapUrl(label.fix)}
						rel="noreferrer"
						target="_blank"
					>
						Open on a map
					</a>
				</>
			)}
			<p className="text-muted-foreground">
				Last report from the phone: {clock(location.reportedAt)}
			</p>
		</article>
	);
}

/**
 * The caller's own shares: who sees their location, a Stop sharing button for each, and a way to
 * share with one more family member. Candidates are members seen in the family's records.
 */
export function SharingControls({
	familyId,
	me,
	locations,
	records,
	onChange,
}: {
	familyId: string;
	me: string;
	locations: FamilyLocations;
	records: ApiState<FamilyRecords>;
	onChange: () => void;
}) {
	const [typed, setTyped] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const mine = locations.shares.filter((s) => s.sharer === me);
	const shared = new Set(mine.map((s) => s.viewer));
	const known =
		records.kind === "ready"
			? [
					...new Set([
						...records.value.messages.map((m) => m.sender),
						...records.value.acknowledgements.map((a) => a.member),
					]),
				].filter((id) => id !== me && !shared.has(id))
			: [];

	const change = async (viewer: string, method: "PUT" | "DELETE") => {
		setBusy(true);
		setError(null);
		const result = await apiRequest(
			FamilyLocations,
			familyPath(familyId, `/location/shares/${viewer}`),
			{ method },
		);
		setBusy(false);
		if (result.kind === "ready") {
			onChange();
			setTyped("");
		} else
			setError(
				result.kind === "signed_out"
					? "Sign in again to change sharing."
					: result.message,
			);
	};

	return (
		<fieldset className="grid gap-2 border border-border p-2">
			<legend className="px-1">Who can see my location</legend>
			{mine.length === 0 ? (
				<p>Nobody. Telly sends no location until you share it with someone.</p>
			) : (
				<ul className="grid gap-1">
					{mine.map((share) => (
						<li
							key={share.viewer}
							className="flex flex-wrap items-center gap-2"
						>
							<span className="min-w-0 flex-1">
								{memberLabel(share.viewer, me)} · since {clock(share.sharedAt)}
							</span>
							<Button
								className="h-11"
								disabled={busy}
								onClick={() => void change(share.viewer, "DELETE")}
								variant="outline"
							>
								Stop sharing with {memberLabel(share.viewer, me)}
							</Button>
						</li>
					))}
				</ul>
			)}
			{known.map((id) => (
				<Button
					key={id}
					className="h-11 justify-self-start"
					disabled={busy}
					onClick={() => void change(id, "PUT")}
				>
					Share with {memberLabel(id, me)}
				</Button>
			))}
			<form
				className="grid gap-1"
				onSubmit={(event) => {
					event.preventDefault();
					if (isIdentity(typed.trim())) void change(typed.trim(), "PUT");
				}}
			>
				<label htmlFor="share-identity">
					Share with a family member by their sharing ID
				</label>
				<span className="flex gap-2">
					<input
						id="share-identity"
						className="win95-inset win95-field h-11 min-w-0 flex-1 bg-card px-2 font-mono text-sm"
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
						aria-invalid={typed.trim() !== "" && !isIdentity(typed.trim())}
						spellCheck={false}
					/>
					<Button
						className="h-11"
						disabled={busy || !isIdentity(typed.trim())}
						type="submit"
					>
						Share
					</Button>
				</span>
			</form>
			{error !== null && (
				<p className="font-bold text-destructive" role="alert">
					{error}
				</p>
			)}
		</fieldset>
	);
}

/**
 * The family view: the latest location of each person who shares it with the caller. A failed
 * read, such as a lost network, shows as a failure, never as an old location passed off as new.
 */
export function FamilyLocationSection({
	familyId,
	me,
	now,
}: {
	familyId: string;
	me: string | null;
	now: number;
}) {
	const state = useApi(FamilyLocations, familyPath(familyId, "/location"), {
		pollMs: 30_000,
	});
	const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
	const shared =
		state.kind === "ready"
			? state.value.locations.filter((l) => l.sharer !== me)
			: [];
	return (
		<section aria-labelledby="location" className="grid gap-2">
			<h3 id="location" className="font-bold">
				Location
			</h3>
			{state.kind !== "ready" ? (
				<ApiNotice state={state} what="location" />
			) : !state.value.seesShared ? (
				<p role="status" className="flex items-center gap-1">
					Location sharing is off for you.
					<Tip text="Someone with family access can turn on Location for you in Sharing." />
				</p>
			) : shared.length === 0 ? (
				<p>Nobody shares a location with you.</p>
			) : (
				shared.map((location) => (
					<LocationCard
						key={location.sharer}
						location={location}
						name={memberLabel(location.sharer, me)}
						now={now}
					/>
				))
			)}
			{me !== null && (
				<p className="flex flex-wrap items-center gap-2">
					<Button
						className="h-11"
						onClick={() =>
							navigator.clipboard.writeText(me).then(
								() => setCopy("copied"),
								() => setCopy("failed"),
							)
						}
						variant="outline"
					>
						Copy my sharing ID
					</Button>
					<Tip text="A family member pastes it in Going out to share their location with you." />
					<span aria-live="polite" className="min-w-0 flex-1 text-xs">
						{copy === "copied"
							? "Copied. Send it to the family member who will share their location with you."
							: copy === "failed"
								? "This browser did not allow copying. Try again."
								: ""}
					</span>
				</p>
			)}
		</section>
	);
}
