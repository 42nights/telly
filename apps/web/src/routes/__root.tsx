import { Toaster } from "@health/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	useMatch,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import Header from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import { FamilyProvider } from "@/lib/family";
import { requireSession } from "@/lib/session";

import "../index.css";

type RouterAppContext = Record<string, never>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
	// No app page, nav tab, or family data shows before sign-in.
	beforeLoad: requireSession,
	component: RootComponent,
	head: () => ({
		meta: [
			{
				title: "Health HUD",
			},
			{
				name: "description",
				content: "Health HUD and family dashboard",
			},
		],
		links: [
			{
				rel: "icon",
				href: "/favicon.ico",
			},
		],
	}),
});

function RootComponent() {
	// The rendered match, not the location: the location changes before the next page loads, and
	// switching layout early would remount sign-in in the old match.
	const signingIn =
		useMatch({ from: "/sign-in", shouldThrow: false }) !== undefined;
	return (
		<>
			<HeadContent />
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				disableTransitionOnChange
				storageKey="vite-ui-theme"
			>
				{signingIn ? (
					<div className="win95-desktop h-svh overflow-y-auto">
						<Outlet />
					</div>
				) : (
					<FamilyProvider>
						<div className="win95-desktop grid h-svh grid-rows-[auto_1fr]">
							<Header />
							<div className="min-h-0 overflow-y-auto">
								<Outlet />
							</div>
						</div>
					</FamilyProvider>
				)}
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
