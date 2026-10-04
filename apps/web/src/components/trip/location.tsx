// Shared location display, trip notices (#302), and per-person sharing (issue #40). A location
// always shows its label, accuracy, fix time, and report time; nothing here says the person is safe.
// People show by name (`useMemberNames`), never by identity.
import { CareAccess } from "@health/contracts/care-profile";
import {
	describeLocation,
	FamilyLocations,
	type SharedLocation,
} from "@health/contracts/location";
import { useState } from "react";

import { clock } from "@/components/family/logic";
import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";
import { useMemberNames } from "@/lib/members";

import { awayText, mapUrl } from "./logic";

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
 * "Who sees where I am": every other member of the family with an on/off box. On shares the
 * caller's location with that person (#40); they see it only while they also hold Location access
 * (#26), and the row says so when they do not.
 */
export function WhoSeesMe({
	familyId,
	me,
	locations,
}: {
	familyId: string;
	me: string;
	locations: FamilyLocations;
}) {
	const { state, members, nameOf } = useMemberNames(familyId);
	const access = useApi(CareAccess, familyPath(familyId, "/care-access"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const shared = new Set(
		locations.shares.filter((s) => s.sharer === me).map((s) => s.viewer),
	);
	const others = members.filter((m) => m.identity !== me);

	const change = async (viewer: string, on: boolean) => {
		setBusy(true);
		setError(null);
		const result = await apiRequest(
			FamilyLocations,
			familyPath(familyId, `/location/shares/${viewer}`),
			{ method: on ? "PUT" : "DELETE" },
		);
		setBusy(false);
		if (result.kind !== "ready")
			setError(
				result.kind === "signed_out"
					? "Not changed: sign in again."
					: `Not changed: ${result.message}`,
			);
	};

	return (
		<fieldset
			className="grid gap-1"
			title="Only the people you tick see where you are."
		>
			<legend className="font-bold">Who sees where I am</legend>
			{state.kind !== "ready" ? (
				<ApiNotice state={state} what="your family" />
			) : others.length === 0 ? (
				<p className="text-[16px]">Nobody else is in this family yet.</p>
			) : (
				others.map(({ identity }) => {
					const on = shared.has(identity);
					const blocked =
						on &&
						access.kind === "ready" &&
						!access.value.grants.some(
							(g) => g.identity === identity && g.scope === "location",
						);
					return (
						<label key={identity} className="flex min-h-11 items-center gap-3">
							<input
								checked={on}
								className="size-6 shrink-0"
								disabled={busy}
								onChange={(event) =>
									void change(identity, event.target.checked)
								}
								type="checkbox"
							/>
							<span className="min-w-0">
								{nameOf(identity)}
								{blocked && (
									<span className="block text-[14px]">
										Cannot see it yet: turn on Location for them in Care ›
										Sharing.
									</span>
								)}
							</span>
						</label>
					);
				})
			)}
			{error !== null && (
				<p className="font-bold text-[16px] text-destructive" role="alert">
					{error}
				</p>
			)}
		</fieldset>
	);
}

/** The newest trip starts and ends of people who share with the caller (#302), with a map link. */
function AwayNotices({
	locations,
	me,
	nameOf,
}: {
	locations: FamilyLocations;
	me: string | null;
	nameOf: (identity: string) => string;
}) {
	const notices = locations.events.filter((e) => e.sharer !== me).slice(0, 5);
	if (notices.length === 0) return null;
	return (
		<ul aria-label="Going out" className="grid gap-1">
			{notices.map((event) => {
				// A manual start has no fix of its own: link the person's latest position.
				const fix =
					event.fix ??
					locations.locations.find((l) => l.sharer === event.sharer)?.fix ??
					null;
				return (
					<li
						key={event.id}
						className="win95-inset flex flex-wrap items-center gap-x-2 bg-card p-2"
					>
						<span className="min-w-0 flex-1">
							{awayText(nameOf(event.sharer), event)}
						</span>
						{fix !== null && (
							<a
								className="underline"
								href={mapUrl(fix)}
								rel="noreferrer"
								target="_blank"
							>
								Open on a map
							</a>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The family view: the latest location of each person who shares it with the caller, and their
 * trip starts and ends. A failed read, such as a lost network, shows as a failure, never as an old
 * location passed off as new.
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
	const { nameOf } = useMemberNames(familyId);
	const shared =
		state.kind === "ready"
			? state.value.locations.filter((l) => l.sharer !== me)
			: [];
	// Nothing shared with me, or no Location access: the section is hidden, not an empty line.
	if (
		state.kind === "ready" &&
		(!state.value.seesShared ||
			(shared.length === 0 && !state.value.events.some((e) => e.sharer !== me)))
	)
		return null;
	return (
		<section aria-labelledby="location" className="grid gap-2">
			<h3 id="location" className="font-bold">
				Location
			</h3>
			{state.kind !== "ready" ? (
				<ApiNotice state={state} what="location" />
			) : (
				shared.map((location) => (
					<LocationCard
						key={location.sharer}
						location={location}
						name={nameOf(location.sharer)}
						now={now}
					/>
				))
			)}
			{state.kind === "ready" && (
				<AwayNotices locations={state.value} me={me} nameOf={nameOf} />
			)}
		</section>
	);
}
