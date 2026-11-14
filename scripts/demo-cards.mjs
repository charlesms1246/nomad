// Full-frame cards for the demo video, drawn by headless Chrome at 1920x1080 in the deck's type (Space Grotesk) and
// the site's wordmark font (Geist Pixel Grid):
//   cold-title.png (transparent, laid over the cold open), num-1..3.png (proof figures), end.png (end card).
//   node scripts/demo-cards.mjs [out dir = out/demo/cards]
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const [outDir = "out/demo/cards"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const grotesk = readFileSync(join(root, "demo/assets/space-grotesk-latin.woff2")).toString("base64");
const pixel = readFileSync(join(root, "web/node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Grid.woff2")).toString("base64");
const pw = join(homedir(), "Library/Caches/ms-playwright");
const shell = process.env.CHROME ?? readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()
  .flatMap((d) => readdirSync(join(pw, d)).map((s) => join(pw, d, s, "chrome-headless-shell"))).find(existsSync);
const port = 9100 + Math.floor(Math.random() * 150);
const chrome = spawn(shell, [`--remote-debugging-port=${port}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target; for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

const css = `@font-face{font-family:G;src:url(data:font/woff2;base64,${grotesk}) format('woff2');font-weight:300 700}
@font-face{font-family:P;src:url(data:font/woff2;base64,${pixel}) format('woff2')}
*{margin:0;box-sizing:border-box} html,body{width:1920px;height:1080px;overflow:hidden}
body{font-family:G,sans-serif;color:#f2f4f8;-webkit-font-smoothing:antialiased}
.bg{background:radial-gradient(ellipse 70% 60% at 50% 45%,#121a2a 0%,#0a0d14 55%,#07090d 100%)}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.num{font-weight:700;font-size:330px;line-height:0.9;letter-spacing:-0.04em;font-variant-numeric:tabular-nums}
.lab{font-weight:500;font-size:64px;margin-top:34px;letter-spacing:-0.01em}
.sub{font-weight:400;font-size:34px;margin-top:22px;color:#9aa4b8}
.acc{color:#3987e5}`;
const page = (body, transparent = false) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="${transparent ? "" : "bg"}">${body}</body></html>`;
const cards = {
  "cold-title.png": [page(`<div style="position:absolute;left:0;right:0;top:34px;text-align:center">
    <span style="display:inline-block;font-weight:700;font-size:92px;letter-spacing:-0.025em;line-height:1.05;padding:14px 40px;background:rgba(7,9,13,0.72);border-radius:6px">
    Three agents. <span class="acc">One transaction.</span></span></div>`, true), true],
  "num-1.png": [page(`<div class="wrap"><div class="num">27</div><div class="lab">rings settled, <span class="acc">0 failed</span></div>
    <div class="sub">A 36-minute live run with 12 agents on NEAR testnet</div></div>`)],
  "num-2.png": [page(`<div class="wrap"><div class="num">3</div><div class="lab">wallet standards in one settled ring</div>
    <div class="sub">NEAR nep413 · Ethereum erc191 · Solana-style raw_ed25519</div></div>`)],
  "num-3.png": [page(`<div class="wrap"><div class="num">0</div><div class="lab">access keys on the rings and mandate contracts</div>
    <div class="sub">Read from NEAR testnet</div></div>`)],
  "end.png": [page(`<div class="wrap"><div style="font-family:P;font-size:250px;line-height:1;letter-spacing:0.02em">NOMAD<span class="acc">.</span></div>
    <div style="width:980px;height:3px;background:#f2f4f8;margin:44px 0 40px"></div>
    <div style="font-weight:600;font-size:66px">nomad.charlesms.dev</div>
    <div class="sub" style="font-size:40px;margin-top:26px">Built on NEAR Intents</div></div>`)],
};
try {
  for (const [name, [html, transparent]] of Object.entries(cards)) {
    await send("Emulation.setDefaultBackgroundColorOverride", transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
    await send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(html).toString("base64") });
    await sleep(500); await send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => 1)", awaitPromise: true }); await sleep(150);
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, name), Buffer.from(r.result.data, "base64")); console.log("wrote", join(outDir, name));
  }
} finally { chrome.kill(); ws.close(); }
process.exit(0);
