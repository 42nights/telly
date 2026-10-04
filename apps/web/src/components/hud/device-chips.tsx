import type { HealthSample, Sources } from "@health/contracts";
import { Glasses, Smartphone, Upload, Watch } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Hint } from "@/components/win95";
import { usePendingCount } from "@/lib/pending";

import { type Battery, type Chip, phoneLine, wearableLine } from "./devices";

/** The part of the Battery Status API this screen reads (Chromium only; absent from the DOM types). */
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

const chip =
	"win95-inset flex items-center gap-1.5 bg-card px-2 py-1 text-[15px] [&_svg]:shrink-0";

function DeviceChip({
	icon: Icon,
	line,
	className = "",
}: {
	icon: typeof Watch;
	line: Chip;
	className?: string;
}) {
	return (
		<Hint text={line.detail} className={`${chip} ${className}`}>
			<Icon aria-hidden className="size-4" />
			{line.text}
		</Hint>
	);
}

/** Phone, glasses, and wearable chips, each on its own, plus any actions saved on this device. */
export function DeviceChips({
	sources,
	samples,
	now,
}: {
	/** Null while the source list is unknown. */
	sources: Sources | null;
	/** Null while the family's records are unknown. */
	samples: readonly HealthSample[] | null;
	now: number;
}) {
	const online = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true,
	);
	const battery = useBattery();
	const pending = usePendingCount();
	return (
		<>
			<DeviceChip
				icon={Smartphone}
				line={phoneLine(online, battery)}
				className={online ? "" : "text-destructive"}
			/>
			<DeviceChip
				icon={Glasses}
				line={{
					text: "Glasses not paired",
					detail: "Optional: nothing needs them.",
				}}
			/>
			<DeviceChip icon={Watch} line={wearableLine(sources, samples, now)} />
			{pending > 0 && (
				<span role="status">
					<DeviceChip
						icon={Upload}
						line={{
							text:
								pending === 1
									? "1 action waiting"
									: `${pending} actions waiting`,
							detail:
								"Saved on this phone. Sent once when the connection returns.",
						}}
					/>
				</span>
			)}
		</>
	);
}
