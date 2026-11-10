// Speech-bubble / text-box detector for manga pages.
//
// Works on a downscaled grayscale image (Uint8Array, w*h). It finds "bubbles":
// connected bright regions that
//   - are a plausible size and shape,
//   - have ink inside them (the lettering shows up as holes in the white region),
//   - and are outlined by a dark border.
// Returns boxes as fractions of the image: {x0, y0, x1, y1} in 0..1.
//
// Known limits: text drawn directly on artwork (narration without a box, SFX)
// is not detected, and bubbles that are open to the white gutter are skipped.
(function (root) {
  "use strict";

  const WHITE = 215; // gray >= WHITE counts as "paper white"
  const OUTLINE_DARK = 170; // gray <= this next to a bubble counts as its outline

  const DEFAULTS = {
    minInk: 0.03, // min fraction of the bubble interior that is not white (lettering)
    maxInk: 0.55,
    minOutline: 0.6, // fraction of rows whose left/right edge touches a dark outline
    minFill: 0.5, // bubble area / bounding-box area
  };

  function rgbaToGray(data, count) {
    const gray = new Uint8Array(count);
    for (let i = 0, p = 0; i < count; i++, p += 4) {
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    return gray;
  }

  function detectTextRegions(gray, w, h, options) {
    const o = Object.assign({}, DEFAULTS, options);
    const n = w * h;
    const label = new Int32Array(n); // 0 = unvisited
    const stack = new Int32Array(n);
    const minBW = Math.max(12, Math.round(0.045 * w));
    const minBH = Math.max(10, Math.round(0.03 * w));
    const maxBW = 0.85 * w;
    const maxBH = 0.9 * w;
    const regions = [];
    let nextLabel = 0;

    for (let start = 0; start < n; start++) {
      if (label[start] || gray[start] < WHITE) continue;

      const id = ++nextLabel;
      let sp = 0;
      stack[sp++] = start;
      label[start] = id;
      let minX = w, maxX = 0, minY = h, maxY = 0, area = 0;

      while (sp > 0) {
        const p = stack[--sp];
        const x = p % w;
        const y = (p - x) / w;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        let q;
        if (x > 0 && !label[(q = p - 1)] && gray[q] >= WHITE) { label[q] = id; stack[sp++] = q; }
        if (x < w - 1 && !label[(q = p + 1)] && gray[q] >= WHITE) { label[q] = id; stack[sp++] = q; }
        if (y > 0 && !label[(q = p - w)] && gray[q] >= WHITE) { label[q] = id; stack[sp++] = q; }
        if (y < h - 1 && !label[(q = p + w)] && gray[q] >= WHITE) { label[q] = id; stack[sp++] = q; }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < minBW || bh < minBH || bw > maxBW || bh > maxBH) continue;
      const aspect = bw > bh ? bw / bh : bh / bw;
      if (aspect > 6) continue; // gutters / separators
      if (area / (bw * bh) < o.minFill) continue;

      // Per-row extents of the component -> interior area and outline check.
      let span = 0, outlineHits = 0, outlineTotal = 0;
      for (let y = minY; y <= maxY; y++) {
        let lo = -1, hi = -1;
        const row = y * w;
        for (let x = minX; x <= maxX; x++) {
          if (label[row + x] === id) {
            if (lo < 0) lo = x;
            hi = x;
          }
        }
        if (lo < 0) continue;
        span += hi - lo + 1;
        if (lo >= 2) { outlineTotal++; if (Math.min(gray[row + lo - 1], gray[row + lo - 2]) <= OUTLINE_DARK) outlineHits++; }
        if (hi <= w - 3) { outlineTotal++; if (Math.min(gray[row + hi + 1], gray[row + hi + 2]) <= OUTLINE_DARK) outlineHits++; }
      }
      if (span === 0 || outlineTotal < 4) continue;

      const ink = (span - area) / span;
      if (ink < o.minInk || ink > o.maxInk) continue;
      if (outlineHits / outlineTotal < o.minOutline) continue;

      regions.push({
        x0: minX / w,
        x1: (maxX + 1) / w,
        y0: minY / h,
        y1: (maxY + 1) / h,
      });
    }
    return regions;
  }

  const api = { detectTextRegions, rgbaToGray, TARGET_WIDTH: 320 };
  root.MAS_Detector = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
