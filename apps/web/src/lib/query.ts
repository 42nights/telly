// The one TanStack Query cache for server data. A key is the API path split at `/`, so
// `/api/families/fam-1/alerts` is `["api", "families", "fam-1", "alerts"]`: one key per family and
// resource, and a key prefix names a family or a resource subtree.
import { QueryClient } from "@tanstack/react-query";

import { onSessionChange } from "./session";

const MINUTE = 60_000;

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// A failure shows at once, as before the cache; the screen offers its own retry.
			retry: false,
			// Keeps a screen's data through tab switches, so a return shows it at once.
			gcTime: 30 * MINUTE,
			// Only polled reads (live readings, alerts, status) read again when the app comes back.
			refetchOnWindowFocus: false,
			// The network came back after a gap of unknown length: the screen reads again.
			refetchOnReconnect: "always",
			// The read itself reports a lost network as "not reachable"; paused reads would hang.
			networkMode: "always",
		},
	},
});
// Listens for the app coming back and the network returning. `QueryClientProvider` would do this
// too, but screens and tests read the cache without one.
queryClient.mount();

export const apiKey = (path: string): string[] =>
	path.split("?")[0]?.split("/").filter(Boolean) ?? [];

/** Profile and settings data that rarely changes, read again after minutes. */
const SLOW: Readonly<Record<string, true>> = {
	me: true,
	families: true,
	"care-access": true,
	"care-profile": true,
	"care-instructions": true,
	cooking: true,
	"reminder-settings": true,
	"report-email": true,
	"speaker-settings": true,
	"alert-thresholds": true,
};

/**
 * How long a reply counts as current. A polled read is current for one poll; settings and the
 * family list for five minutes; everything else (records, reports, visits, needs) for 30 s. The
 * resource is the segment after the family id (the family record has none), or after `/api`.
 */
export const staleTimeFor = (key: readonly string[], pollMs?: number) =>
	pollMs ??
	(SLOW[(key[1] === "families" && key.length > 2 ? key[3] : key[1]) ?? ""]
		? 5 * MINUTE
		: 30_000);

// What a write changes besides its own resource subtree, from the server routes. "" is the family
// record (`GET /api/families/:id`: samples, alerts, messages, acknowledgements). Care needs and the
// contact ladder live under `/care`; a need contacts the family by message.
const ALSO_CHANGES: Readonly<Record<string, readonly string[]>> = {
	alerts: [""],
	messages: [""],
	emergency: ["", "alerts", "care", "messages"],
	trips: ["", "messages"],
	care: ["", "messages"],
	// A meal check-in answered with "help" opens a care need.
	"reminder-occurrences": ["", "care", "messages"],
	samples: ["", "alerts", "monitoring"],
	"alert-thresholds": ["monitoring"],
	"care-access": ["care-profile", "care-instructions"],
	"care-instructions": ["care-profile"],
	reminders: ["reminder-occurrences"],
	reports: ["report-pdfs"],
};
/** Writes that only compute an answer and store nothing. */
const STORES_NOTHING: Readonly<Record<string, true>> = {
	trends: true,
	voice: true,
};

/**
 * Marks the reads a successful write to `path` changed as stale; the ones on screen read again.
 * A write outside a family (a new family, a joined invite) changes the family list. That list
 * shows loading until its new reply, so the new family is never missing from the selection.
 */
export const invalidateAfterWrite = (path: string) => {
	const key = apiKey(path);
	const familyId = key[2];
	const resource = key[3];
	if (
		key[1] !== "families" ||
		familyId === undefined ||
		resource === undefined
	) {
		void queryClient.resetQueries({
			queryKey: ["api", "families"],
			exact: true,
		});
		return;
	}
	if (STORES_NOTHING[resource]) return;
	const family = ["api", "families", familyId];
	for (const changed of [resource, ...(ALSO_CHANGES[resource] ?? [])])
		void queryClient.invalidateQueries(
			changed === ""
				? { queryKey: family, exact: true }
				: { queryKey: [...family, changed] },
		);
};

// One person's data never shows to the next. A sign-in or sign-out drops every cached reply: the
// reads off screen go, and the reads on screen start again, so after a sign-out they show signed out.
onSessionChange(() => {
	queryClient.removeQueries({ type: "inactive" });
	void queryClient.resetQueries();
});
