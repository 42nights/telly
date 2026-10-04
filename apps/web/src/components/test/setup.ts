// Import this module for its side effect as the FIRST import of a component test
// (`import "../test/setup";`). It must run before React DOM and `@/env` load:
// - React DOM decides at load whether it runs in a browser (for example, whether text inputs fire
//   `onChange`), so the happy-dom globals must exist before it loads. `installDom()` removes them
//   after each component test file and installs them again for the next one.
// - The generated `@/env` reads varlock's ENV, which `varlock run` fills in the app. Tests fill it
//   with the one value the components read.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initVarlockEnv } from "varlock/env";

const SERVER = "http://server.test";

// React's scheduler keeps the timer functions it finds when it loads, once per process. happy-dom's
// timers stop when its window closes after a test file, so later files would never render an
// update. The runtime's own timers stay installed instead.
const timers = {
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	setImmediate,
	clearImmediate,
	queueMicrotask,
};

/** Installs the happy-dom globals, keeping the runtime's timers. */
export function registerDom() {
	if (!GlobalRegistrator.isRegistered)
		GlobalRegistrator.register({ url: "http://localhost/" });
	Object.assign(globalThis, timers, { IS_REACT_ACT_ENVIRONMENT: true });
}

registerDom();
Object.assign(globalThis, {
	__varlockLoadedEnv: {
		settings: { disableProcessEnvInjection: true },
		config: { VITE_SERVER_URL: { value: SERVER } },
	},
});
initVarlockEnv();
