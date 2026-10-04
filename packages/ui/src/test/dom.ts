import "./register";
import { afterAll, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";

/**
 * Give the calling test file a DOM and remove it after the file.
 * bun test shares one global scope across files, so a DOM left behind would
 * leak into server and logic tests. Query through `render()` or
 * `within(document.body)`, not `screen`: `screen` binds the first document.
 *
 * ponytail: a module that reads `window` at import time (next-themes) and is
 * first imported by a later test file sees no DOM. A bunfig `preload` of
 * `./register` fixes that if a test ever needs it.
 */
export function installDom() {
	if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
	afterEach(cleanup);
	afterAll(async () => {
		// Let deferred React work (base-ui positioners) finish while `window` exists.
		await Bun.sleep(0);
		await GlobalRegistrator.unregister();
	});
}
