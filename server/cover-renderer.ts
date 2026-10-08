import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";

export async function renderInProcess(
  html: Buffer,
  timeout = 8000,
  signal?: AbortSignal,
) {
  const temporary = await mkdtemp(path.join(tmpdir(), "lark-render-"));
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./cover-render-worker.ts", import.meta.url)),
        ],
        {
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
            TMPDIR: temporary,
          },
        },
      );
      let failure: Error | undefined,
        size = 0,
        diagnostic = "";
      let browserPid: number | undefined;
      child.on("message", (message: any) => {
        if (Number.isInteger(message?.browserPid))
          browserPid = message.browserPid;
      });
      const chunks: Buffer[] = [];
      const kill = () => {
        if (browserPid && process.platform !== "win32") {
          try {
            process.kill(-browserPid, "SIGKILL");
          } catch {}
        }
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      const abort = () => {
        failure = new Error("Cover rendering cancelled");
        kill();
      };
      const timer = setTimeout(() => {
        failure = new Error("Cover rendering timed out");
        kill();
      }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin!.on("error", () => {});
      child.stdout!.on("data", (data) => {
        size += data.length;
        if (size > 2 * 1024 * 1024) {
          failure = new Error("Cover rendering output exceeded its limit");
          kill();
        } else chunks.push(data);
      });
      child.stderr!.on("data", (data) => {
        if (diagnostic.length < 4000) diagnostic += data.toString();
      });
      child.on("error", (error) => {
        failure = Object.assign(error, { transient: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        // Also reap browser descendants after an early worker failure.
        kill();
        if (failure) reject(failure);
        else if (code !== 0 || !size)
          reject(
            Object.assign(new Error(diagnostic || "Cover renderer failed"), {
              transient:
                /Executable doesn't exist|browser.*launch|sandbox/i.test(
                  diagnostic,
                ),
            }),
          );
        else resolve(Buffer.concat(chunks));
      });
      child.stdin!.end(html);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function buildRenderer(render = renderInProcess) {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, logger: true });
  app.addContentTypeParser(
    "text/html",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  let active = 0;
  app.get("/health", async () => ({ ok: true, active }));
  app.post("/render", async (req, reply) => {
    if (active >= 1)
      return reply
        .code(503)
        .header("Retry-After", "2")
        .send({ message: "Renderer busy" });
    if (!Buffer.isBuffer(req.body))
      return reply.code(400).send({ message: "HTML required" });
    active++;
    const controller = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    req.raw.once("aborted", disconnect);
    reply.raw.once("close", disconnect);
    try {
      return reply
        .type("image/webp")
        .send(await render(req.body, 8000, controller.signal));
    } catch (error: any) {
      req.log.error(error, "Cover rendering failed");
      return reply
        .code(error.transient ? 503 : 422)
        .type("application/json")
        .send({ message: "Cover rendering failed" });
    } finally {
      active--;
      req.raw.removeListener("aborted", disconnect);
      reply.raw.removeListener("close", disconnect);
    }
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildRenderer();
  await app.listen({
    host: process.env.RENDERER_HOST || "127.0.0.1",
    port: Number(process.env.RENDERER_PORT || 3003),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => void app.close());
}
