import { Health, type Loaded, loadDecoded, Sources } from "@health/contracts";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@health/ui/components/empty";
import { createFileRoute } from "@tanstack/react-router";
import type { Schema } from "effect";
import {
	BellOff,
	Camera,
	HeartPulse,
	MessageSquareOff,
	MicOff,
} from "lucide-react";
import { useEffect, useState } from "react";

import { CameraPreview } from "@/components/hud/camera-preview";
import { Window } from "@/components/hud/window";
import { ENV } from "@/env";

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
	return `Monitoring: stopped · ${sources.latest.value.sources
		.map(
			({ source, status }) =>
				`${source.toUpperCase()} ${status.replace("_", " ")}`,
		)
		.join(" · ")}`;
}

function HudComponent() {
	const health = usePolled(Health, "/health");
	const sources = usePolled(Sources, "/api/sources");
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);

	const server = serverStatus(health, now);

	return (
		<main className="win95-desktop grid min-h-0 content-start gap-2 overflow-y-auto p-2 md:grid-cols-[minmax(0,1fr)_20rem] md:grid-rows-[auto_1fr] md:content-stretch">
			{/* Regions 1 and 2 from the board sketch: status and request. */}
			<div className="flex flex-wrap gap-2 md:col-start-1">
				<Window className="flex-[1_1_16rem]" icon={HeartPulse} title="Status">
					<div className="grid gap-1 px-1 text-sm">
						<p className="flex flex-wrap items-center gap-x-2 font-bold">
							<span>Heart rate unavailable</span>
							<span aria-hidden>·</span>
							<time dateTime={new Date(now).toISOString()}>
								{new Date(now).toLocaleTimeString([], {
									hour: "numeric",
									minute: "2-digit",
								})}
							</time>
						</p>
						<p className="flex items-center gap-2">
							<span
								aria-hidden
								className={`win95-inset size-3 shrink-0 ${server.live ? "bg-[#008000]" : "bg-destructive"}`}
							/>
							<span
								className={server.live ? undefined : "text-destructive"}
								title={server.detail}
							>
								{server.text}
							</span>
						</p>
						<p>{monitoringStatus(sources)}</p>
					</div>
				</Window>
				<Window className="flex-[2_1_16rem]" icon={MicOff} title="Request">
					<p className="win95-inset bg-card px-2 py-2 text-muted-foreground text-sm">
						Voice and text requests are not available yet.
					</p>
				</Window>
			</div>

			{/* Region 3: the camera scene that object markers will draw on. */}
			<Window
				className="min-h-[24rem] md:col-start-1"
				icon={Camera}
				title="Camera"
			>
				<div className="win95-inset relative flex-1 overflow-hidden bg-card">
					<CameraPreview />
				</div>
			</Window>

			{/* Region 4: chat and notifications. */}
			<Window
				className="md:col-start-2 md:row-span-2 md:row-start-1"
				icon={MessageSquareOff}
				status="Not connected"
				title="Messages and alerts"
			>
				<div className="win95-inset grid flex-1 content-start bg-card">
					<Empty className="p-4 md:p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MessageSquareOff />
							</EmptyMedia>
							<EmptyTitle>Messages unavailable</EmptyTitle>
							<EmptyDescription>
								No message service is connected. Family messages and replies are
								not available yet.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
					<hr className="mx-2" />
					<Empty className="p-4 md:p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<BellOff />
							</EmptyMedia>
							<EmptyTitle>Health alerts unavailable</EmptyTitle>
							<EmptyDescription>
								No health source is connected, so the HUD cannot detect a
								problem. No alert does not mean all clear.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>
			</Window>
		</main>
	);
}
