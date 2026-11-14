// Record the real Nomad site for the demo video, frame by frame at a steady 30 fps.
//   node scripts/record-site.mjs <base url> <out dir> [segment ...]
// Segments: hero, replay, v2. Each becomes <out dir>/web-<segment>.mp4 (1920x1080, 30 fps, no audio).
// Pages render at 1440x810 CSS px with deviceScaleFactor 4/3, so the layout is the desktop one and the output is 1080p.
// Timers, animation frames and WebGL run on Chrome's virtual time, advanced exactly 1/30 s per frame, so pacing
// is steady no matter how slow a capture is. Anything that needs the network (the /v2 on-chain checks) is loaded
// in real time first; after that the scroll position is set per frame from an eased curve.
// A beat line in the deck's style is drawn over the page (bottom centre); the page itself is not modified.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const [base = "http://localhost:3000", outDir = "out/demo", ...want] = process.argv.slice(2);
const FPS = 30, W = +(process.env.VW ?? 1440), H = +(process.env.VH ?? 810), DSF = 1080 / H;
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const font = readFileSync(join(root, "demo/assets/space-grotesk-latin.woff2")).toString("base64");
mkdirSync(outDir, { recursive: true });

const pw = join(homedir(), "Library/Caches/ms-playwright");
const shell = process.env.CHROME ?? readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()
  .flatMap((d) => readdirSync(join(pw, d)).map((s) => join(pw, d, s, "chrome-headless-shell"))).find(existsSync);
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(shell, [`--remote-debugging-port=${port}`, "--use-angle=metal", "--hide-scrollbars", "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target; for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const waiters = []; const logs = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method) for (const w of waiters.splice(0)) if (w.method === m.method) w.r(m); else waiters.push(w);
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const once = (method) => new Promise((r) => waiters.push({ method, r }));
/* an evaluate that races a navigation can lose its context and never get a reply: give up after 3 s */
const ev = async (expression) => (await Promise.race([send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }), sleep(3000).then(() => ({}))])).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false });

const overlayJs = (text) => `(() => {
  let s = document.getElementById('__demo_style');
  if (!s) { s = document.createElement('style'); s.id = '__demo_style';
    s.textContent = "@font-face{font-family:'DemoGrotesk';src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:300 700}" +
      "#__demo_beat{position:fixed;left:0;right:0;bottom:${(3.2 * 16 * W / 1920).toFixed(1)}px;text-align:center;pointer-events:none;z-index:2147483647}" +
      "#__demo_beat span{display:inline-block;font:500 ${(1.42 * 16 * W / 1920).toFixed(1)}px 'DemoGrotesk',sans-serif;color:#f2f4f8;padding:${(0.5 * 16 * W / 1920).toFixed(1)}px ${(1.2 * 16 * W / 1920).toFixed(1)}px;background:rgba(7,9,13,0.82);border-radius:3px;font-variant-numeric:tabular-nums}";
    document.head.appendChild(s); }
  let b = document.getElementById('__demo_beat');
  if (!b) { b = document.createElement('div'); b.id = '__demo_beat'; b.innerHTML = '<span></span>'; document.body.appendChild(b); }
  b.firstChild.textContent = ${JSON.stringify(text)}; b.style.display = ${JSON.stringify(text)} ? 'block' : 'none'; return 1; })()`;

async function advance(ms) {
  const done = once("Emulation.virtualTimeBudgetExpired");
  await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: ms });
  await Promise.race([done, sleep(4000)]);
}
async function record(name, seconds, perFrame, beats) {
  const out = join(outDir, `web-${name}.mp4`);
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-vf", "scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", "-r", String(FPS), out], { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round(seconds * FPS); let lastBeat = null;
  for (let f = 0; f < n; f++) {
    const t = f / FPS;
    let beat = ""; for (const [bt, line] of beats) if (t >= bt) beat = line;
    if (beat !== lastBeat) { await ev(overlayJs(beat)); lastBeat = beat; }
    if (perFrame) await perFrame(t);
    await advance(1000 / FPS);
    const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 93 });
    const buf = Buffer.from(r.result.data, "base64");
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end(); await new Promise((r) => ff.on("close", r));
  console.log(`wrote ${out}: ${n} frames`);
}
async function openPaused(url, settleMs) {
  /* load in real time (fonts, data, WebGL init), then freeze the clock */
  await send("Page.navigate", { url: "about:blank" }); await sleep(300);
  await send("Page.navigate", { url }); await sleep(settleMs);
  await ev(`document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`);
  await send("Emulation.setVirtualTimePolicy", { policy: "pause" });
}
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

const SEGMENTS = {
  /* the landing hero: the dithered ring and the headline, held */
  async hero() {
    /* load in real time and freeze the clock the moment the hero mounts, so the reveal is captured on virtual time */
    await send("Page.navigate", { url: "about:blank" }); await sleep(300);
    await send("Page.navigate", { url: base + "/" });
    for (let i = 0; i < 200; i++) { await sleep(15); if (await ev(`!!document.querySelector('main h1, main [class*="font-pixel"]')`).catch(() => false)) break; }
    await send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    await ev(`document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`);
    await record("hero", 8, null, [[1.6, "The landing page: agents trade in loops."]]);
  },
  /* the ring replay of the real three-wallet ring: exactly one cycle of its six stages (3.2+5.2+3.6+4.2+3.2+4.6 s),
     from stage 0. The clock is frozen as soon as the section mounts, because the replay starts on mount. */
  async replay() {
    await send("Page.navigate", { url: "about:blank" }); await sleep(300);
    await send("Page.navigate", { url: base + "/" });
    /* pause once the page has fully loaded (well inside the first 3.2 s stage): pausing before the load event stalls the clock */
    const t0 = Date.now();
    for (let i = 0; i < 600; i++) { await sleep(10); if (await ev(`document.readyState === 'complete' && !!document.querySelector('#replay')`)) break; }
    await send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    console.log(`replay: clock paused ${Date.now() - t0} ms after navigation`);
    await sleep(1500);
    await ev(`document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`);
    const y = await ev(`(() => { const p = document.querySelector('#replay p'); return p.getBoundingClientRect().bottom + scrollY + 10; })()`);
    await ev(`window.scrollTo(0, ${y}); 1`);
    await advance(50);
    await record("replay", 23.6, null, [[0.3, "A real three-wallet ring, replayed from testnet."], [3.4, "Each wallet attaches its own signed leg."],
      [8.6, "k4, a stranger, closes it."], [12.2, "One execute_intents call settles all three legs."], [16.4, "The tips go to k4, and the contract records reputation."]]);
  },
  /* /v2 with every close re-checked on chain in the browser: three held shots with hard cuts, one per ring card
     (mandate ring, ERC-7683 ring, three-wallet ring). Each is scrolled into place and fully re-rastered before its
     frame is taken: frames grabbed mid-scroll on this page can show stale tiles from before the checks expanded. */
  async v2() {
    await send("Page.navigate", { url: "about:blank" }); await sleep(300);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const si = window.setInterval;
      window.setInterval = function (fn, ms, ...a) { if (ms === 15000) return 0; return si.call(this, fn, ms, ...a); }; })();` });
    await send("Page.navigate", { url: base + "/v2?verify=1" });
    for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ev(`(document.body.innerText.match(/Verified on chain/g) || []).length`)) >= 4) break; }
    await sleep(1500);
    await ev(`document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`);
    const top = async (id) => ev(`(() => { const h = [...document.querySelectorAll('span,div')].find(e => e.innerText && e.innerText.trim() === 'Ring ${id}');
      let c = h; while (c && c.parentElement && !/rounded/.test(c.className || '')) c = c.parentElement;
      return Math.max(0, c.getBoundingClientRect().top + scrollY - 24); })()`);
    const shots = [
      { y: 0, secs: 6.5, beats: [[0, "The live page reads the rings contract from testnet."], [2.8, "Every closed ring is re-checked on chain, in your browser."]] },
      { y: await top("a44df021aa"), secs: 5.5, beats: [[0, "An ERC-7683 order, verified on chain and enforced by the contract."]] },
      { y: await top("f5d3e16fca"), secs: 6, beats: [[0, "Three wallet standards, one settled ring, closed by k4."]] },
    ];
    const { writeFileSync, mkdtempSync } = await import("node:fs"); const os = await import("node:os");
    const dir = mkdtempSync(join(os.tmpdir(), "v2shots-")); let list = ""; let k = 0;
    for (const sh of shots) {
      await ev(`window.scrollTo(0, ${sh.y}); 1`);
      await send("Emulation.setDeviceMetricsOverride", { width: W, height: H + 40, deviceScaleFactor: DSF, mobile: false }); await sleep(400);
      await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false }); await sleep(900);
      for (let b = 0; b < sh.beats.length; b++) {
        const [bt, line] = sh.beats[b], end = b + 1 < sh.beats.length ? sh.beats[b + 1][0] : sh.secs;
        await ev(overlayJs(line)); await sleep(250);
        const r = await send("Page.captureScreenshot", { format: "png" });
        const fn = join(dir, `${String(k++).padStart(3, "0")}.png`); writeFileSync(fn, Buffer.from(r.result.data, "base64"));
        list += `file '${fn}'\nduration ${(end - bt).toFixed(3)}\n`;
      }
    }
    list += list.split("\n").filter((l) => l.startsWith("file")).at(-1) + "\n";
    writeFileSync(join(dir, "list.txt"), list);
    const out = join(outDir, "web-v2.mp4"), total = shots.reduce((a, s) => a + s.secs, 0);
    await new Promise((r) => spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
      "-vf", `scale=1920:1080:flags=lanczos,fps=${FPS}`, "-t", String(total), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-r", String(FPS), out], { stdio: "inherit" }).on("close", r));
    console.log(`wrote ${out}: ${shots.length} shots, ${total} s`);
  },
};
try {
  for (const name of want.length ? want : Object.keys(SEGMENTS)) await SEGMENTS[name]();
  if (logs.length) console.error(logs.slice(0, 10).join("\n"));
} finally { chrome.kill(); ws.close(); }
process.exit(0);
