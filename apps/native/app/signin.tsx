import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";

import { saveSession } from "@/lib/session";

export default function SignIn() {
	const { url, token } = useLocalSearchParams();
	useEffect(() => {
		const valid =
			typeof url === "string" &&
			url.startsWith("https://") &&
			typeof token === "string" &&
			token !== "";
		void (valid ? saveSession({ url, token }) : Promise.resolve()).then(() =>
			router.replace("/"),
		);
	}, [url, token]);
	return null;
}
