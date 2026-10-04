const SILENCE =
	"data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==";

export const player = new Audio();

export function play(src: string, rate = 1) {
	player.src = src;
	player.defaultPlaybackRate = rate;
	player.playbackRate = rate;
	return player.play();
}

export function unlockPlayer() {
	const done = new AbortController();
	const unlock = () => {
		done.abort();
		void play(SILENCE).catch(() => {});
	};
	for (const type of ["pointerdown", "keydown"])
		document.addEventListener(type, unlock, {
			capture: true,
			signal: done.signal,
		});
}
