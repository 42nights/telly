// The signed-in app's frame (docs: the approved navigation redesign, issue linked in the PR).
// 900 px and wider: one Explorer window with the screen tree on the left, Back and the path on a
// toolbar, and a status bar. Narrower: the same window full screen, with a taskbar at the bottom
// and a Start menu that lists the same screens as the tree, in the same order.
import { Button } from "@health/ui/components/button";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { ArrowLeft, LogOut, Monitor, Users, X } from "lucide-react";
import { useRef } from "react";

import { useFamily } from "@/lib/family";
import { setSessionToken } from "@/lib/session";
import { setView, useView, type View } from "@/lib/view";

import {
	familyScreens,
	locate,
	pinned,
	type Screen,
	settingsScreen,
	wearerScreens,
} from "./screens";

const START_MENU = "start-menu";

export function Shell() {
	const view = useView();
	const pathname = useLocation({ select: (location) => location.pathname });
	const { screen, tab, up } = locate(pathname, view);
	const { family } = useFamily();
	const startMenu = useRef<HTMLDivElement>(null);
	const signOut = useRef<HTMLDialogElement>(null);
	const Icon = screen?.icon ?? Monitor;
	const title = screen?.label ?? "Telly";
	const menu = (
		<Menu
			view={view}
			onPick={() => startMenu.current?.hidePopover()}
			onSignOut={() => {
				startMenu.current?.hidePopover();
				signOut.current?.showModal();
			}}
		/>
	);

	return (
		<div
			data-view={view}
			className="win95-raised win95-window flex h-svh flex-col gap-1 pt-0"
		>
			<h1 className="win95-titlebar -mx-1.5 flex min-h-12 items-center gap-2 py-0.5 pr-2 pl-4.5 text-lg min-[900px]:min-h-7 min-[900px]:pl-3 min-[900px]:text-sm">
				<Icon aria-hidden className="size-5 shrink-0 min-[900px]:size-4" />
				<span className="min-w-0 flex-1 truncate">
					<span className="hidden min-[900px]:inline">Telly · </span>
					{title}
					{tab !== undefined && tab.to !== screen?.to && ` · ${tab.label}`}
				</span>
				{up !== null && (
					<Link
						to={up}
						aria-label={`Close ${title}`}
						className="win95-close grid shrink-0 place-items-center min-[900px]:hidden"
					>
						<X aria-hidden className="size-6" />
					</Link>
				)}
			</h1>

			<div className="hidden items-center gap-1 min-[900px]:flex">
				{up === null ? (
					<button type="button" className="win95-tab" disabled>
						<ArrowLeft aria-hidden className="size-4" /> Back
					</button>
				) : (
					<Link to={up} className="win95-tab gap-1.5">
						<ArrowLeft aria-hidden className="size-4" /> Back
					</Link>
				)}
				<nav
					aria-label="Path"
					className="win95-inset flex min-h-11 min-w-0 flex-1 items-center gap-1.5 bg-card px-3 text-sm"
				>
					<span>Telly</span>
					{screen !== undefined && (
						<>
							<span aria-hidden>›</span>
							<Link to={screen.to} activeOptions={{ exact: true }}>
								{screen.label}
							</Link>
						</>
					)}
					{tab !== undefined && tab.to !== screen?.to && (
						<>
							<span aria-hidden>›</span>
							<span aria-current="page">{tab.label}</span>
						</>
					)}
				</nav>
			</div>

			<div className="flex min-h-0 flex-1 gap-1">
				<nav
					aria-label="Screens"
					className="win95-inset hidden w-60 shrink-0 overflow-y-auto bg-card p-1 min-[900px]:block"
				>
					{menu}
				</nav>
				<div className="flex min-w-0 flex-1 flex-col">
					{screen?.tabs !== undefined && (
						<nav
							aria-label={`${screen.label} pages`}
							className="flex shrink-0 flex-wrap px-1 pt-1"
						>
							{screen.tabs.map((t) => (
								<Link
									key={t.to}
									to={t.to}
									activeOptions={{ exact: true }}
									className="win95-sheet-tab"
								>
									{t.label}
								</Link>
							))}
						</nav>
					)}
					<div className="win95-desktop win95-inset min-h-0 flex-1 overflow-y-auto">
						<Outlet />
					</div>
				</div>
			</div>

			<div className="hidden gap-1 text-sm min-[900px]:flex">
				<p className="win95-status flex-1 px-2 py-0.5">
					{family?.name ?? "No person"}
				</p>
				<p className="win95-status px-2 py-0.5">
					{view === "wearer" ? "Wearer view" : "Family view"}
				</p>
			</div>

			<nav
				aria-label="Taskbar"
				className="win95-taskbar grid grid-cols-4 gap-1 min-[900px]:hidden"
			>
				<button
					type="button"
					popoverTarget={START_MENU}
					className="win95-tab win95-taskbar-button font-bold"
				>
					<span aria-hidden className="win95-logo">
						T
					</span>
					Start
				</button>
				{pinned[view].map((s) => (
					<Link key={s.to} to={s.to} className="win95-tab win95-taskbar-button">
						<s.icon aria-hidden className="size-6" />
						{s.label}
					</Link>
				))}
			</nav>
			<div
				ref={startMenu}
				id={START_MENU}
				popover="auto"
				className="win95-raised win95-start-menu"
			>
				<p aria-hidden className="win95-start-band">
					Telly
				</p>
				<div className="min-w-0 flex-1 overflow-y-auto p-1">{menu}</div>
			</div>

			<dialog
				ref={signOut}
				aria-labelledby="sign-out-title"
				className="win95-raised win95-window m-auto w-[min(22rem,calc(100vw-2rem))] border-0 p-1.5 text-foreground backdrop:bg-black/30"
			>
				<h2
					id="sign-out-title"
					className="win95-titlebar flex items-center gap-1.5 px-1.5 py-1 text-sm"
				>
					<LogOut aria-hidden className="size-4" /> Sign out
				</h2>
				<form method="dialog" className="grid gap-3 p-3 text-sm">
					<p>Sign out of Telly on this device?</p>
					<div className="grid grid-cols-2 gap-2">
						<Button
							type="submit"
							className="win95-primary"
							onClick={() => setSessionToken(null)}
						>
							Sign out
						</Button>
						<Button type="submit" autoFocus>
							Cancel
						</Button>
					</div>
				</form>
			</dialog>
		</div>
	);
}

/** The screen list: the desktop tree and the phone Start menu. */
function Menu({
	view,
	onPick,
	onSignOut,
}: {
	view: View;
	onPick: () => void;
	onSignOut: () => void;
}) {
	const groups: ReadonlyArray<readonly [string, readonly Screen[]]> =
		view === "wearer"
			? [["For me", wearerScreens]]
			: [
					["Family", familyScreens],
					["For me", wearerScreens],
				];
	const other: View = view === "wearer" ? "family" : "wearer";
	return (
		<ul className="grid">
			{groups.map(([label, screens]) => (
				<li key={label}>
					<p className="win95-menu-head">{label}</p>
					<ul>
						{screens.map((s) => (
							<li key={s.to}>
								<MenuLink screen={s} onPick={onPick} />
							</li>
						))}
					</ul>
					<hr />
				</li>
			))}
			<li>
				<button
					type="button"
					className="win95-menu-item w-full"
					onClick={() => {
						setView(other);
						onPick();
					}}
				>
					<Users aria-hidden className="size-5" />
					{other === "family"
						? "Switch to family view"
						: "Switch to wearer view"}
				</button>
			</li>
			<li>
				<MenuLink screen={settingsScreen} onPick={onPick} />
				<hr />
			</li>
			<li>
				<button
					type="button"
					className="win95-menu-item w-full"
					onClick={onSignOut}
				>
					<LogOut aria-hidden className="size-5" />
					Sign out…
				</button>
			</li>
		</ul>
	);
}

function MenuLink({ screen, onPick }: { screen: Screen; onPick: () => void }) {
	return (
		<Link to={screen.to} className="win95-menu-item" onClick={onPick}>
			<screen.icon aria-hidden className="size-5" />
			{screen.label}
		</Link>
	);
}
