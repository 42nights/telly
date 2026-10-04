// Onboarding screen 4 (.lavish/onboarding-plan.html#wf-4, #wf-4c, #whoop): three real sources, each
// skippable. Health data comes only from the WHOOP strap through NOOP; nothing here writes a reading.
import type { Family } from "@health/contracts";
import { WhoopPushToken } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { InviteLink, useInvite } from "@/components/family/invite";
import { ENV } from "@/env";
import { apiRequest, familyPath } from "@/lib/api";

import { failureText, noopLink } from "./logic";
import { FirstMedicine } from "./medicine";
import { ShareLink } from "./share-link";
import { useSetupStatus, WhoopStatus } from "./status";

type Open = "whoop" | "medicine" | "invite";

function Row({
	done,
	title,
	note,
	action,
	onAction,
	children,
}: {
	done: boolean;
	title: string;
	note: ReactNode;
	action: string;
	onAction: () => void;
	children?: ReactNode;
}) {
	return (
		<li className="grid gap-2 bg-card p-2">
			<div className="grid grid-cols-[20px_1fr_auto] items-center gap-2">
				<span
					aria-label={done ? "Done" : "Not done"}
					className="win95-inset grid size-5 place-items-center bg-card text-xs"
					role="img"
				>
					{done ? "✓" : ""}
				</span>
				<span className="grid min-w-0">
					<b>{title}</b>
					<small>{note}</small>
				</span>
				<Button type="button" className="h-11 px-3" onClick={onAction}>
					{action}
				</Button>
			</div>
			{children}
		</li>
	);
}

export function ConnectScreen({ family }: { family: Family }) {
	const navigate = useNavigate();
	const status = useSetupStatus(family.id);
	const [open, setOpen] = useState<Open | null>(null);
	const [whoopLink, setWhoopLink] = useState<string | null>(null);
	const invite = useInvite(family.id);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const connectWhoop = async () => {
		setOpen("whoop");
		setError(null);
		const result = await apiRequest(
			WhoopPushToken,
			familyPath(family.id, "/whoop-token"),
			{ method: "POST" },
		);
		if (result.kind === "ready")
			return setWhoopLink(noopLink(ENV.VITE_SERVER_URL, result.value.token));
		setError(
			result.kind === "unavailable"
				? "WHOOP push is not set up on this server."
				: failureText(result),
		);
	};

	const sendInvite = async () => {
		setOpen("invite");
		setError(null);
		const failed = await invite.create();
		if (failed !== null) return setError(failed);
		status.markInvited();
	};

	return (
		<div className="grid gap-3 p-2">
			<ul className="grid gap-2">
				<Row
					done={status.hasWhoop}
					title="WHOOP"
					note={
						<>
							Send a connect link to the person with the strap
							<br />
							<WhoopStatus records={status.records} />
						</>
					}
					action="Connect"
					onAction={() => void connectWhoop()}
				>
					{open === "whoop" && whoopLink !== null && (
						<div className="grid gap-2">
							<p>
								Send this link to the person with the WHOOP strap. They tap it
								on the iPhone that runs NOOP. NOOP then sends the strap's
								readings to {family.name}. A new link stops the old one.
							</p>
							<ShareLink link={whoopLink} title="Connect WHOOP to Telly" />
						</div>
					)}
				</Row>
				<Row
					done={status.hasMedicine}
					title="First medicine"
					note="Photo of the real box; Gemini reads the label"
					action="Take photo"
					onAction={() => {
						setError(null);
						setOpen("medicine");
					}}
				>
					{open === "medicine" && (
						<FirstMedicine
							familyId={family.id}
							onSaved={(text) => {
								setMessage(text);
								setOpen(null);
							}}
						/>
					)}
				</Row>
				<Row
					done={status.invited}
					title="Invite family"
					note="Share a join link"
					action="Invite"
					onAction={() => void sendInvite()}
				>
					{open === "invite" && invite.link !== null && (
						<InviteLink link={invite.link} familyName={family.name} />
					)}
				</Row>
			</ul>
			{message !== null && <p role="status">{message}</p>}
			{error !== null && <p role="alert">{error}</p>}
			<Button
				type="button"
				className={`${open === null ? "win95-primary" : ""}h-11 w-full`}
				onClick={() => void navigate({ to: "/hud" })}
			>
				Finish
			</Button>
			<p className="text-xs">
				Finish works with nothing checked. Skipped items show on Home as a
				checklist.
			</p>
		</div>
	);
}
