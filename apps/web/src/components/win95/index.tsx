// Shared Win95 pieces for every screen: a tooltip hint for secondary text, and one notice for every
// API state that is not data. Each notice says what is missing; none of them reads as "all clear".
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@health/ui/components/empty";
import { cn } from "@health/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { CloudOff, Info, Loader, LockKeyhole, ShieldOff } from "lucide-react";
import { type ReactNode, useId } from "react";

import type { ApiFailure } from "@/lib/api";

/** Contact support. Subject only: never put health data in this link. */
export const SUPPORT_MAILTO = "mailto:vexzyl@pm.me?subject=Telly%20support";

/** An info button whose text shows as a Win95 yellow tooltip on hover and keyboard focus. */
export function Tip({
	text,
	align = "center",
}: {
	text: string;
	/** `end` keeps the tooltip inside the window when the button sits at a right edge. */
	align?: "center" | "end";
}) {
	return (
		<button
			type="button"
			className="win95-tip"
			data-align={align}
			data-tip={text}
			aria-label={text}
		>
			<Info aria-hidden className="size-4" />
		</button>
	);
}

/**
 * Visible content with its details in a Win95 yellow tooltip. The content is a button, so the
 * tooltip opens on hover, tap, and keyboard focus; screen readers read it as the description.
 */
export function Hint({
	text,
	align = "start",
	side = "below",
	className,
	children,
}: {
	text: string;
	/** `end` keeps the tooltip inside the window when the content sits at a right edge. */
	align?: "start" | "end";
	/** `above` keeps the tooltip on screen when the content sits at the bottom edge. */
	side?: "below" | "above";
	className?: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<button
			type="button"
			className={cn("win95-hint", className)}
			data-align={align}
			data-side={side}
			aria-describedby={id}
		>
			{children}
			<span id={id} role="tooltip" className="win95-hint-body">
				{text}
			</span>
		</button>
	);
}

const notice = {
	loading: {
		icon: Loader,
		title: (what: string) => `Loading ${what}…`,
		problem: false,
	},
	signed_out: {
		icon: LockKeyhole,
		title: () => "Sign-in required",
		problem: false,
	},
	forbidden: {
		icon: ShieldOff,
		title: () => "Not a member of this family",
		problem: true,
	},
	unavailable: {
		icon: CloudOff,
		title: (what: string) =>
			`${what[0]?.toUpperCase()}${what.slice(1)} unavailable`,
		problem: true,
	},
	error: {
		icon: CloudOff,
		title: (what: string) => `Could not load ${what}`,
		problem: true,
	},
} as const;

/** The notice for an API state that has no data yet: loading, signed out, or a failure. */
export function ApiNotice({
	state,
	what,
}: {
	state: { readonly kind: "loading" } | ApiFailure;
	/** What the screen tried to read, in lower case, such as "alerts". */
	what: string;
}) {
	const { icon: Icon, title, problem } = notice[state.kind];
	const description =
		state.kind === "loading"
			? "Waiting for the server."
			: state.kind === "signed_out"
				? `Sign in to see ${what}.`
				: state.message;
	return (
		<Empty className="p-4" role={problem ? "alert" : "status"}>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon aria-hidden />
				</EmptyMedia>
				<EmptyTitle>{title(what)}</EmptyTitle>
				<EmptyDescription>
					{description}
					{state.kind === "signed_out" && (
						<>
							{" "}
							<Link to="/sign-in">Go to Sign in</Link>
						</>
					)}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
