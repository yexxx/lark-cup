import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { args, local, root, type Fixture } from "./common.js";
const a = args(),
  command = String(a.command || "check"),
  exec = promisify(execFile),
  name = "lark-load-tls";
const env = {
  ...process.env,
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
  DOCKER_CONFIG: path.join(local, "docker"),
};
const folder = path.join(local, "certs"),
  main = "https://localhost:18443",
  preview = "https://127.0.0.1:18443";
async function docker(argv: string[]) {
  return exec("docker", argv, { env, timeout: 60000, maxBuffer: 100000 });
}
if (command === "up") {
  await writeFile(
    path.join(local, "tls-state.json"),
    await readFile(path.join(local, "active.json"), "utf8"),
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "7",
    "-keyout",
    path.join(folder, "ca.key"),
    "-out",
    path.join(folder, "ca.pem"),
    "-subj",
    "/CN=Lark Load Test CA",
  ]);
  await exec("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(folder, "server.key"),
    "-out",
    path.join(folder, "server.csr"),
    "-subj",
    "/CN=localhost",
  ]);
  await writeFile(
    path.join(folder, "extensions.cnf"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  await exec("openssl", [
    "x509",
    "-req",
    "-in",
    path.join(folder, "server.csr"),
    "-CA",
    path.join(folder, "ca.pem"),
    "-CAkey",
    path.join(folder, "ca.key"),
    "-CAcreateserial",
    "-out",
    path.join(folder, "server.pem"),
    "-days",
    "7",
    "-extfile",
    path.join(folder, "extensions.cnf"),
  ]);
  for (const file of ["ca.key", "server.key"])
    await chmod(path.join(folder, file), 0o600);
  let config = await readFile(path.join(root, "deploy/nginx.tls.conf"), "utf8");
  config = config
    .replaceAll("cup.example.com", "localhost")
    .replaceAll("preview.example.net", "127.0.0.1")
    .replaceAll(
      "/etc/nginx/certs/main/fullchain.pem",
      "/etc/nginx/certs/server.pem",
    )
    .replaceAll(
      "/etc/nginx/certs/preview/fullchain.pem",
      "/etc/nginx/certs/server.pem",
    )
    .replaceAll(
      "/etc/nginx/certs/main/privkey.pem",
      "/etc/nginx/certs/server.key",
    )
    .replaceAll(
      "/etc/nginx/certs/preview/privkey.pem",
      "/etc/nginx/certs/server.key",
    );
  await writeFile(path.join(local, "nginx-tls.conf"), config);
  await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/load/env.ts",
      "--command",
      "up",
      "--tag",
      "fixed",
      "--profile",
      "default",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LOAD_APP_ORIGIN: main,
        LOAD_PREVIEW_ORIGIN: preview,
        LOAD_CAPTURE_PREVIEW_HEADERS: "1",
      },
      timeout: 180000,
      maxBuffer: 300000,
    },
  );
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "lark-cup-load-owned=true",
    "--network",
    "lark-cup-load_default",
    "--memory",
    "192m",
    "--cpus",
    "0.5",
    "-p",
    "127.0.0.1:18443:443",
    "-v",
    `${path.join(local, "nginx-tls.conf")}:/etc/nginx/nginx.conf:ro`,
    "-v",
    `${folder}:/etc/nginx/certs:ro`,
    "lark-cup-load-web:fixed",
  ]);
  console.log(
    JSON.stringify({ main, preview, ca: path.join(folder, "ca.pem") }),
  );
} else if (command === "down") {
  const label = (
    await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "lark-cup-load-owned"}}',
      name,
    ])
  ).stdout.trim();
  assert.equal(label, "true");
  await docker(["rm", "-f", name]);
  const previous = JSON.parse(
    await readFile(path.join(local, "tls-state.json"), "utf8"),
  );
  await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/load/env.ts",
      "--command",
      "up",
      "--source",
      previous.source,
      "--tag",
      previous.tag,
      "--profile",
      previous.profile,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LOAD_APP_ORIGIN: previous.appOrigin || "http://localhost:18080",
        LOAD_PREVIEW_ORIGIN: previous.previewOrigin || "http://localhost:18081",
        LOAD_CAPTURE_PREVIEW_HEADERS: "0",
      },
      timeout: 180000,
      maxBuffer: 300000,
    },
  );
} else if (command === "check") {
  const fixture: Fixture = JSON.parse(
      await readFile(path.join(local, "fixtures/fixture.json"), "utf8"),
    ),
    ca = await readFile(path.join(folder, "ca.pem"));
  function call(
    url: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: unknown,
  ) {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      data: any;
      authorized: boolean;
      protocol: string | null;
    }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        url,
        {
          method,
          ca,
          headers: {
            ...headers,
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": String(Buffer.byteLength(payload)),
                }
              : {}),
          },
          timeout: 10000,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          const socket = res.socket as import("node:tls").TLSSocket;
          res.on("data", (s) => (text += s));
          res.on("end", () => {
            let data: any;
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              data,
              authorized: socket.authorized,
              protocol: socket.getProtocol(),
            });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("TLS timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }
  const login = await call(
    main + "/api/v1/auth/login",
    "POST",
    { Origin: main },
    { username: fixture.users[200].username, password: fixture.password },
  );
  assert.equal(login.status, 200);
  assert(login.authorized);
  const cookie = login.headers["set-cookie"]!.find((s) =>
    s.startsWith("lark_session="),
  )!;
  assert(cookie.includes("Secure"));
  assert(cookie.includes("HttpOnly"));
  assert(cookie.includes("SameSite=Lax"));
  assert(!cookie.includes("Domain="));
  const sessionCookie = cookie.split(";")[0],
    me = await call(main + "/api/v1/auth/me", "GET", { Cookie: sessionCookie });
  assert.equal(me.data.user.id, fixture.users[200].id);
  const previewPage = await call(
    preview + "/preview/" + fixture.works[0].htmlId,
    "GET",
    {
      Cookie: sessionCookie,
      Authorization: "Bearer synthetic-load-probe",
      "X-Forwarded-For": "198.18.0.99",
    },
  );
  assert.equal(previewPage.status, 200);
  assert(previewPage.authorized);
  assert.equal(previewPage.headers["set-cookie"], undefined);
  const captured = (
    await readFile(path.join(local, "metrics/preview-headers.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s))
    .filter((r) => r.path === "/preview/" + fixture.works[0].htmlId)
    .at(-1);
  assert(captured);
  assert.equal(captured.cookiePresent, false);
  assert.equal(captured.authorizationPresent, false);
  assert.notEqual(captured.ip, "198.18.0.99");
  assert(
    String(previewPage.headers["content-security-policy"]).includes(
      "sandbox allow-scripts",
    ),
  );
  const cross = await call(main + "/api/v1/auth/logout", "POST", {
    Cookie: sessionCookie,
    Origin: preview,
  });
  assert.equal(cross.status, 403);
  const logout = await call(main + "/api/v1/auth/logout", "POST", {
    Cookie: sessionCookie,
    Origin: main,
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await call(main + "/api/v1/auth/me", "GET", { Cookie: sessionCookie }))
      .data.user,
    null,
  );
  const result = {
    date: new Date().toISOString(),
    main,
    preview,
    certificateAuthorized: true,
    tlsProtocol: login.protocol,
    cookie: { secure: true, httpOnly: true, sameSite: "Lax", hostScoped: true },
    proxySession: 200,
    crossOrigin: 403,
    previewStatus: 200,
    previewCookieStripped: true,
    logout: 200,
  };
  const output = path.resolve(
    String(a.output || "test-results/load/tls-checks.json"),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else throw new Error("Use --command up|check|down");
