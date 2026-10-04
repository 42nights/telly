import { Health } from "@health/contracts";
import {
	ReminderHistory,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import { SavedSpeakerSettings, SpeakerStatus } from "@health/contracts/speaker";
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
	speakerLine,
	timerLeft,
} from "@/components/bedtime/logic";
import { OvernightReminders } from "@/components/bedtime/reminders";
import { STALE_MS, usePolled } from "@/components/hud/use-polled";
import { Window } from "@/components/hud/window";
import { Emergency, useEmergency } from "@/components/wearer/emergency";
import { Request } from "@/components/wearer/request";
import { useNow } from "@/components/wearer/use-now";
import { Hint, Tip } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";
import { loadFamilyReads, useFamily } from "@/lib/family";

export const Route = createFileRoute("/bedtime")({
	loader: loadFamilyReads((familyId) => [
		[SavedSpeakerSettings, familyPath(familyId, "/speaker-settings")],
		[SpeakerStatus, familyPath(familyId, "/speaker")],
		[ReminderHistory, familyPath(familyId, "/reminder-occurrences")],
		[SavedReminderSettings, familyPath(familyId, "/reminder-settings")],
	]),
	component: Bedtime,
});

function OvernightCheck({
	familyId,
	now,
	soundAllowed,
}: {
	familyId: string | null;
	now: number;
	soundAllowed: boolean;
}) {
	const battery = useBattery();
	const online = useOnline();
	const health = usePolled(Health, "/health");
	const serverLive =
		health.latest?.kind === "ready" && now - (health.okAt ?? 0) <= STALE_MS;
	const path = familyId === null ? null : familyPath(familyId, "");
	const speaker = useApi(
		SavedSpeakerSettings,
		path === null ? null : `${path}/speaker-settings`,
	);
	const simulator = useApi(
		SpeakerStatus,
		path === null ? null : `${path}/speaker`,
	);
	// What the app can and cannot do tonight. Missing pieces stay visible, never "all set".
	const lines: readonly Line[] = [
		...(soundAllowed ? [{ ok: true, text: "Reminder sound on." }] : []),
		chargeLine(battery),
		connectionLine(online, serverLive),
		{
			ok: true,
			text: "Glasses not needed. Taking them off changes nothing here.",
		},
		speakerLine(
			speaker.kind === "ready" ? speaker.value.settings.enabled : null,
			simulator.kind === "ready" ? simulator.value.mode : null,
		),
		{
			ok: false,
			text: "WHOOP buzz off · the strap does not buzz for reminders yet.",
		},
	];
	return (
		<fieldset className="grid gap-2 border border-border p-2">
			<legend className="px-1 font-bold">Tonight</legend>
			{/* The one thing the wearer must act on stays a full sentence. */}
			{!soundAllowed && (
				<p className="flex items-start gap-2 font-bold text-[18px] text-destructive">
					<span
						aria-hidden
						className="mt-1.5 size-3 shrink-0 border border-black bg-destructive"
					/>
					Reminder sound blocked by the browser · tap this screen once to allow
					it.
				</p>
			)}
			<ul className="flex flex-wrap gap-1.5 text-[16px]">
				{lines.map(({ ok, text }) => (
					<li key={text}>
						<Hint
							text={text}
							className="win95-inset flex items-center gap-1.5 bg-card px-2 py-1"
						>
							<span
								aria-hidden
								className={`size-3 shrink-0 border border-black ${ok ? "bg-[#008000]" : "bg-destructive"}`}
							/>
							{/* The short phrase; the whole line is the tooltip. */}
							{text.split(" · ")[0]?.split(". ")[0]?.replace(/\.$/, "")}
						</Hint>
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
		<main>
			<Window icon={Moon} title="Bedtime" className="mx-auto w-full max-w-6xl">
				<div className="grid content-start gap-3 p-1 lg:grid-cols-2">
					<div className="grid content-start gap-3">
						<fieldset className="grid gap-2 border border-border p-2">
							<legend className="px-1 font-bold">Reminders tonight</legend>
							<OvernightReminders familyId={familyId} onPrompt={onPrompt} />
						</fieldset>

						<OvernightCheck
							familyId={familyId}
							now={now}
							soundAllowed={allowed}
						/>

						{/* Folded so the screen fits a phone; it opens with one tap. */}
						<details className="border border-border p-2 text-[18px]">
							<summary className="min-h-11 cursor-pointer content-center font-bold">
								Sleep sound · optional
							</summary>
							<div className="grid gap-3 pt-2">
								<Button
									className="win95-primary h-14 text-[20px] [&_svg]:size-6"
									onClick={() =>
										sound.playing ? sound.pause() : sound.play(timer)
									}
								>
									{sound.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
									{sound.playing ? "Pause sound" : "Play sound"}
								</Button>
								<div className="grid grid-cols-2 gap-2">
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
													e.target.value === "off"
														? null
														: Number(e.target.value);
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
								</div>
								<p aria-live="polite" className="flex items-center gap-1">
									{sound.playing
										? left === null
											? "Playing until you pause it."
											: `Stops in ${left}.`
										: "Sound is off."}
									<Tip text="Soft noise made on this phone. It stops when you ask for help." />
								</p>
							</div>
						</details>
					</div>

					{/* A request for help always wins over the sleep sound. */}
					<section
						aria-label="Ask for help"
						className="grid content-start gap-2"
						onPointerDownCapture={sound.pause}
						onKeyDownCapture={sound.pause}
					>
						<h2 className="sr-only">Need something?</h2>
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
