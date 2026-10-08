import test from "node:test";
import assert from "node:assert/strict";
import { api, send, upload } from "../src/api.js";
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

test("upload replacement and account changes cancel XHR and discard old responses", async () => {
  const original = globalThis.XMLHttpRequest;
  const requests: any[] = [];
  class MockXHR {
    upload = {};
    status = 200;
    responseText = '{"id":"old","kind":"html"}';
    onabort?: () => void;
    onload?: () => void;
    onloadend?: () => void;
    open() {}
    setRequestHeader() {}
    send() {
      requests.push(this);
    }
    abort() {
      this.onabort?.();
      this.onloadend?.();
    }
  }
  globalThis.XMLHttpRequest = MockXHR as any;
  updateSession("upload-user-a", true);
  try {
    const controller = new AbortController();
    const replaced = upload(
      new File(["html"], "one.html"),
      () => {},
      controller.signal,
    ).then(
      () => "accepted",
      (e) => e.name,
    );
    await new Promise<void>((r) => setImmediate(r));
    controller.abort();
    assert.equal(await replaced, "AbortError");
    requests[0].onload();
    const stale = upload(new File(["html"], "two.html"), () => {}).then(
      () => "accepted",
      (e) => e.name,
    );
    await new Promise<void>((r) => setImmediate(r));
    updateSession("upload-user-b", true);
    assert.equal(await stale, "AbortError");
    requests[1].onload();
    const current = upload(new File(["html"], "three.html"), () => {});
    await new Promise<void>((r) => setImmediate(r));
    requests[2].responseText = '{"id":"new","kind":"html"}';
    requests[2].onload();
    requests[2].onloadend();
    assert.equal((await current).id, "new");
  } finally {
    globalThis.XMLHttpRequest = original;
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
