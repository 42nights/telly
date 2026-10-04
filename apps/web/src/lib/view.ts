// Who uses this device: the wearer (big wearer screens first) or a family member (family tools
// first). Each device keeps its own choice; Settings › This device changes it.
import { useSyncExternalStore } from "react";

export type View = "wearer" | "family";

const KEY = "telly.view";
const listeners = new Set<() => void>();

export const getView = (): View =>
	typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "wearer"
		? "wearer"
		: "family";

export const setView = (view: View) => {
	localStorage.setItem(KEY, view);
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

export const useView = (): View => useSyncExternalStore(subscribe, getView);
