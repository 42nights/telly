import { useEffect, useState } from "react";

/** `Date.now()`, updated every second for clocks and ages. */
export function useNow() {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}
