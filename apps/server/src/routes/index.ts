import { Hono } from "hono";
import type { ServerConfig } from "../config";
import type { FamilyEnv, FamilyRoutes } from "../http";
import { elevenLabsVoice } from "../integrations/elevenlabs";
import { r2Bucket } from "../integrations/r2";
import { alertRoutes } from "./alerts";
import { askRoutes } from "./ask";
import { careRoutes } from "./care";
import { careProfileRoutes } from "./care-profile";
import { chatRoutes } from "./chat";
import { cueRoutes } from "./cues";
import { emergencyRoutes } from "./emergency";
import { exerciseRoutes } from "./exercise";
import { familyRoutes } from "./families";
import { finchnodeRoutes } from "./finchnode";
import { mealRoutes } from "./meal-facts";
import { reportRoutes } from "./reports";
import { toolRoutes } from "./tools";
import { trendRoutes } from "./trends";
import { visionRoutes } from "./vision";
import { voiceRoutes } from "./voice";

/**
 * Every domain route factory, relative to `/api/families/:familyId`. `app.ts` mounts the result
 * behind sign-in and the family membership check. Add a domain's mount here.
 */
export const familyDomainRoutes = (config: ServerConfig): FamilyRoutes => {
	const voice = elevenLabsVoice(config.voice);
	return new Hono<FamilyEnv>()
		.route("/", familyRoutes())
		.route("/", alertRoutes())
		.route("/", voiceRoutes(voice))
		.route(
			"/",
			askRoutes({
				gemini: config.gemini,
				fetchAgent: config.fetchAgent,
				voice,
			}),
		)
		.route("/vision", visionRoutes(config.gemini))
		.route("/", mealRoutes(config.gemini))
		.route(
			"/",
			reportRoutes(config.r2 === undefined ? undefined : r2Bucket(config.r2)),
		)
		.route("/", finchnodeRoutes(config.finchnode))
		.route("/", toolRoutes())
		.route("/", trendRoutes(config.finchnode))
		.route("/", chatRoutes())
		.route("/care", careRoutes())
		.route("/", emergencyRoutes())
		.route("/", cueRoutes(config.gemma))
		.route("/", careProfileRoutes())
		.route("/", exerciseRoutes());
};
