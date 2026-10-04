// "Going out" (issue #40): the wearer's chosen destination and purpose, a spoken reminder, walking
// directions in the phone's own maps app, location sharing, and "Help me get home".
// ponytail: the trip and home address stay on this device until the trip-purpose contract (#39).
import { FamilyMessage, FamilyRecords } from "@health/contracts";
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
import { ApiNotice } from "@/components/win95";
import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";
import { telHref, useContacts } from "@/lib/contacts";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/trip")({ component: TripScreen });

const HOME_KEY = "telly.home";
const big = "h-14 text-[18px]";

function TripScreen() {
	const { family } = useFamily();
	const familyId = family?.id ?? null;
	const [trip, setTrip] = useTrip();
	const { speech, say } = useSpeech(familyId);
	const [refresh, setRefresh] = useState(0);
	const path = familyId === null ? null : familyPath(familyId, "/location");
	const locations = useApi(FamilyLocations, path, {
		pollMs: 30_000,
		refreshKey: refresh,
	});
	const me = useApi(Me, "/api/me");
	const myId = me.kind === "ready" ? me.value.identity : null;
	const sharing =
		locations.kind === "ready" &&
		locations.value.shares.some((s) => s.sharer === myId);

	return (
		<main className="win95-desktop min-h-0 overflow-y-auto p-2 sm:p-4">
			<Window
				title="Going out"
				icon={Footprints}
				className="mx-auto w-full max-w-xl"
				status={TRAFFIC_NOTE}
			>
				<div className="grid gap-4 p-2 text-[18px]">
					<TripPlan trip={trip} setTrip={setTrip} say={say} speech={speech} />

					<HelpHome
						familyId={familyId}
						trip={trip}
						sharing={sharing}
						say={say}
						speech={speech}
					/>

					<LocationPanel
						familyId={familyId}
						trip={trip}
						sharing={sharing}
						locations={locations}
						me={me}
						onChange={() => setRefresh((n) => n + 1)}
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
	onChange,
}: {
	familyId: string | null;
	trip: Trip | null;
	sharing: boolean;
	locations: ApiState<FamilyLocations>;
	me: ApiState<Me>;
	onChange: () => void;
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
				<OwnLocation locations={locations.value} me={me.value.identity} />
				<SharingControls
					familyId={familyId}
					locations={locations.value}
					me={me.value.identity}
					onChange={onChange}
					records={records}
				/>
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
				onChange={(event) => setDestination(event.target.value)}
				placeholder="The pharmacy on Main Street"
			/>
			<label htmlFor="trip-purpose">What for? (you can leave this empty)</label>
			<input
				id="trip-purpose"
				className="win95-inset win95-field h-12 bg-card px-2"
				value={purpose}
				onChange={(event) => setPurpose(event.target.value)}
				placeholder="pick up my pills"
			/>
			<p className="text-[16px]">Saved on this device only.</p>
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
	| { readonly kind: "idle" | "sending" | "sent" }
	| { readonly kind: "failed"; readonly message: string };

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
	// One id per help request, reused by a retry, so the family gets the message once.
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
			FamilyMessage,
			familyPath(familyId, "/messages"),
			{
				method: "POST",
				body: { clientId: clientId.current, body: helpMessage(trip, sharing) },
			},
		);
		if (result.kind === "ready") {
			clientId.current = null;
			setHelp({ kind: "sent" });
			void say("help", "I told your family that you need help getting home.");
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
			<h3 id="help" className="font-bold">
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
				{help.kind === "sent" &&
					"Your family got a message in Telly's family chat."}
			</p>
			{help.kind === "failed" && (
				<p className="font-bold text-[16px] text-destructive" role="alert">
					{help.message}
				</p>
			)}
			{speech.key === "help" && <SpeechLine speech={speech} />}
			<div className="grid gap-2 sm:grid-cols-2">
				{contacts.momPhone === null ? (
					<p className="text-[16px]">
						Add Mom's number in Settings to call her here.
					</p>
				) : (
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
			<label className="text-[16px]" htmlFor="home-address">
				Home address, for Directions home (saved on this device only)
			</label>
			<input
				id="home-address"
				className="win95-inset win95-field h-12 bg-card px-2"
				value={home}
				onChange={(event) => {
					setHome(event.target.value);
					localStorage.setItem(HOME_KEY, event.target.value);
				}}
			/>
		</section>
	);
}

const reportText = (
	reporting: Reporting,
	trip: Trip | null,
	sharing: boolean,
) => {
	if (!sharing)
		return "Not shared. Telly sends your location only to people you choose.";
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

function OwnLocation({
	locations,
	me,
}: {
	locations: FamilyLocations;
	me: string;
}) {
	const now = useNow();
	const own = locations.locations.find((l) => l.sharer === me);
	return own === undefined ? null : (
		<LocationCard location={own} name="What your family sees" now={now} />
	);
}
