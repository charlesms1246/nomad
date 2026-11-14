// Render the demo deck (demo/index.html) frame by frame through the Chrome DevTools Protocol.
// Every frame is computed from (scene, t) by window.renderAt, so output is deterministic.
//   node scripts/render-demo.mjs still  <scene> <t> <out.png>
//   node scripts/render-demo.mjs video  <scene> <out.mp4> [fps=30] [from=0] [to=loop]
//   node scripts/render-demo.mjs info
// Env: CHROME (headless shell binary), W/H (default 1920x1080), FFMPEG (default ffmpeg).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../demo");
const W = +(process.env.W ?? 1920), H = +(process.env.H ?? 1080);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse() : [];
  for (const d of dirs) for (const sub of readdirSync(join(base, d))) {
    const p = join(base, d, sub, "chrome-headless-shell"); if (existsSync(p)) return p;
  }
  throw new Error("no headless shell found; set CHROME");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(ROOT)) throw 0;
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
    res.end(await readFile(p.endsWith("/") ? join(p, "index.html") : p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, "--use-angle=metal", "--hide-scrollbars",
  "--enable-webgl", "--ignore-gpu-blocklist", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) { await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
if (!target) throw new Error("chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") logs.push("console.error " + m.params.args.map((a) => a.value ?? a.description).join(" ")); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

async function open(scene) {
  await send("Page.navigate", { url: `${base}#${scene}?t=0` });
  for (let i = 0; i < 100; i++) { await sleep(100); if (await evaluate("window.__ready === true")) break; }
  if (logs.length) console.error(logs.join("\n"));
}
async function shot(scene, t, fmt = "png") {
  await evaluate(`renderAt(${scene}, ${t}); new Promise(r => requestAnimationFrame(() => r(1)))`);
  const r = await send("Page.captureScreenshot", fmt === "png" ? { format: "png" } : { format: "jpeg", quality: 93 });
  return Buffer.from(r.result.data, "base64");
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "info") {
    await open(0); console.log(JSON.stringify(await evaluate("sceneInfo()"), null, 1));
  } else if (cmd === "still") {
    const [scene, t, out] = args; await open(+scene);
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, await shot(+scene, +t)); console.log("wrote", out);
  } else if (cmd === "qa") {
    /* sample every frame at `fps` and print edge-clipping / caption-overlap problems, merged into time ranges */
    const scenes = args[0] === "all" ? null : [+args[0]], fps = +(args[1] ?? 10);
    const info = await (async () => { await open(scenes ? scenes[0] : 0); return evaluate("sceneInfo()"); })();
    let total = 0;
    for (const sc of scenes ?? info.map((_, i) => i)) {
      await open(sc); const loop = info[sc].loop; const open_ = new Map(), list = [];
      for (let f = 0; f < loop * fps; f++) {
        const t = f / fps;
        const issues = await evaluate(`renderAt(${sc}, ${t}); qa()`);
        for (const k of issues) { const key = k.replace(/ \[.*\]$/, ""); const r = open_.get(key);
          if (r && f - r.lastF === 1) { r.end = t; r.lastF = f; } else { const n = { key, start: t, end: t, lastF: f }; open_.set(key, n); list.push(n); } }
      }
      list.sort((a, b) => a.start - b.start);
      total += list.length;
      console.log(`scene ${sc} (${info[sc].key}): ${list.length ? list.length + " problem range(s)" : "clean"}`);
      for (const r of list) console.log(`  ${r.start.toFixed(1)}-${r.end.toFixed(1)} s  ${r.key}`);
    }
    process.exitCode = total ? 1 : 0;
  } else if (cmd === "sheet") {
    /* contact sheet: one frame per `step` seconds (offset by half a step), 4 across */
    const [scene, out, step = "1"] = args; await open(+scene);
    const loop = (await evaluate("sceneInfo()"))[+scene].loop;
    const dir = resolve(dirname(resolve(out)), `.sheet-${scene}`); await mkdir(dir, { recursive: true });
    const files = [];
    for (let t = +step / 2, i = 0; t < loop; t += +step, i++) {
      const f = join(dir, `${String(i).padStart(3, "0")}.png`); await writeFile(f, await shot(+scene, t)); files.push([f, t]);
    }
    const cols = 4, rows = Math.ceil(files.length / cols);
    const inputs = files.flatMap(([f]) => ["-i", f]);
    const lab = files.map(([, t], i) => `[${i}]scale=480:270[v${i}]`).join(";");
    const pad = files.length < rows * cols ? Array.from({ length: rows * cols - files.length }, (_, k) => `color=black:480x270:d=1[p${k}]`).join(";") + ";" : "";
    const all = [...files.map((_, i) => `[v${i}]`), ...Array.from({ length: rows * cols - files.length }, (_, k) => `[p${k}]`)].join("");
    const layout = Array.from({ length: rows * cols }, (_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join("|");
    await new Promise((r, j) => spawn(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex",
      `${pad}${lab};${all}xstack=inputs=${rows * cols}:layout=${layout}`, "-frames:v", "1", "-q:v", "3", out], { stdio: "inherit" })
      .on("close", (c) => c ? j(new Error("ffmpeg " + c)) : r()));
    console.log(`wrote ${out}: ${files.length} frames`);
  } else if (cmd === "video") {
    const [scene, out, fps = "30", from = "0", to] = args; await open(+scene);
    const loop = (await evaluate("sceneInfo()"))[+scene].loop;
    const end = to != null ? +to : loop, n = Math.round((end - +from) * +fps);
    await mkdir(dirname(resolve(out)), { recursive: true });
    const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", fps, "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", "-r", fps, out], { stdio: ["pipe", "inherit", "inherit"] });
    const t0 = Date.now();
    for (let f = 0; f < n; f++) {
      const t = +from + f / +fps;
      const buf = await shot(+scene, t, "jpeg");
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % 60 === 0) process.stderr.write(`scene ${scene}: frame ${f}/${n}\r`);
    }
    ff.stdin.end(); await new Promise((r) => ff.on("close", r));
    console.log(`wrote ${out}: ${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } else {
    console.log("usage: render-demo.mjs still <scene> <t> <out.png> | video <scene> <out.mp4> [fps] [from] [to] | info");
  }
  if (logs.length) console.error(logs.join("\n"));
} finally { chrome.kill(); server.close(); ws.close(); }
process.exit(0);
