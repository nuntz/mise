import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, test } from "vitest";

const iconsDir = join(import.meta.dirname, "../public/icons");
const svg = readFileSync(join(iconsDir, "icon.svg"), "utf8");

/** The SVG's fills in drawing order: the full-bleed ground first, then the bowl. */
const [ground, mark] = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map(([, hex]) => hex?.toLowerCase());

type Png = { width: number; pixel: (x: number, y: number) => string };

/** An 8-bit, non-interlaced RGB or RGBA PNG, read with zlib alone; a pixel as lower-case #rrggbb. */
function readPng(file: string): Png {
  const bytes = readFileSync(join(iconsDir, file));
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect({ depth: data[8], interlace: data[12] }).toEqual({ depth: 8, interlace: 0 });
      channels = { 2: 3, 6: 4 }[data[9] as 2 | 6];
      expect(channels).toBeDefined();
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i] ?? 0;
      const left = i >= channels ? (out[y * stride + i - channels] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] ?? 0) : 0;
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter ?? 0] ?? 0;
      out[y * stride + i] = (value + predictor) & 0xff;
    }
  }
  return {
    width,
    pixel: (x, y) =>
      `#${[0, 1, 2].map((c) => (out[y * stride + x * channels + c] ?? 0).toString(16).padStart(2, "0")).join("")}`,
  };
}

test.each([
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
])("%s is icon.svg at %ipx, so the home screen shows the drawing (bun run icons renders it)", (file, size) => {
  const png = readPng(file);
  expect(png.width).toBe(size);
  // A corner is the ground; the middle of the bowl, at (256, 300) of the SVG's 512, is the mark.
  expect({ corner: png.pixel(1, 1), bowl: png.pixel(size / 2, Math.round((300 / 512) * size)) }).toEqual({
    corner: ground,
    bowl: mark,
  });
});
