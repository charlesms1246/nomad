// Real-time page screenshots through the Chrome DevTools Protocol, using only Node 22 built-ins
// (fetch, WebSocket). Unlike headless --screenshot it waits real time, so framer-motion reveals and
// the WebGL background finish. It also emulates mobile viewports and prefers-reduced-motion.
// usage: node scripts/cdp-shot.mjs <chrome-binary> <url> <out.png> [width=1440] [height=900] [waitMs=4000] [fullPage=0] [reduced=0] [scroll=0|#elementId]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [bin, url, out, w = "1440", h = "900", wait = "4000", full = "0", reduced = "0", scroll = "0"] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(bin, [
  `--remote-debugging-port=${port}`,
  "--hide-scrollbars",
  // Match the window to the emulated viewport: with the default 800x600 window, desktop-width
  // emulation can stall Page.captureScreenshot indefinitely.
  `--window-size=${w},${h}`,
  // WebGL (the landing background) needs SwiftShader in headless mode; CDP_NO_GL=1 drops it.
  ...(process.env.CDP_NO_GL ? ["--disable-gpu"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Never hang a caller (ui-check): give up after 60 s.
setTimeout(() => {
  console.error(`${out}: gave up after 60 s`);
  chrome.kill();
  process.exit(1);
}, 60_000).unref();
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) {
  chrome.kill();
  throw new Error("chrome did not start");
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) logs.push(m.params.type + " " + m.params.args.map((a) => a.value ?? a.description).join(" "));
});
const DEBUG = !!process.env.CDP_DEBUG;
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    if (DEBUG) console.error(`[cdp] -> ${method}`);
    pending.set(i, (m) => {
      if (DEBUG) console.error(`[cdp] <- ${method}${m.error ? " ERROR " + JSON.stringify(m.error) : ""}`);
      r(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const W = +w, H = +h, mobile = W < 600;
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile });
if (reduced === "1") await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.navigate", { url });
await sleep(+wait);
if (scroll.startsWith("#")) {
  await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(scroll)})?.scrollIntoView({block:"start"})` });
  await sleep(2500);
} else if (+scroll) {
  await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${+scroll})` });
  await sleep(2500);
}
let clip;
// fullPage captures beyond the viewport with a clip. Caution: in chrome-headless-shell this can
// stall on tall pages, as can a window taller than the screen (the 60 s watchdog then exits),
// so ui-check keeps every viewport at most 900 px tall.
if (full === "1") {
  const r = await send("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true });
  clip = { x: 0, y: 0, width: W, height: Math.min(+r.result.result.value, 8000), scale: 1 };
}
const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
if (!shot.result) {
  console.error(`${out}: captureScreenshot failed: ${JSON.stringify(shot.error)}`);
  chrome.kill();
  process.exit(1);
}
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
const ow = await send("Runtime.evaluate", { expression: "document.documentElement.scrollWidth > window.innerWidth ? 'HORIZONTAL OVERFLOW ' + document.documentElement.scrollWidth : 'no overflow'", returnByValue: true });
console.log(out, ow.result.result.value, logs.length ? "\n" + logs.map((l) => l.split("\n")[0]).join("\n") : "");
ws.close();
chrome.kill();
