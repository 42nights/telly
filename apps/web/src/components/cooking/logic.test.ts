import { describe, expect, test } from "bun:test";
import {
	advance,
	type Session,
	type SessionAction,
	startSession,
} from "./logic";

const steps = [{ helper: false }, { helper: true }];
const run = (...actions: SessionAction[]) =>
	actions.reduce<Session>((s, a) => advance(s, a, steps), startSession);

describe("cooking session", () => {
	test("pause holds the step until resume", () => {
		expect(run("pause", "next", "explain").step).toBe(0);
		expect(run("pause", "next").paused).toBe(true);
		expect(run("pause", "resume", "next").step).toBe(1);
	});

	test("a helper step waits for the helper, and the last step finishes", () => {
		expect(run("next", "next").step).toBe(1);
		expect(run("next", "next").ended).toBeNull();
		expect(run("next", "helper_here", "next").ended).toBe("finished");
	});

	test("explain toggles and resets on the next step; stop ends at once", () => {
		expect(run("explain").explaining).toBe(true);
		expect(run("explain", "next").explaining).toBe(false);
		expect(run("pause", "stop").ended).toBe("stopped");
		expect(run("stop", "resume", "next")).toEqual({
			...startSession,
			ended: "stopped",
		});
	});
});
