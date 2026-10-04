// Appointments (#44): upcoming visits in their own time zone, suggestions kept apart from provider-
// confirmed bookings, and preparation for each visit. Telly books nothing and contacts no provider.
import {
	Appointments,
	type NewAppointment,
} from "@health/contracts/appointments";
import { Button } from "@health/ui/components/button";
import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { failureText } from "@/components/reports/use-report-sheet";
import { useNow } from "@/components/wearer/use-now";
import { ApiNotice } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

import { buttonClass, fieldClass, useAction } from "./action";
import { emptyPrep, localToUtc, prepOf } from "./logic";
import { PrepFields, VisitCard } from "./visit";

const NOTICE =
	"Simulated: Telly has no scheduling or clinician access. A request books nothing; only the provider's confirmation does.";

export function AppointmentsScreen() {
	const { state, family } = useFamily();
	if (family === null)
		return (
			<Window title="Appointments" icon={CalendarClock} status="No person">
				<ApiNotice
					state={
						state.kind === "ready"
							? { kind: "error", message: "No person is paired yet." }
							: state
					}
					what="appointments"
				/>
			</Window>
		);
	return <FamilyAppointments familyId={family.id} />;
}

function FamilyAppointments({ familyId }: { familyId: string }) {
	const state = useApi(Appointments, familyPath(familyId, "/appointments"));
	const now = useNow();
	if (state.kind !== "ready")
		return (
			<Window title="Appointments" icon={CalendarClock} status={NOTICE}>
				<ApiNotice state={state} what="appointments" />
			</Window>
		);
	const { appointments } = state.value;
	const upcoming = appointments.filter(
		(a) => a.status !== "cancelled" && Date.parse(a.visit.startsAt) >= now,
	);
	const past = appointments.filter((a) => !upcoming.includes(a));
	const cards = (list: typeof appointments) =>
		list.map((appointment) => (
			<VisitCard
				key={appointment.id}
				appointment={appointment}
				familyId={familyId}
			/>
		));
	return (
		<div className="grid gap-3">
			<Window title="Upcoming visits" icon={CalendarClock} status={NOTICE}>
				<div className="grid gap-2">
					{upcoming.length === 0 ? (
						<p className="p-2 text-sm">No upcoming visits recorded.</p>
					) : (
						cards(upcoming)
					)}
				</div>
			</Window>
			<NewVisit familyId={familyId} />
			{past.length > 0 && (
				<Window title="Past and cancelled" icon={CalendarClock}>
					<div className="grid gap-2">{cards(past)}</div>
				</Window>
			)}
		</div>
	);
}

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Some engines list neither `UTC` nor the device's alias zone, so the device zone is added first.
const zones = [...new Set([localZone, ...Intl.supportedValuesOf("timeZone")])];

function NewVisit({ familyId }: { familyId: string }) {
	const [visit, setVisit] = useState({
		title: "",
		clinician: "",
		location: "",
		local: "",
		timeZone: localZone,
	});
	const [prep, setPrep] = useState(emptyPrep);
	const { busy, failure, run } = useAction();
	let startsAt: string | null = null;
	try {
		startsAt = localToUtc(visit.local, visit.timeZone);
	} catch {}
	const ready = visit.title.trim() !== "" && startsAt !== null;

	const save = async () => {
		if (startsAt === null) return;
		const body: NewAppointment = {
			source: "member",
			visit: {
				title: visit.title.trim(),
				clinician: visit.clinician.trim() || null,
				location: visit.location.trim() || null,
				startsAt,
				timeZone: visit.timeZone,
			},
			prep: prepOf(prep),
		};
		const path = familyPath(familyId, "/appointments");
		if (await run("Saving suggestion…", path, "POST", body)) {
			setVisit({ ...visit, title: "", clinician: "", location: "", local: "" });
			setPrep(emptyPrep);
		}
	};

	const text = (field: "title" | "clinician" | "location", label: string) => (
		<label className="grid gap-1">
			{label}
			<input
				className={`${fieldClass} h-11`}
				value={visit[field]}
				onChange={(e) => setVisit({ ...visit, [field]: e.target.value })}
			/>
		</label>
	);

	return (
		<Window
			title="Suggest a visit"
			icon={CalendarClock}
			status={
				busy ??
				(failure === null
					? "A suggestion is not a booking."
					: failureText(failure))
			}
		>
			<form
				className="grid gap-2 p-1 text-sm md:grid-cols-2"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				{text("title", "Visit")}
				{text("clinician", "Clinician (optional)")}
				{text("location", "Place (optional)")}
				<label className="grid gap-1">
					Date and time (local to the visit)
					<input
						type="datetime-local"
						className={`${fieldClass} h-11`}
						value={visit.local}
						onChange={(e) => setVisit({ ...visit, local: e.target.value })}
					/>
				</label>
				<label className="grid gap-1">
					Time zone of the visit
					<select
						className={`${fieldClass} h-11`}
						value={visit.timeZone}
						onChange={(e) => setVisit({ ...visit, timeZone: e.target.value })}
					>
						{zones.map((zone) => (
							<option key={zone}>{zone}</option>
						))}
					</select>
				</label>
				<div className="grid gap-2 md:col-span-2">
					<PrepFields draft={prep} onChange={setPrep} />
				</div>
				<Button
					type="submit"
					className={`${buttonClass} win95-primary justify-self-start`}
					disabled={!ready || busy !== null}
				>
					Save suggestion
				</Button>
			</form>
		</Window>
	);
}
