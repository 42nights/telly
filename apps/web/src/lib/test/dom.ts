// Gives a test file a browser: happy-dom globals plus the server URL that `@/env` would read from
// varlock. Call `setupDom()` at the top of a test file, before it loads the app or testing-library
// with `await import(...)`.
//
// Bun runs every test file in one process with one module cache, so this module's body runs once
// and each file calls `setupDom` for its own hooks. The globals are removed after the file: happy-dom
// replaces `fetch`, `Response`, and other globals that later server tests need from Bun.
import { afterAll, afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React's scheduler keeps the timer functions it finds when it first loads, for the whole run.
// happy-dom's timers stop when its window closes after a file, so every file keeps Bun's own.
const timers = {
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	setImmediate,
	clearImmediate,
	queueMicrotask,
	MessageChannel,
};

const cleanup = async () => {
	const { cleanup } = await import("@testing-library/react/pure");
	cleanup();
};

export function setupDom() {
	GlobalRegistrator.register({ url: "http://app.test/" });
	Object.assign(globalThis, timers);
	mock.module("@/env", () => ({
		ENV: {
			VITE_SERVER_URL: "http://server.test",
			VITE_OIDC_ISSUER: "https://issuer.test",
			VITE_OIDC_CLIENT_ID: "web-client",
		},
	}));
	// Screens load data after the first render, outside `act`; React then warns on every update. The
	// tests wait for the visible result instead, so only that one warning is dropped.
	const consoleError = console.error;
	console.error = (...args: unknown[]) => {
		if (String(args[0]).includes("not wrapped in act(")) return;
		consoleError(...args);
	};
	afterEach(async () => {
		await cleanup();
		localStorage.clear();
		sessionStorage.clear();
	});
	afterAll(async () => {
		await cleanup();
		// Let React finish the work it scheduled for the unmounts while `window` still exists.
		await Bun.sleep(10);
		console.error = consoleError;
		await GlobalRegistrator.unregister();
	});
}
