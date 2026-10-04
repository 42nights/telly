import "../test/setup";

import { describe, expect, test } from "bun:test";
import { FamilyProvider } from "@/lib/family";
import {
	act,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { useWearerRecords } from "./use-wearer-records";

installDom();

const family = { id: "1", name: "Grandma", createdAt: "2026-01-01T00:00:00Z" };
const records = {
	families: [family],
	samples: [],
	alerts: [],
	messages: [],
	acknowledgements: [],
};

function Probe() {
	const { familyId, familiesKind, records, retry } = useWearerRecords();
	return (
		<>
			<p data-testid="family">{familyId ?? "none"}</p>
			<p data-testid="families">{familiesKind}</p>
			<p data-testid="records">{records === null ? "null" : records.kind}</p>
			<button onClick={retry} type="button">
				Retry
			</button>
		</>
	);
}

const show = () => {
	const view = render(
		<FamilyProvider>
			<Probe />
		</FamilyProvider>,
	);
	return {
		view,
		text: (id: string) => view.getByTestId(id).textContent,
	};
};

describe("useWearerRecords", () => {
	test("while the family list loads, the records show its loading state", () => {
		serve({
			"GET /api/families": () => Promise.withResolvers<ServerReply>().promise,
		});
		const { text } = show();
		expect(text("families")).toBe("loading");
		expect(text("records")).toBe("loading");
		expect(text("family")).toBe("none");
	});

	test("a failed family list explains the missing records, and no records are read", async () => {
		const calls = serve({ "GET /api/families": { status: 401 } });
		const { text } = show();
		await waitFor(() => expect(text("records")).toBe("signed_out"));
		expect(text("families")).toBe("signed_out");
		expect(calls.map((call) => call.path)).toEqual(["/api/families"]);
	});

	test("with no person paired, the records are null", async () => {
		serve({ "GET /api/families": { json: { families: [] } } });
		const { text } = show();
		await waitFor(() => expect(text("families")).toBe("ready"));
		expect(text("records")).toBe("null");
		expect(text("family")).toBe("none");
	});

	test("reads the selected family's records and reads them again on retry", async () => {
		const calls = serve({
			"GET /api/families": { json: { families: [family] } },
			"GET /api/families/1": { json: records },
		});
		const { view, text } = show();
		await waitFor(() => expect(text("records")).toBe("ready"));
		expect(text("family")).toBe("1");
		const reads = () =>
			calls.filter((call) => call.path === "/api/families/1").length;
		expect(reads()).toBe(1);
		await act(async () => view.getByRole("button", { name: "Retry" }).click());
		await waitFor(() => expect(reads()).toBe(2));
	});

	test("a records failure keeps its meaning", async () => {
		serve({
			"GET /api/families": { json: { families: [family] } },
			"GET /api/families/1": {
				status: 503,
				body: { error: "unavailable", message: "Database down" },
			},
		});
		const { text } = show();
		await waitFor(() => expect(text("records")).toBe("unavailable"));
	});
});
