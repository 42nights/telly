// The app frame's Win95 status bar, on every page and in both views: the phone, the WHOOP strap,
// monitoring, the server, and actions saved on this phone. One short phrase per pane on desktop,
// only an icon and a state dot on a phone; the details are in each pane's tooltip.
import { DEMO_SOURCE, FamilyRecords, Health, Sources } from "@health/contracts";
import { Monitoring } from "@health/contracts/alerts";
import { cn } from "@health/ui/lib/utils";
import {
	Activity,
	type LucideIcon,
	PlayCircle,
	Server,
	Smartphone,
	Upload,
	Watch,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { monitoringLevel } from "@/components/family/logic";
import { type Polled, STALE_MS, usePolled } from "@/components/hud/use-polled";
import { useNow } from "@/components/wearer/use-now";
import { Hint } from "@/components/win95";
import { type ApiState, familyPath, useApi } from "@/lib/api";
import { usePendingCount } from "@/lib/pending";

import { type Battery, type Pane, phoneLine, wearableLine } from "./devices";

/** The part of the Battery Status API this bar reads (Chromium only; absent from the DOM types). */
type BatteryManager = EventTarget & {
	readonly level: number;
	readonly charging: boolean;
};

/** The phone battery, null when this browser reports none, undefined while reading. */
function useBattery(): Battery | undefined {
	const [battery, setBattery] = useState<Battery | undefined>(undefined);
	useEffect(() => {
		const read = (
			navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
		).getBattery;
		if (read === undefined) {
			setBattery(null);
			return;
		}
		let manager: BatteryManager | null = null;
		const update = () => {
			if (manager !== null)
				setBattery({ level: manager.level, charging: manager.charging });
		};
		read
			.call(navigator)
			.then((found) => {
				manager = found;
				update();
				found.addEventListener("levelchange", update);
				found.addEventListener("chargingchange", update);
			})
			.catch(() => setBattery(null));
		return () => {
			manager?.removeEventListener("levelchange", update);
			manager?.removeEventListener("chargingchange", update);
			manager = null;
		};
	}, []);
	return battery;
}

const subscribeOnline = (listener: () => void) => {
	window.addEventListener("online", listener);
	window.addEventListener("offline", listener);
	return () => {
		window.removeEventListener("online", listener);
		window.removeEventListener("offline", listener);
	};
};

/** The server pane: live only while `/health` answered within `STALE_MS`. */
function serverLine(health: Polled<Health>, now: number): Pane {
	const age =
		health.okAt === undefined
			? "No reply yet."
			: `Last reply ${Math.max(0, Math.round((now - health.okAt) / 1_000))} s ago.`;
	if (health.latest === undefined)
		return { text: "Checking the server…", detail: age, state: "unknown" };
	if (health.latest.kind === "error")
		return {
			text: "Server offline",
			detail: `${health.latest.message}. ${age}`,
			state: "bad",
		};
	if (now - (health.okAt ?? 0) > STALE_MS)
		return { text: "Server data stale", detail: age, state: "warn" };
	return { text: "Server online", detail: age, state: "ok" };
}

/** The monitoring pane for the selected person; never "on" without a fresh reading for each rule. */
function monitoringLine(state: ApiState<Monitoring>): Pane {
	if (state.kind === "loading")
		return {
			text: "Monitoring…",
			detail: "Asking the server.",
			state: "unknown",
		};
	if (state.kind !== "ready")
		return {
			text: "Monitoring unknown",
			detail: state.kind === "signed_out" ? "Sign in first." : state.message,
			state: "unknown",
		};
	const level = monitoringLevel(state.value);
	return level === "on"
		? {
				text: "Monitoring on",
				detail: "Every threshold has a fresh reading.",
				state: "ok",
			}
		: level === "partial"
			? {
					text: "Monitoring partial",
					detail:
						"Some thresholds have no fresh reading, so an alert could be missed.",
					state: "warn",
				}
			: {
					text: "Monitoring off",
					detail:
						state.value.thresholds.length === 0
							? "No thresholds set: nothing is monitored."
							: "No threshold has a fresh reading.",
					state: "bad",
				};
}

/** Reads the person's monitoring only while a person is selected. */
function MonitoringPane({ familyId }: { familyId: string }) {
	const state = useApi(Monitoring, familyPath(familyId, "/monitoring"), {
		pollMs: 60_000,
	});
	return (
		<StatusPane icon={Activity} pane={monitoringLine(state)} align="end" />
	);
}

/** "Demo", shown only while the selected family replays a WHOOP recording (#334). */
function DemoPane({ familyId }: { familyId: string }) {
	const records = useApi(FamilyRecords, familyPath(familyId));
	return records.kind === "ready" &&
		records.value.samples.some(
			(s) => s.familyId === familyId && s.source === DEMO_SOURCE,
		) ? (
		<StatusPane
			icon={PlayCircle}
			pane={{
				text: "Demo",
				detail: "Replaying a real WHOOP recording.",
				state: "warn",
			}}
		/>
	) : null;
}

const dot: Record<Pane["state"], string> = {
	ok: "bg-[#008000]",
	warn: "bg-[#c0a000]",
	bad: "bg-destructive",
	unknown: "bg-[#808080]",
};

/** One sunken pane. On a phone the words are for screen readers only; tap or focus shows the tip. */
function StatusPane({
	icon: Icon,
	pane,
	align = "start",
}: {
	icon: LucideIcon;
	pane: Pane;
	align?: "start" | "end";
}) {
	return (
		<Hint
			text={pane.detail}
			align={align}
			side="above"
			className={cn(
				"win95-status flex min-h-7 select-none items-center gap-1.5 px-2 text-sm [-webkit-touch-callout:none]",
				pane.state === "bad" && "text-destructive",
			)}
		>
			<Icon aria-hidden className="size-4 shrink-0" />
			<span
				aria-hidden
				className={cn("size-2.5 shrink-0 border border-black", dot[pane.state])}
			/>
			<span className="max-[899px]:sr-only">{pane.text}</span>
		</Hint>
	);
}

/** The status bar under the screens. `familyId` is the selected person, null when there is none. */
export function StatusBar({ familyId }: { familyId: string | null }) {
	const now = useNow();
	const online = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true,
	);
	const battery = useBattery();
	const pending = usePendingCount();
	const health = usePolled(Health, "/health");
	const sources = usePolled(Sources, "/api/sources");
	return (
		<footer className="app-status flex shrink-0 flex-wrap gap-1 max-[899px]:justify-around">
			<StatusPane icon={Smartphone} pane={phoneLine(online, battery)} />
			<StatusPane
				icon={Watch}
				pane={wearableLine(
					sources.latest?.kind === "ready" ? sources.latest.value : null,
					now,
				)}
			/>
			{familyId === null ? (
				<StatusPane
					icon={Activity}
					align="end"
					pane={{
						text: "Monitoring off",
						detail: "No person is selected.",
						state: "bad",
					}}
				/>
			) : (
				<>
					<MonitoringPane familyId={familyId} />
					<DemoPane familyId={familyId} />
				</>
			)}
			<StatusPane icon={Server} pane={serverLine(health, now)} align="end" />
			{pending > 0 && (
				<span role="status" className="contents">
					<StatusPane
						icon={Upload}
						align="end"
						pane={{
							text: pending === 1 ? "1 waiting" : `${pending} waiting`,
							detail: `${pending === 1 ? "1 action is" : `${pending} actions are`} saved on this phone. They are sent once when the connection returns.`,
							state: "warn",
						}}
					/>
				</span>
			)}
		</footer>
	);
}
