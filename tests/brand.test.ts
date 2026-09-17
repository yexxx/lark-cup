import test from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { settings } from "../server/domain.js";
import { activityWindow } from "../src/activity.js";

const migration = "003_super_code_brand.sql";
test("brand migration upgrades default fields independently and preserves activity configuration", async () => {
  const db = await openDB({ memory: true });
  try {
    await migrate(db);
    const initial = await settings(db);
    assert.equal(initial.title, "超级码力");
    assert.equal(initial.tagline, "让灵感起飞，让码力集结");
    assert.match(initial.prompt, /SVG/);
    const custom = {
      ...initial,
      title: "社区定制活动",
      tagline: "一只百灵鸟，无限种可能。",
      description: "管理员介绍",
      prizes: "社区奖品",
      submissionEnd: "2026-10-24T23:59:59+08:00",
      dailyLimit: 7,
    };
    await db.query("UPDATE competition SET data=$1 WHERE id=1", [
      JSON.stringify(custom),
    ]);
    await db.query("DELETE FROM schema_migrations WHERE name=$1", [migration]);
    await migrate(db);
    const upgraded = await settings(db);
    assert.deepEqual(upgraded, {
      ...custom,
      tagline: "让灵感起飞，让码力集结",
    });
    await migrate(db);
    assert.deepEqual(await settings(db), upgraded);
    await db.query("UPDATE competition SET data=$1 WHERE id=1", [
      JSON.stringify({
        ...custom,
        title: "百灵鸟杯",
        tagline: "管理员口号",
        description:
          "用 AI，让想象自由鸣唱。一个主题，不同模型，创造属于你的百灵鸟世界。",
      }),
    ]);
    await db.query("DELETE FROM schema_migrations WHERE name=$1", [migration]);
    await migrate(db);
    assert.deepEqual(await settings(db), {
      ...custom,
      title: initial.title,
      tagline: "管理员口号",
      description: initial.description,
    });
  } finally {
    await db.close();
  }
});
test("activity status respects configured inclusive boundaries", () => {
  const start = "2026-10-01T00:00:00+08:00",
    end = "2026-10-24T23:59:59+08:00";
  assert.equal(activityWindow(start, end, Date.parse(start) - 1), "未开始");
  assert.equal(activityWindow(start, end, Date.parse(start)), "进行中");
  assert.equal(activityWindow(start, end, Date.parse(end)), "进行中");
  assert.equal(activityWindow(start, end, Date.parse(end) + 1), "已结束");
});
