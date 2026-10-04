// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type {
	CareNeed,
	CareResponse,
	ContactAttempt,
} from "@health/contracts/care";

import { fireEvent, render, setupDom, within } from "../test/dom-routed";
import { NeedCard } from "./need-card";

setupDom();

const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const AT = "2026-10-04T03:00:00.000Z";

const attempt = (
	step: number,
	member: string,
	name: string,
	status: ContactAttempt["status"],
	change: Partial<ContactAttempt> = {},
): ContactAttempt => ({
	step,
	member,
	name,
	backup: false,
	channel: "message",
	status,
	body: "",
	createdAt: AT,
	updatedAt: AT,
	contactLocalTime: "Sat 3:04 AM (Asia/Kolkata)",
	...change,
});

const need = (change: Partial<CareNeed>): CareNeed => ({
	id: "1",
	familyId: "7",
	kind: "help",
	summary: "Mom asked for help getting up.",
	facts: [],
	alertId: null,
	dueAt: AT,
	status: "open",
	acceptedBy: null,
	followUpBy: null,
	raisedBy: "a".repeat(64),
	clientId: "c1",
	createdAt: AT,
	updatedAt: AT,
	attempts: [],
	remaining: [],
	...change,
});

const ignore = () => {};

test("an open need shows who was contacted, how, and who is next", () => {
	const view = render(
		<NeedCard
			need={need({
				facts: [
					{
						text: "Heart rate 120",
						source: "watch",
						observedAt: AT,
						uncertainty: "single reading",
					},
				],
				attempts: [
					attempt(0, BOB, "Bob", "no_answer"),
					attempt(1, CAROL, "Carol", "sent", { channel: "call", backup: true }),
				],
				remaining: ["Dana"],
			})}
			me={null}
			busy={false}
			onRespond={ignore}
		/>,
	);
	const card = view.getByRole("article", {
		name: "Request for help: Waiting for someone to accept",
	});
	expect(within(card).getByRole("heading").textContent).toBe(
		"Request for help",
	);
	expect(
		within(card).getByText("Mom asked for help getting up."),
	).toBeDefined();
	const fact = within(card).getByText(/^Heart rate 120 · /);
	expect(fact.textContent).not.toContain("single reading");
	expect(
		document.getElementById(fact.getAttribute("aria-describedby") ?? "")
			?.textContent,
	).toBe("watch");
	const steps = within(
		within(card).getByRole("list", { name: "Contact attempts" }),
	).getAllByRole("listitem");
	expect(steps.map((li) => li.textContent)).toEqual([
		"BobMessageNo answertheir time Sat 3:04 AM (Asia/Kolkata)",
		"Carol (backup)Simulated callSenttheir time Sat 3:04 AM (Asia/Kolkata)",
		"Dana: not contacted yet",
	]);
	// Someone who is not the current contact gets no answer buttons: only the fact's tooltip.
	expect(within(card).queryAllByRole("button")).toEqual([fact]);
});

test("the current contact of a ringing call may answer it, accept, or decline", () => {
	const sent: CareResponse["response"][] = [];
	const view = render(
		<NeedCard
			need={need({
				attempts: [attempt(0, CAROL, "Carol", "sent", { channel: "call" })],
			})}
			me={CAROL}
			busy={false}
			onRespond={(response) => sent.push(response)}
		/>,
	);
	expect(view.getAllByRole("button").map((b) => b.textContent)).toEqual([
		"Mark seen",
		"Answer call",
		"I'll take it",
		"I can't",
	]);
	fireEvent.click(view.getByRole("button", { name: "Answer call" }));
	fireEvent.click(view.getByRole("button", { name: "I'll take it" }));
	expect(sent).toEqual(["answer", "accept"]);
});

test("while an answer is being sent the buttons are disabled", () => {
	const sent: CareResponse["response"][] = [];
	const view = render(
		<NeedCard
			need={need({ attempts: [attempt(0, BOB, "Bob", "delivered")] })}
			me={BOB}
			busy
			onRespond={(response) => sent.push(response)}
		/>,
	);
	const decline = view.getByRole("button", { name: "I can't" });
	expect(decline.hasAttribute("disabled")).toBe(true);
	fireEvent.click(decline);
	expect(sent).toEqual([]);
});

test("an accepted need says when the ladder continues and lets the acceptor confirm help", () => {
	const sent: CareResponse["response"][] = [];
	const view = render(
		<NeedCard
			need={need({
				kind: "alert",
				status: "accepted",
				acceptedBy: BOB,
				followUpBy: "2026-10-04T03:30:00.000Z",
				attempts: [attempt(0, BOB, "Bob", "accepted")],
			})}
			me={BOB}
			busy={false}
			onRespond={(response) => sent.push(response)}
		/>,
	);
	expect(
		view.getByRole("article", {
			name: "Health alert: Accepted, help not confirmed yet",
		}),
	).toBeDefined();
	expect(
		view.getByText(
			/^If help is not confirmed by .*, Telly asks the next contact\.$/,
		),
	).toBeDefined();
	fireEvent.click(view.getByRole("button", { name: "Help confirmed" }));
	expect(sent).toEqual(["help_confirmed"]);
});

test("a resolved need is closed: no follow-up deadline and no answers", () => {
	const view = render(
		<NeedCard
			need={need({
				kind: "call_reminder",
				status: "resolved",
				acceptedBy: BOB,
				attempts: [attempt(0, BOB, "Bob", "accepted")],
			})}
			me={BOB}
			busy={false}
			onRespond={ignore}
		/>,
	);
	expect(
		view.getByRole("article", { name: "Call reminder: Help confirmed" }),
	).toBeDefined();
	expect(view.queryByText(/Telly asks the next contact/)).toBeNull();
	expect(view.queryAllByRole("button")).toHaveLength(0);
});
