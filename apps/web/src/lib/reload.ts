// After a deploy, an open page can ask for a lazy chunk of its older build that is gone. Vite then
// fires `vite:preloadError` (every route import goes through Vite's preload helper). One reload
// loads the new build. A second failure within `windowMs` is a real error, so it does not reload
// again: the stamp in sessionStorage stops a reload loop.
const KEY = "telly.chunk-reload";
const windowMs = 10_000;

export function reloadOnce(
	storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
	reload: () => void = () => location.reload(),
	now = Date.now(),
): boolean {
	if (now - Number(storage.getItem(KEY)) < windowMs) return false;
	storage.setItem(KEY, String(now));
	reload();
	return true;
}
