import { type FamilyRecords, Health, Sources } from "@health/contracts";

import { DeviceChips } from "@/components/hud/device-chips";
import { type Polled, STALE_MS, usePolled } from "@/components/hud/use-polled";
import { Hint } from "@/components/win95";
import type { ApiState } from "@/lib/api";

/** The server chip: live only while `/health` answered within `STALE_MS`. */
function serverStatus(health: Polled<Health>, now: number) {
	const age =
		health.okAt === undefined
			? "No reply yet."
			: `Last reply ${Math.max(0, Math.round((now - health.okAt) / 1_000))} s ago.`;
	if (health.latest === undefined)
		return { live: false, text: "Checking the server…", detail: age };
	if (health.latest.kind === "error")
		return {
			live: false,
			text: "Server offline",
			detail: `${health.latest.message}. ${age}`,
		};
	if (now - (health.okAt ?? 0) > STALE_MS)
		return { live: false, text: "Server data stale", detail: age };
	return { live: true, text: "Server online", detail: age };
}

function monitoringStatus(sources: Polled<Sources>) {
	if (sources.latest === undefined)
		return { text: "Monitoring: checking…", detail: "Asking the server." };
	if (sources.latest.kind === "error")
		return {
			text: "Monitoring: unknown",
			detail: "The server did not answer.",
		};
	if (sources.latest.value.sources.length === 0)
		return {
			text: "Monitoring: stopped",
			detail: "No health source configured.",
		};
	return {
		text: "Monitoring: stopped",
		detail: "Family › Thresholds shows each rule.",
	};
}

const chip = "win95-inset bg-card px-2 py-1 text-[15px]";

/** Footer chips: phone, glasses, and wearable apart, then monitoring and the server. */
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
	const monitoring = monitoringStatus(sources);
	return (
		<footer className="flex flex-wrap gap-1.5 self-end md:col-span-2">
			<DeviceChips
				sources={sources.latest?.kind === "ready" ? sources.latest.value : null}
				samples={records?.kind === "ready" ? records.value.samples : null}
				now={now}
			/>
			<Hint text={monitoring.detail} className={chip}>
				{monitoring.text}
			</Hint>
			<Hint
				text={server.detail}
				className={`${chip} flex items-center gap-1.5 ${server.live ? "" : "text-destructive"}`}
			>
				<span
					aria-hidden
					className={`win95-inset size-3 shrink-0 ${server.live ? "bg-[#008000]" : "bg-destructive"}`}
				/>
				{server.text}
			</Hint>
		</footer>
	);
}
