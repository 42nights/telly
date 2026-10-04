import {
	FamilyRecords,
	Health,
	type Loaded,
	loadDecoded,
	Sources,
} from "@health/contracts";
import { Button, buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { Schema } from "effect";
import { CloudOff, Home, RotateCw, Utensils } from "lucide-react";
import { useEffect, useState } from "react";

import { Alerts } from "@/components/hud/alerts";
import { DeviceChips } from "@/components/hud/device-chips";
import { Window } from "@/components/hud/window";
import { HeartReading } from "@/components/wearer/heart";
import { Messages } from "@/components/wearer/messages";
import { Request } from "@/components/wearer/request";
import { useNow } from "@/components/wearer/use-now";
import { ENV } from "@/env";
import { type ApiState, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/hud")({
	component: HudComponent,
});

const POLL_MS = 5_000;
/** A reply older than three missed polls is stale, even when no read has failed yet. */
const STALE_MS = 3 * POLL_MS;

type Polled<T> = {
	readonly latest: Loaded<T> | undefined;
	/** `Date.now()` of the last decoded reply; undefined until the server answers once. */
	readonly okAt: number | undefined;
};

/** Re-reads a server endpoint every `POLL_MS`. A read still pending at the next poll is cancelled. */
function usePolled<T>(schema: Schema.Decoder<T>, path: string): Polled<T> {
	const [polled, setPolled] = useState<Polled<T>>({
		latest: undefined,
		okAt: undefined,
	});
	useEffect(() => {
		let cancel = () => {};
		const poll = () => {
			cancel();
			cancel = loadDecoded(schema, `${ENV.VITE_SERVER_URL}${path}`, (latest) =>
				setPolled((previous) => ({
					latest,
					okAt: latest.kind === "ready" ? Date.now() : previous.okAt,
				})),
			);
		};
		poll();
		const timer = setInterval(poll, POLL_MS);
		return () => {
			clearInterval(timer);
			cancel();
		};
	}, [schema, path]);
	return polled;
}

/** The server line: live only while `/health` answered within `STALE_MS`. */
function serverStatus(health: Polled<Health>, now: number) {
	const age =
		health.okAt === undefined
			? "no reply yet"
			: `last reply ${Math.max(0, Math.round((now - health.okAt) / 1_000))} s ago`;
	if (health.latest === undefined)
		return { live: false, text: "Checking the server…", detail: undefined };
	if (health.latest.kind === "error")
		return {
			live: false,
			text: `Server unavailable · ${age}`,
			detail: health.latest.message,
		};
	if (now - (health.okAt ?? 0) > STALE_MS)
		return {
			live: false,
			text: `Server data stale · ${age}`,
			detail: undefined,
		};
	return {
		live: true,
		text: `Server connected · ${age}`,
		detail: undefined,
	};
}

/**
 * The monitoring line, from health sources only, never from server liveness. The `Sources`
 * contract allows only `not_connected`, so monitoring is stopped whenever the list is known;
 * "partial" and "on" need a connected source in the contract first.
 */
function monitoringStatus(sources: Polled<Sources>) {
	if (sources.latest === undefined) return "Monitoring: checking…";
	if (sources.latest.kind === "error")
		return "Monitoring: unknown · the server did not answer";
	if (sources.latest.value.sources.length === 0)
		return "Monitoring: stopped · no health source configured";
	return "Monitoring: stopped";
}

const chip = "win95-inset bg-card px-2 py-1 text-[15px]";

/** Footer chips: phone, glasses, and wearable apart, then monitoring and the server line. */
function StatusFooter({
	now,
	records,
}: {
	now: number;
	records: ApiState<FamilyRecords> | null;
}) {
	const health = usePolled(Health, "/health");
	const sources = usePolled(Sources, "/api/sources");
	const server = serverStatus(health, now);
	return (
		<footer className="flex flex-wrap gap-1.5 self-end md:col-span-2">
			<DeviceChips
				sources={sources.latest?.kind === "ready" ? sources.latest.value : null}
				samples={records?.kind === "ready" ? records.value.samples : null}
				now={now}
			/>
			<span className={chip}>{monitoringStatus(sources)}</span>
			<span
				className={`${chip} flex items-center gap-1.5 ${server.live ? "" : "text-destructive"}`}
				title={server.detail}
			>
				<span
					aria-hidden
					className={`win95-inset size-3 shrink-0 ${server.live ? "bg-[#008000]" : "bg-destructive"}`}
				/>
				{server.text}
			</span>
		</footer>
	);
}

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

/**
 * The selected family's records. Without a family, the family list's own state explains why;
 * with none paired, null.
 */
function useWearerRecords() {
	const { state: families, family } = useFamily();
	const [retry, setRetry] = useState(0);
	const familyRecords = useApi(
		FamilyRecords,
		family === null ? null : familyPath(family.id),
		{ pollMs: 30_000, refreshKey: retry },
	);
	let records: ApiState<FamilyRecords> | null = familyRecords;
	if (families.kind !== "ready") records = families;
	else if (family === null) records = null;
	return {
		familyId: family?.id ?? null,
		familiesKind: families.kind,
		records,
		retry: () => setRetry((n) => n + 1),
	};
}

function HudComponent() {
	const now = useNow();
	const { familyId, familiesKind, records, retry } = useWearerRecords();
	const clock = new Date(now).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

	return (
		<main className="mx-auto w-full max-w-6xl p-2 md:p-4">
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
						{records?.kind === "unavailable" || records?.kind === "error" ? (
							<OfflineBanner message={records.message} onRetry={retry} />
						) : (
							<Request familyId={familyId} talkNote={talkNote[familiesKind]} />
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
					</div>

					<section
						aria-label="Messages and alerts"
						className="grid min-w-0 content-start gap-2 md:row-span-2"
					>
						<h2 className="font-bold text-[16px]">Alerts</h2>
						{records === null ? (
							<p className="win95-inset bg-card p-3 text-[18px]">
								No person is paired yet, so there are no alerts.
							</p>
						) : (
							<Alerts familyId={familyId} now={now} records={records} />
						)}
						<h2 className="font-bold text-[16px]">Messages</h2>
						{records === null ? (
							<p className="win95-inset bg-card p-3 text-[18px]">
								No person is paired yet, so there are no messages.
							</p>
						) : (
							<Messages familyId={familyId} records={records} />
						)}
					</section>

					<StatusFooter now={now} records={records} />
				</div>
			</Window>
		</main>
	);
}
