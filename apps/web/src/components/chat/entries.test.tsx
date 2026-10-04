// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { expect, mock, spyOn, test } from "bun:test";
import type { FamilyMessage } from "@health/contracts";
import type { FamilyAnswer } from "@health/contracts/ask";

import { fireEvent, render, setupDom, within } from "../test/dom";
import { ChatLog } from "./entries";
import { type Ask, timeline } from "./logic";

setupDom();

const ME = "me1234567890";

const message = (
	id: string,
	sender: string,
	clientId = `c${id}`,
): FamilyMessage => ({
	id,
	familyId: "f1",
	sender,
	body: `Body ${id}`,
	sentAt: `2026-10-04T10:0${id}:00.000Z`,
	clientId,
});

const ANSWER: FamilyAnswer = {
	answer: "Her heart rate was steady.",
	evidence: [],
	alerts: [],
	unavailable: [],
	model: "gemini-test",
	answeredAt: "2026-10-04T10:09:00.000Z",
	followUps: [],
	urgent: false,
};

const ask = (id: string, state: Ask["state"], files: string[] = []): Ask => ({
	id,
	question: `Question ${id}`,
	files,
	askedAt: `2026-10-04T10:0${id}:30.000Z`,
	state,
});

const log = (
	items: Parameters<typeof ChatLog>[0]["items"],
	identity: string | null = ME,
) => {
	const onReply = mock((_label: string) => {});
	const onFollowUp = mock((_question: string) => {});
	const view = render(
		<ChatLog
			items={items}
			identity={identity}
			emptyText="No family messages yet."
			onReply={onReply}
			onFollowUp={onFollowUp}
		/>,
	);
	return { view, onReply, onFollowUp };
};

test("an empty log shows the empty text", () => {
	const { view } = log([]);
	expect(
		within(view.getByRole("log", { name: "Messages" })).getByText(
			"No family messages yet.",
		),
	).toBeDefined();
});

test("only another member's message offers Reply; yours and alerts do not", () => {
	const { view, onReply } = log(
		timeline(
			[
				message("1", ME),
				message("2", "abcdef999"),
				message("3", "server", "alert-7"),
			],
			[],
		),
	);
	expect(view.getByText("You")).toBeDefined();
	expect(view.getByText("Telly alert")).toBeDefined();
	expect(view.getByText("Body 2")).toBeDefined();
	const replies = view.getAllByRole("button", { name: /^Reply to/ });
	expect(replies.map((button) => button.getAttribute("aria-label"))).toEqual([
		"Reply to Member abcdef",
	]);
	fireEvent.click(replies[0] as HTMLElement);
	expect(onReply).toHaveBeenCalledWith("Member abcdef");
});

test("without a known identity no message offers Reply", () => {
	const { view } = log(timeline([message("2", "abcdef999")], []), null);
	expect(view.getByText("Member abcdef")).toBeDefined();
	expect(view.queryByRole("button", { name: /^Reply to/ })).toBeNull();
});

test("a pending ask shows the question, its files, and that the agent is working", () => {
	const { view } = log(
		timeline([], [ask("1", { kind: "pending" }, ["a.png", "b.pdf"])]),
	);
	expect(view.getByText("You → family agent")).toBeDefined();
	expect(view.getByText("Question 1")).toBeDefined();
	expect(view.getByText("Attached: a.png, b.pdf")).toBeDefined();
	expect(view.getByText("working…")).toBeDefined();
	expect(view.getByText("Checking the family's records…")).toBeDefined();
});

test("a failed ask says it was not answered and why", () => {
	const { view } = log(
		timeline([], [ask("1", { kind: "failed", message: "Sign in first." })]),
	);
	expect(view.getByText("Not answered")).toBeDefined();
	expect(view.getByText("Sign in first.")).toBeDefined();
	expect(view.queryByText(/^Attached:/)).toBeNull();
});

test("an answer shows its model, cited sources, missing records, and follow-ups", () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const answer: FamilyAnswer = {
		...ANSWER,
		evidence: [
			{
				id: "s1",
				familyId: "f1",
				metric: "heart_rate",
				value: 72,
				unit: "bpm",
				sourceTime: "2026-10-01T10:00:00.000Z",
				receivedAt: "2026-10-01T10:00:01.000Z",
				source: "Watch",
				synthetic: true,
				quality: "validated",
				stale: true,
			},
		],
		unavailable: ["steps"],
		followUps: ["And her sleep?"],
	};
	const { view, onFollowUp } = log(
		timeline([], [ask("1", { kind: "answered", answer })]),
	);
	expect(view.getByText("(gemini-test)")).toBeDefined();
	expect(view.getByText("Her heart rate was steady.")).toBeDefined();
	const sources = within(view.getByRole("list", { name: "Sources" }));
	expect(
		sources.getByText(
			/^heart_rate 72 bpm · Watch · .* · demo, not real · stale$/,
		),
	).toBeDefined();
	expect(sources.getByText("No records: steps")).toBeDefined();
	expect(errors).toHaveBeenCalledWith(
		"The answer cites 1 demo samples that are not real readings (heart_rate).",
	);
	expect(view.getByText("Suggested by the family agent")).toBeDefined();
	fireEvent.click(view.getByRole("button", { name: "And her sleep?" }));
	expect(onFollowUp).toHaveBeenCalledWith("And her sleep?");
	errors.mockRestore();
});

test("an answer without sources or follow-ups shows only the text", () => {
	const { view } = log(
		timeline([], [ask("1", { kind: "answered", answer: ANSWER })]),
	);
	expect(view.getByText("Her heart rate was steady.")).toBeDefined();
	expect(view.queryByRole("list", { name: "Sources" })).toBeNull();
	expect(view.queryByText("Suggested by the family agent")).toBeNull();
});

test("the log jumps to the newest entry only when it is your own", () => {
	const scroll = spyOn(HTMLElement.prototype, "scrollTo");
	const other = timeline([message("1", "abcdef999")], []);
	const { view } = log(other);
	expect(scroll).not.toHaveBeenCalled();

	const props = {
		identity: ME,
		emptyText: "",
		onReply: () => {},
		onFollowUp: () => {},
	};
	const mine = [message("1", "abcdef999"), message("2", ME)];
	view.rerender(<ChatLog items={timeline(mine, [])} {...props} />);
	expect(scroll).toHaveBeenCalledTimes(1);
	expect(scroll).toHaveBeenLastCalledWith({ top: 0 });
	view.rerender(
		<ChatLog
			items={timeline(mine, [ask("3", { kind: "pending" })])}
			{...props}
		/>,
	);
	expect(scroll).toHaveBeenCalledTimes(2);
	scroll.mockRestore();
});
