import { spawn } from "node:child_process";
const renderer = spawn(
  process.execPath,
  ["--import", "tsx", "server/cover-renderer.ts"],
  {
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    },
  },
);
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
  renderer.kill();
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
renderer.on("exit", (code) => {
  if (!stopping)
    process.stderr.write(
      `封面服务已退出（${code}），作品可继续使用占位封面发布。\n`,
    );
});
