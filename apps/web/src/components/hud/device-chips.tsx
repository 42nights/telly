import type { HealthSample, Sources } from "@health/contracts";
import { Glasses, Smartphone, Upload, Watch } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { usePendingCount } from "@/lib/pending";

import { type Battery, phoneLine, wearableLine } from "./devices";

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
			<span className={`${chip} ${online ? "" : "text-destructive"}`}>
				<Smartphone aria-hidden className="size-4" />
				{phoneLine(online, battery)}
			</span>
			<span className={chip}>
				<Glasses aria-hidden className="size-4" />
				Glasses not paired · optional · nothing needs them
			</span>
			<span className={chip}>
				<Watch aria-hidden className="size-4" />
				{wearableLine(sources, samples, now)}
			</span>
			{pending > 0 && (
				<span className={chip} role="status">
					<Upload aria-hidden className="size-4" />
					{pending === 1 ? "1 action" : `${pending} actions`} saved on this
					phone · sent once when the connection returns
				</span>
			)}
		</>
	);
}
