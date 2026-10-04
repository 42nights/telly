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
 * One alert with "Mark as seen", "Call Mom", and "Call 911". Seen and unseen use the same rows and
 * buttons, so the card keeps its size when someone marks it.
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
			className="win95-raised grid gap-3 border-l-4 border-l-destructive p-3"
		>
			<header className="flex items-start gap-2">
				<TriangleAlert
					aria-hidden
					className="mt-0.5 size-5 shrink-0 text-destructive"
				/>
				<h3 className="min-w-0 flex-1 break-words font-bold text-lg leading-tight">
					{item.alert.summary}
				</h3>
				<span
					className={cn(
						"win95-inset w-28 shrink-0 bg-card px-1 py-0.5 text-center font-bold text-sm",
						seen === null && "text-destructive",
					)}
				>
					{seen === null ? "Not seen yet" : "Seen"}
				</span>
			</header>
			<dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
				<dt className="text-muted-foreground">When</dt>
				<dd>
					{clock(item.alert.createdAt)} · {ago(item.alert.createdAt, now)}
				</dd>
				<dt className="text-muted-foreground">Signal</dt>
				<dd className="break-words">{signal(item.sample)}</dd>
				<dt className="text-muted-foreground">Delivery</dt>
				<dd
					className={cn("break-words", failed && "font-bold text-destructive")}
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
			<AlertActions
				seen={seen !== null}
				busy={busy}
				error={error}
				onSeen={onSeen}
			/>
		</article>
	);
}

/** "Mark as seen", "Call Mom", and "Call 911", with one line under them for an error or the numbers. */
function AlertActions({
	seen,
	busy,
	error,
	onSeen,
}: {
	seen: boolean;
	busy: boolean;
	error: string | null;
	onSeen: () => void;
}) {
	const [contacts] = useContacts();
	const settings = (
		<Link to="/settings" className="font-bold text-primary underline">
			{contacts.momPhone === null ? "Add it in Settings" : "Settings"}
		</Link>
	);
	return (
		<>
			<div className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-2">
				<Button
					className="win95-primary h-14"
					aria-label={seen ? "Seen" : "Mark as seen"}
					title={seen ? "Seen" : "Mark as seen"}
					disabled={seen || busy}
					onClick={onSeen}
				>
					<Check aria-hidden className="size-6" />
				</Button>
				{contacts.momPhone === null ? (
					<Button className="h-14" disabled>
						<Phone aria-hidden /> Call Mom
					</Button>
				) : (
					<a
						data-slot="button"
						className={cn(buttonVariants(), "h-14")}
						href={telHref(contacts.momPhone)}
					>
						<Phone aria-hidden /> Call Mom
					</a>
				)}
				<a
					data-slot="button"
					className={cn(buttonVariants(), "h-14 font-bold text-destructive!")}
					href={telHref(contacts.emergency)}
				>
					<Phone aria-hidden /> Call {contacts.emergency}
				</a>
			</div>
			<p
				className="min-h-5 text-sm"
				role={error === null ? undefined : "alert"}
			>
				{error ??
					(contacts.momPhone === null && (
						<>Call Mom is off: no number saved. {settings}.</>
					))}
			</p>
		</>
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
