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
import { FamilyProvider, NewFamilyBar } from "@/lib/family";
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
	// The rendered match, not the address: the address changes before the next page has loaded, and
	// switching the layout early remounts the page that is still showing.
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
				<div className="win95-desktop flex h-svh flex-col">
					<header className="win95-titlebar px-2 py-1 text-[0.9375rem]">
						Telly
					</header>
					{signingIn ? (
						<div className="min-h-0 flex-1 overflow-y-auto">
							<Outlet />
						</div>
					) : (
						<FamilyProvider>
							<Header />
							<NewFamilyBar />
							<div className="min-h-0 flex-1 overflow-y-auto">
								<Outlet />
							</div>
						</FamilyProvider>
					)}
				</div>
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
