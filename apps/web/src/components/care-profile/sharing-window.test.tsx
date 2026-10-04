// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type {
	CareAccess,
	CareGrantChange,
} from "@health/contracts/care-profile";

import { act, fireEvent, render, setupDom, within } from "../test/dom-routed";
import type { CareData } from "./data";
import { SharingWindow } from "./sharing-window";

setupDom();

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

/** A care plan whose writes are recorded and answered from `replies` (`null` = kept). */
const fakeCare = (replies: (string | null)[] = [], me: string | null = ME) => {
	const writes: { method: string; path: string; body: unknown }[] = [];
	const care: CareData = {
		me,
		access: { kind: "loading" },
		profile: { kind: "loading" },
		instructions: { kind: "loading" },
		prompt: { kind: "loading" },
		write: async (method, path, body) => {
			writes.push({ method, path, body });
			return replies.shift() ?? null;
		},
	};
	return { care, writes };
};

const grant = (
	identity: string,
	scope: CareGrantChange["scope"],
): CareGrantChange => ({
	identity,
	scope,
	granted: true,
	changedBy: ME,
	changedAt: "2026-10-01T10:00:00Z",
});

const managed: CareAccess = {
	mine: ["family_access", "health_records"],
	grants: [
		grant(ME, "family_access"),
		grant(ME, "health_records"),
		grant(OTHER, "location"),
	],
	history: [grant(ME, "family_access")],
};

test("a new family's creator sets up sharing with the three care plan scopes", async () => {
	const { care, writes } = fakeCare();
	const view = render(
		<SharingWindow
			access={{ mine: [], grants: [], history: [] }}
			care={care}
		/>,
	);
	expect(
		view.getByText("You have no care access in this family."),
	).toBeDefined();
	await act(async () =>
		view
			.getByRole("button", { name: "Set up sharing as the family's creator" })
			.click(),
	);
	expect(writes).toEqual(
		["family_access", "health_records", "care_plan_edit"].map((scope) => ({
			method: "POST",
			path: "/care-access",
			body: { identity: ME, scope, granted: true },
		})),
	);
	expect(
		view.getByText("Sharing is set up. You can now grant access to others."),
	).toBeDefined();
});

test("set up stops at the first refusal and shows it", async () => {
	const { care, writes } = fakeCare([null, "Only the creator can set up."]);
	const view = render(
		<SharingWindow
			access={{ mine: [], grants: [], history: [] }}
			care={care}
		/>,
	);
	await act(async () =>
		view
			.getByRole("button", { name: "Set up sharing as the family's creator" })
			.click(),
	);
	expect(writes).toHaveLength(2);
	expect(view.getByText("Only the creator can set up.")).toBeDefined();
});

test("after every grant is revoked, or without an identity, set up is not offered", () => {
	const revoked = { mine: [], grants: [], history: [grant(OTHER, "media")] };
	const view = render(
		<SharingWindow access={revoked} care={fakeCare().care} />,
	);
	expect(view.getByText("Nobody has access now.")).toBeDefined();
	view.unmount();
	const noMe = render(
		<SharingWindow
			access={{ mine: [], grants: [], history: [] }}
			care={fakeCare([], null).care}
		/>,
	);
	expect(noMe.getByText("Nobody has access now.")).toBeDefined();
	expect(noMe.queryByRole("button")).toBeNull();
});

test("a manager sees each member's grants and can revoke one", async () => {
	const { care, writes } = fakeCare([null, "Refused."]);
	const view = render(<SharingWindow access={managed} care={care} />);
	expect(
		view.getByText("Your access: Manage sharing, Health records"),
	).toBeDefined();
	const other = view.getByText(`Member ${OTHER.slice(0, 6)}`).closest("li");
	if (other === null) throw new Error("no member row");
	expect(within(other).getByText("Location")).toBeDefined();
	const revoke = view.getByRole("button", {
		name: `Revoke Location from Member ${OTHER.slice(0, 6)}`,
	});
	await act(async () => revoke.click());
	expect(writes).toEqual([
		{
			method: "POST",
			path: "/care-access",
			body: { identity: OTHER, scope: "location", granted: false },
		},
	]);
	expect(view.getByText("Access revoked.")).toBeDefined();
	await act(async () =>
		view
			.getByRole("button", { name: "Revoke Manage sharing from You" })
			.click(),
	);
	expect(view.getByText("Refused.")).toBeDefined();
});

test("a manager grants a scope only to a valid 64-character identity", async () => {
	const { care, writes } = fakeCare();
	const view = render(<SharingWindow access={managed} care={care} />);
	const form = view.getByRole("form", { name: "Grant access" });
	const submit = view.getByRole("button", { name: "Grant" });
	const identity = view.getByLabelText("Family member identity");
	fireEvent.change(identity, { target: { value: "not-an-identity" } });
	expect(submit.hasAttribute("disabled")).toBe(true);
	fireEvent.submit(form);
	expect(writes).toEqual([]);
	fireEvent.change(identity, { target: { value: `  ${OTHER}  ` } });
	fireEvent.change(view.getByLabelText("Access"), {
		target: { value: "purchases" },
	});
	expect(submit.hasAttribute("disabled")).toBe(false);
	await act(async () => fireEvent.submit(form));
	expect(writes).toEqual([
		{
			method: "POST",
			path: "/care-access",
			body: { identity: OTHER, scope: "purchases", granted: true },
		},
	]);
	expect(view.getByText("Access granted.")).toBeDefined();
});

test("without the sharing grant, grants show but cannot be changed", () => {
	const view = render(
		<SharingWindow
			access={{ ...managed, mine: ["media"] }}
			care={fakeCare().care}
		/>,
	);
	expect(view.getByText("Your access: Photos and audio")).toBeDefined();
	expect(view.getByText("Location")).toBeDefined();
	expect(view.queryByRole("button", { name: /Revoke/ })).toBeNull();
	expect(view.queryByRole("form", { name: "Grant access" })).toBeNull();
});
