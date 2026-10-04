import { describe, expect, test } from "bun:test";
import { cn } from "@health/ui/lib/utils";

describe("cn", () => {
	test("joins truthy class values and drops falsy ones", () => {
		expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
	});

	test("includes object keys whose value is truthy", () => {
		expect(cn({ on: true, off: false }, ["x", ["y"]])).toBe("on x y");
	});

	test("later tailwind utility wins a conflict", () => {
		expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
	});

	test("keeps non-conflicting utilities across variants", () => {
		expect(cn("text-red-500 hover:text-blue-500", "text-green-500")).toBe(
			"hover:text-blue-500 text-green-500",
		);
	});
});
