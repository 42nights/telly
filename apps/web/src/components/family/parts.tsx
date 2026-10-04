// Pieces of the family screen: the alert card with its three actions, the monitoring badge, and
// today's newest readings. Each shows only what the server returned.
import type { Family, HealthSample } from "@health/contracts";
import type { FamilyAlert, Monitoring } from "@health/contracts/alerts";
import { Button, buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { Check, Phone, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { ApiNotice, Hint, Tip } from "@/components/win95";
import type { ApiState } from "@/lib/api";
import { telHref, useContacts } from "@/lib/contacts";
import { metricLabel, readingValue, sourceName } from "@/lib/readings";

import { type FamilyData, useShownAlert } from "./data";
import {
	ago,
	clock,
	deliveryText,
	type Glance,
	monitoringLevel,
	newestPerMetric,
	oldAge,
	seenText,
} from "./logic";

/** Renders `children` for the selected family, or why there is none: loading, failure, or no person. */
export function FamilyGate({
	data,
	emptyClassName,
	children,
}: {
	data: FamilyData;
	/** Classes for the "no person" paragraph. */
	emptyClassName: string;
	children: (family: Family) => ReactNode;
}) {
	if (data.familyState.kind !== "ready")
		return <ApiNotice state={data.familyState} what="your family" />;
	if (data.family === null)
		return (
			<p className={emptyClassName}>
				No person is set up with this account yet.{" "}
				<Link to="/welcome">Set up a person</Link>
			</p>
		);
	return children(data.family);
}

/** The alert to act on, or why there is none. */
export function AlertSection({ data, now }: { data: FamilyData; now: number }) {
	const { alerts } = data;
	const shown = useShownAlert(
		alerts.kind === "ready" ? alerts.value.alerts : [],
	);
	return (
		<section aria-label="Alert">
			{alerts.kind !== "ready" ? (
				<ApiNotice state={alerts} what="alerts" />
			) : shown === null ? (
				<NoAlert monitoring={data.monitoring} />
			) : (
				<AlertCard
					item={shown}
					me={data.me}
					busy={data.busyId === shown.alert.id}
					error={data.seenError}
					now={now}
					onSeen={() => void data.markSeen(shown.alert.id)}
				/>
			)}
		</section>
	);
}

/** Today's newest reading per metric for one family, or why the readings are missing. */
export function ReadingsGlance({
	data,
	familyId,
	now,
}: {
	data: FamilyData;
	familyId: string;
	now: number;
}) {
	const { readings } = data;
	if (readings.kind !== "ready")
		return <ApiNotice state={readings} what="readings" />;
	return (
		<GlanceList
			now={now}
			glance={newestPerMetric(
				readings.value.samples.filter((s) => s.familyId === familyId),
			)}
		/>
	);
}

const signal = (sample: HealthSample | null) =>
	sample === null
		? "Manual alert"
		: `${metricLabel(sample.metric)} ${readingValue(sample)}`;

/**
 * One alert as one compact row: the summary, how long ago, whether it is seen, and "Mark as seen",
 * "Call Mom", and "Call 911" (captain: one row, details behind a tap). Seen and unseen use the same
 * row and buttons, so the card keeps its size when someone marks it.
 */
function AlertCard({
	item,
	me,
	busy,
	error,
	now,
	onSeen,
}: {
	item: FamilyAlert;
	me: string | null;
	busy: boolean;
	error: string | null;
	now: number;
	onSeen: () => void;
}) {
	const seen = seenText(item.acknowledgements, me);
	const failed =
		item.delivery?.status === "failed" ||
		item.delivery?.status === "unavailable";
	return (
		<article
			aria-label={`Alert: ${item.alert.summary}`}
			className="win95-raised grid gap-1 border-l-4 border-l-destructive p-2"
		>
			<div className="flex items-center gap-2">
				<TriangleAlert
					aria-hidden
					className="size-5 shrink-0 text-destructive"
				/>
				<div className="min-w-0 flex-1">
					<h3 className="break-words font-bold leading-tight">
						{item.alert.summary}
					</h3>
					<p className="text-xs">
						{ago(item.alert.createdAt, now)} ·{" "}
						<span className={cn(seen === null && "font-bold text-destructive")}>
							{seen === null ? "Not seen yet" : "Seen"}
						</span>
						{failed && (
							<span className="font-bold text-destructive">
								{" "}
								· Not delivered
							</span>
						)}
					</p>
				</div>
				<AlertActions seen={seen !== null} busy={busy} onSeen={onSeen} />
			</div>
			<AlertNote error={error} />
			<details className="text-sm">
				<summary className="cursor-pointer">Details</summary>
				<dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 pt-1">
					<dt className="text-muted-foreground">When</dt>
					<dd>
						{clock(item.alert.createdAt)} · {ago(item.alert.createdAt, now)}
					</dd>
					<dt className="text-muted-foreground">Signal</dt>
					<dd className="break-words">{signal(item.sample)}</dd>
					<dt className="text-muted-foreground">Delivery</dt>
					<dd
						className={cn(
							"break-words",
							failed && "font-bold text-destructive",
						)}
					>
						{deliveryText(item.delivery)}
						{item.delivery?.lastError ? ` (${item.delivery.lastError})` : ""}
					</dd>
					<dt className="flex items-center gap-1 text-muted-foreground">
						Seen
						<Tip text="Seen means a family member opened and marked this alert. It is separate from delivery." />
					</dt>
					<dd>{seen ?? "Not yet"}</dd>
				</dl>
			</details>
		</article>
	);
}

/** "Mark as seen", "Call Mom", and "Call 911" as small buttons at the end of the alert row. */
function AlertActions({
	seen,
	busy,
	onSeen,
}: {
	seen: boolean;
	busy: boolean;
	onSeen: () => void;
}) {
	const [contacts] = useContacts();
	const button = "h-11 shrink-0 px-2";
	return (
		<div className="flex shrink-0 gap-1">
			<Button
				className={cn(button, "win95-primary w-11")}
				aria-label={seen ? "Seen" : "Mark as seen"}
				title={seen ? "Seen" : "Mark as seen"}
				disabled={seen || busy}
				onClick={onSeen}
			>
				<Check aria-hidden className="size-5" />
			</Button>
			{contacts.momPhone === null ? (
				<Button className={button} aria-label="Call Mom" disabled>
					<Phone aria-hidden /> Mom
				</Button>
			) : (
				<a
					data-slot="button"
					aria-label="Call Mom"
					className={cn(buttonVariants(), button)}
					href={telHref(contacts.momPhone)}
				>
					<Phone aria-hidden /> Mom
				</a>
			)}
			<a
				data-slot="button"
				aria-label={`Call ${contacts.emergency}`}
				className={cn(buttonVariants(), button, "font-bold text-destructive!")}
				href={telHref(contacts.emergency)}
			>
				<Phone aria-hidden /> {contacts.emergency}
			</a>
		</div>
	);
}

/** A failed "Mark as seen", or how to turn on Call Mom; nothing otherwise. */
function AlertNote({ error }: { error: string | null }) {
	const [contacts] = useContacts();
	if (error !== null)
		return (
			<p className="text-sm" role="alert">
				{error}
			</p>
		);
	if (contacts.momPhone !== null) return null;
	return (
		<p className="text-sm">
			Call Mom is off: no number saved.{" "}
			<Link to="/settings" className="font-bold text-primary underline">
				Add it in Settings
			</Link>
			.
		</p>
	);
}

/** Shown when there is no alert to act on. Never "all clear": it says what is being watched. */
function NoAlert({ monitoring }: { monitoring: ApiState<Monitoring> }) {
	const level =
		monitoring.kind === "ready" ? monitoringLevel(monitoring.value) : null;
	return (
		<div className="win95-raised grid gap-1 p-3" role="status">
			<p className="font-bold text-lg">No alerts right now</p>
			<p className="text-sm">
				{level === null
					? "Monitoring state is unknown, so an alert could be missed."
					: level === "on"
						? "Every threshold has a fresh reading."
						: level === "partial"
							? "Some thresholds have no fresh reading, so an alert could be missed."
							: "Monitoring is stopped: no threshold has a fresh reading."}
			</p>
		</div>
	);
}

/** Newest reading per metric. Its source and time are in a tooltip; an old reading shows its age. */
function GlanceList({ glance, now }: { glance: Glance[]; now: number }) {
	if (glance.length === 0)
		return (
			<p className="win95-inset bg-card p-2 text-sm">
				No readings stored for this person.
			</p>
		);
	return (
		// ponytail: an inner scroll only when the cards outgrow the window (a long list of metrics).
		<ul className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] content-start gap-1.5 overflow-y-auto">
			{glance.map(({ metric, sample }) => {
				if (sample === null)
					return (
						<li key={metric} className="win95-inset grid gap-0.5 bg-card p-1.5">
							<span className="text-xs">{metricLabel(metric)}</span>
							<b className="text-lg text-muted-foreground leading-tight">
								Unavailable
							</b>
						</li>
					);
				const age = oldAge(sample.sourceTime, now);
				return (
					<li key={metric} className="win95-inset grid bg-card">
						<Hint
							text={`${sourceName(sample.source)} · ${clock(sample.sourceTime)}`}
							className="grid content-start gap-0.5 p-1.5"
						>
							<span className="text-xs">{metricLabel(metric)}</span>
							<b className="text-lg leading-tight">{readingValue(sample)}</b>
							{age !== null && (
								<span className="text-[11px] text-muted-foreground">{age}</span>
							)}
						</Hint>
					</li>
				);
			})}
		</ul>
	);
}
