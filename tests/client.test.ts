import test from "node:test";
import assert from "node:assert/strict";
import { send } from "../src/api.js";

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
