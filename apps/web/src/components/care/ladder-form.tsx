// The family's contact ladder: contacts in order, an optional backup, and how long each may take.
// Contacts are family members by identity; the server refuses anyone outside the family.
import {
	type ContactLadder,
	type ContactLadderInput,
	ContactLadderReply,
	type LadderContact,
	type NeedKind,
} from "@health/contracts/care";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { apiRequest } from "@/lib/api";

import { kindLabel } from "./logic";

const KINDS: readonly NeedKind[] = ["alert", "help", "call_reminder"];
const field = "win95-inset win95-field h-11 min-w-0 bg-card px-2 text-sm";

const blank = (member: string): LadderContact => ({
	member,
	name: "",
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	detail: "summary",
	callFor: ["alert"],
});

function ContactFields({
	label,
	value,
	onChange,
}: {
	label: string;
	value: LadderContact;
	onChange: (next: LadderContact) => void;
}) {
	const set = (patch: Partial<LadderContact>) =>
		onChange({ ...value, ...patch });
	return (
		<fieldset className="win95-inset grid gap-2 bg-card p-2 sm:grid-cols-2">
			<legend className="px-1 font-bold">{label}</legend>
			<label className="grid gap-1">
				Name
				<input
					className={field}
					value={value.name}
					onChange={(e) => set({ name: e.target.value })}
				/>
			</label>
			<label className="grid gap-1">
				Member identity
				<input
					className={`${field} font-mono`}
					value={value.member}
					onChange={(e) => set({ member: e.target.value.trim() })}
				/>
			</label>
			<label className="grid gap-1">
				Time zone
				<input
					className={field}
					value={value.timeZone}
					onChange={(e) => set({ timeZone: e.target.value })}
				/>
			</label>
			<label className="grid gap-1">
				Details they may see
				<select
					className={field}
					value={value.detail}
					onChange={(e) =>
						set({ detail: e.target.value as LadderContact["detail"] })
					}
				>
					<option value="minimal">Only that help is needed</option>
					<option value="summary">The summary</option>
					<option value="facts">Summary and health facts</option>
				</select>
			</label>
			<fieldset className="grid gap-1 sm:col-span-2">
				<legend>Call (simulated) instead of message for</legend>
				<div className="flex flex-wrap gap-3">
					{KINDS.map((kind) => (
						<label key={kind} className="flex min-h-11 items-center gap-1.5">
							<input
								type="checkbox"
								checked={value.callFor.includes(kind)}
								onChange={(e) =>
									set({
										callFor: e.target.checked
											? [...value.callFor, kind]
											: value.callFor.filter((k) => k !== kind),
									})
								}
							/>
							{kindLabel[kind]}
						</label>
					))}
				</div>
			</fieldset>
		</fieldset>
	);
}

export function LadderForm({
	path,
	ladder,
	me,
	onSaved,
}: {
	/** `/api/families/:familyId/care/ladder`. */
	path: string;
	ladder: ContactLadder | null;
	me: string | null;
	onSaved: () => void;
}) {
	const [draft, setDraft] = useState<ContactLadderInput>(
		ladder ?? {
			contacts: [blank(me ?? "")],
			backup: null,
			answerSeconds: 120,
			followUpSeconds: 1800,
		},
	);
	const [status, setStatus] = useState<string>(
		ladder === null ? "No ladder yet: alerts contact nobody." : "Saved",
	);
	const setContact = (index: number, next: LadderContact) =>
		setDraft({
			...draft,
			contacts: draft.contacts.map((c, i) => (i === index ? next : c)),
		});
	const save = async () => {
		setStatus("Saving…");
		const result = await apiRequest(ContactLadderReply, path, {
			method: "PUT",
			body: draft,
		});
		if (result.kind === "ready") {
			setStatus("Saved");
			onSaved();
		} else
			setStatus(
				result.kind === "signed_out"
					? "Sign in to save the ladder."
					: `Not saved: ${result.message}`,
			);
	};
	return (
		<form
			className="grid gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<p className="text-xs">
				Your member identity:{" "}
				<code className="break-all">{me ?? "loading…"}</code>. Ask each family
				member for theirs; only members can be contacts.
			</p>
			{draft.contacts.map((contact, index) => (
				<ContactFields
					// biome-ignore lint/suspicious/noArrayIndexKey: the ladder order is the identity of a row.
					key={index}
					label={`Contact ${index + 1}`}
					value={contact}
					onChange={(next) => setContact(index, next)}
				/>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					className="h-11"
					disabled={draft.contacts.length >= 5}
					onClick={() =>
						setDraft({ ...draft, contacts: [...draft.contacts, blank("")] })
					}
				>
					Add contact
				</Button>
				<Button
					type="button"
					className="h-11"
					disabled={draft.contacts.length <= 1}
					onClick={() =>
						setDraft({ ...draft, contacts: draft.contacts.slice(0, -1) })
					}
				>
					Remove last
				</Button>
				<Button
					type="button"
					className="h-11"
					onClick={() =>
						setDraft({
							...draft,
							backup: draft.backup === null ? blank("") : null,
						})
					}
				>
					{draft.backup === null ? "Add backup" : "Remove backup"}
				</Button>
			</div>
			{draft.backup !== null && (
				<ContactFields
					label="Backup"
					value={draft.backup}
					onChange={(backup) => setDraft({ ...draft, backup })}
				/>
			)}
			<div className="grid gap-2 sm:grid-cols-2">
				<label className="grid gap-1">
					Seconds to accept before the next contact
					<input
						type="number"
						min={10}
						max={86400}
						className={field}
						value={draft.answerSeconds}
						onChange={(e) =>
							setDraft({ ...draft, answerSeconds: Number(e.target.value) })
						}
					/>
				</label>
				<label className="grid gap-1">
					Seconds to confirm help after accepting
					<input
						type="number"
						min={10}
						max={604800}
						className={field}
						value={draft.followUpSeconds}
						onChange={(e) =>
							setDraft({ ...draft, followUpSeconds: Number(e.target.value) })
						}
					/>
				</label>
			</div>
			<div className="flex items-center gap-2">
				<Button type="submit" className="h-11">
					Save ladder
				</Button>
				<p role="status" className="text-xs">
					{status}
				</p>
			</div>
		</form>
	);
}
