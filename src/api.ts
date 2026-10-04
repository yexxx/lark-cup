import {
  sessionIdentity,
  sessionVersion,
  trackSession,
  reportSessionError,
} from "./session";
let active = 0;
type Waiter = {
  resolve: () => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
};
const queue: Waiter[] = [];
const cancelled = () =>
  new DOMException("登录状态已更新，请重新操作", "AbortError");
async function permit(signal: AbortSignal) {
  if (signal.aborted) throw cancelled();
  if (active < 4) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      signal,
      abort: () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(cancelled());
      },
    };
    queue.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
  });
}
function release() {
  const next = queue.shift();
  if (next) {
    next.signal.removeEventListener("abort", next.abort);
    next.resolve();
  } else active--;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const publicRead =
    (!options.method || options.method === "GET") &&
    ["/competition", "/stats", "/health", "/leaderboard", "/works"].includes(
      url.split("?")[0],
    );
  const bound =
    url === "/auth/password" ||
    url === "/auth/logout" ||
    (!url.startsWith("/auth/") && !publicRead);
  const version = sessionVersion();
  const controller = new AbortController();
  const untrack = bound ? trackSession(controller) : () => {};
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let acquired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await permit(controller.signal);
    acquired = true;
    if (controller.signal.aborted || (bound && version !== sessionVersion()))
      throw cancelled();
    timer = setTimeout(() => controller.abort(), 20000);
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    const id = sessionIdentity();
    if (bound && id) headers.set("X-Lark-User", id);
    const response = await fetch(`/api/v1${url}`, {
      ...options,
      credentials: "same-origin",
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      if (response.ok) throw new ApiError("服务器响应异常，请稍后重试", 502);
      data = {
        message:
          response.status === 429
            ? "请求过于频繁，请稍后再试"
            : response.status >= 500
              ? "服务暂时不可用，请稍后再试"
              : "请求失败，请稍后重试",
      };
    }
    if (controller.signal.aborted || (bound && version !== sessionVersion()))
      throw cancelled();
    if (!response.ok) {
      if (
        bound &&
        (response.status !== 401 ||
          url !== "/auth/password" ||
          data.code === "AUTH_EXPIRED")
      )
        reportSessionError(response.status, data.code);
      throw new ApiError(data.message || "请求失败", response.status);
    }
    return data;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
    untrack();
    if (acquired) release();
  }
}
export const send = (
  url: string,
  body?: unknown,
  method = "POST",
  headers?: Record<string, string>,
) =>
  api(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
export async function upload(
  file: File,
  onProgress: (n: number) => void,
): Promise<{ id: string; kind: string }> {
  const controller = new AbortController();
  const untrack = trackSession(controller);
  const version = sessionVersion();
  const id = sessionIdentity();
  let acquired = false;
  try {
    await permit(controller.signal);
    acquired = true;
    if (controller.signal.aborted || version !== sessionVersion())
      throw cancelled();
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      xhr.open("POST", "/api/v1/uploads");
      if (id) xhr.setRequestHeader("X-Lark-User", id);
      xhr.timeout = 60000;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onloadend = () =>
        controller.signal.removeEventListener("abort", abort);
      xhr.onabort = () => reject(cancelled());
      xhr.onerror = () => reject(new Error("上传连接中断，请重试"));
      xhr.ontimeout = () => reject(new Error("上传超时，请重试"));
      xhr.onload = () => {
        if (controller.signal.aborted || version !== sessionVersion()) {
          reject(cancelled());
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else {
            reportSessionError(xhr.status, data.code);
            reject(new ApiError(data.message || "上传失败", xhr.status));
          }
        } catch {
          reject(
            new ApiError(
              xhr.status === 429
                ? "请求过于频繁，请稍后再试"
                : xhr.status >= 500
                  ? "服务暂时不可用，请稍后再试"
                  : xhr.status === 413
                    ? "上传文件超过大小限制"
                    : "上传响应异常，请稍后重试",
              xhr.status || 502,
            ),
          );
        }
      };
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  } finally {
    untrack();
    if (acquired) release();
  }
}
