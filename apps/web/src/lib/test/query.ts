// Readies the app's one query cache for a test file. Load it after the file's DOM exists.
import { notifyManager } from "@tanstack/react-query";

import { queryClient } from "@/lib/query";

/**
 * The cache listens for focus and network changes on the window it found when it mounted, and each
 * test file has a new window, so it mounts again on this one. In the browser the cache tells
 * screens about a reply on a timer; in a test, fake timers or a tight loop of presses can hold
 * timers back, so it tells them at once, as a promise would.
 */
export function prepareQueryCache() {
	notifyManager.setScheduler(queueMicrotask);
	queryClient.unmount();
	queryClient.mount();
}
