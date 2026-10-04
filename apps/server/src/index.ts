import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { serverConfig } from "./config";
import { ENV } from "./env.server";
import { serverLayer } from "./server";

// SIGINT/SIGTERM interrupt the layer, which closes the listener and the background workers.
NodeRuntime.runMain(Layer.launch(serverLayer(serverConfig(ENV), ENV)));
