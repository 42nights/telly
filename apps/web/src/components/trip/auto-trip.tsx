// Automatic trips (#302) for every screen. While the signed-in person shares their location and
// turns on automatic trips, or a trip they started by hand is open, this device sends its position;
// the database decides when a trip starts and ends. Inside the iOS shell, the same switch starts and
// stops the phone's background location (`apps/native`).
import {
	type AwayInput,
	type HomeInput,
	HomeWatch,
} from "@health/contracts/location";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

import {
	type ApiResult,
	type ApiState,
	apiRequest,
	familyPath,
	useApi,
} from "@/lib/api";
import { useFamily } from "@/lib/family";

import { type Reporting, useLocationReporter } from "./use-trip";

type AutoTrip = {
	readonly familyId: string | null;
	readonly home: ApiState<HomeWatch>;
	readonly reporting: Reporting;
	/** Saves home settings (`PUT /location/home`) or starts or ends a trip (`POST /location/away`). */
	readonly change: (
		request:
			| { readonly path: "/location/home"; readonly body: HomeInput }
			| { readonly path: "/location/away"; readonly body: AwayInput },
	) => Promise<ApiResult<HomeWatch>>;
	/** Reads the settings again, such as after a share changed. */
	readonly refresh: () => void;
};

const Context = createContext<AutoTrip | null>(null);

export function AutoTripProvider({ children }: { children: ReactNode }) {
	const { family } = useFamily();
	const familyId = family?.id ?? null;
	const [refreshKey, setRefreshKey] = useState(0);
	const home = useApi(
		HomeWatch,
		familyId === null ? null : familyPath(familyId, "/location/home"),
		{ pollMs: 60_000, refreshKey },
	);
	const active =
		home.kind === "ready" &&
		home.value.sharing &&
		(home.value.autoTrip || home.value.awaySince !== null);
	const reporting = useLocationReporter(familyId, active);
	const known = home.kind === "ready";

	useEffect(() => {
		if (!known) return;
		globalThis.ReactNativeWebView?.postMessage(
			JSON.stringify({
				type: "location-watch",
				familyId: active ? familyId : null,
			}),
		);
	}, [known, active, familyId]);

	const refresh = () => setRefreshKey((n) => n + 1);
	const change: AutoTrip["change"] = async ({ path, body }) => {
		if (familyId === null)
			return { kind: "error", message: "No family is set up on this device." };
		const result = await apiRequest(HomeWatch, familyPath(familyId, path), {
			method: path === "/location/home" ? "PUT" : "POST",
			body,
		});
		if (result.kind === "ready") refresh();
		return result;
	};

	return (
		<Context.Provider value={{ familyId, home, reporting, change, refresh }}>
			{children}
		</Context.Provider>
	);
}

export const useAutoTrip = (): AutoTrip => {
	const value = useContext(Context);
	if (value === null)
		throw new Error("useAutoTrip must be used inside AutoTripProvider");
	return value;
};
