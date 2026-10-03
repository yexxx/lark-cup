import test from "node:test";
import assert from "node:assert/strict";
import { api, send } from "../src/api.js";
import { updateSession } from "../src/session.js";

test("public startup data survives an authentication change", async () => {
  const original = globalThis.fetch;
  let resolve!: (response: Response) => void;
  globalThis.fetch = async () =>
    new Promise<Response>((r) => {
      resolve = r;
    });
  try {
    const startup = api("/competition");
    await new Promise<void>((done) => setImmediate(done));
    updateSession("new-user", true);
    resolve(new Response('{"title":"活动"}'));
    assert.deepEqual(await startup, { title: "活动" });
  } finally {
    globalThis.fetch = original;
    updateSession(null, true);
  }
});

test("bodyless actions omit JSON content type; populated actions preserve JSON and idempotency", async () => {
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options!);
    return new Response("{}", { status: 200 });
  };
  try {
    await send("/works/example/votes", undefined, "POST", {
      "Idempotency-Key": "example",
    });
    await send("/auth/logout");
    await send("/works", { title: "飞行" });
    assert.equal(new Headers(requests[0].headers).get("Content-Type"), null);
    assert.equal(
      new Headers(requests[0].headers).get("Idempotency-Key"),
      "example",
    );
    assert.equal(new Headers(requests[1].headers).get("Content-Type"), null);
    assert.equal(
      new Headers(requests[2].headers).get("Content-Type"),
      "application/json",
    );
    assert.equal(requests[2].body, JSON.stringify({ title: "飞行" }));
  } finally {
    globalThis.fetch = original;
  }
});

test("account changes cancel queued requests and discard old in-flight responses", async () => {
  const original = globalThis.fetch;
  const pending: {
    resolve: (response: Response) => void;
    options: RequestInit;
  }[] = [];
  globalThis.fetch = async (_url, options) =>
    new Promise<Response>((resolve) =>
      pending.push({ resolve, options: options! }),
    );
  updateSession("user-a", true);
  try {
    const running = Array.from({ length: 4 }, () =>
      api("/me/works").then(
        () => "accepted",
        (error) => error.name,
      ),
    );
    const queued = api("/me/quota").then(
      () => "accepted",
      (error) => error.name,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 4);
    assert.ok(
      pending.every(
        (r) => new Headers(r.options.headers).get("X-Lark-User") === "user-a",
      ),
    );
    updateSession("user-b", true);
    assert.equal(await queued, "AbortError");
    for (const request of pending)
      request.resolve(new Response('{"items":["old-private-data"]}'));
    assert.deepEqual(await Promise.all(running), [
      "AbortError",
      "AbortError",
      "AbortError",
      "AbortError",
    ]);
    assert.equal(pending.length, 4);
    globalThis.fetch = async (_url, options) => {
      assert.equal(new Headers(options!.headers).get("X-Lark-User"), "user-b");
      return new Response('{"items":["new-user-data"]}');
    };
    assert.deepEqual(await api("/me/works"), { items: ["new-user-data"] });
    globalThis.fetch = async (_url, options) => {
      assert.equal(new Headers(options!.headers).get("X-Lark-User"), null);
      return new Response('{"user":null}');
    };
    assert.deepEqual(await api("/auth/me"), { user: null });
  } finally {
    globalThis.fetch = original;
    updateSession(null, true);
  }
});
