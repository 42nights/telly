import { Toaster } from "@health/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	useLocation,
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
	const signingIn = useLocation({
		select: (location) => location.pathname === "/sign-in",
	});
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
						<div className="win95-desktop flex h-svh flex-col">
							<Header />
							<NewFamilyBar />
							<div className="min-h-0 flex-1 overflow-y-auto">
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
