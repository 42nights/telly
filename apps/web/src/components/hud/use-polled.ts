import { type Loaded, loadDecoded } from "@health/contracts";
import type { Schema } from "effect";
import { useEffect, useState } from "react";

import { ENV } from "@/env";

const POLL_MS = 5_000;
/** A reply older than three missed polls is stale, even when no read has failed yet. */
export const STALE_MS = 3 * POLL_MS;

export type Polled<T> = {
	readonly latest: Loaded<T> | undefined;
	/** `Date.now()` of the last decoded reply; undefined until the server answers once. */
	readonly okAt: number | undefined;
};

/**
 * Re-reads a public server endpoint (no sign-in) every `POLL_MS`. A read still pending at the next
 * poll is cancelled.
 */
export function usePolled<T>(
	schema: Schema.Decoder<T>,
	path: string,
): Polled<T> {
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
