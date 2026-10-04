import {
	type FamilyRecords,
	Health,
	type Loaded,
	loadDecoded,
	Sources,
} from "@health/contracts";
import type { Schema } from "effect";
import { useEffect, useState } from "react";

import { DeviceChips } from "@/components/hud/device-chips";
import { ENV } from "@/env";
import type { ApiState } from "@/lib/api";

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
export function StatusFooter({
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
