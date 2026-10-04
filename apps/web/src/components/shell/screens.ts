// Every screen of the signed-in app, in menu order. The desktop tree and the phone Start menu both
// list these, so the two sizes show the same names in the same order.
import {
	CalendarClock,
	ChefHat,
	DoorOpen,
	FileText,
	HeartHandshake,
	House,
	type LucideIcon,
	MessageCircle,
	Moon,
	ScanSearch,
	Settings,
	Users,
	Utensils,
} from "lucide-react";

import type { View } from "@/lib/view";

type Tab = { readonly to: string; readonly label: string };
export type Screen = {
	readonly to: string;
	readonly label: string;
	readonly icon: LucideIcon;
	/** Sub-pages, shown as Win95 tabs. The first tab is the screen itself. */
	readonly tabs?: readonly Tab[];
};

export const familyScreens = [
	{
		to: "/family",
		label: "Family",
		icon: Users,
		tabs: [
			{ to: "/family", label: "Overview" },
			{ to: "/family/alerts", label: "Alerts" },
			{ to: "/family/trends", label: "Trends" },
			{ to: "/family/thresholds", label: "Thresholds" },
		],
	},
	{ to: "/chat", label: "Chat", icon: MessageCircle },
	{
		to: "/care",
		label: "Care",
		icon: HeartHandshake,
		tabs: [
			{ to: "/care", label: "Needs" },
			{ to: "/care/contacts", label: "Contacts" },
			{ to: "/care/plan", label: "Care plan" },
			{ to: "/care/sharing", label: "Sharing" },
		],
	},
	{ to: "/appointments", label: "Visits", icon: CalendarClock },
	{ to: "/reports", label: "Reports", icon: FileText },
] as const satisfies readonly Screen[];

export const wearerScreens = [
	{ to: "/hud", label: "Home", icon: House },
	{ to: "/medicine", label: "Find things", icon: ScanSearch },
	{ to: "/bedtime", label: "Bedtime", icon: Moon },
	{ to: "/trip", label: "Going out", icon: DoorOpen },
] as const satisfies readonly Screen[];

export const settingsScreen = {
	to: "/settings",
	label: "Settings",
	icon: Settings,
	tabs: [
		{ to: "/settings", label: "Phone numbers" },
		{ to: "/settings/speaker", label: "Home speaker" },
		{ to: "/settings/places", label: "Things and places" },
		{ to: "/settings/reports", label: "Report email" },
		{ to: "/settings/device", label: "This device" },
		{ to: "/settings/family", label: "Delete family" },
	],
} as const satisfies Screen;

/** Screens opened from Home, not from the menu. Close returns to Home. */
const homeChildren = [
	{ to: "/meal", label: "Meal", icon: Utensils },
	{ to: "/cooking", label: "Cook", icon: ChefHat },
] as const satisfies readonly Screen[];

/** The 3 screens pinned to the phone taskbar in each view. */
export const pinned = {
	family: [familyScreens[0], familyScreens[1], familyScreens[4]],
	wearer: [wearerScreens[0], wearerScreens[1], wearerScreens[2]],
} as const;

/** The first screen of each view. */
export const homePath = (view: View) =>
	view === "wearer" ? wearerScreens[0].to : familyScreens[0].to;

const all: readonly Screen[] = [
	...familyScreens,
	...wearerScreens,
	settingsScreen,
	...homeChildren,
];

/** Where the current page sits: its screen, its tab, and the page one level up (null at home). */
export function locate(pathname: string, view: View) {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	const screen = all.find((s) => path === s.to || path.startsWith(`${s.to}/`));
	const tab = screen?.tabs?.find((t) => t.to === path);
	const home = homePath(view);
	const up = homeChildren.some((s) => s.to === path)
		? wearerScreens[0].to
		: path === home
			? null
			: home;
	return { screen, tab, up };
}
