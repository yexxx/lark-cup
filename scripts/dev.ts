import { spawn } from "node:child_process";
const api = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  stdio: "inherit",
});
const web = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { stdio: "inherit" },
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  api.kill();
  web.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => {
  stop();
  process.exitCode = code || 0;
});
web.on("exit", (code) => {
  stop();
  process.exitCode = code || 0;
});
