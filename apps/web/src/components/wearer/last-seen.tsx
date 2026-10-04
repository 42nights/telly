// Where medicine was last seen (issue #29): the remembered places, the moved-container recovery,
// and saving a new place after a confirmed camera check. A remembered place is never shown as the
// current one, and nothing here records a dose.
import { FamilyMessage } from "@health/contracts";
import type {
	MedicineMemory,
	MedicineSighting,
} from "@health/contracts/medicine-memory";
import type { MedicineDetection } from "@health/contracts/vision";
import { Button } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { History, MapPinOff, Save, Users } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
	type ApiResult,
	type ApiState,
	apiRequest,
	familyPath,
} from "@/lib/api";
import type { MedicineMemoryChange as Change } from "@/lib/medicine-memory";

import { ago, sightingState } from "./logic";
import type { PictureCheck } from "./medicine-check";
import { useNow } from "./use-now";

type Sent = ApiResult<unknown> | { readonly kind: "sending" } | null;

const lg = "h-14 w-full text-[20px] [&_svg]:size-6";
const field = "win95-inset win95-field h-12 w-full bg-card px-2 text-[18px]";

function Result({ result, done }: { result: Sent; done: ReactNode }) {
	if (result === null || result.kind === "sending") return null;
	if (result.kind === "ready") return <p role="status">{done}</p>;
	return (
		<p className="text-[16px] text-destructive" role="alert">
			{result.kind === "signed_out" ? "Sign in first." : result.message}
		</p>
	);
}

/** The container moved: other agreed places to look, and a message asking the family for help. */
function Moved({
	sighting,
	places,
	familyId,
}: {
	sighting: MedicineSighting;
	places: readonly string[];
	familyId: string;
}) {
	// One id per request, so a retry after a lost reply sends the message once.
	const [clientId] = useState(() => crypto.randomUUID());
	const [sent, setSent] = useState<Sent>(null);
	const ask = async () => {
		setSent({ kind: "sending" });
		setSent(
			await apiRequest(FamilyMessage, familyPath(familyId, "/messages"), {
				method: "POST",
				body: {
					clientId,
					body: `I can't find ${sighting.container}. It was last seen at ${sighting.place}, but it is not there now. Can you help me find it?`,
				},
			}),
		);
	};
	return (
		<div className="grid gap-2">
			{places.length > 0 && (
				<>
					<p>Other places to look:</p>
					<ul className="list-disc pl-7">
						{places.map((place) => (
							<li key={place}>{place}</li>
						))}
					</ul>
				</>
			)}
			<Button
				className={lg}
				disabled={sent?.kind === "sending" || sent?.kind === "ready"}
				onClick={() => void ask()}
				variant="outline"
			>
				<Users aria-hidden />
				Ask family for help
			</Button>
			<Result done="I asked your family for help." result={sent} />
		</div>
	);
}

function Sighting({
	sighting,
	now,
	change,
}: {
	sighting: MedicineSighting;
	now: number;
	change: Change;
}) {
	const [sent, setSent] = useState<Sent>(null);
	const { outdated, old, unsure } = sightingState(sighting, now);
	const notThere = async () => {
		setSent({ kind: "sending" });
		setSent(
			await change(
				"POST",
				`/sightings/${encodeURIComponent(sighting.id)}/not-found`,
			),
		);
	};
	return (
		<div className="grid gap-1">
			<p>
				<b>Last seen {ago(now - Date.parse(sighting.seenAt))}</b> at{" "}
				<b className="break-words">{sighting.place}</b>:{" "}
				<span className="break-words">{sighting.container}</span>.
			</p>
			{old && <p>This note is old. It has probably moved since.</p>}
			{unsure && <p>I was not sure about the label then.</p>}
			{outdated && sighting.notFoundAt !== null ? (
				<p className="flex items-start gap-2 font-semibold">
					<MapPinOff aria-hidden className="mt-1 size-5 shrink-0" />
					It was not there {ago(now - Date.parse(sighting.notFoundAt))}. This
					place is out of date.
				</p>
			) : (
				<Button
					className={lg}
					disabled={sent?.kind === "sending"}
					onClick={() => void notThere()}
					variant="outline"
				>
					<MapPinOff aria-hidden />
					It's not there
				</Button>
			)}
			<Result done={null} result={sent?.kind === "ready" ? null : sent} />
		</div>
	);
}

/** The remembered places for the medicine finder, labelled as past sightings. */
export function LastSeen({
	memory,
	change,
	familyId,
	item,
}: {
	memory: ApiState<MedicineMemory>;
	change: Change;
	familyId: string | null;
	item: string;
}) {
	const now = useNow();
	if (memory.kind === "loading" || familyId === null) return null;
	const box = "win95-raised grid gap-2 p-3 text-[18px]";
	if (memory.kind !== "ready")
		return (
			<p className="text-[16px] text-muted-foreground">
				I can't read my notes on where medicine was last seen.{" "}
				{memory.kind === "signed_out" ? "Sign in first." : memory.message}
			</p>
		);
	const { permission, sightings } = memory.value;
	if (permission === null)
		return (
			<p className="text-[16px] text-muted-foreground">
				I don't keep notes on where medicine was last seen.{" "}
				<Link className="underline" to="/settings/places">
					Turn this on in Settings
				</Link>
			</p>
		);
	if (sightings.length === 0)
		return (
			<p className="text-[16px] text-muted-foreground">
				I have no note yet of where {item} was last seen. When I find it, I can
				remember the place.
			</p>
		);
	const moved = sightings.find((s) => s.notFoundAt !== null);
	return (
		<section aria-label="Last seen" className={box}>
			<h3 className="flex items-center gap-2 font-semibold">
				<History aria-hidden className="size-5" />
				Where I last saw it
			</h3>
			{sightings.slice(0, 3).map((sighting) => (
				<Sighting
					change={change}
					key={sighting.id}
					now={now}
					sighting={sighting}
				/>
			))}
			<p className="text-[16px]">
				This is where it was seen before, not where it is now. Go there and
				check the picture again.
			</p>
			{moved !== undefined && (
				<Moved
					familyId={familyId}
					places={permission.places.filter((p) => p !== moved.place)}
					sighting={moved}
				/>
			)}
		</section>
	);
}

/**
 * Saves where a container found in `check` is. A low-confidence or unread label must be checked by
 * the person first. Mount it with `key={check.id}`, so each picture starts a new form.
 */
export function RememberPlace({
	check,
	best,
	memory,
	change,
}: {
	check: PictureCheck;
	best: MedicineDetection;
	memory: ApiState<MedicineMemory>;
	change: Change;
}) {
	const known = memory.kind === "ready" ? memory.value : null;
	// Only a label read in this picture names the container; a past sighting never does.
	const [container, setContainer] = useState(best.label ?? "");
	const [place, setPlace] = useState("");
	const [labelChecked, setLabelChecked] = useState(false);
	const [saved, setSaved] = useState<Sent>(null);
	if (known?.permission == null) return null;
	const places = [
		...new Set([
			...known.permission.places,
			...known.sightings.map((s) => s.place),
		]),
	];
	const ready =
		container.trim() !== "" &&
		place.trim() !== "" &&
		(labelChecked || !best.needsVerification) &&
		saved?.kind !== "sending";
	return (
		<form
			aria-label="Remember where it is"
			className="win95-raised grid gap-2 p-3 text-[18px]"
			onSubmit={(event) => {
				event.preventDefault();
				if (!ready) return;
				setSaved({ kind: "sending" });
				void change("POST", "/sightings", {
					container: container.trim(),
					place: place.trim(),
					seenAt: new Date(check.capturedAt).toISOString(),
					source: "camera_check",
					confidence: best.confidence,
					labelRead: best.label !== null,
				}).then(setSaved);
			}}
		>
			<h3 className="font-semibold">Remember where it is</h3>
			<label className="grid gap-1">
				What is it?
				<input
					className={field}
					maxLength={120}
					onChange={(event) => setContainer(event.target.value)}
					placeholder="The name on the label"
					value={container}
				/>
			</label>
			<label className="grid gap-1">
				Where is it? A room or a landmark.
				<input
					className={field}
					list="medicine-places"
					maxLength={120}
					onChange={(event) => setPlace(event.target.value)}
					placeholder="Kitchen counter, by the kettle"
					value={place}
				/>
				<datalist id="medicine-places">
					{places.map((p) => (
						<option key={p} value={p} />
					))}
				</datalist>
			</label>
			{best.needsVerification && (
				<label className="flex min-h-11 items-center gap-2">
					<input
						checked={labelChecked}
						className="size-5"
						onChange={(event) => setLabelChecked(event.target.checked)}
						type="checkbox"
					/>
					I read the label. It is the right medicine.
				</label>
			)}
			<Button className={lg} disabled={!ready} type="submit" variant="outline">
				<Save aria-hidden />
				Remember this place
			</Button>
			<Result
				done="Saved as the last place it was seen. This does not record a dose."
				result={saved}
			/>
		</form>
	);
}
