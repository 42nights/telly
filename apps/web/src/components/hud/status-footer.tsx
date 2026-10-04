import { type FamilyRecords, Health, Sources } from "@health/contracts";

import { DeviceChips } from "@/components/hud/device-chips";
import { type Polled, STALE_MS, usePolled } from "@/components/hud/use-polled";
import type { ApiState } from "@/lib/api";

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
