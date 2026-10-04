import { Toaster } from "@health/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	useMatch,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { OnboardingRedirect } from "@/components/onboarding/redirect";
import { Shell } from "@/components/shell";
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
				{signingIn ? (
					<div className="win95-desktop h-[calc(100svh-var(--win95-top-band))] overflow-y-auto">
						<Outlet />
					</div>
				) : (
					<FamilyProvider>
						<OnboardingRedirect />
						<Shell />
					</FamilyProvider>
				)}
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
