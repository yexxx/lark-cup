import { chromium } from "playwright";
import sharp from "sharp";
import { previewPolicy } from "./preview-policy.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const html = Buffer.concat(chunks).toString("utf8");
const server = await chromium.launchServer({
  headless: true,
  chromiumSandbox: true,
  timeout: 5000,
});
process.send?.({ browserPid: server.process().pid });
const browser = await chromium.connect(server.wsEndpoint());
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 860 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
  });
  let served = false;
  const url = "https://work.invalid/";
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!served && request.url() === url && request.isNavigationRequest()) {
      served = true;
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Content-Security-Policy": previewPolicy("'none'"),
          "Referrer-Policy": "no-referrer",
        },
        body: html,
      });
    } else await route.abort();
  });
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
      Object.defineProperty(window, name, {
        value: undefined,
        configurable: false,
        writable: false,
      });
    }
  });
  const page = await context.newPage();
  context.on("page", (popup) => {
    if (popup !== page) void popup.close();
  });
  page.on("dialog", (dialog) => void dialog.dismiss());
  page.on("download", (download) => void download.cancel());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5000 });
  await page.evaluate(async () => {
    await Promise.race([
      Promise.all([
        document.fonts.ready,
        ...Array.from(document.images, (image) =>
          image.decode().catch(() => {}),
        ),
      ]),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  const screenshot = await page.screenshot({
    type: "png",
    fullPage: false,
    timeout: 2000,
  });
  const result = await sharp(screenshot).webp({ quality: 82 }).toBuffer();
  process.stdout.write(result);
} finally {
  await browser.close();
  await server.close();
}
