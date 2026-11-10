// Run with:  node test/detector.test.js
const assert = require("assert");
const { detectTextRegions } = require("../detector.js");

const W = 320, H = 480;

function makeImage() {
  const g = new Uint8Array(W * H).fill(120); // mid-gray "artwork"
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = v; };

  // deterministic noise so the background is not perfectly flat
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < g.length; i++) g[i] = 90 + Math.floor(rnd() * 60);

  function ellipse(cx, cy, rx, ry, withText) {
    for (let y = cy - ry - 3; y <= cy + ry + 3; y++) {
      for (let x = cx - rx - 3; x <= cx + rx + 3; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1) set(x, y, 255);
        else if (d <= 1.15) set(x, y, 25); // outline
      }
    }
    if (withText) {
      for (let line = -2; line <= 2; line++) {
        const y = cy + line * 9;
        for (let x = cx - rx * 0.6; x < cx + rx * 0.6; x += 6) {
          const half = Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2));
          if (half <= 0.25) continue;
          for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) set(Math.floor(x) + dx, y + dy, 50);
        }
      }
    }
  }

  ellipse(100, 100, 55, 38, true); // bubble with text
  ellipse(230, 250, 60, 40, true); // bubble with text
  ellipse(90, 400, 50, 35, false); // empty white bubble (no lettering)

  // white gutter strip across the page
  for (let y = 180; y < 192; y++) for (let x = 0; x < W; x++) set(x, y, 255);
  // big white area (e.g. blank page region)
  for (let y = 300; y < 480; y++) for (let x = 140; x < W; x++) if (y > 330) set(x, y, 255);
  return g;
}

const regions = detectTextRegions(makeImage(), W, H);
console.log("regions:", regions.map((r) => ({
  x0: +r.x0.toFixed(2), x1: +r.x1.toFixed(2), y0: +r.y0.toFixed(2), y1: +r.y1.toFixed(2),
})));

const centers = regions.map((r) => ({ x: ((r.x0 + r.x1) / 2) * W, y: ((r.y0 + r.y1) / 2) * H }));
const near = (cx, cy) => centers.some((c) => Math.abs(c.x - cx) < 15 && Math.abs(c.y - cy) < 15);

assert(near(100, 100), "bubble 1 should be detected");
assert(near(230, 250), "bubble 2 should be detected");
assert(!near(90, 400), "empty bubble must not be detected");
assert.strictEqual(regions.length, 2, "exactly two regions expected");
console.log("OK");
