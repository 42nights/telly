import { Health } from "@health/contracts";
import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Moon, Pause, Play } from "lucide-react";
import { useCallback, useState } from "react";

import {
	useBattery,
	useChime,
	useOnline,
	useSleepSound,
} from "@/components/bedtime/hooks";
import {
	chargeLine,
	connectionLine,
	type Line,
	SLEEP_TIMERS,
	timerLeft,
} from "@/components/bedtime/logic";
import { OvernightReminders } from "@/components/bedtime/reminders";
import { STALE_MS, usePolled } from "@/components/hud/use-polled";
import { Window } from "@/components/hud/window";
import { Emergency, useEmergency } from "@/components/wearer/emergency";
import { Request } from "@/components/wearer/request";
import { useNow } from "@/components/wearer/use-now";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/bedtime")({
	component: Bedtime,
});

function OvernightCheck({
	now,
	soundAllowed,
}: {
	now: number;
	soundAllowed: boolean;
}) {
	const battery = useBattery();
	const online = useOnline();
	const health = usePolled(Health, "/health");
	const serverLive =
		health.latest?.kind === "ready" && now - (health.okAt ?? 0) <= STALE_MS;
	// What the app can and cannot do tonight. Missing pieces stay visible, never "all set".
	const lines: readonly Line[] = [
		soundAllowed
			? { ok: true, text: "Reminder sound on." }
			: {
					ok: false,
					text: "Reminder sound blocked by the browser · tap this screen once to allow it.",
				},
		chargeLine(battery),
		connectionLine(online, serverLive),
		{
			ok: true,
			text: "Glasses not needed. Taking them off changes nothing here.",
		},
		{ ok: false, text: "No supported speaker yet (issue #46)." },
		{
			ok: false,
			text: "WHOOP buzz off · not verified on the strap (issue #38).",
		},
	];
	return (
		<fieldset className="border border-border p-2">
			<legend className="px-1 font-bold">Tonight</legend>
			<ul className="grid gap-2 text-[18px]">
				{lines.map(({ ok, text }) => (
					<li key={text} className="flex items-start gap-2">
						<span
							aria-hidden
							className={`win95-inset mt-1.5 size-3 shrink-0 ${ok ? "bg-[#008000]" : "bg-destructive"}`}
						/>
						<span>{text}</span>
					</li>
				))}
			</ul>
		</fieldset>
	);
}

function Bedtime() {
	const now = useNow();
	const familyId = useFamily().family?.id ?? null;
	const emergency = useEmergency(familyId);
	const sound = useSleepSound();
	const { allowed, chime } = useChime();
	const [timer, setTimer] = useState<number | null>(30);
	const left = timerLeft(sound.endsAt, now);
	const { pause } = sound;
	// An important prompt always wins over the sleep sound.
	const onPrompt = useCallback(() => {
		pause();
		chime();
	}, [pause, chime]);

	return (
		<main className="mx-auto w-full max-w-3xl p-2 md:p-4">
			<Window icon={Moon} title="Bedtime">
				<div className="grid gap-4 p-2 md:p-4">
					<fieldset className="grid gap-2 border border-border p-2">
						<legend className="px-1 font-bold">Reminders tonight</legend>
						<OvernightReminders familyId={familyId} onPrompt={onPrompt} />
					</fieldset>

					<OvernightCheck now={now} soundAllowed={allowed} />

					<fieldset className="grid gap-3 border border-border p-2 text-[18px]">
						<legend className="px-1 font-bold">Sleep sound · optional</legend>
						<p>
							Soft noise made on this phone. It stops when you ask for help.
						</p>
						<Button
							className="win95-primary h-14 text-[20px] [&_svg]:size-6"
							onClick={() =>
								sound.playing ? sound.pause() : sound.play(timer)
							}
						>
							{sound.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
							{sound.playing ? "Pause sound" : "Play sound"}
						</Button>
						<label className="grid gap-1">
							Volume
							<input
								type="range"
								min={0}
								max={1}
								step={0.05}
								value={sound.volume}
								onChange={(e) => sound.setVolume(Number(e.target.value))}
							/>
						</label>
						<label className="grid gap-1">
							Sleep timer
							<select
								className="win95-inset win95-field bg-card p-2"
								value={timer ?? "off"}
								onChange={(e) => {
									const next =
										e.target.value === "off" ? null : Number(e.target.value);
									setTimer(next);
									if (sound.playing) sound.play(next);
								}}
							>
								{SLEEP_TIMERS.map((minutes) => (
									<option key={minutes ?? "off"} value={minutes ?? "off"}>
										{minutes === null ? "No timer" : `${minutes} minutes`}
									</option>
								))}
							</select>
						</label>
						<p aria-live="polite">
							{sound.playing
								? left === null
									? "Playing until you pause it."
									: `Stops in ${left}.`
								: "Sound is off."}
						</p>
					</fieldset>

					{/* A request for help always wins over the sleep sound. */}
					<section
						aria-label="Ask for help"
						className="grid gap-2"
						onPointerDownCapture={sound.pause}
						onKeyDownCapture={sound.pause}
					>
						<h2 className="font-bold text-[16px]">Need something?</h2>
						<Request
							familyId={familyId}
							onEmergency={emergency.start}
							talkNote="Talk needs a paired person. You can still type."
						/>
						<Emergency emergency={emergency} familyId={familyId} />
					</section>
				</div>
			</Window>
		</main>
	);
}
