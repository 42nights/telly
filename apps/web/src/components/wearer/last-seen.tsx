// Where a member's things were last seen (issues #29, #301): the saved objects ("Where is my…?"),
// the moved-object recovery, and saving a new place after a confirmed camera check. A remembered
// place is never shown as the current one, and nothing here records a dose.
import { FamilyMessage } from "@health/contracts";
import type {
	MedicineMemory,
	MedicineSighting,
} from "@health/contracts/medicine-memory";
import type { ObjectDetection } from "@health/contracts/vision";
import { Button } from "@health/ui/components/button";
import {
	CameraOff,
	History,
	MapPinOff,
	MapPinPlus,
	Save,
	ScanSearch,
	TriangleAlert,
	Users,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
	type ApiResult,
	type ApiState,
	apiRequest,
	familyPath,
} from "@/lib/api";
import { arCapabilities } from "@/lib/ar-bridge";
import type { MedicineMemoryChange as Change } from "@/lib/medicine-memory";
import { type ArOutcome, pinInAr, showInAr } from "./ar-pin";
import { objectName, sightingState, whenSeen } from "./logic";
import { type PictureCheck, thumbnail } from "./medicine-check";
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

/** The object moved: other agreed places to look, and a message asking the family for help. */
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

type ArStep = ArOutcome | { readonly kind: "busy"; readonly text: string };

const PIN_TEXT =
	"Turn slowly, then walk closer. Point your phone at it and tap Pin here.";
const FIND_TEXT = "Move your phone slowly around the room.";

/** One AR outcome: busy, done, or a failure with what to do next. */
function ArResult({ step }: { step: ArStep | null }) {
	if (step === null) return null;
	if (step.kind !== "failed")
		return (
			<p className="sm:col-span-2" role="status">
				{step.text}
			</p>
		);
	const Icon = step.code === "camera-denied" ? CameraOff : TriangleAlert;
	return (
		<div className="win95-raised grid gap-1 p-2 sm:col-span-2" role="alert">
			<p className="flex items-center gap-2 font-semibold">
				<Icon aria-hidden className="size-5 shrink-0" />
				{step.title}
			</p>
			<p className="text-[16px]">{step.text}</p>
		</div>
	);
}

/**
 * "Pin it in AR" and "Show me in AR" for one object, with the result of the last try. `findNow`
 * starts "Show me in AR" at once, for an object the person just picked that has a pin.
 */
function ArPin({
	familyId,
	sighting,
	findNow,
}: {
	familyId: string;
	sighting: MedicineSighting;
	findNow: boolean;
}) {
	const [step, setStep] = useState<ArStep | null>(null);
	const run = async (flow: typeof pinInAr, text: string) => {
		setStep({ kind: "busy", text });
		setStep(await flow(familyId, sighting));
	};
	const started = useRef(false);
	useEffect(() => {
		if (!findNow || started.current) return;
		started.current = true;
		void run(showInAr, FIND_TEXT);
	});
	const busy = step?.kind === "busy";
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			<Button
				className={lg}
				disabled={busy}
				onClick={() => void run(pinInAr, PIN_TEXT)}
				variant="outline"
			>
				<MapPinPlus aria-hidden />
				Pin it in AR
			</Button>
			<Button
				className={lg}
				disabled={busy}
				onClick={() => void run(showInAr, FIND_TEXT)}
				variant="outline"
			>
				<ScanSearch aria-hidden />
				Show me in AR
			</Button>
			<ArResult step={step} />
		</div>
	);
}

function Sighting({
	sighting,
	now,
	change,
	ar,
	places,
	familyId,
	findNow,
}: {
	sighting: MedicineSighting;
	now: number;
	change: Change;
	/** The family, when this device can pin in AR. */
	ar: string | null;
	/** The member's agreed places, offered when the object moved. */
	places: readonly string[];
	familyId: string;
	findNow: boolean;
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
		<div className="grid gap-2">
			<p>
				<b>Last seen {whenSeen(sighting.seenAt, now)}</b> at{" "}
				<b className="break-words">{sighting.place}</b>.
			</p>
			{sighting.usualPlace !== null && (
				<p>
					Usually kept at <b className="break-words">{sighting.usualPlace}</b>.
				</p>
			)}
			{old && <p>This note is old. It has probably moved since.</p>}
			{unsure && sighting.category === "medicine" && (
				<p>I was not sure about the label then.</p>
			)}
			{outdated && sighting.notFoundAt !== null ? (
				<>
					<p className="flex items-start gap-2 font-semibold">
						<MapPinOff aria-hidden className="mt-1 size-5 shrink-0" />
						It was not there {whenSeen(sighting.notFoundAt, now)}. This place is
						out of date.
					</p>
					<Moved
						familyId={familyId}
						places={places.filter((p) => p !== sighting.place)}
						sighting={sighting}
					/>
				</>
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
			{ar !== null && (
				<ArPin
					familyId={ar}
					findNow={findNow && sighting.pinned}
					sighting={sighting}
				/>
			)}
			<Result done={null} result={sent?.kind === "ready" ? null : sent} />
		</div>
	);
}

/** Whether this device can pin in AR: only the iOS shell with ARKit says so. */
export function useArSupported() {
	const [supported, setSupported] = useState(false);
	useEffect(() => {
		let live = true;
		void arCapabilities().then((c) => live && setSupported(c.supported));
		return () => {
			live = false;
		};
	}, []);
	return supported;
}

/** A small picture of the object from the check that saved it, or nothing for an older note. */
export function Thumb({ sighting }: { sighting: MedicineSighting }) {
	if (sighting.thumbnail === "") return null;
	return (
		<img
			alt=""
			className="win95-inset size-12 shrink-0 bg-black object-contain"
			src={`data:image/jpeg;base64,${sighting.thumbnail}`}
		/>
	);
}

/**
 * "Where is my…?": the member's saved things, newest first. Picking one shows where it was last
 * seen, where it is usually kept, and on an iPhone with a pin starts finding it in AR. `asked` is
 * the category of the request, which picks the first matching thing; `open` is a thing a link
 * opens, as if the person picked it.
 */
export function SavedThings({
	memory,
	change,
	familyId,
	asked,
	ar,
	open,
}: {
	memory: ApiState<MedicineMemory>;
	change: Change;
	familyId: string | null;
	asked: ObjectDetection["category"] | null;
	ar: boolean;
	open: string | null;
}) {
	const now = useNow();
	const [picked, setPicked] = useState<{
		readonly id: string;
		readonly byTap: boolean;
	} | null>(open === null ? null : { id: open, byTap: true });
	if (memory.kind === "loading" || familyId === null) return null;
	const box = "win95-raised grid gap-2 p-3 text-[18px]";
	if (memory.kind !== "ready")
		return (
			<p className="text-[16px] text-muted-foreground">
				I can't read my notes on where things were last seen.{" "}
				{memory.kind === "signed_out" ? "Sign in first." : memory.message}
			</p>
		);
	const { places, sightings } = memory.value;
	if (sightings.length === 0)
		return (
			<p className="text-[16px] text-muted-foreground">
				No saved things yet. Point the camera at something you often lose, then
				tap Save.
			</p>
		);
	const shown =
		sightings.find((s) => s.id === picked?.id) ??
		(asked === null ? undefined : sightings.find((s) => s.category === asked));
	return (
		<section aria-label="Where is my…?" className={box}>
			<h3 className="flex items-center gap-2 font-semibold">
				<History aria-hidden className="size-5" />
				Where is my…?
			</h3>
			<ul className="grid gap-1">
				{sightings.map((sighting) => (
					<li key={sighting.id}>
						<Button
							aria-pressed={sighting === shown}
							className="h-auto min-h-14 w-full justify-start gap-3 px-2 text-left text-[18px]"
							onClick={() => setPicked({ id: sighting.id, byTap: true })}
							variant="outline"
						>
							<Thumb sighting={sighting} />
							<span className="grid min-w-0">
								<b className="break-words">
									{objectName(sighting.category, sighting.container)}
								</b>
								<span className="text-[15px] text-muted-foreground">
									{sighting.place} · {whenSeen(sighting.seenAt, now)}
								</span>
							</span>
						</Button>
					</li>
				))}
			</ul>
			{shown !== undefined && (
				<>
					<Sighting
						ar={ar ? familyId : null}
						change={change}
						familyId={familyId}
						findNow={picked?.id === shown.id && picked.byTap}
						key={shown.id}
						now={now}
						places={places}
						sighting={shown}
					/>
					<p className="text-[16px]">
						This is where it was seen before, not where it is now. Go there and
						check with the camera.
					</p>
				</>
			)}
		</section>
	);
}

/**
 * Saves the object the person confirmed with Save: its name, kind, a small picture, and the room
 * or spot they pick or name. A medicine label that is low-confidence or unread must be checked
 * first. On an iPhone with ARKit it then opens the AR pairing step to pin the spot. Mount it with
 * `key={check.id}`, so each picture starts a new form.
 */
export function RememberPlace({
	check,
	best,
	memory,
	change,
	ar,
}: {
	check: PictureCheck;
	best: ObjectDetection;
	memory: ApiState<MedicineMemory>;
	change: Change;
	/** The family, when this device can pin in AR. */
	ar: string | null;
}) {
	if (memory.kind !== "ready") return null;
	const places = [
		...new Set([
			...memory.value.places,
			...memory.value.sightings.map((s) => s.place),
		]),
	];
	return (
		<SaveForm
			ar={ar}
			best={best}
			change={change}
			check={check}
			places={places}
		/>
	);
}

function SaveForm({
	check,
	best,
	places,
	change,
	ar,
}: {
	check: PictureCheck;
	best: ObjectDetection;
	/** The member's agreed and past places, offered once each. */
	places: readonly string[];
	change: Change;
	ar: string | null;
}) {
	const medicine = best.category === "medicine";
	// Only a label read in this picture names medicine; a past sighting never does.
	const [label, setLabel] = useState(
		best.label ?? (medicine ? "" : objectName(best.category, null)),
	);
	const [place, setPlace] = useState("");
	const [labelChecked, setLabelChecked] = useState(false);
	const [saved, setSaved] = useState<Sent>(null);
	const [pin, setPin] = useState<ArStep | null>(null);
	const ready =
		label.trim() !== "" &&
		place.trim() !== "" &&
		(labelChecked || !medicine || !best.needsVerification) &&
		saved?.kind !== "sending";
	const save = async () => {
		setSaved({ kind: "sending" });
		// A picture is a nice-to-have: the place is saved without one when the browser cannot cut it.
		const picture = await thumbnail(check, best.box).catch(() => undefined);
		const result = await change("POST", "/sightings", {
			container: label.trim(),
			place: place.trim(),
			seenAt: new Date(check.capturedAt).toISOString(),
			source: "camera_check",
			confidence: best.confidence,
			labelRead: best.label !== null,
			category: best.category,
			...(picture === undefined ? {} : { thumbnail: picture }),
		});
		setSaved(result);
		if (result.kind !== "ready" || ar === null) return;
		const key = label.trim().toLowerCase();
		const object = result.value.sightings.find(
			(s) => s.container.trim().toLowerCase() === key,
		);
		if (object === undefined) return;
		setPin({ kind: "busy", text: PIN_TEXT });
		setPin(await pinInAr(ar, object));
	};
	return (
		<form
			aria-label="Save where it is"
			className="win95-raised grid gap-2 p-3 text-[18px]"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) void save();
			}}
		>
			<h3 className="font-semibold">Save where it is</h3>
			<label className="grid gap-1">
				What is it?
				<input
					className={field}
					maxLength={120}
					onChange={(event) => setLabel(event.target.value)}
					placeholder={medicine ? "The name on the label" : "My house keys"}
					value={label}
				/>
			</label>
			<label className="grid gap-1">
				Where is it? A room or a spot.
				<input
					className={field}
					list="object-places"
					maxLength={120}
					onChange={(event) => setPlace(event.target.value)}
					placeholder="Kitchen counter, by the kettle"
					value={place}
				/>
				<datalist id="object-places">
					{places.map((p) => (
						<option key={p} value={p} />
					))}
				</datalist>
			</label>
			{medicine && best.needsVerification && (
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
				Save this place
			</Button>
			<Result
				done={
					medicine
						? "Saved as the last place it was seen. This does not record a dose."
						: "Saved as the last place it was seen."
				}
				result={saved}
			/>
			<ArResult step={pin} />
		</form>
	);
}
