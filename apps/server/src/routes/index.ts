import { Hono } from "hono";
import type { ServerConfig } from "../config";
import type { FamilyEnv, FamilyRoutes } from "../http";
import { elevenLabsVoice } from "../integrations/elevenlabs";
import { alertRoutes } from "./alerts";
import { chatRoutes } from "./chat";
import { cueRoutes } from "./cues";
import { familyRoutes } from "./families";
import { finchnodeRoutes } from "./finchnode";
import { reportRoutes } from "./reports";
import { toolRoutes } from "./tools";
import { visionRoutes } from "./vision";
import { voiceRoutes } from "./voice";

/**
 * Every domain route factory, relative to `/api/families/:familyId`. `app.ts` mounts the result
 * behind sign-in and the family membership check. Add a domain's mount here.
 */
export const familyDomainRoutes = (config: ServerConfig): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.route("/", familyRoutes())
		.route("/", alertRoutes())
		.route("/", voiceRoutes(elevenLabsVoice(config.voice)))
		.route("/vision", visionRoutes(config.gemini))
		.route("/", reportRoutes())
		.route("/", finchnodeRoutes(config.finchnode))
		.route("/", toolRoutes())
		.route("/", chatRoutes())
		.route("/", cueRoutes(config.gemma));
