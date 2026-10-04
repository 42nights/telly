// "Going out" (issue #40): the wearer's chosen destination and purpose, a spoken reminder, walking
// directions in the phone's own maps app, location sharing, and "Help me get home".
// ponytail: the trip and home address stay on this device until the trip-purpose contract (#39).
import { FamilyRecords } from "@health/contracts";
import { CareNeed } from "@health/contracts/care";
import { Me } from "@health/contracts/families";
import { FamilyLocations } from "@health/contracts/location";
import { Button, buttonVariants } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Footprints } from "lucide-react";
import { useRef, useState } from "react";

import { Window } from "@/components/hud/window";
import { LocationCard, SharingControls } from "@/components/trip/location";
import {
	directionsUrl,
	helpMessage,
	TRAFFIC_NOTE,
	type Trip,
	tripReminder,
} from "@/components/trip/logic";
import {
	type Reporting,
	useLocationReporter,
	useTrip,
} from "@/components/trip/use-trip";
import { type Speech, SpeechLine, useSpeech } from "@/components/wearer/speech";
import { useNow } from "@/components/wearer/use-now";
import { ApiNotice, Tip } from "@/components/win95";
import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";
import { telHref, useContacts } from "@/lib/contacts";
import { loadFamilyReads, useFamily } from "@/lib/family";

export const Route = createFileRoute("/trip")({
	loader: loadFamilyReads((familyId) => [
		[Me, "/api/me"],
		[FamilyLocations, familyPath(familyId, "/location")],
		[FamilyRecords, familyPath(familyId)],
	]),
	component: TripScreen,
});

const HOME_KEY = "telly.home";
const big = "h-14 text-[18px]";

function TripScreen() {
	const { family } = useFamily();
	const familyId = family?.id ?? null;
	const [trip, setTrip] = useTrip();
	const { speech, say } = useSpeech(familyId);
	const path = familyId === null ? null : familyPath(familyId, "/location");
	const locations = useApi(FamilyLocations, path, {
		pollMs: 30_000,
	});
	const me = useApi(Me, "/api/me");
	const myId = me.kind === "ready" ? me.value.identity : null;
	const sharing =
		locations.kind === "ready" &&
		locations.value.shares.some((s) => s.sharer === myId);

	return (
		<main>
			<Window
				title="Going out"
				icon={Footprints}
				className="mx-auto w-full max-w-6xl"
				status={TRAFFIC_NOTE}
			>
				<div className="grid content-start gap-3 p-1 text-[18px] lg:grid-cols-2">
					<div className="grid content-start gap-3">
						<TripPlan trip={trip} setTrip={setTrip} say={say} speech={speech} />
						<HelpHome
							familyId={familyId}
							trip={trip}
							sharing={sharing}
							say={say}
							speech={speech}
						/>
					</div>
					<LocationPanel
						familyId={familyId}
						trip={trip}
						sharing={sharing}
						locations={locations}
						me={me}
					/>
				</div>
			</Window>
		</main>
	);
}

function TripPlan({
	trip,
	setTrip,
	say,
	speech,
}: {
	trip: Trip | null;
	setTrip: (next: Trip | null) => void;
	say: (key: string, text: string) => Promise<void>;
	speech: Speech;
}) {
	const [editing, setEditing] = useState(false);
	if (trip === null || editing)
		return (
			<TripForm
				trip={trip}
				onSave={(next) => {
					setTrip(next);
					setEditing(false);
				}}
				onBack={trip === null ? null : () => setEditing(false)}
			/>
		);
	return (
		<section aria-labelledby="trip" className="grid gap-2">
			<h3 id="trip" className="font-bold text-2xl">
				You are going to {trip.destination}
			</h3>
			{trip.purpose !== "" && <p>To {trip.purpose}.</p>}
			<div className="grid gap-2 sm:grid-cols-2">
				<Button
					className={big}
					onClick={() => void say("trip", tripReminder(trip))}
				>
					Remind me
				</Button>
				<a
					className={buttonVariants({ className: big })}
					data-slot="button"
					href={directionsUrl(trip.destination)}
					rel="noreferrer"
					target="_blank"
				>
					Directions
				</a>
				<Button
					className={big}
					onClick={() => setEditing(true)}
					variant="outline"
				>
					My plans changed
				</Button>
				<Button className={big} onClick={() => setTrip(null)} variant="outline">
					Cancel trip
				</Button>
			</div>
			{speech.key === "trip" && <SpeechLine speech={speech} />}
			<p className="text-[16px]">
				Directions open in your maps app. Telly does not plan the route.
			</p>
		</section>
	);
}

function LocationPanel({
	familyId,
	trip,
	sharing,
	locations,
	me,
}: {
	familyId: string | null;
	trip: Trip | null;
	sharing: boolean;
	locations: ApiState<FamilyLocations>;
	me: ApiState<Me>;
}) {
	const records = useApi(
		FamilyRecords,
		familyId === null ? null : familyPath(familyId),
	);
	const reporting = useLocationReporter(familyId, trip !== null && sharing);
	const body =
		locations.kind !== "ready" ? (
			<ApiNotice state={locations} what="location" />
		) : me.kind !== "ready" || familyId === null ? (
			<ApiNotice
				state={me.kind === "ready" ? { kind: "loading" } : me}
				what="your sharing settings"
			/>
		) : (
			<>
				<ReportLine reporting={reporting} trip={trip} sharing={sharing} />
				<OwnLocation
					reporting={reporting}
					locations={locations.value}
					me={me.value.identity}
				/>
				{/* Folded so the screen fits a phone; the summary names what opens. */}
				<details className="win95-inset bg-card p-2">
					<summary className="min-h-11 cursor-pointer content-center font-bold">
						Sharing settings
					</summary>
					<SharingControls
						familyId={familyId}
						locations={locations.value}
						me={me.value.identity}
						records={records}
					/>
				</details>
			</>
		);
	return (
		<section aria-labelledby="where" className="grid gap-2 text-[16px]">
			<h3 id="where" className="font-bold text-[18px]">
				My location
			</h3>
			{body}
		</section>
	);
}

function TripForm({
	trip,
	onSave,
	onBack,
}: {
	trip: Trip | null;
	onSave: (trip: Trip) => void;
	onBack: (() => void) | null;
}) {
	const [destination, setDestination] = useState(trip?.destination ?? "");
	const [purpose, setPurpose] = useState(trip?.purpose ?? "");
	return (
		<form
			aria-label="Plan a trip"
			className="grid gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (destination.trim() !== "")
					onSave({
						destination: destination.trim(),
						purpose: purpose.trim(),
						setAt: Date.now(),
					});
			}}
		>
			<label htmlFor="trip-destination">Where are you going?</label>
			<input
				id="trip-destination"
				className="win95-inset win95-field h-12 bg-card px-2"
				value={destination}
				maxLength={150}
				onChange={(event) => setDestination(event.target.value)}
				placeholder="The pharmacy on Main Street"
			/>
			<label htmlFor="trip-purpose">What for?</label>
			<input
				id="trip-purpose"
				className="win95-inset win95-field h-12 bg-card px-2"
				value={purpose}
				maxLength={150}
				onChange={(event) => setPurpose(event.target.value)}
				placeholder="pick up my pills"
			/>
			<div className="flex flex-wrap gap-2">
				<Button
					className={`${big} win95-primary`}
					disabled={destination.trim() === ""}
					type="submit"
				>
					{trip === null ? "Start trip" : "Save the new plan"}
				</Button>
				{onBack !== null && (
					<Button
						className={big}
						onClick={onBack}
						type="button"
						variant="outline"
					>
						Keep the old plan
					</Button>
				)}
			</div>
		</form>
	);
}

type Help =
	| { readonly kind: "idle" | "sending" }
	| { readonly kind: "sent" | "failed"; readonly message: string };

function HelpHome({
	familyId,
	trip,
	sharing,
	say,
	speech,
}: {
	familyId: string | null;
	trip: Trip | null;
	sharing: boolean;
	say: (key: string, text: string) => Promise<void>;
	speech: Speech;
}) {
	const [contacts] = useContacts();
	const [home, setHome] = useState(() => localStorage.getItem(HOME_KEY) ?? "");
	const [help, setHelp] = useState<Help>({ kind: "idle" });
	// One id per help request, reused by a retry, so the family ladder opens one need.
	const clientId = useRef<string | null>(null);

	const ask = async () => {
		if (familyId === null) {
			setHelp({
				kind: "failed",
				message: "No family is set up on this device.",
			});
			return;
		}
		clientId.current ??= crypto.randomUUID();
		setHelp({ kind: "sending" });
		const result = await apiRequest(
			CareNeed,
			familyPath(familyId, "/care/needs"),
			{
				method: "POST",
				body: {
					clientId: clientId.current,
					kind: "help",
					summary: helpMessage(trip, sharing),
					sampleIds: [],
					dueAt: null,
				},
			},
		);
		if (result.kind === "ready") {
			clientId.current = null;
			const contact = result.value.attempts.at(-1);
			const message =
				contact === undefined
					? "Nobody is set up to be contacted yet. Your request stays open on the Care page. Call instead."
					: `I asked ${contact.name}. Telly keeps asking your family until someone says they will help.`;
			setHelp({ kind: "sent", message });
			void say("help", message);
		} else
			setHelp({
				kind: "failed",
				message:
					result.kind === "signed_out"
						? "Not sent. Sign in again, or call instead."
						: `Not sent: ${result.message} Call instead.`,
			});
	};

	return (
		<section aria-labelledby="help" className="grid gap-2">
			<h3 id="help" className="sr-only">
				Help me get home
			</h3>
			<Button
				className={`${big} win95-primary`}
				disabled={help.kind === "sending"}
				onClick={() => void ask()}
			>
				{help.kind === "failed"
					? "Try again: tell my family"
					: "Tell my family I need help"}
			</Button>
			<p aria-live="polite" className="text-[16px]">
				{help.kind === "sending" && "Sending…"}
				{help.kind === "sent" && help.message}
			</p>
			{help.kind === "failed" && (
				<p className="font-bold text-[16px] text-destructive" role="alert">
					{help.message}
				</p>
			)}
			{speech.key === "help" && <SpeechLine speech={speech} />}
			<div className="grid gap-2 sm:grid-cols-2">
				{contacts.momPhone !== null && (
					<a
						className={buttonVariants({ className: big, variant: "outline" })}
						data-slot="button"
						href={telHref(contacts.momPhone)}
					>
						Call Mom
					</a>
				)}
				{home.trim() === "" ? null : (
					<a
						className={buttonVariants({ className: big, variant: "outline" })}
						data-slot="button"
						href={directionsUrl(home.trim())}
						rel="noreferrer"
						target="_blank"
					>
						Directions home
					</a>
				)}
			</div>
			<div className="flex items-center gap-2 text-[16px]">
				<label htmlFor="home-address">Home address</label>
				<Tip text="For Directions home. Saved on this device only." />
				<input
					id="home-address"
					className="win95-inset win95-field h-12 min-w-0 flex-1 bg-card px-2"
					value={home}
					onChange={(event) => {
						setHome(event.target.value);
						localStorage.setItem(HOME_KEY, event.target.value);
					}}
				/>
			</div>
		</section>
	);
}

const reportText = (
	reporting: Reporting,
	trip: Trip | null,
	sharing: boolean,
) => {
	if (!sharing) return "Not shared with anyone.";
	if (trip === null)
		return "Shared during a trip. Start a trip to send your location.";
	switch (reporting.kind) {
		case "off":
		case "waiting":
			return "Looking for your position…";
		case "sent":
			return `Sent to the people you chose at ${new Date(reporting.report.reportedAt).toLocaleTimeString([], { timeStyle: "short" })}.`;
		case "failed":
			return reporting.message;
	}
};

function ReportLine(props: {
	reporting: Reporting;
	trip: Trip | null;
	sharing: boolean;
}) {
	const failed = props.reporting.kind === "failed";
	return (
		<p
			className={failed ? "font-bold text-destructive" : undefined}
			role={failed ? "alert" : "status"}
		>
			{reportText(props.reporting, props.trip, props.sharing)}
		</p>
	);
}

/** The caller's latest report, as the people they share with see it. */
function OwnLocation({
	reporting,
	locations,
	me,
}: {
	reporting: Reporting;
	locations: FamilyLocations;
	me: string;
}) {
	const now = useNow();
	// The report just sent is newer than the last poll.
	const own =
		reporting.kind === "sent"
			? reporting.report
			: locations.locations.find((l) => l.sharer === me);
	return own === undefined ? null : (
		<LocationCard location={own} name="What your family sees" now={now} />
	);
}
