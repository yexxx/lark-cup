import test from "node:test";
import assert from "node:assert/strict";
import {
  detailGuide,
  galleryGuide,
  loginGuide,
  mineGuide,
  scheduleGuidance,
  submitGuide,
  voteGuidance,
} from "../src/guides.js";
import { placeGuide } from "../src/guide-layout.js";
import type { Competition, Quota, Work } from "../src/types.js";
import type { User } from "../src/auth.js";

const competition: Competition = {
  title: "创作活动",
  tagline: "创作",
  description: "活动介绍",
  prompt: "用 SVG 创作百灵鸟",
  rules: "活动规则",
  prizes: "奖项",
  submissionStart: "2026-10-01T00:00:00+08:00",
  submissionEnd: "2026-10-24T23:59:59+08:00",
  voteStart: "2026-10-01T00:00:00+08:00",
  voteEnd: "2026-10-25T23:59:59+08:00",
  dailyLimit: 10,
  effectiveDailyLimit: 7,
  nextDailyLimit: null,
  limitEffectiveDate: null,
};
const user: User = {
  id: "user",
  name: "创作者",
  role: "user",
  status: "active",
};
const work = (status: string): Work =>
  ({ id: status, title: "百灵鸟", status }) as Work;
const quota: Quota = {
  day: "2026-10-08",
  limit: 7,
  classic: 4,
  open: 0,
  votedIds: ["approved"],
};
const now = Date.parse("2026-10-08T12:00:00+08:00");
const text = (guide: ReturnType<typeof submitGuide>) =>
  guide.steps.map((step) => step.body).join(" ");

test("vote guidance uses current quotas, account state and work eligibility", () => {
  assert.match(
    voteGuidance(competition, null, null, undefined, now),
    /登录后.*每日 7 票/,
  );
  assert.match(
    voteGuidance(competition, user, quota, undefined, now),
    /还剩 3 票/,
  );
  assert.match(
    voteGuidance(competition, user, quota, work("approved"), now),
    /今天已为这份作品投票/,
  );
  assert.match(
    voteGuidance(competition, user, { ...quota, classic: 7 }, undefined, now),
    /选票已用完/,
  );
  assert.match(
    voteGuidance(competition, user, { ...quota, limit: 12 }, undefined, now),
    /每日 12 票/,
  );
  assert.match(
    voteGuidance(competition, user, quota, work("draft"), now),
    /公开后可参与投票/,
  );
  assert.match(
    voteGuidance(competition, user, null, undefined, now),
    /额度正在同步/,
  );
});
test("schedule guidance reflects configured inclusive windows and Beijing time", () => {
  const start = Date.parse(competition.submissionStart);
  const end = Date.parse(competition.submissionEnd);
  assert.match(
    scheduleGuidance(competition, "submission", start - 1),
    /当前未开始/,
  );
  assert.match(
    scheduleGuidance(competition, "submission", start),
    /当前进行中/,
  );
  assert.match(scheduleGuidance(competition, "submission", end), /当前进行中/);
  assert.match(
    scheduleGuidance(competition, "submission", end + 1),
    /当前已结束/,
  );
  assert.match(
    scheduleGuidance(competition, "submission", now),
    /10\/01 00:00.*10\/24 23:59.*北京时间/,
  );
});
test("submission and authentication guides match existing optional fields and publication behavior", () => {
  assert.match(
    text(submitGuide(competition, user, true, false)),
    /名称必填.*介绍.*模型可选填/,
  );
  assert.match(
    text(submitGuide(competition, user, true, false)),
    /HTML 前保存/,
  );
  assert.match(
    text(submitGuide(competition, user, true, true)),
    /保存后继续在展区展示/,
  );
  assert.match(
    text(submitGuide(competition, user, true, true)),
    /生成中或使用占位封面时也可发布/,
  );
  assert.equal(submitGuide(competition, null, true, false).steps.length, 1);
  assert.match(text(loginGuide(true, false)), /显示姓名.*允许.*重名/);
  assert.match(text(loginGuide(false, false)), /忘记密码.*管理员重置/);
  assert.equal(loginGuide(true, true).ready, false);
});
test("empty and mixed ownership lists offer actions matching the mounted UI", () => {
  const empty = mineGuide(user, true, []);
  assert.deepEqual(
    empty.steps.map((step) => step.anchor),
    ["mine-create"],
  );
  const mixed = mineGuide(user, true, [
    work("draft"),
    work("approved"),
    work("withdrawn"),
  ]);
  assert.ok(mixed.steps.some((step) => step.anchor === "mine-withdraw"));
  assert.ok(mixed.steps.some((step) => step.anchor === "mine-publish"));
  assert.equal(
    mineGuide(user, true, [work("approved")]).steps.some(
      (step) => step.anchor === "mine-publish",
    ),
    false,
  );
  assert.equal(
    galleryGuide(false, competition, null, null, true).steps.some(
      (step) => step.anchor === "gallery-vote",
    ),
    false,
  );
  assert.match(
    text(detailGuide(work("draft"), competition, user, quota, true)),
    /尚未提供 HTML/,
  );
});
test("guide placement separates the card and highlight at all acceptance widths", () => {
  for (const width of [320, 390, 768, 1440]) {
    const viewport = { left: 0, top: 0, width, height: 844 };
    const card = { width: Math.min(360, width - 24), height: 300 };
    for (const target of [
      { left: 18, top: 70, width: Math.min(width - 36, 250), height: 44 },
      { left: 18, top: 12, width: width - 36, height: 700 },
    ]) {
      const { card: panel, hole } = placeGuide(
        target,
        card,
        viewport,
        width <= 600,
      );
      assert.ok(panel.left >= 12 && panel.left + panel.width <= width - 12);
      assert.ok(
        panel.top >= 12 && panel.top + card.height <= viewport.height - 12,
      );
      assert.ok(hole.width > 0 && hole.height > 0);
      const separated =
        hole.left + hole.width <= panel.left ||
        hole.left >= panel.left + panel.width ||
        hole.top + hole.height <= panel.top ||
        hole.top >= panel.top + card.height;
      assert.ok(separated, `card overlaps highlight at width ${width}`);
    }
  }
});
