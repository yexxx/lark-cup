import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, type Page } from "playwright";
import type { Competition, Quota, Work } from "../src/types.js";
import type { User } from "../src/auth.js";

const output = "test-results/guide";
await mkdir(output, { recursive: true });
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const address = socket.address();
assert.ok(address && typeof address === "object");
const port = address.port;
await new Promise<void>((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const web = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { stdio: "pipe" },
);
let serverLog = "";
web.stdout.on("data", (chunk) => {
  serverLog += String(chunk);
});
web.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
});
const competition: Competition = {
  title: "超级码力",
  tagline: "让灵感起飞，让码力集结",
  description: "一起发现创意的无限可能。",
  prompt: "创建一个 HTML，内容是用 SVG 绘制一只飞行中唱歌的百灵鸟的 2D 动画。",
  rules: "使用统一提示词创作。",
  prizes: "创意奖",
  submissionStart: "2026-10-01T00:00:00+08:00",
  submissionEnd: "2026-10-24T23:59:59+08:00",
  voteStart: "2026-10-01T00:00:00+08:00",
  voteEnd: "2026-10-25T23:59:59+08:00",
  dailyLimit: 10,
  effectiveDailyLimit: 7,
  nextDailyLimit: null,
  limitEffectiveDate: null,
};
const member: User = {
  id: "guide-user",
  name: "引导验收",
  role: "user",
  status: "active",
};
const coverUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><rect width="400" height="260" fill="#91c8ee"/><ellipse cx="190" cy="140" rx="70" ry="40" fill="#ffcf4a"/><circle cx="251" cy="116" r="27" fill="#ffcf4a"/><circle cx="260" cy="110" r="5" fill="#172e4e"/><path d="M170 140L120 50L220 115M277 111L309 122L277 130" fill="#172e4e"/></svg>')}`;
const work = (status: string, number: number): Work => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  number,
  title: `百灵鸟的创意 ${number}`,
  description: "点击体验飞行中的百灵鸟。",
  model: "创作模型",
  prompt: competition.prompt,
  track: "classic",
  status,
  reason: "",
  recommended: true,
  version: 2,
  votes: 24 - number,
  coverId: "cover",
  htmlId: "html",
  coverMode: "auto",
  coverStatus: "ready",
  coverUrl,
  previewUrl: `${origin}/guide-preview.html`,
  ownerId: member.id,
  rank: number,
  createdAt: "2026-10-08T08:00:00+08:00",
  updatedAt: "2026-10-08T08:00:00+08:00",
});
const owned = [work("approved", 1), work("draft", 2), work("withdrawn", 3)];
let user: User | null = null;
let empty = false;
let failList = false;
let delayList: Promise<void> | null = null;
const quota: Quota = {
  day: "2026-10-08",
  limit: 7,
  classic: 4,
  open: 0,
  votedIds: [owned[0].id],
};
const writes: string[] = [];
const errors: string[] = [];
const journeys: Array<{ width: number; route: string; steps: string[] }> = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let visitSequence = 0;
async function visit(page: Page, path: string) {
  const authenticated = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/auth/me",
  );
  await page.goto(`${origin}/?guide-qa=${++visitSequence}#${path}`);
  await authenticated;
  if (user) await page.locator(".user-button").waitFor();
}
async function readyServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (web.exitCode !== null) throw new Error(serverLog);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite startup timed out: ${serverLog}`);
}
async function openGuide(page: Page, modal = false) {
  const selector = modal
    ? "dialog.dialog [data-guide-entry]"
    : "header [data-guide-entry]";
  if (!modal && (await page.locator(".mobile-toggle").isVisible()))
    await page.locator(".mobile-toggle").click();
  await page.locator(selector).waitFor({ state: "visible" });
  await page.waitForFunction(
    (value) => !(document.querySelector(value) as HTMLButtonElement)?.disabled,
    selector,
  );
  await page.locator(selector).click();
  await page.locator(".guide-card").waitFor({ state: "visible" });
  if (!modal) assert.equal(await page.locator(".nav.open").count(), 0);
}
async function inspectLayout(page: Page) {
  await page
    .waitForFunction(
      () => {
        const outline = document.querySelector(".guide-highlight");
        const card = document
          .querySelector(".guide-card")
          ?.getBoundingClientRect();
        return (
          outline &&
          card &&
          Number(outline.getAttribute("width")) > 2 &&
          Number(outline.getAttribute("height")) > 2 &&
          card.left >= 0 &&
          card.right <= innerWidth + 1 &&
          card.top >= 0 &&
          card.bottom <= innerHeight + 1
        );
      },
      undefined,
      { timeout: 5000 },
    )
    .catch(async (error) => {
      await page.screenshot({ path: `${output}/failure.png` });
      const state = await page.evaluate(() => ({
        viewport: {
          width: innerWidth,
          height: innerHeight,
          visualWidth: visualViewport?.width,
          visualHeight: visualViewport?.height,
          offsetTop: visualViewport?.offsetTop,
          offsetLeft: visualViewport?.offsetLeft,
        },
        step: document
          .querySelector(".guide-card")
          ?.getAttribute("data-guide-step"),
        highlight: document.querySelector(".guide-highlight")?.outerHTML,
        dialogs: Array.from(document.querySelectorAll("dialog")).map(
          (element) => ({
            rect: element.getBoundingClientRect().toJSON(),
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }),
        ),
      }));
      throw new Error(`${String(error)} ${JSON.stringify(state)}`);
    });
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".guide-card")!;
    const rect = panel.getBoundingClientRect();
    const outline = document.querySelector(".guide-highlight")!;
    const hole = {
      left: Number(outline.getAttribute("x")),
      top: Number(outline.getAttribute("y")),
      width: Number(outline.getAttribute("width")),
      height: Number(outline.getAttribute("height")),
    };
    const control = panel
      .querySelector(".guide-controls")!
      .getBoundingClientRect();
    return {
      card: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      hole,
      width: innerWidth,
      height: innerHeight,
      controlBottom: control.bottom,
      step: panel.dataset.guideStep,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(
    geometry.card.left >= 0 && geometry.card.right <= geometry.width + 1,
    JSON.stringify(geometry),
  );
  assert.ok(
    geometry.card.top >= 0 && geometry.card.bottom <= geometry.height + 1,
    JSON.stringify(geometry),
  );
  assert.ok(
    geometry.controlBottom <= geometry.height,
    JSON.stringify(geometry),
  );
  assert.equal(geometry.overflow, false, JSON.stringify(geometry));
  const { hole, card } = geometry;
  assert.ok(
    hole.left + hole.width <= card.left ||
      hole.left >= card.right ||
      hole.top + hole.height <= card.top ||
      hole.top >= card.bottom,
    JSON.stringify(geometry),
  );
  return geometry.step!;
}
async function completeGuide(
  page: Page,
  width: number,
  screenshotPrefix?: string,
) {
  const baseline = writes.length;
  const steps: string[] = [];
  for (let count = 0; count < 15; count++) {
    const id = await inspectLayout(page);
    steps.push(id);
    if (screenshotPrefix && (id === "submit-html" || steps.length === 1))
      await page.screenshot({
        path: `${output}/${screenshotPrefix}-${id}-${width}.png`,
      });
    const dialog = page.locator(".guide-dialog");
    const done = dialog.getByRole("button", { name: "完成", exact: true });
    if (await done.count()) {
      await done.click();
      break;
    }
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
  }
  assert.equal(await page.locator(".guide-dialog").count(), 0);
  assert.equal(writes.length, baseline, "guide caused a business write");
  journeys.push({ width, route: new URL(page.url()).hash, steps });
  return steps;
}
try {
  await readyServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
  });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      await route.fulfill({
        status: 500,
        json: { message: "Unexpected business write during guide QA" },
      });
      return;
    }
    let body: unknown;
    if (path === "/competition") body = competition;
    else if (path === "/auth/me") body = { user };
    else if (path === "/me/quota") body = quota;
    else if (path === "/stats")
      body = { works: empty ? 0 : 3, votes: 66, creators: 3 };
    else if (path === "/me/works") body = { items: empty ? [] : owned };
    else if (path === "/works" || path === "/leaderboard") {
      if (delayList) await delayList;
      if (failList) {
        await route.fulfill({
          status: 503,
          json: { message: "服务繁忙，请稍后重试" },
        });
        return;
      }
      body = {
        items: empty ? [] : [owned[0]],
        total: empty ? 0 : 1,
        pages: 1,
        updatedAt: "2026-10-08T08:00:00+08:00",
      };
    } else if (path.startsWith("/works/"))
      body = owned.find((item) => item.id === path.split("/")[2]);
    else if (path.startsWith("/uploads/"))
      body = { id: "cover", url: coverUrl, status: "ready" };
    else body = {};
    await route.fulfill({ json: body });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width <= 600 ? 844 : 1100 });
    user = null;
    empty = false;
    for (const path of [
      "/",
      "/gallery",
      "/ranking",
      `/work/${owned[0].id}`,
      "/submit",
      "/mine",
    ]) {
      await visit(page, path);
      assert.equal(
        await page.locator(".guide-dialog").count(),
        0,
        "guide opened automatically",
      );
      await openGuide(page);
      await completeGuide(page, width, path === "/" ? "home" : undefined);
    }
    await visit(page, "/submit");
    await page.getByRole("button", { name: "登录并参赛", exact: true }).click();
    const auth = page.locator("dialog.dialog");
    await auth.locator("input[name=username]").fill("guide_test");
    await auth.locator("input[name=password]").fill("password with 空格");
    await openGuide(page, true);
    await completeGuide(page, width);
    assert.equal(
      await auth.locator("input[name=password]").inputValue(),
      "password with 空格",
    );
    assert.equal(
      await auth
        .locator("[data-guide-entry]")
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await auth.getByRole("button", { name: "注册", exact: true }).click();
    await auth.locator("input[name=name]").fill("创作者");
    await openGuide(page, true);
    await completeGuide(page, width, width === 390 ? "register" : undefined);
    assert.equal(await auth.locator("input[name=name]").inputValue(), "创作者");
    await auth.getByRole("button", { name: "关闭", exact: true }).click();
    user = member;
    await visit(page, "/submit");
    await page.getByPlaceholder("给你的灵感起个名字").fill("填写中的作品");
    await page
      .getByPlaceholder("它有什么故事？可以怎样互动？")
      .fill("输入内容保持完整");
    await page.getByPlaceholder("例如：你使用的模型及版本").fill("测试模型");
    await openGuide(page);
    await completeGuide(page, width, "submit");
    assert.equal(
      await page.getByPlaceholder("给你的灵感起个名字").inputValue(),
      "填写中的作品",
    );
    assert.equal(
      await page.getByPlaceholder("它有什么故事？可以怎样互动？").inputValue(),
      "输入内容保持完整",
    );
    for (const path of [
      "/mine",
      `/submit/${owned[0].id}`,
      `/work/${owned[1].id}`,
    ]) {
      await visit(page, path);
      await openGuide(page);
      await completeGuide(page, width);
    }
    empty = true;
    for (const path of ["/gallery", "/ranking", "/mine"]) {
      await visit(page, path);
      await openGuide(page);
      const steps = await completeGuide(page, width);
      if (path === "/mine") assert.deepEqual(steps, ["mine-create"]);
      else assert.equal(steps.includes("gallery-vote"), false);
    }
    console.log(`Guide journeys passed at ${width}px.`);
  }
  empty = false;
  await visit(page, "/gallery");
  await openGuide(page);
  for (const width of [320, 1440, 768, 390, 1440]) {
    await page.setViewportSize({ width, height: width <= 600 ? 844 : 1100 });
    await inspectLayout(page);
  }
  await page
    .locator(".guide-dialog")
    .getByRole("button", { name: "下一步", exact: true })
    .click();
  await page
    .locator(".guide-dialog")
    .getByRole("button", { name: "上一步", exact: true })
    .click();
  assert.match(await page.locator(".guide-progress").innerText(), /1 \/ /);
  for (let count = 0; count < 10; count++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator(".guide-dialog")
        .evaluate((element) => element.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".guide-dialog").count(), 0);
  assert.equal(
    await page
      .locator("header [data-guide-entry]")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await openGuide(page);
  assert.match(await page.locator(".guide-progress").innerText(), /1 \/ /);
  await page
    .locator('[data-guide="gallery-search"]')
    .evaluate((element) => element.removeAttribute("data-guide"));
  await page.locator(".guide-card[data-guide-step=gallery-sort]").waitFor();
  await page.evaluate(() => {
    location.hash = "/ranking";
  });
  await page.locator(".guide-dialog").waitFor({ state: "detached" });
  await openGuide(page);
  user = null;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("lark:auth-changed")),
  );
  await page.locator(".guide-dialog").waitFor({ state: "detached" });
  await openGuide(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("lark:auth-expired")),
  );
  await page.locator(".guide-dialog").waitFor({ state: "detached" });
  await page.locator("dialog.dialog").waitFor();
  assert.equal(
    await page.evaluate(() => document.body.style.overflow),
    "hidden",
  );
  await page
    .locator("dialog.dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");
  let resolveList!: () => void;
  delayList = new Promise<void>((resolve) => {
    resolveList = resolve;
  });
  await visit(page, "/gallery");
  await page.waitForFunction(
    () =>
      (document.querySelector("header [data-guide-entry]") as HTMLButtonElement)
        ?.disabled,
  );
  resolveList();
  delayList = null;
  await openGuide(page);
  await page
    .locator(".guide-dialog")
    .getByRole("button", { name: "跳过", exact: true })
    .click();
  failList = true;
  await visit(page, "/gallery");
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.locator("header [data-guide-entry]").isDisabled(),
    true,
  );
  failList = false;
  for (const path of ["/admin", "/missing", "/submit-missing"]) {
    await visit(page, path);
    await page.locator("footer").waitFor();
    assert.equal(await page.locator("[data-guide-entry]").count(), 0);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        fixtureBased: true,
        widths: [320, 390, 768, 1440],
        journeys,
        writes,
        errors,
        focusRestoration: true,
        keyboardTrap: true,
        missingAnchorRecovery: true,
        loadingAndErrorStates: true,
        routeAndAccountChanges: true,
        formValuesPreserved: true,
        modalScrollLocks: true,
        activeViewportResize: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `Guide QA passed: ${journeys.length} journeys; zero business writes. Screenshots: ${output}/`,
  );
  await Promise.all(
    ["failure.png", "failure.json"].map((name) =>
      rm(`${output}/${name}`, { force: true }),
    ),
  );
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    await failedPage.screenshot({ path: `${output}/failure.png` });
    await writeFile(
      `${output}/failure.json`,
      JSON.stringify(
        {
          error: String(error),
          user,
          errors,
          page: await failedPage.locator("body").innerText(),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  web.kill("SIGTERM");
}
