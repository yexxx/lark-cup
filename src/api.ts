let active = 0;
const queue: (() => void)[] = [];
async function permit() {
  if (active >= 4) await new Promise<void>((r) => queue.push(r));
  else active++;
}
function release() {
  const next = queue.shift();
  if (next) next();
  else active--;
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
  await permit();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/v1${url}`, {
        ...options,
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });
      const data = await response.json();
      if (!response.ok)
        throw new ApiError(data.message || "请求失败", response.status);
      return data;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release();
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
  await permit();
  try {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/v1/uploads");
      xhr.timeout = 60000;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onerror = () => reject(new Error("上传连接中断，请重试"));
      xhr.ontimeout = () => reject(new Error("上传超时，请重试"));
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(data.message || "上传失败", xhr.status));
        } catch {
          reject(new Error("上传响应异常"));
        }
      };
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  } finally {
    release();
  }
}
