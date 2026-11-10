const $ = (id) => document.getElementById(id);
const speedInput = $("speed");
const speedVal = $("speedVal");
const smartSlow = $("smartSlow");
const slow = $("slow");
const slowVal = $("slowVal");
const debug = $("debug");
const statusEl = $("status");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    statusEl.textContent = "Open a MangaFire page (and refresh it) first.";
    return null;
  }
}

chrome.storage.sync.get({ speed: 60, smartSlow: true, slowPercent: 40 }, (v) => {
  speedInput.value = v.speed;
  speedVal.textContent = v.speed;
  smartSlow.checked = v.smartSlow;
  slow.value = v.slowPercent;
  slowVal.textContent = v.slowPercent + "%";
});

// Reflect the page's current debug state (also tells us if the page is reachable).
send({ type: "getState" }).then((s) => {
  if (s) debug.checked = !!s.debug;
});

// Settings go through storage; the content script reacts via onChanged.
speedInput.addEventListener("input", () => {
  const speed = Number(speedInput.value);
  speedVal.textContent = speed;
  chrome.storage.sync.set({ speed });
});
smartSlow.addEventListener("change", () => chrome.storage.sync.set({ smartSlow: smartSlow.checked }));
slow.addEventListener("input", () => {
  const slowPercent = Number(slow.value);
  slowVal.textContent = slowPercent + "%";
  chrome.storage.sync.set({ slowPercent });
});
debug.addEventListener("change", () => send({ type: "setDebug", value: debug.checked }));

$("toggle").addEventListener("click", () => send({ type: "toggle" }));
