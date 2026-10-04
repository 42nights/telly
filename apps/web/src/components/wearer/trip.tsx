import {
	CurrentTrip,
	TRIP_QUESTION,
	type Trip,
	type TripAnswer,
	TripCheckIn,
	TripReply,
} from "@health/contracts/trips";
import { Button } from "@health/ui/components/button";
import type { Schema } from "effect";
import { DoorOpen, Volume2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, reread, useApi } from "@/lib/api";

import { type Speech, SpeechLine, useSpeech } from "./speech";

const big = "h-12 px-4 text-[18px] [&_svg]:size-5";
const field =
	"win95-inset win95-field h-12 min-w-0 bg-white px-3 text-[18px] text-black";

/** The device battery level from 0 to 1, or null where the browser does not report it. */
const batteryLevel = async (): Promise<number | null> => {
	const nav = navigator as Navigator & {
		getBattery?: () => Promise<{ level: number }>;
	};
	if (nav.getBattery === undefined) return null;
	return (await nav.getBattery().catch(() => null))?.level ?? null;
};

function PlanForm({
	trip,
	onAnswer,
}: {
	trip: Trip;
	onAnswer: (answer: TripAnswer) => void;
}) {
	const [purpose, setPurpose] = useState(trip.plan?.purpose ?? "");
	const [destination, setDestination] = useState(trip.plan?.destination ?? "");
	const [notify, setNotify] = useState(trip.notify);
	return (
		<form
			className="grid gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void batteryLevel().then((battery) =>
					onAnswer({
						answer: "leaving",
						purpose: purpose.trim(),
						destination: destination.trim() === "" ? null : destination.trim(),
						notify,
						battery,
					}),
				);
			}}
		>
			<label className="grid gap-1 text-[18px]">
				What are you going out for?
				<input
					className={field}
					maxLength={200}
					onChange={(event) => setPurpose(event.target.value)}
					required
					value={purpose}
				/>
			</label>
			<label className="grid gap-1 text-[18px]">
				Where to? (optional)
				<input
					className={field}
					maxLength={200}
					onChange={(event) => setDestination(event.target.value)}
					value={destination}
				/>
			</label>
			{(["departure", "arrival"] as const).map((key) => (
				<label className="flex items-center gap-2 text-[18px]" key={key}>
					<input
						checked={notify[key]}
						className="size-5"
						onChange={(event) =>
							setNotify({ ...notify, [key]: event.target.checked })
						}
						type="checkbox"
					/>
					{key === "departure"
						? "Tell my family I left"
						: "Tell my family I arrived"}
				</label>
			))}
			<div className="flex flex-wrap gap-2">
				<Button className={`win95-primary ${big}`} type="submit">
					Save my plan
				</Button>
				<Button
					className={big}
					onClick={() => onAnswer({ answer: "cancel" })}
					type="button"
					variant="outline"
				>
					{trip.status === "asked" ? "Not now" : "Cancel trip"}
				</Button>
			</div>
		</form>
	);
}

function Question({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
	return (
		<div className="grid gap-2">
			<p className="font-bold text-[22px]">{TRIP_QUESTION}</p>
			<div className="flex flex-wrap gap-2">
				<Button className={`win95-primary ${big}`} onClick={onYes}>
					Yes
				</Button>
				<Button className={big} onClick={onNo} variant="outline">
					Not now
				</Button>
			</div>
		</div>
	);
}

/** The confirmed plan, the last preparation prompt, and the trip's controls. */
function ActiveTrip({
	trip,
	prompt,
	speech,
	say,
	onEdit,
	onAnswer,
}: {
	trip: Trip;
	prompt: string | null;
	speech: Speech;
	say: (key: string, text: string) => Promise<void>;
	onEdit: () => void;
	onAnswer: (answer: TripAnswer) => void;
}) {
	const plan = `You're going out for ${trip.plan?.purpose ?? "your trip"}${
		trip.plan?.destination == null ? "" : ` to ${trip.plan.destination}`
	}.`;
	return (
		<div className="grid gap-2">
			<p className="text-[20px]">{plan}</p>
			{prompt !== null && (
				<p className="text-[18px]" role="status">
					{prompt}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					className={big}
					onClick={() => void say("trip", `${plan} ${prompt ?? ""}`.trim())}
					variant="outline"
				>
					<Volume2 aria-hidden />
					Remind me
				</Button>
				<Button className={big} onClick={onEdit} variant="outline">
					My plans changed
				</Button>
				<Button
					className={big}
					onClick={() => onAnswer({ answer: "arrived" })}
					variant="outline"
				>
					I arrived
				</Button>
				<Button
					className={big}
					onClick={() => onAnswer({ answer: "cancel" })}
					variant="outline"
				>
					Cancel trip
				</Button>
			</div>
			{speech.key === "trip" && <SpeechLine speech={speech} />}
		</div>
	);
}

/** The family's current trip and the check-in actions. A failed send shows as `problem`. */
function useTrip(familyId: string | null) {
	const [reply, setReply] = useState<TripReply | null>(null);
	const [editing, setEditing] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const { speech, say } = useSpeech(familyId);
	const current = useApi(
		CurrentTrip,
		familyId === null ? null : familyPath(familyId, "/trips/current"),
		// Polls like the HUD's records, so another device's step or a recovered server shows up.
		{ pollMs: 30_000 },
	);
	const send = async <T,>(
		schema: Schema.Decoder<T>,
		path: string,
		body: unknown,
	) => {
		if (familyId === null) return null;
		setProblem(null);
		const result = await apiRequest(schema, familyPath(familyId, path), {
			method: "POST",
			body,
		});
		if (result.kind === "ready") return result.value;
		// A refused write changes no cache, but another device may have moved the trip on.
		reread(familyPath(familyId, "/trips/current"));
		setProblem(
			"message" in result ? result.message : "Sign in to save your trip.",
		);
		return null;
	};
	const answer = async (id: string, body: TripAnswer) => {
		const replied = await send(TripReply, `/trips/${id}/answer`, body);
		setEditing(false);
		setReply(replied);
		if (replied?.prompt != null) void say("trip", replied.prompt);
	};
	const checkIn = () =>
		void send(TripCheckIn, "/trips/check-in", { source: "manual" });
	return {
		current,
		reply,
		editing,
		setEditing,
		problem,
		speech,
		say,
		answer,
		checkIn,
	};
}

/**
 * The leaving-home check-in: one question, then the wearer's plan, the items to check, and the
 * family messages the wearer chose. It uses no location, so it works with location turned off.
 */
export function TripCheckInCard({ familyId }: { familyId: string | null }) {
	const {
		current,
		reply,
		editing,
		setEditing,
		problem,
		speech,
		say,
		answer,
		checkIn,
	} = useTrip(familyId);
	if (familyId === null) return null;
	if (current.kind !== "ready")
		return (
			<div className="win95-inset bg-card">
				<ApiNotice state={current} what="your trip" />
			</div>
		);
	const trip = current.value.trip;

	let view: ReactNode;
	if (trip === null || trip.status === "cancelled" || trip.status === "arrived")
		view = (
			<Button
				className={`justify-self-start ${big}`}
				onClick={checkIn}
				variant="outline"
			>
				<DoorOpen aria-hidden />
				I'm going out
			</Button>
		);
	else if (editing)
		view = (
			<PlanForm onAnswer={(body) => void answer(trip.id, body)} trip={trip} />
		);
	else if (trip.status === "asked")
		view = (
			<Question
				onNo={() => void answer(trip.id, { answer: "cancel" })}
				onYes={() => setEditing(true)}
			/>
		);
	else
		view = (
			<ActiveTrip
				onAnswer={(body) => void answer(trip.id, body)}
				onEdit={() => setEditing(true)}
				prompt={reply?.trip.id === trip.id ? reply.prompt : null}
				say={say}
				speech={speech}
				trip={trip}
			/>
		);

	return (
		<section
			aria-label="Going out"
			className="win95-inset grid gap-3 bg-card p-3"
		>
			{problem !== null && (
				<p className="text-[18px] text-destructive" role="alert">
					{problem}
				</p>
			)}
			{view}
		</section>
	);
}
