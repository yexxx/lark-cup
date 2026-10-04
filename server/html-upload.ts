import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateHtml } from "./html.js";

export async function validateHtmlUpload(data: Buffer) {
  if (data.length <= 128 * 1024) {
    validateHtml(data);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--max-old-space-size=256",
        fileURLToPath(new URL("./html-worker.ts", import.meta.url)),
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "",
      failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = Object.assign(new Error("HTML 处理超时，请精简内容后重试"), {
        statusCode: 400,
      });
      child.kill("SIGKILL");
    }, 3000);
    child.stdout.on("data", (chunk) => {
      if (output.length < 16384) output += chunk.toString();
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      failure = Object.assign(new Error("文件处理服务繁忙，请稍后再试"), {
        statusCode: 503,
      });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      let result: any;
      try {
        result = JSON.parse(output);
      } catch {}
      if (code === 0 && result?.ok) return resolve();
      reject(
        Object.assign(
          new Error(result?.message || "HTML 内容过于复杂，请精简内容后重试"),
          { statusCode: result?.statusCode || 400 },
        ),
      );
    });
    child.stdin.end(data);
  });
}
