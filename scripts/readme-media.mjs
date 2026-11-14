// README stills from the real site: media/landing.png (hero), media/dashboard.png (the workshop mid-settle),
// media/v2-verified.png (ring f5d3e16fca with its green "Verified on chain" box). 1440 px wide.
//   node scripts/readme-media.mjs <base url> [out dir = media]
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [base = "http://localhost:3000", outDir = "media"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const pw = join(homedir(), "Library/Caches/ms-playwright");
const shell = process.env.CHROME ?? readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()
  .flatMap((d) => readdirSync(join(pw, d)).map((s) => join(pw, d, s, "chrome-headless-shell"))).find(existsSync);
const port = 9300 + Math.floor(Math.random() * 300);
const chrome = spawn(shell, [`--remote-debugging-port=${port}`, "--use-angle=metal", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target; for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, "base64")); console.log("wrote", join(outDir, name)); };
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const go = async (path) => { await send("Page.navigate", { url: base + path }); await sleep(800); await ev(`document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`); };

try {
  await go("/"); await sleep(5000); await shot("landing.png");

  /* dashboard: scroll the workshop to the top, wait for the settle line of the three-wallet ring, then the hop's apex */
  await go("/dashboard"); await sleep(1500);
  await ev(`(() => { const c = document.querySelector('canvas'); let w = c; while (w && !/rounded/.test(w.className || '')) w = w.parentElement;
    window.scrollTo(0, Math.max(0, (w || c).getBoundingClientRect().top + scrollY - 205)); return 1; })()`);
  for (let i = 0; i < 400; i++) { await sleep(50); if (await ev(`document.body.innerText.includes('Settled: 3 agents traded in one transaction')`)) break; }
  await sleep(180); await shot("dashboard.png");

  /* /v2?verify=1: wait for the on-chain checks, then the three-wallet ring card */
  await go("/v2?verify=1");
  for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ev(`(document.body.innerText.match(/Verified on chain/g) || []).length`)) >= 4) break; }
  await sleep(1000);
  await ev(`(() => { const h = [...document.querySelectorAll('span,div')].find(e => e.innerText && e.innerText.trim() === 'Ring f5d3e16fca');
    let c = h; while (c && c.parentElement && !/rounded/.test(c.className || '')) c = c.parentElement;
    window.scrollTo(0, Math.max(0, c.getBoundingClientRect().top + scrollY - 40)); return 1; })()`);
  await sleep(1200); await shot("v2-verified.png");
} finally { chrome.kill(); ws.close(); }
process.exit(0);
