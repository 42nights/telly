import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";

import { saveWebSession } from "@/lib/web-session";

export default function SignIn() {
	const { url, token } = useLocalSearchParams();
	useEffect(() => {
		const valid =
			typeof url === "string" &&
			url.startsWith("https://") &&
			typeof token === "string" &&
			token !== "";
		void (valid ? saveWebSession({ url, token }) : Promise.resolve()).then(() =>
			router.replace("/web"),
		);
	}, [url, token]);
	return null;
}
