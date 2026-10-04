import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import Loader from "./components/loader";
import { startPendingSync } from "./lib/pending";
import { queryClient } from "./lib/query";
import { reloadOnce } from "./lib/reload";
import { followSession } from "./lib/session";
import { routeTree } from "./routeTree.gen";

// The router shows no error for a chunk of an older build while the reload loads the new one.
window.addEventListener("vite:preloadError", (event) => {
	if (reloadOnce()) event.preventDefault();
});

const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	// The query cache decides when data is current, so a preload always asks it.
	defaultPreloadStaleTime: 0,
	scrollRestoration: true,
	defaultPendingComponent: () => <Loader />,
	context: { queryClient },
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	startPendingSync();
	followSession(router);
}
