// The generated env module needs varlock at runtime; tests only need the server URL. Import this
// module for its side effect as the first import of a component test (`import "../test/env";`), so
// the mock is in place before anything loads `@/lib/api`, which loads `@/env`.
import { mock } from "bun:test";

export const SERVER = "http://server.test";
mock.module("@/env", () => ({ ENV: { VITE_SERVER_URL: SERVER } }));
