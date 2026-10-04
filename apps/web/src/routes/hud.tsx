import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { CloudOff, Home, RotateCw } from "lucide-react";

import { Window } from "@/components/hud/window";
import { Emergency, useEmergency } from "@/components/wearer/emergency";
import { Request } from "@/components/wearer/request";
import { useNow } from "@/components/wearer/use-now";
import { useWearerRecords } from "@/components/wearer/use-wearer-records";

export const Route = createFileRoute("/hud")({
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
					Questions are paused. Your family is not told that you are fine.
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
		<main className="mx-auto grid w-full max-w-3xl gap-2 p-2 md:p-4">
			<Window icon={Home} title={`Home · ${clock}`}>
				<div className="grid gap-5 p-2 md:p-5">
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
					<p className="text-[20px]">
						Reminders and alerts come to your phone as texts.
					</p>
					{records?.kind === "unavailable" || records?.kind === "error" ? (
						<OfflineBanner message={records.message} onRetry={retry} />
					) : (
						<Request
							familyId={familyId}
							onEmergency={emergency.start}
							talkNote={talkNote[familiesKind]}
						/>
					)}
					<Emergency emergency={emergency} familyId={familyId} />
				</div>
			</Window>
		</main>
	);
}
