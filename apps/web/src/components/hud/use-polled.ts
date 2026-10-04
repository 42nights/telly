import { type Loaded, loadDecoded } from "@health/contracts";
import { useQuery } from "@tanstack/react-query";
import type { Schema } from "effect";

import { ENV } from "@/env";
import { queryClient } from "@/lib/query";

const POLL_MS = 5_000;
/** A reply older than three missed polls is stale, even when no read has failed yet. */
export const STALE_MS = 3 * POLL_MS;

export type Polled<T> = {
	readonly latest: Loaded<T> | undefined;
	/** `Date.now()` of the last decoded reply; undefined until the server answers once. */
	readonly okAt: number | undefined;
};

/**
 * Re-reads a public server endpoint (no sign-in) every `POLL_MS`. A read still pending when the
 * next poll is due is cancelled; the last reply stays, and its age shows. Every screen that shows
 * the endpoint shares one cached read, so a screen switch shows the last reply at once.
 */
export function usePolled<T>(
	schema: Schema.Decoder<T>,
	path: string,
): Polled<T> {
	const queryKey = ["public", path];
	const { data } = useQuery(
		{
			queryKey,
			queryFn: ({ signal }) => {
				const { promise, resolve } = Promise.withResolvers<Polled<T>>();
				const last = queryClient.getQueryData<Polled<T>>(queryKey) ?? {
					latest: undefined,
					okAt: undefined,
				};
				const timer = setTimeout(() => {
					cancel();
					resolve(last);
				}, POLL_MS);
				const cancel = loadDecoded(
					schema,
					`${ENV.VITE_SERVER_URL}${path}`,
					(latest) => {
						clearTimeout(timer);
						resolve({
							latest,
							okAt: latest.kind === "ready" ? Date.now() : last.okAt,
						});
					},
				);
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					cancel();
				});
				return promise;
			},
			staleTime: POLL_MS,
			refetchInterval: POLL_MS,
			refetchOnWindowFocus: true,
		},
		queryClient,
	);
	return data ?? { latest: undefined, okAt: undefined };
}
