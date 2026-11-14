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
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("chrome did not start");

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
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

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
// fullPage stretches the viewport to the page height: fine for normal pages, but it also
// stretches 100vh sections and fixed backgrounds, so use the scroll argument for the landing page.
if (full === "1") {
  const r = await send("Runtime.evaluate", { expression: "JSON.stringify([document.documentElement.scrollWidth, document.documentElement.scrollHeight])", returnByValue: true });
  const [sw, sh] = JSON.parse(r.result.result.value);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: Math.min(sh, 8000), deviceScaleFactor: mobile ? 2 : 1, mobile });
  await sleep(1200);
  clip = { x: 0, y: 0, width: W, height: Math.min(sh, 8000), scale: 1 };
}
const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
const ow = await send("Runtime.evaluate", { expression: "document.documentElement.scrollWidth > window.innerWidth ? 'HORIZONTAL OVERFLOW ' + document.documentElement.scrollWidth : 'no overflow'", returnByValue: true });
console.log(out, ow.result.result.value, logs.length ? "\n" + logs.map((l) => l.split("\n")[0]).join("\n") : "");
ws.close();
chrome.kill();
