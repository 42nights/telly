// Registers Happy DOM before React DOM, Testing Library, or TanStack Router load: they check for
// `document` when their modules load. `./dom` imports this module first; test files import `./dom`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React's scheduler keeps the timer functions it finds when it loads, and Bun shares that module
// across test files. Each file closes its Happy DOM window, which stops that window's timers, so the
// page keeps Bun's own timers and React still flushes updates in later files.
const TIMERS = [
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"setImmediate",
	"clearImmediate",
	"queueMicrotask",
	"MessageChannel",
] as const;

export const registerDom = () => {
	if (GlobalRegistrator.isRegistered) return;
	const saved = TIMERS.map((name) =>
		Object.getOwnPropertyDescriptor(globalThis, name),
	);
	GlobalRegistrator.register({ url: "http://app.test/" });
	TIMERS.forEach((name, index) => {
		const descriptor = saved[index];
		if (descriptor !== undefined)
			Object.defineProperty(globalThis, name, descriptor);
	});
};

registerDom();
