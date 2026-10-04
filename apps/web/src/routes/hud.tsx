import { Button, buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChefHat, CloudOff, Home, RotateCw, Utensils } from "lucide-react";

import { ExerciseInvite } from "@/components/exercise/session";
import { Window } from "@/components/hud/window";
import { MealCheckIn } from "@/components/meal-check-in/check-in";
import { SetupChecklist } from "@/components/onboarding/checklist";
import { Emergency, useEmergency } from "@/components/wearer/emergency";
import { HeartReading } from "@/components/wearer/heart";
import { WearerInbox } from "@/components/wearer/inbox";
import { MedicationReminders } from "@/components/wearer/medication-reminder";
import { Request } from "@/components/wearer/request";
import { TripCheckInCard } from "@/components/wearer/trip";
import { useNow } from "@/components/wearer/use-now";
import {
	loadWearerHome,
	useWearerRecords,
} from "@/components/wearer/use-wearer-records";

export const Route = createFileRoute("/hud")({
	loader: loadWearerHome,
	component: HudComponent,
});

function OfflineBanner({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div
			className="win95-raised grid grid-cols-[auto_1fr] gap-3 p-4"
			role="alert"
		>
			<CloudOff aria-hidden className="size-8 text-destructive" />
			<div className="grid gap-2">
				<p className="font-semibold text-[22px]">I can't connect right now.</p>
				<p className="text-[18px]">
					Questions and new messages are paused. Your family is not told that
					you are fine.
				</p>
				<p className="break-words text-[15px] text-muted-foreground">
					{message}
				</p>
				<Button
					className="win95-primary h-14 text-[20px] [&_svg]:size-6"
					onClick={onRetry}
				>
					<RotateCw aria-hidden />
					Try again
				</Button>
			</div>
		</div>
	);
}

/** Why Talk is off, by the family list's state, while no family is selected. */
const talkNote = {
	loading: "Talk is getting ready…",
	signed_out: "Sign in to use Talk. You can still type.",
	ready: "Talk needs a paired person. You can still type.",
	forbidden: "Talk is not available right now. You can still type.",
	unavailable: "Talk is not available right now. You can still type.",
	error: "Talk is not available right now. You can still type.",
} as const;

function HudComponent() {
	const now = useNow();
	const { familyId, familiesKind, records, retry } = useWearerRecords();
	const emergency = useEmergency(familyId);
	const clock = new Date(now).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

	return (
		<main className="mx-auto grid w-full max-w-6xl gap-2 p-2 md:p-4">
			<SetupChecklist />
			<Window icon={Home} title={`Home · ${clock}`}>
				<div className="grid gap-5 p-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-x-8 md:p-5">
					<div className="flex items-end justify-between gap-2 md:col-span-2">
						<div>
							<time
								className="block font-semibold text-[34px] leading-none tracking-tight sm:text-[40px]"
								dateTime={new Date(now).toISOString()}
							>
								{clock}
							</time>
							<p className="mt-1.5 text-[18px] text-muted-foreground">
								{new Date(now).toLocaleDateString([], {
									weekday: "long",
									day: "numeric",
									month: "long",
								})}
							</p>
						</div>
						<HeartReading familyId={familyId} now={now} records={records} />
					</div>

					<div className="grid min-w-0 content-start gap-3">
						{familyId !== null && <MedicationReminders familyId={familyId} />}
						{records?.kind === "unavailable" || records?.kind === "error" ? (
							<OfflineBanner message={records.message} onRetry={retry} />
						) : (
							<Request
								familyId={familyId}
								onEmergency={emergency.start}
								talkNote={talkNote[familiesKind]}
							/>
						)}
						<TripCheckInCard familyId={familyId} />
						{familyId !== null && (
							<MealCheckIn
								familyId={familyId}
								now={now}
								onUrgent={(words) => emergency.start("help", words)}
							/>
						)}
						<Link
							className={buttonVariants({
								variant: "outline",
								className: "h-14 w-full text-[20px] [&_svg]:size-6",
							})}
							data-slot="button"
							to="/meal"
						>
							<Utensils aria-hidden />
							Meal
						</Link>
						<Link
							className={buttonVariants({
								variant: "outline",
								className: "h-14 w-full text-[20px] [&_svg]:size-6",
							})}
							data-slot="button"
							to="/cooking"
						>
							<ChefHat aria-hidden />
							Cook
						</Link>
						{familyId !== null && (
							<ExerciseInvite familyId={familyId} now={now} />
						)}
						<Emergency emergency={emergency} familyId={familyId} />
					</div>

					<WearerInbox familyId={familyId} now={now} records={records} />
				</div>
			</Window>
		</main>
	);
}
