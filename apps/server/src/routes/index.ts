import { Hono } from "hono";
import type { ServerConfig } from "../config";
import type { FamilyEnv, FamilyRoutes } from "../http";
import { simulatedDelivery } from "../integrations/delivery";
import { elevenLabsVoice } from "../integrations/elevenlabs";
import { r2Bucket } from "../integrations/r2";
import { resendMailer } from "../integrations/resend";
import { alertRoutes } from "./alerts";
import { appointmentRoutes } from "./appointments";
import { askRoutes } from "./ask";
import { careRoutes } from "./care";
import { careProfileRoutes } from "./care-profile";
import { chatRoutes } from "./chat";
import { cookingRoutes } from "./cooking";
import { cueRoutes } from "./cues";
import { deliveryRoutes } from "./delivery";
import { emergencyRoutes } from "./emergency";
import { exerciseRoutes } from "./exercise";
import { familyRoutes } from "./families";
import { finchnodeRoutes } from "./finchnode";
import { healthKitRoutes } from "./healthkit";
import { locationRoutes } from "./location";
import { mealRoutes } from "./meal-facts";
import { medicineMemoryRoutes } from "./medicine-memory";
import { reminderRoutes } from "./reminders";
import { reportRoutes } from "./reports";
import { speakerRoutes } from "./speaker";
import { toolRoutes } from "./tools";
import { trendRoutes } from "./trends";
import { tripRoutes } from "./trips";
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
		.route("/", medicineMemoryRoutes())
		.route("/", mealRoutes(config.gemini))
		.route(
			"/",
			reportRoutes(
				config.r2 === undefined ? undefined : r2Bucket(config.r2),
				config.reportEmail === undefined
					? undefined
					: resendMailer(config.reportEmail),
			),
		)
		.route("/", reminderRoutes())
		.route("/", speakerRoutes())
		.route("/", finchnodeRoutes(config.finchnode))
		.route("/", appointmentRoutes(config.finchnode))
		.route("/", toolRoutes())
		.route("/", trendRoutes(config.finchnode))
		.route("/", chatRoutes())
		.route("/care", careRoutes())
		.route("/", emergencyRoutes())
		.route("/", cueRoutes(config.qwen))
		.route("/", careProfileRoutes())
		.route("/", tripRoutes())
		.route("/", exerciseRoutes())
		.route("/", deliveryRoutes(simulatedDelivery()))
		.route("/", healthKitRoutes())
		.route("/", locationRoutes())
		.route("/", cookingRoutes());
};
