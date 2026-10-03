import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InjectOptions } from "fastify";
import { openDB, type DB } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { buildApp } from "../server/app.js";
import { Cache } from "../server/cache.js";
import { config } from "../server/config.js";
import {
  createLocalAccount,
  resetLocalPassword,
  resolveIdentity,
  cleanupSessions,
  createSessionStore,
} from "../server/auth.js";
import { hashPassword } from "../server/password.js";
let db: DB, servers: Awaited<ReturnType<typeof buildApp>>, folder: string;
const initialTime = new Date("2026-10-03T10:00:00+08:00");
let now = initialTime;
const password = "local password 这是测试密码 🔑";
const changedPassword = "updated password 这是新密码 🔐";
let client = 1;
const cookieOf = (r: { headers: Record<string, unknown> }) =>
  ([] as string[])
    .concat((r.headers["set-cookie"] as string[]) || [])
    .find((s) => s.startsWith("lark_session="))!
    .split(";")[0];
const headers = (cookie?: string) => ({
  origin: config.appOrigin,
  ...(cookie ? { cookie } : {}),
});
const write = (
  url: string,
  payload?: InjectOptions["payload"],
  cookie?: string,
  method: InjectOptions["method"] = "POST",
) =>
  servers.app.inject({
    method,
    url: `/api/v1${url}`,
    payload,
    headers: headers(cookie),
    remoteAddress: `127.0.0.${client++}`,
  });
const read = (url: string, cookie?: string) =>
  servers.app.inject({ url: `/api/v1${url}`, headers: headers(cookie) });
async function register(username: string, name = "同名参赛者") {
  const r = await write("/auth/register", { username, name, password });
  assert.equal(r.statusCode, 200, r.body);
  return { user: r.json().user, cookie: cookieOf(r) };
}
async function login(username: string, secret = password, cookie?: string) {
  return write("/auth/login", { username, password: secret }, cookie);
}
before(async () => {
  db = await openDB({ memory: true });
  await migrate(db);
  folder = await mkdtemp(path.join(tmpdir(), "lark-auth-"));
  servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
    now: () => now,
  });
});
after(async () => {
  await servers?.close();
  await db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

test("registration validates credentials, generates stable IDs and grants participant role", async () => {
  assert.equal(
    (await write("/auth/register", { username: "ab", name: "甲", password }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await write("/auth/register", {
        username: "short",
        name: "甲",
        password: "short",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await write("/auth/register", {
        username: "long",
        name: "甲",
        password: "密".repeat(129),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await write("/auth/register", {
        username: "privileged",
        name: "甲",
        password,
        role: "admin",
      })
    ).statusCode,
    400,
  );
  const a = await register("Admin"),
    b = await register("another");
  assert.equal(a.user.role, "user");
  assert.equal(a.user.name, b.user.name);
  assert.notEqual(a.user.id, b.user.id);
  assert.match(a.user.id, /^[a-f0-9-]{36}$/);
  assert.equal((await read("/admin/overview", a.cookie)).statusCode, 403);
  const stored = (
    await db.query(
      "SELECT password_hash FROM local_credentials WHERE user_id=$1",
      [a.user.id],
    )
  ).rows[0].password_hash;
  assert.match(stored, /^scrypt\$131072\$8\$1\$/);
  assert.ok(!stored.includes(password));
  const session = (
    await db.query("SELECT token_hash FROM auth_sessions WHERE user_id=$1", [
      a.user.id,
    ])
  ).rows[0].token_hash;
  assert.match(session, /^[a-f0-9]{64}$/);
  assert.ok(!a.cookie.includes(session));
});
test("case-insensitive concurrent registration creates one complete account", async () => {
  const beforeCount = (await db.query("SELECT count(*) FROM users")).rows[0]
    .count;
  const results = await Promise.all([
    write("/auth/register", { username: "Alice", name: "甲", password }),
    write("/auth/register", { username: "ALICE", name: "乙", password }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    Number((await db.query("SELECT count(*) FROM users")).rows[0].count),
    Number(beforeCount) + 1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM auth_identities WHERE subject='alice'",
      )
    ).rows[0].count,
    1,
  );
  const success = await login("aLiCe");
  assert.equal(success.statusCode, 200, success.body);
});
test("login failures are uniform; anonymous and cross-site writes are rejected", async () => {
  const missing = await login("missinguser"),
    wrong = await login("alice", changedPassword);
  assert.equal(missing.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(missing.json().message, wrong.json().message);
  assert.equal((await read("/auth/me")).json().user, null);
  for (const origin of [undefined, "null", "https://evil.example"]) {
    const r = await servers.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "alice", password },
      headers: origin ? { origin } : {},
    });
    assert.equal(r.statusCode, 403);
  }
});
test("two users have independent works, assets and daily votes; stale client identity is refused", async () => {
  const a = await register("isolate_a"),
    b = await register("isolate_b");
  const payload = {
    title: "用户甲作品",
    description: "d",
    model: "m",
    prompt: "p",
    coverId: null,
    htmlId: null,
  };
  const draft = await write("/works", payload, a.cookie);
  assert.equal(draft.statusCode, 200, draft.body);
  const mineA = await read("/me/works", a.cookie),
    mineB = await read("/me/works", b.cookie);
  assert.equal(mineA.json().items[0].id, draft.json().id);
  assert.equal(mineB.json().items.length, 0);
  assert.equal(
    (await read(`/works/${draft.json().id}`, b.cookie)).statusCode,
    404,
  );
  const asset = randomUUID();
  await db.query(
    "INSERT INTO assets(id,owner_id,kind,filename,mime,bytes) VALUES($1,$2,'html',$3,'text/html',10)",
    [asset, a.user.id, `${asset}.html`],
  );
  assert.equal(
    (await write("/works", { ...payload, htmlId: asset }, b.cookie)).statusCode,
    400,
  );
  const approved = randomUUID();
  await db.query(
    "INSERT INTO works(id,owner_id,track,title,description,model,prompt,status) VALUES($1,$2,'classic','w','d','m','p','approved')",
    [approved, a.user.id],
  );
  const vote = await servers.app.inject({
    method: "POST",
    url: `/api/v1/works/${approved}/votes`,
    headers: { ...headers(a.cookie), "idempotency-key": randomUUID() },
  });
  assert.equal(vote.statusCode, 200, vote.body);
  assert.equal((await read("/me/quota", a.cookie)).json().classic, 1);
  assert.equal((await read("/me/quota", b.cookie)).json().classic, 0);
  const stale = await servers.app.inject({
    method: "POST",
    url: "/api/v1/works",
    headers: { ...headers(b.cookie), "x-lark-user": a.user.id },
    payload,
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "AUTH_CHANGED");
  for (const [url, payload] of [
    ["/auth/logout", undefined],
    [
      "/auth/password",
      { currentPassword: password, newPassword: changedPassword },
    ],
  ] as const) {
    const staleAuth = await servers.app.inject({
      method: "POST",
      url: `/api/v1${url}`,
      headers: { ...headers(b.cookie), "x-lark-user": a.user.id },
      payload,
    });
    assert.equal(staleAuth.statusCode, 409);
    assert.equal(staleAuth.json().code, "AUTH_CHANGED");
    assert.equal((await read("/auth/me", b.cookie)).json().user.id, b.user.id);
  }
  for (let i = 0; i < 12; i++) {
    assert.equal(
      (await read("/auth/me", i % 2 ? b.cookie : a.cookie)).json().user.id,
      i % 2 ? b.user.id : a.user.id,
    );
  }
});
test("multiple devices keep separate sessions; logout and rotation revoke only the current session", async () => {
  const a = await register("devices");
  const second = await login("devices"),
    cookieB = cookieOf(second);
  assert.notEqual(a.cookie, cookieB);
  await write("/auth/logout", undefined, a.cookie);
  assert.equal((await read("/auth/me", a.cookie)).json().user, null);
  assert.equal((await read("/me/quota", a.cookie)).statusCode, 401);
  assert.equal((await read("/auth/me", cookieB)).json().user.id, a.user.id);
  const rotated = await login("devices", password, cookieB);
  assert.equal((await read("/auth/me", cookieB)).json().user, null);
  assert.equal(
    (await read("/auth/me", cookieOf(rotated))).json().user.id,
    a.user.id,
  );
  for (const forged of [
    "lark_demo=admin",
    `lark_session=${"a".repeat(43)}`,
    `${cookieOf(rotated)}; ${cookieOf(rotated)}`,
  ])
    assert.equal((await read("/auth/me", forged)).json().user, null);
  const other = await register("logout_other");
  await write("/auth/logout", undefined, cookieOf(rotated));
  assert.equal(
    (await read("/auth/me", other.cookie)).json().user.id,
    other.user.id,
  );
});
test("idle and absolute expiry are enforced on the server and expired rows are collected", async () => {
  try {
    const idle = await register("idle");
    now = new Date(initialTime.getTime() + config.authIdleSeconds * 1000);
    assert.equal((await read("/auth/me", idle.cookie)).json().user, null);
    await cleanupSessions(db, now);
    assert.equal(
      (
        await db.query("SELECT count(*) FROM auth_sessions WHERE user_id=$1", [
          idle.user.id,
        ])
      ).rows[0].count,
      0,
    );
    now = initialTime;
    const absolute = await register("absolute");
    for (let hours = 12; hours < 168; hours += 12) {
      now = new Date(initialTime.getTime() + hours * 3600000);
      assert.equal(
        (await read("/auth/me", absolute.cookie)).json().user.id,
        absolute.user.id,
      );
    }
    now = new Date(initialTime.getTime() + config.authSessionSeconds * 1000);
    assert.equal((await read("/auth/me", absolute.cookie)).json().user, null);
  } finally {
    now = initialTime;
  }
});
test("sessions survive app restart; provider identities resolve to the same competition user", async () => {
  const a = await register("restart");
  await servers.close();
  servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
    now: () => now,
  });
  assert.equal((await read("/auth/me", a.cookie)).json().user.id, a.user.id);
  await db.query(
    "INSERT INTO auth_identities(provider,subject,user_id) VALUES('enterprise-test','verified-subject',$1)",
    [a.user.id],
  );
  assert.equal(
    (await resolveIdentity(db, "enterprise-test", "verified-subject"))!.id,
    a.user.id,
  );
  const provider = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
    now: () => now,
  });
  const sessions = createSessionStore(db, () => now);
  provider.app.post("/api/v1/test-verified-provider", async (req, reply) => {
    const mapped = await resolveIdentity(
      db,
      "enterprise-test",
      "verified-subject",
    );
    return { user: await sessions.establish(req, reply, mapped!.id) };
  });
  try {
    const login = await provider.app.inject({
      method: "POST",
      url: "/api/v1/test-verified-provider",
      headers: headers(),
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().user.id, a.user.id);
    assert.equal(
      (await read("/auth/me", cookieOf(login))).json().user.id,
      a.user.id,
    );
  } finally {
    await provider.close();
  }
});
test("password change and server reset invalidate every device and enforce the new password", async () => {
  const a = await register("passwords");
  const second = await login("passwords"),
    cookieB = cookieOf(second);
  assert.equal(
    (
      await write(
        "/auth/password",
        { currentPassword: changedPassword, newPassword: changedPassword },
        a.cookie,
      )
    ).statusCode,
    401,
  );
  assert.equal((await read("/auth/me", a.cookie)).json().user.id, a.user.id);
  assert.equal(
    (
      await write(
        "/auth/password",
        { currentPassword: password, newPassword: changedPassword },
        a.cookie,
      )
    ).statusCode,
    200,
  );
  for (const cookie of [a.cookie, cookieB])
    assert.equal((await read("/auth/me", cookie)).json().user, null);
  assert.equal((await login("passwords")).statusCode, 401);
  const updated = await login("passwords", changedPassword);
  assert.equal(updated.statusCode, 200, updated.body);
  await resetLocalPassword(db, "PASSWORDS", password);
  assert.equal((await read("/auth/me", cookieOf(updated))).json().user, null);
  assert.equal((await login("passwords", changedPassword)).statusCode, 401);
  assert.equal((await login("passwords")).statusCode, 200);
});
test("disabling a user revokes every session and re-enabling requires fresh login", async () => {
  await createLocalAccount(
    db,
    { username: "organizer", name: "管理员", password },
    "admin",
  );
  const admin = cookieOf(await login("organizer"));
  const a = await register("disabled"),
    cookieB = cookieOf(await login("disabled"));
  assert.equal(
    (
      await write(
        `/admin/users/${a.user.id}`,
        { status: "disabled" },
        admin,
        "PATCH",
      )
    ).statusCode,
    200,
  );
  for (const cookie of [a.cookie, cookieB])
    assert.equal((await read("/auth/me", cookie)).json().user, null);
  assert.equal((await login("disabled")).statusCode, 403);
  assert.equal(
    (
      await write(
        `/admin/users/${a.user.id}`,
        { status: "active" },
        admin,
        "PATCH",
      )
    ).statusCode,
    200,
  );
  assert.equal((await read("/auth/me", a.cookie)).json().user, null);
  assert.equal((await login("disabled")).statusCode, 200);
});
test("login and registration have independent shared rate budgets", async () => {
  const oldRegister = config.authRegisterRate,
    oldLogin = config.authLoginAccountRate,
    oldIp = config.authLoginIpRate;
  try {
    config.authRegisterRate = 1;
    const opts = {
      method: "POST" as const,
      url: "/api/v1/auth/register",
      headers: headers(),
      remoteAddress: "192.0.2.20",
    };
    assert.equal(
      (
        await servers.app.inject({
          ...opts,
          payload: { username: "ratelogin", name: "限流", password },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await servers.app.inject({
          ...opts,
          payload: { username: "rateregister", name: "限流", password },
        })
      ).statusCode,
      429,
    );
    config.authLoginAccountRate = 1;
    assert.equal((await login("ratelogin", changedPassword)).statusCode, 401);
    assert.equal((await login("ratelogin", changedPassword)).statusCode, 429);
    config.authLoginIpRate = 1;
    const request = {
      method: "POST" as const,
      url: "/api/v1/auth/login",
      headers: headers(),
      remoteAddress: "192.0.2.21",
    };
    assert.equal(
      (
        await servers.app.inject({
          ...request,
          payload: { username: "missing_one", password },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await servers.app.inject({
          ...request,
          payload: { username: "missing_two", password },
        })
      ).statusCode,
      429,
    );
  } finally {
    config.authRegisterRate = oldRegister;
    config.authLoginAccountRate = oldLogin;
    config.authLoginIpRate = oldIp;
  }
});
test("password computation rejects excess work and recovers its capacity", async () => {
  const results = await Promise.allSettled([
    hashPassword(password),
    hashPassword(password),
    hashPassword(password),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.statusCode, 503);
  assert.match(await hashPassword(password), /^scrypt\$/);
});
function interceptDB(db: DB, query: DB["query"]): DB {
  return {
    ...db,
    query,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn(
          interceptDB(tx, async (sql, args) => {
            if (sql.startsWith("INSERT INTO auth_sessions"))
              throw new Error("injected session write failure");
            return tx.query(sql, args);
          }),
        ),
      ),
  };
}
test("a failed session write rolls registration back completely", async () => {
  const wrapped = interceptDB(db, (sql, args) => db.query(sql, args));
  const failed = await buildApp(wrapped, {
    cache: new Cache(true),
    uploads: folder,
  });
  const beforeCount = (await db.query("SELECT count(*) FROM users")).rows[0]
    .count;
  try {
    const result = await failed.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: headers(),
      payload: { username: "rollback", name: "故障", password },
    });
    assert.equal(result.statusCode, 500);
    assert.equal(await resolveIdentity(db, "local", "rollback"), null);
    assert.equal(
      (await db.query("SELECT count(*) FROM users")).rows[0].count,
      beforeCount,
    );
  } finally {
    await failed.close();
  }
  await register("rollback");
});
test("password reset racing with login prevents a stale password from creating a session", async () => {
  const a = await register("race_reset");
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const selected = new Promise<void>((r) => {
    arrived = r;
  });
  const wrapped: DB = {
    ...db,
    query: async (sql, args) => {
      const result = await db.query(sql, args);
      if (
        sql.startsWith("SELECT u.id,u.name,u.role,u.status,c.password_hash")
      ) {
        arrived();
        await gate;
      }
      return result;
    },
  };
  const racing = await buildApp(wrapped, {
    cache: new Cache(true),
    uploads: folder,
  });
  try {
    const pending = racing.app
      .inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: headers(),
        payload: { username: "race_reset", password },
      })
      .then((r) => r);
    await selected;
    await resetLocalPassword(db, "race_reset", changedPassword);
    release();
    assert.equal((await pending).statusCode, 401);
    assert.equal(
      (
        await db.query("SELECT count(*) FROM auth_sessions WHERE user_id=$1", [
          a.user.id,
        ])
      ).rows[0].count,
      0,
    );
  } finally {
    release();
    await racing.close();
  }
});
test("HTTPS cookies are host scoped, secure and cleared with the same attributes", async () => {
  const original = config.appOrigin;
  try {
    config.appOrigin = "https://cup.example.test";
    const a = await write("/auth/register", {
      username: "https_cookie",
      name: "HTTPS",
      password,
    });
    assert.equal(a.statusCode, 200, a.body);
    const cookies = ([] as string[]).concat(a.headers["set-cookie"] || []);
    assert.ok(
      cookies.every(
        (c) =>
          c.includes("HttpOnly") &&
          c.includes("SameSite=Lax") &&
          c.includes("Secure") &&
          !c.includes("Domain="),
      ),
    );
    const logout = await write("/auth/logout", undefined, cookieOf(a));
    assert.ok(
      ([] as string[])
        .concat(logout.headers["set-cookie"] || [])
        .every((c) => c.includes("Max-Age=0") && c.includes("Secure")),
    );
  } finally {
    config.appOrigin = original;
  }
});
