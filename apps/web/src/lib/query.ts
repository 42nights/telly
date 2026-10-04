// The one TanStack Query cache for server data. A key is the signed-in account, then the API path
// split at `/`, then its query string when it has one: `/api/families/fam-1/alerts` is
// `[account, "api", "families", "fam-1", "alerts"]`. So there is one key per account, family,
// resource, and member (`?person=`), and a key prefix names a family or a resource subtree.
import { tokenClaims } from "@health/contracts/session";
import { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getSessionToken, onSessionChange } from "./session";

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

let decoded: { readonly token: string | null; readonly account: string } = {
	token: null,
	account: "signed-out",
};

/**
 * The account a reply belongs to: the issuer and subject of the session token, which stay the same
 * when the token is renewed. A reply can only ever be read back by the account that read it.
 */
const account = () => {
	const token = getSessionToken();
	if (token === decoded.token) return decoded.account;
	const claims = token === null ? null : tokenClaims(token);
	const claim = (name: string) =>
		typeof claims === "object" && claims !== null && name in claims
			? String(Reflect.get(claims, name))
			: "";
	decoded = {
		token,
		account: token === null ? "signed-out" : `${claim("iss")} ${claim("sub")}`,
	};
	return decoded.account;
};

export const apiKey = (path: string): string[] => {
	const [pathname = "", search] = path.split("?");
	return [
		account(),
		...pathname.split("/").filter(Boolean),
		...(search === undefined ? [] : [`?${search}`]),
	];
};

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
	(SLOW[(key[2] === "families" && key.length > 3 ? key[4] : key[2]) ?? ""]
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
	"demo-data": ["", "alerts", "monitoring"],
	"alert-thresholds": ["monitoring"],
	"care-access": ["care-profile", "care-instructions"],
	// A location share grants the viewer Location access.
	location: ["care-access"],
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
	const [scope = "", , collection, familyId, resource] = apiKey(path);
	if (
		collection !== "families" ||
		familyId === undefined ||
		resource === undefined
	) {
		// A deleted family's replies go with it.
		if (collection === "families" && familyId !== undefined)
			queryClient.removeQueries({
				queryKey: [scope, "api", "families", familyId],
			});
		void queryClient.resetQueries({
			queryKey: [scope, "api", "families"],
			exact: true,
		});
		return;
	}
	if (STORES_NOTHING[resource]) return;
	const family = [scope, "api", "families", familyId];
	for (const changed of [resource, ...(ALSO_CHANGES[resource] ?? [])])
		void queryClient.invalidateQueries(
			changed === ""
				? { queryKey: family, exact: true }
				: { queryKey: [...family, changed] },
		);
};

/**
 * Drops the cached replies under `path` (a person's family, or one member's data) and reads the
 * ones on screen again. A switch to another person or member calls it first, so the screen shows
 * loading until that person's current data arrives, never a reply from an earlier visit.
 */
export const freshRead = (path: string) =>
	void queryClient.resetQueries({ queryKey: apiKey(path) });

// One account's data never shows to the next. Keys carry the account, and a sign-in or sign-out
// removes every account's cached reply and cancels its reads in flight, so a reply on its way for
// the last account is dropped. Each reader follows the session (`useAccount`) and reads again
// under the new account's key; after a sign-out that read shows signed out.
onSessionChange(() =>
	queryClient.removeQueries({
		predicate: (query) => query.queryKey[0] !== "public",
	}),
);

/** The signed-in account; a reader that calls it renders again, with new keys, when it changes. */
export const useAccount = () => useSyncExternalStore(onSessionChange, account);
