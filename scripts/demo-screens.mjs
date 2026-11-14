// Capture crisp crops of the real Nomad UI for the demo deck's in-scene monitors.
//   node scripts/demo-screens.mjs <base url, e.g. http://localhost:3000> <out dir>
// Opens /v2?verify=1, waits until every closed ring shows "Verified on chain", then saves one
// PNG per ring card (2x scale), named by ring id. Also saves the landing hero at 1440x900.
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [base = "http://localhost:3000", out = "demo/assets/screens"] = process.argv.slice(2);
const pw = join(homedir(), "Library/Caches/ms-playwright");
const shell = process.env.CHROME ?? readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()
  .flatMap((d) => readdirSync(join(pw, d)).map((s) => join(pw, d, s, "chrome-headless-shell"))).find(existsSync);
const port = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(shell, [`--remote-debugging-port=${port}`, "--use-angle=metal", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch {} }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const p = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await mkdir(out, { recursive: true });

async function shoot(name, clip) {
  const r = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 }, captureBeyondViewport: true });
  await writeFile(join(out, name + ".png"), Buffer.from(r.result.data, "base64")); console.log("wrote", name, Math.round(clip.width), "x", Math.round(clip.height));
}

/* landing hero */
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: base + "/" }); await sleep(9000);
await shoot("landing-hero", { x: 0, y: 0, width: 1440, height: 900 });

/* v2 with on-chain verification */
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: base + "/v2?verify=1" });
for (let i = 0; i < 90; i++) { await sleep(1000);
  const n = await ev(`(document.body.innerText.match(/Verified on chain/g) || []).length`); if (n >= 4) break; }
await sleep(1500);
/* hide the Next.js dev badge if present */
await ev(`document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`);
const cards = await ev(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length && /^\\s*Ring\\s+[0-9a-f]{10}/.test(el.innerText || '') && false) {}
  }
  const heads = [...document.querySelectorAll('span,div,h2,h3,p')].filter(e => /^Ring [0-9a-f]{10}$/.test((e.innerText||'').trim()));
  for (const h of heads) {
    let c = h; while (c && c.parentElement && !/rounded/.test(c.className || '')) c = c.parentElement;
    const r = c.getBoundingClientRect();
    out.push({ id: h.innerText.trim().slice(5), x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
  }
  const top = document.querySelector('h1')?.parentElement?.getBoundingClientRect();
  return { cards: out, top: top ? { x: top.x, y: top.y + scrollY, w: top.width, h: top.height } : null };
})()`);
for (const c of cards.cards) await shoot("v2-ring-" + c.id, { x: c.x - 8, y: c.y - 8, width: c.w + 16, height: c.h + 16 });
if (cards.top) await shoot("v2-header", { x: cards.top.x - 8, y: cards.top.y - 8, width: cards.top.w + 16, height: cards.top.h + 16 });
chrome.kill(); ws.close(); process.exit(0);
