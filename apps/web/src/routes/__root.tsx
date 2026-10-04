import { Toaster } from "@health/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	retainSearchParams,
	useMatch,
	useNavigate,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { OnboardingRedirect } from "@/components/onboarding/redirect";
import { Shell } from "@/components/shell";
import { ThemeProvider } from "@/components/theme-provider";
import { AutoTripProvider } from "@/components/trip/auto-trip";
import { FamilyProvider } from "@/lib/family";
import { requireSession } from "@/lib/session";

import "../index.css";

type RouterAppContext = Record<string, never>;

type RootSearch = {
	/** The family id of the person this tab shows (`useFamily`). */
	person?: string | undefined;
};

export const Route = createRootRouteWithContext<RouterAppContext>()({
	// The router parses `?person=12` as the number 12; a family id is a string. An id that is not
	// listed falls back to the default person (`chooseFamily`).
	validateSearch: ({ person }: Record<string, unknown>): RootSearch =>
		typeof person === "number" || typeof person === "string"
			? /^[\w-]{1,64}$/.test(String(person))
				? { person: String(person) }
				: {}
			: {},
	// Every link and navigation keeps the person, so moving between screens never changes it.
	search: { middlewares: [retainSearchParams(["person"])] },
	// No app page, nav tab, or family data shows before sign-in.
	beforeLoad: requireSession,
	component: RootComponent,
	head: ({ matches }) => ({
		meta: [
			{
				title: tabTitle(matches.at(-1)?.fullPath ?? "/"),
			},
			{
				name: "description",
				content:
					"Telly: day-to-day help for memory loss, with the family in the loop",
			},
		],
	}),
});

// "Telly" on Home, "<Page> · Telly" elsewhere: the last static path segment, e.g. /settings/device → "Device · Telly".
function tabTitle(fullPath: string): string {
	const page = fullPath
		.split("/")
		.filter((s) => s && !s.startsWith("$"))
		.at(-1);
	if (!page) return "Telly";
	const name =
		page === "hud"
			? "HUD"
			: page.charAt(0).toUpperCase() + page.slice(1).replaceAll("-", " ");
	return `${name} · Telly`;
}

function RootComponent() {
	// The rendered match, not the address: the address changes before the next page has loaded, and
	// switching the layout early remounts the page that is still showing.
	const signingIn =
		useMatch({ from: "/sign-in", shouldThrow: false }) !== undefined;
	const { person } = Route.useSearch();
	const navigate = useNavigate();
	const pick = (familyId: string) =>
		void navigate({
			to: ".",
			search: (prev) => ({ ...prev, person: familyId }),
			replace: true,
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
					<div className="win95-desktop h-[calc(100svh-var(--win95-top-band))] overflow-y-auto">
						<Outlet />
					</div>
				) : (
					<FamilyProvider person={{ picked: person ?? null, pick }}>
						<AutoTripProvider>
							<OnboardingRedirect />
							<Shell />
						</AutoTripProvider>
					</FamilyProvider>
				)}
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
