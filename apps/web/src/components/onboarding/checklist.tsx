// The Home setup checklist (.lavish/onboarding-plan.html#wf-5). Each item is done only by real data;
// an open item links to the screen that does it.
import type { Family } from "@health/contracts";
import { Button } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Window } from "@/components/hud/window";
import { useContacts } from "@/lib/contacts";
import { useFamily } from "@/lib/family";

import { useSetupStatus, WhoopStatus } from "./status";

const open = "grid min-h-11 place-items-center px-2 underline";

function Item({
	done,
	children,
	to,
}: {
	done: boolean;
	children: ReactNode;
	to: "/welcome" | "/settings" | "/care-profile" | null;
}) {
	return (
		<li className="grid min-h-11 grid-cols-[20px_1fr_auto] items-center gap-2 bg-card px-2 py-1">
			<span
				aria-label={done ? "Done" : "Not done"}
				className="win95-inset grid size-5 place-items-center bg-card text-xs"
				role="img"
			>
				{done ? "✓" : ""}
			</span>
			<span className="min-w-0">{children}</span>
			{to !== null &&
				!done &&
				(to === "/welcome" ? (
					<Link className={open} search={{ step: "connect" }} to="/welcome">
						Open
					</Link>
				) : (
					<Link className={open} to={to}>
						Open
					</Link>
				))}
		</li>
	);
}

/** The checklist of the selected family, if any; it reads the family itself to keep Home's imports few. */
export function SetupChecklist() {
	const { family } = useFamily();
	return family === null ? null : <Checklist family={family} key={family.id} />;
}

function Checklist({ family }: { family: Family }) {
	const key = `telly.checklist.hidden.${family.id}`;
	const [hidden, setHidden] = useState(true);
	useEffect(() => setHidden(localStorage.getItem(key) !== null), [key]);
	const status = useSetupStatus(family.id);
	const [contacts] = useContacts();
	if (hidden) return null;
	return (
		<Window icon={ListChecks} title={`${family.name} · Setup`}>
			<div className="grid gap-2 p-2 text-sm">
				<ul className="grid gap-1">
					<Item done to={null}>
						Family created
					</Item>
					<Item done={status.hasWhoop} to="/welcome">
						WHOOP: <WhoopStatus records={status.records} />
					</Item>
					<Item done={status.hasMedicine} to="/welcome">
						{status.hasMedicine ? "First medicine" : "Add first medicine"}
					</Item>
					<Item done={status.invited} to="/welcome">
						Invite family
					</Item>
					<Item
						done={contacts.momPhone !== null || contacts.familyPhone !== null}
						to="/settings"
					>
						Phone numbers for Call buttons
					</Item>
					<Item done={false} to="/care-profile">
						Care plan details (optional)
					</Item>
				</ul>
				<Button
					type="button"
					className="h-11 justify-self-start px-4"
					onClick={() => {
						localStorage.setItem(key, new Date().toISOString());
						setHidden(true);
					}}
				>
					Hide checklist
				</Button>
			</div>
		</Window>
	);
}
