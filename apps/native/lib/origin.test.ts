/// <reference types="bun" />

import { expect, test } from "bun:test";

import { originOf } from "./origin";

test("originOf returns only an exact http(s) origin", () => {
	expect(originOf("https://app.saintess.tech")).toBe(
		"https://app.saintess.tech",
	);
	expect(originOf("HTTPS://App.Saintess.Tech/family?x=1#y")).toBe(
		"https://app.saintess.tech",
	);
	expect(originOf("http://192.168.1.5:3001/")).toBe("http://192.168.1.5:3001");
	// Look-alike hosts keep their own origin, so they never equal the web app's origin.
	expect(originOf("https://app.saintess.tech.evil.example/")).toBe(
		"https://app.saintess.tech.evil.example",
	);
	expect(originOf("https://app.saintess.tech@evil.example/")).toBeNull();
	expect(originOf("tel:+15551234567")).toBeNull();
	expect(originOf("mailto:a@example.com")).toBeNull();
	expect(originOf("about:blank")).toBeNull();
});
