importScripts("detector.js");

// ---------- browser-level shortcut -> active tab ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-scroll") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {
    // Not a MangaFire tab (no content script) - ignore.
  });
});

// ---------- image analysis fallback ----------
// When the page's <img> is cross-origin, the content script cannot read its pixels
// (tainted canvas). The service worker has host permissions, so it downloads the
// image itself and runs the detector here. Only the detected boxes go back.

// Many image hosts reject hotlinking by Referer; make our own fetches look like
// they come from the reader page.
chrome.declarativeNetRequest
  .updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "referer", operation: "set", value: "https://mangafire.to/" }],
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  })
  .catch((e) => console.warn("[MyAutoScroll] referer rule failed:", e));

const MAX_BYTES = 30 * 1024 * 1024;

async function analyzeUrl(url) {
  if (!/^https:\/\//i.test(url)) throw new Error("only https images are analyzed");
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  if (blob.size > MAX_BYTES) throw new Error("image too large");
  if (!blob.type.startsWith("image/")) throw new Error("not an image: " + blob.type);

  const bmp = await createImageBitmap(blob);
  const w = MAS_Detector.TARGET_WIDTH;
  const h = Math.max(1, Math.min(6000, Math.round((bmp.height * w) / bmp.width)));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = MAS_Detector.rgbaToGray(data, w * h);
  return MAS_Detector.detectTextRegions(gray, w, h);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "analyzeUrl") return;
  analyzeUrl(String(msg.url)).then(
    (regions) => sendResponse({ ok: true, regions }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // async response
});
