import { openDB } from "./db.js";
import { migrate } from "./migrate.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
const db = await openDB();
await migrate(db);
const servers = await buildApp(db, { logger: true });
await servers.app.listen({ host: "0.0.0.0", port: config.port });
await servers.preview.listen({ host: "0.0.0.0", port: config.previewPort });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await servers.close();
  await db.close();
}
process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
