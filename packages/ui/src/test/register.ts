import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Own module so it evaluates before React and Testing Library load:
// react-dom reads `window` once at import time.
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
