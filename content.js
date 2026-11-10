(() => {
  "use strict";

  const DEFAULT_SPEED = 60; // pixels per second
  const MIN_SPEED = 10;
  const MAX_SPEED = 600;
  const SPEED_STEP = 10;
  const BOTTOM_GRACE_MS = 1500; // wait for lazy-loaded images before declaring "end"

  // Phase 2: slow down while a speech bubble is in the "reading band".
  const DEFAULT_SLOW_PERCENT = 40; // % of normal speed over text
  const BAND_TOP = 0.2; // reading band, as fractions of the viewport height
  const BAND_BOTTOM = 0.7;
  const EASE_SECONDS = 0.25; // how quickly speed glides between fast and slow
  const SCAN_INTERVAL_MS = 600;
  const MIN_IMG_SIZE = 300; // ignore icons / thumbnails
  const MAX_PARALLEL = 2;

  let speed = DEFAULT_SPEED;
  let smartSlow = true;
  let slowPercent = DEFAULT_SLOW_PERCENT;
  let debug = false;

  let running = false;
  let rafId = null;
  let lastTime = 0;
  let carry = 0; // fractional pixels carried between frames
  let atBottomSince = null;
  let factor = 1; // current speed multiplier (eases toward 1 or slowPercent/100)

  // ---------- settings ----------
  function clampSpeed(n) {
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(n)));
  }
  function clampPercent(n) {
    return Math.min(100, Math.max(10, Math.round(n)));
  }

  try {
    chrome.storage.sync.get(
      { speed: DEFAULT_SPEED, smartSlow: true, slowPercent: DEFAULT_SLOW_PERCENT },
      (v) => {
        speed = clampSpeed(Number(v.speed) || DEFAULT_SPEED);
        smartSlow = !!v.smartSlow;
        slowPercent = clampPercent(Number(v.slowPercent) || DEFAULT_SLOW_PERCENT);
      }
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.speed) {
        speed = clampSpeed(Number(changes.speed.newValue) || DEFAULT_SPEED);
        showHud(`Speed ${speed}`);
      }
      if (changes.smartSlow) {
        smartSlow = !!changes.smartSlow.newValue;
        showHud(`Slow on text: ${smartSlow ? "ON" : "OFF"}`);
      }
      if (changes.slowPercent) {
        slowPercent = clampPercent(Number(changes.slowPercent.newValue) || DEFAULT_SLOW_PERCENT);
      }
    });
  } catch (_) {
    /* storage unavailable - use defaults */
  }

  // ---------- text-region analysis ----------
  // img -> { src, state: "pending" | "done" | "failed", regions: [{x0,y0,x1,y1}] }
  const analyzed = new Map();
  let active = 0;
  const queue = [];
  const stats = { done: 0, failed: 0, lastError: "" };

  function eligible(img) {
    return img.complete && img.naturalWidth >= MIN_IMG_SIZE && img.naturalHeight >= MIN_IMG_SIZE;
  }

  function scanImages() {
    const vh = window.innerHeight;
    for (const [img] of analyzed) {
      if (!img.isConnected) analyzed.delete(img);
    }
    for (const img of document.images) {
      if (!eligible(img)) continue;
      const src = img.currentSrc || img.src;
      const rec = analyzed.get(img);
      if (rec && rec.src === src) continue;
      const r = img.getBoundingClientRect();
      if (r.width < MIN_IMG_SIZE / 2) continue;
      if (r.bottom < -vh || r.top > vh * 4) continue; // only look ahead a few screens
      const next = { src, state: "pending", regions: [] };
      analyzed.set(img, next);
      queue.push({ img, rec: next });
    }
    pump();
  }

  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      active++;
      analyze(job.img)
        .then((regions) => {
          job.rec.regions = regions;
          job.rec.state = "done";
          stats.done++;
        })
        .catch((err) => {
          job.rec.state = "failed";
          stats.failed++;
          stats.lastError = String(err?.message || err);
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  async function analyze(img) {
    try {
      return analyzeLocally(img);
    } catch (e) {
      // Cross-origin image -> canvas is tainted. Let the background worker fetch it.
      const resp = await chrome.runtime.sendMessage({
        type: "analyzeUrl",
        url: img.currentSrc || img.src,
      });
      if (!resp?.ok) throw new Error(resp?.error || "background analysis failed");
      return resp.regions;
    }
  }

  function analyzeLocally(img) {
    const D = window.MAS_Detector;
    const w = D.TARGET_WIDTH;
    const h = Math.max(1, Math.min(6000, Math.round((img.naturalHeight * w) / img.naturalWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h); // throws SecurityError if tainted
    return D.detectTextRegions(D.rgbaToGray(data, w * h), w, h);
  }

  // Is any detected bubble currently inside the reading band?
  function textInReadingBand() {
    const vh = window.innerHeight;
    const bandTop = vh * BAND_TOP;
    const bandBottom = vh * BAND_BOTTOM;
    for (const [img, rec] of analyzed) {
      if (rec.state !== "done" || !rec.regions.length) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom < bandTop || r.top > bandBottom) continue;
      for (const g of rec.regions) {
        const top = r.top + g.y0 * r.height;
        const bottom = r.top + g.y1 * r.height;
        if (bottom >= bandTop && top <= bandBottom) return true;
      }
    }
    return false;
  }

  let scanTimer = null;
  function updateScanTimer() {
    const need = running || debug;
    if (need && !scanTimer) {
      scanImages();
      scanTimer = setInterval(scanImages, SCAN_INTERVAL_MS);
    } else if (!need && scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  // ---------- scrolling ----------
  function tick(now) {
    if (!running) return;
    const dtRaw = Math.min(now - lastTime, 100) / 1000; // cap so tab-switch doesn't jump
    lastTime = now;

    // Ease the speed multiplier toward 1 (normal) or the slow factor (over text).
    const target = smartSlow && textInReadingBand() ? slowPercent / 100 : 1;
    factor += (target - factor) * (1 - Math.exp(-dtRaw / EASE_SECONDS));

    carry += speed * factor * dtRaw;
    const whole = Math.floor(carry);
    if (whole >= 1) {
      carry -= whole;
      window.scrollBy(0, whole);
    }

    // Stop when we've sat at the bottom for a while (chapter end).
    const doc = document.documentElement;
    const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
    if (atBottom) {
      if (atBottomSince === null) atBottomSince = now;
      else if (now - atBottomSince > BOTTOM_GRACE_MS) {
        stop("End of page");
        return;
      }
    } else {
      atBottomSince = null;
    }

    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    carry = 0;
    factor = 1;
    atBottomSince = null;
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
    updateScanTimer();
    showHud(`▶ Scrolling · Speed ${speed}`);
  }

  function stop(msg = "⏸ Paused") {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    updateScanTimer();
    showHud(msg);
  }

  function toggle() {
    running ? stop() : start();
  }

  function changeSpeed(delta) {
    speed = clampSpeed(speed + delta);
    try {
      chrome.storage.sync.set({ speed });
    } catch (_) {}
    showHud(`Speed ${speed}`);
  }

  function toggleSmartSlow() {
    smartSlow = !smartSlow;
    try {
      chrome.storage.sync.set({ smartSlow });
    } catch (_) {}
    showHud(`Slow on text: ${smartSlow ? "ON" : "OFF"}`);
  }

  function setDebug(on) {
    debug = on;
    if (debug) startOverlay();
    else stopOverlay();
    updateScanTimer();
    showHud(`Debug overlay ${debug ? "ON" : "OFF"}`);
  }

  // ---------- keyboard shortcuts (in-page) ----------
  //   Space           start / pause
  //   ]  or  =  / +   faster
  //   [  or  -        slower
  //   T               toggle "slow down on text"
  //   D               toggle debug overlay (shows detected bubbles)
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) toggle();
          break;
        case "]":
        case "=":
        case "+":
          changeSpeed(SPEED_STEP);
          break;
        case "[":
        case "-":
        case "_":
          changeSpeed(-SPEED_STEP);
          break;
        case "t":
        case "T":
          if (!e.repeat) toggleSmartSlow();
          break;
        case "d":
        case "D":
          if (!e.repeat) setDebug(!debug);
          break;
      }
    },
    true // capture: run before the site's own key handlers
  );

  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // ---------- messages from popup / background ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "toggle":
        toggle();
        break;
      case "start":
        start();
        break;
      case "stop":
        stop();
        break;
      case "setDebug":
        setDebug(!!msg.value);
        break;
    }
    sendResponse({ running, speed, smartSlow, slowPercent, debug });
  });

  // ---------- debug overlay ----------
  // Red boxes = detected bubbles, green = bubbles inside the reading band
  // (these slow the scroll). The blue strip is the reading band.
  let overlay = null;
  let overlayRaf = null;

  function startOverlay() {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;pointer-events:none;overflow:hidden";
      document.documentElement.appendChild(overlay);
    }
    const loop = () => {
      drawOverlay();
      overlayRaf = requestAnimationFrame(loop);
    };
    if (!overlayRaf) overlayRaf = requestAnimationFrame(loop);
  }

  function stopOverlay() {
    if (overlayRaf) cancelAnimationFrame(overlayRaf);
    overlayRaf = null;
    overlay?.remove();
    overlay = null;
  }

  function box(x, y, w, h, css) {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${css}`;
    return d;
  }

  function drawOverlay() {
    if (!overlay) return;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const bandTop = vh * BAND_TOP;
    const bandBottom = vh * BAND_BOTTOM;
    const frag = document.createDocumentFragment();
    frag.appendChild(
      box(0, bandTop, vw, bandBottom - bandTop, "background:rgba(60,120,255,.10);border-block:1px dashed #3c78ff")
    );

    let pending = 0;
    for (const [img, rec] of analyzed) {
      if (rec.state === "pending") pending++;
      if (rec.state !== "done") continue;
      const r = img.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;
      for (const g of rec.regions) {
        const top = r.top + g.y0 * r.height;
        const bottom = r.top + g.y1 * r.height;
        const hot = bottom >= bandTop && top <= bandBottom;
        frag.appendChild(
          box(
            r.left + g.x0 * r.width,
            top,
            (g.x1 - g.x0) * r.width,
            bottom - top,
            hot
              ? "border:2px solid #1db954;background:rgba(29,185,84,.18)"
              : "border:2px solid #e53935;background:rgba(229,57,53,.12)"
          )
        );
      }
    }

    const info = document.createElement("div");
    info.style.cssText =
      "position:absolute;left:12px;bottom:12px;padding:6px 10px;border-radius:6px;" +
      "background:rgba(20,20,20,.85);color:#fff;font:12px/1.4 system-ui,sans-serif;max-width:70vw";
    info.textContent =
      `analyzed ${stats.done} · pending ${pending} · failed ${stats.failed}` +
      (stats.lastError ? ` · last error: ${stats.lastError}` : "") +
      ` · speed ×${factor.toFixed(2)}`;
    frag.appendChild(info);
    overlay.replaceChildren(frag);
  }

  // ---------- tiny HUD ----------
  let hud = null;
  let hudTimer = null;

  function showHud(text) {
    if (!hud) {
      hud = document.createElement("div");
      hud.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "padding:8px 14px",
        "border-radius:8px",
        "background:rgba(20,20,20,.85)",
        "color:#fff",
        "font:600 13px/1.2 system-ui,sans-serif",
        "pointer-events:none",
        "transition:opacity .25s",
        "opacity:0",
      ].join(";");
      document.documentElement.appendChild(hud);
    }
    hud.textContent = text;
    hud.style.opacity = "1";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hud.style.opacity = "0"), 1500);
  }
})();
