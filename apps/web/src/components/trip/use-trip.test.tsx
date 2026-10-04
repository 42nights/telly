import "../test/setup";

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	act,
	cleanup,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import type { Trip } from "./logic";
import { useLocationReporter, useTrip } from "./use-trip";

installDom();

const trip: Trip = {
	destination: "the pharmacy",
	purpose: "pick up my pills",
	setAt: 1,
};

function TripProbe({ next }: { next: Trip | null }) {
	const [current, save] = useTrip();
	return (
		<>
			<p data-testid="trip">
				{current === null ? "none" : current.destination}
			</p>
			<button onClick={() => save(next)} type="button">
				Save
			</button>
		</>
	);
}

describe("useTrip", () => {
	test("starts with the trip saved on this device", async () => {
		localStorage.setItem("telly.trip", JSON.stringify(trip));
		const view = render(<TripProbe next={null} />);
		await waitFor(() =>
			expect(view.getByTestId("trip").textContent).toBe("the pharmacy"),
		);
	});

	test.each([
		["nothing saved", null],
		["broken JSON", "{"],
		["a wrong shape", JSON.stringify({ ...trip, setAt: "now" })],
		["a bare value", "3"],
	])("%s gives no trip", (_, stored) => {
		if (stored !== null) localStorage.setItem("telly.trip", stored);
		const view = render(<TripProbe next={null} />);
		expect(view.getByTestId("trip").textContent).toBe("none");
	});

	test("saving shows and keeps the trip; saving null cancels it", async () => {
		const view = render(<TripProbe next={trip} />);
		await act(async () => view.getByRole("button").click());
		expect(view.getByTestId("trip").textContent).toBe("the pharmacy");
		expect(JSON.parse(localStorage.getItem("telly.trip") ?? "null")).toEqual(
			trip,
		);
		view.rerender(<TripProbe next={null} />);
		await act(async () => view.getByRole("button").click());
		expect(view.getByTestId("trip").textContent).toBe("none");
		expect(localStorage.getItem("telly.trip")).toBeNull();
	});
});

const start = Date.parse("2026-01-01T08:00:00Z");
const me = "a".repeat(64);
const shared = (status: string) => ({
	familyId: "1",
	sharer: me,
	status,
	fix: null,
	reportedAt: "2026-01-01T08:00:00Z",
});

type Watcher = {
	success: PositionCallback;
	failure: PositionErrorCallback;
};

/** Installs a fake `navigator.geolocation`; returns the watchers and cleared ids. */
const fakeGeolocation = () => {
	const watchers: Watcher[] = [];
	const cleared: number[] = [];
	Object.defineProperty(navigator, "geolocation", {
		configurable: true,
		value: {
			watchPosition: (
				success: PositionCallback,
				failure: PositionErrorCallback,
			) => watchers.push({ success, failure }),
			clearWatch: (id: number) => cleared.push(id),
		},
	});
	return { watchers, cleared };
};

const position = (latitude: number) =>
	({
		coords: { latitude, longitude: 2, accuracy: 8 },
		timestamp: start,
	}) as GeolocationPosition;
const denied = {
	code: 1,
	PERMISSION_DENIED: 1,
	POSITION_UNAVAILABLE: 2,
	TIMEOUT: 3,
} as GeolocationPositionError;

function ReporterProbe({
	familyId,
	active,
}: {
	familyId: string | null;
	active: boolean;
}) {
	const state = useLocationReporter(familyId, active);
	return (
		<p data-testid="state">
			{state.kind === "sent"
				? `sent ${state.report.status}`
				: state.kind === "failed"
					? state.message
					: state.kind}
		</p>
	);
}

describe("useLocationReporter", () => {
	afterEach(() => {
		// Unmount first: the hook clears its watch on the fake geolocation.
		cleanup();
		Reflect.deleteProperty(navigator, "geolocation");
		setSystemTime();
	});

	const report = (call: { body: unknown }): ServerReply => {
		const body = call.body;
		const status =
			typeof body === "object" && body !== null && "status" in body
				? String(body.status)
				: "?";
		return { json: shared(status) };
	};

	test.each([
		["not active", "1", false],
		["no family", null, true],
	])("is off and sends nothing when %s", (_, familyId, active) => {
		const calls = serve({});
		const { watchers } = fakeGeolocation();
		const view = render(<ReporterProbe active={active} familyId={familyId} />);
		expect(view.getByTestId("state").textContent).toBe("off");
		expect(calls).toEqual([]);
		expect(watchers).toEqual([]);
	});

	test("without location in the browser, it reports no fix once", async () => {
		// happy-dom defines `geolocation` on the prototype; hide it for this test.
		const proto = Object.getPrototypeOf(navigator);
		const descriptor = Object.getOwnPropertyDescriptor(proto, "geolocation");
		Reflect.deleteProperty(proto, "geolocation");
		try {
			const calls = serve({ "POST /api/families/1/location": report });
			const view = render(<ReporterProbe active familyId="1" />);
			await waitFor(() =>
				expect(view.getByTestId("state").textContent).toBe("sent no_fix"),
			);
			expect(calls.map((call) => call.body)).toEqual([{ status: "no_fix" }]);
			cleanup();
		} finally {
			if (descriptor !== undefined)
				Object.defineProperty(proto, "geolocation", descriptor);
		}
	});

	test("sends a fix at once, the same status at most once a minute, and a change of status at once", async () => {
		setSystemTime(start);
		const calls = serve({ "POST /api/families/1/location": report });
		const { watchers, cleared } = fakeGeolocation();
		const view = render(<ReporterProbe active familyId="1" />);
		const state = () => view.getByTestId("state").textContent;
		expect(state()).toBe("waiting");
		const watcher = watchers[0];
		if (watcher === undefined) throw new Error("no watch");

		await act(async () => watcher.success(position(1)));
		await waitFor(() => expect(state()).toBe("sent fix"));
		expect(calls[0]?.body).toEqual({
			status: "fix",
			fix: {
				latitude: 1,
				longitude: 2,
				accuracyMeters: 8,
				fixTime: "2026-01-01T08:00:00.000Z",
			},
		});

		setSystemTime(start + 59_000);
		await act(async () => watcher.success(position(1.1)));
		expect(calls).toHaveLength(1);

		await act(async () => watcher.failure(denied));
		await waitFor(() => expect(state()).toBe("sent gps_denied"));
		expect(calls[1]?.body).toEqual({ status: "gps_denied" });

		setSystemTime(start + 120_000);
		await act(async () => watcher.success(position(1.2)));
		await waitFor(() => expect(calls).toHaveLength(3));

		view.unmount();
		expect(cleared).toEqual([1]);
	});

	test.each([
		// A 401 ends the session, so the next position has no token to send with.
		[{ status: 401 }, "Not sent: sign in again.", 1],
		[
			{ status: 403, body: { error: "forbidden", message: "Share first." } },
			"Not sent: Share first.",
			2,
		],
	])(
		"a refused report says why and the next position tries again at once",
		async (reply, text, sent) => {
			const calls = serve({ "POST /api/families/1/location": reply });
			const { watchers } = fakeGeolocation();
			const view = render(<ReporterProbe active familyId="1" />);
			const watcher = watchers[0];
			if (watcher === undefined) throw new Error("no watch");
			await act(async () => watcher.success(position(1)));
			await waitFor(() =>
				expect(view.getByTestId("state").textContent).toBe(text),
			);
			await act(async () => watcher.success(position(1)));
			await waitFor(() => expect(calls).toHaveLength(sent));
			await waitFor(() =>
				expect(view.getByTestId("state").textContent).toBe(text),
			);
		},
	);

	test("a report still in flight when sharing stops changes nothing", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({
			"POST /api/families/1/location": () => reply.promise,
		});
		const { watchers, cleared } = fakeGeolocation();
		const view = render(<ReporterProbe active familyId="1" />);
		const watcher = watchers[0];
		if (watcher === undefined) throw new Error("no watch");
		await act(async () => watcher.success(position(1)));
		expect(calls).toHaveLength(1);
		view.rerender(<ReporterProbe active={false} familyId="1" />);
		expect(cleared).toEqual([1]);
		await act(async () => reply.resolve({ json: shared("fix") }));
		expect(view.getByTestId("state").textContent).toBe("off");
	});

	test("a report that fails after the family changed does not show as a failure", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		serve({ "POST /api/families/1/location": () => reply.promise });
		const { watchers } = fakeGeolocation();
		const view = render(<ReporterProbe active familyId="1" />);
		const watcher = watchers[0];
		if (watcher === undefined) throw new Error("no watch");
		await act(async () => watcher.success(position(1)));
		view.rerender(<ReporterProbe active familyId="2" />);
		await act(async () => reply.reject(new Error("connection reset")));
		expect(view.getByTestId("state").textContent).toBe("waiting");
	});
});
