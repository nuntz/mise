/**
 * Renders the app icon's PNGs from apps/web/public/icons/icon.svg, the one drawing: the 180 apple-touch
 * icon and the manifest's 192 and 512. Run it after any change to the SVG and commit the PNGs with it;
 * apps/web/test/icons.test.ts fails while they show other colours than the SVG.
 * The SVG is full-bleed and opaque, so the PNGs are too: iOS fills a transparent touch icon with black.
 * Usage: bun run icons. Needs Playwright's Chromium once: bunx playwright install chromium.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const iconsDir = join(import.meta.dirname, "../../web/public/icons");
const svg = readFileSync(join(iconsDir, "icon.svg"), "utf8");
const sizes = { "apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512 };

const browser = await chromium.launch();
try {
  for (const [file, size] of Object.entries(sizes)) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await page.setContent(
      `<body style="margin:0"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`,
    );
    await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    await page.screenshot({ path: join(iconsDir, file) });
    await page.close();
    console.log(`${file}: ${size}x${size}`);
  }
} finally {
  await browser.close();
}
