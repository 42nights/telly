import { Toaster } from "@health/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import Header from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import { FamilyProvider } from "@/lib/family";

import "../index.css";

type RouterAppContext = Record<string, never>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
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
	return (
		<>
			<HeadContent />
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				disableTransitionOnChange
				storageKey="vite-ui-theme"
			>
				<FamilyProvider>
					<div className="win95-desktop grid h-svh grid-rows-[auto_auto_1fr]">
						<header className="win95-titlebar px-2 py-1 text-[0.9375rem]">
							Telly
						</header>
						<Header />
						<div className="min-h-0 overflow-y-auto">
							<Outlet />
						</div>
					</div>
				</FamilyProvider>
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
