import { type Loaded, loadDecoded, Sources } from "@health/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ENV } from "@/env";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

function HomeComponent() {
	const [state, setState] = useState<Loaded<Sources>>();

	useEffect(
		() => loadDecoded(Sources, `${ENV.VITE_SERVER_URL}/api/sources`, setState),
		[],
	);

	return (
		<div className="container mx-auto max-w-3xl px-4 py-2">
			<section
				aria-labelledby="sources-heading"
				className="grid gap-3 rounded-lg border p-4"
			>
				<h2 id="sources-heading" className="font-medium">
					Data sources
				</h2>
				{state === undefined && <p>Checking the server…</p>}
				{/* An unreachable server is unavailable, never "all clear". */}
				{state?.kind === "error" && (
					<p role="alert">Server unavailable: {state.message}</p>
				)}
				{state?.kind === "ready" &&
					state.value.sources.map((source) => (
						<div key={source.source}>
							<p className="font-medium">Healer S.I. not connected</p>
							<p className="text-muted-foreground text-sm">
								WHOOP readings and WHOOP-based nudges are unavailable.
							</p>
						</div>
					))}
			</section>
		</div>
	);
}
