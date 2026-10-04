// Appointments (#44): upcoming visits in their own time zone, suggestions kept apart from provider-
// confirmed bookings, and preparation for each visit. Telly books nothing and contacts no provider.
import {
	Appointments,
	type NewAppointment,
} from "@health/contracts/appointments";
import { Button } from "@health/ui/components/button";
import { CalendarClock, Plus } from "lucide-react";
import { useRef, useState } from "react";

import { Window } from "@/components/hud/window";
import { failureText } from "@/components/reports/use-report-sheet";
import { useNow } from "@/components/wearer/use-now";
import { ApiNotice, Tip } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

import { buttonClass, fieldClass, useAction } from "./action";
import { emptyPrep, localToUtc, prepOf } from "./logic";
import { PrepFields, VisitCard } from "./visit";

const NOTICE = "Telly books nothing: only the provider's confirmation does.";

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
			<Window title="Appointments" icon={CalendarClock}>
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
		<>
			<div className="flex items-center justify-end gap-1">
				<Tip text={NOTICE} />
				<NewVisit familyId={familyId} />
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-2 lg:grid lg:grid-cols-2">
				<Window
					group
					title="Upcoming visits"
					icon={CalendarClock}
					className="min-h-0 flex-1"
				>
					<div className="grid min-h-0 content-start gap-2 overflow-y-auto">
						{upcoming.length === 0 ? (
							<p className="p-2 text-sm">No upcoming visits recorded.</p>
						) : (
							cards(upcoming)
						)}
					</div>
				</Window>
				{past.length > 0 && (
					<Window
						group
						title="Past and cancelled"
						icon={CalendarClock}
						className="min-h-0 flex-1"
					>
						<div className="grid min-h-0 content-start gap-2 overflow-y-auto">
							{cards(past)}
						</div>
					</Window>
				)}
			</div>
		</>
	);
}

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Some engines list neither `UTC` nor the device's alias zone, so the device zone is added first.
const zones = [...new Set([localZone, ...Intl.supportedValuesOf("timeZone")])];

/** "Suggest a visit": a button that opens the suggestion form in a Win95 dialog. */
function NewVisit({ familyId }: { familyId: string }) {
	const dialog = useRef<HTMLDialogElement>(null);
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
			dialog.current?.close();
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
		<>
			<Button
				className={buttonClass}
				onClick={() => dialog.current?.showModal()}
			>
				<Plus aria-hidden />
				Suggest a visit
			</Button>
			<dialog
				ref={dialog}
				aria-labelledby="suggest-visit"
				className="win95-raised win95-window m-auto max-h-[calc(100svh-1rem)] w-[min(40rem,calc(100vw-1rem))] border-0 p-1.5 text-foreground backdrop:bg-black/30"
			>
				<h2
					id="suggest-visit"
					className="win95-titlebar flex items-center gap-1.5 px-1.5 py-1 text-sm"
				>
					<CalendarClock aria-hidden className="size-4" /> Suggest a visit
				</h2>
				<form
					className="flex min-h-0 flex-col gap-2 p-2 text-sm"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div className="grid content-start gap-2 md:grid-cols-2">
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
								onChange={(e) =>
									setVisit({ ...visit, timeZone: e.target.value })
								}
							>
								{zones.map((zone) => (
									<option key={zone}>{zone}</option>
								))}
							</select>
						</label>
						<div className="grid gap-2 md:col-span-2">
							<PrepFields draft={prep} onChange={setPrep} />
						</div>
					</div>
					<p className="win95-inset px-2 py-1 text-xs" role="status">
						{busy ??
							(failure === null
								? "A suggestion is not a booking."
								: failureText(failure))}
					</p>
					<div className="grid grid-cols-2 gap-2">
						<Button
							type="submit"
							className={`${buttonClass} win95-primary`}
							disabled={!ready || busy !== null}
						>
							Save suggestion
						</Button>
						<Button
							type="button"
							className={buttonClass}
							onClick={() => dialog.current?.close()}
						>
							Cancel
						</Button>
					</div>
				</form>
			</dialog>
		</>
	);
}
