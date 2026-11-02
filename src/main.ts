// QT Chart starts here: the saved data (settings, drawings, alerts) comes from the backend first, then the app
// itself (app.ts) is built with it.

import { initStorage } from "./core/storage.ts";

void initStorage().then(() => import("./app.ts"));
