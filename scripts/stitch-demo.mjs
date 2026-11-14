// Stitch the demo video: deck scenes 0-4, the real website (hero, ring replay, /v2?verify=1), then deck scene 5
// (proof board, the cast, the URL) as the finale. Silent, 1920x1080, 30 fps, H.264.
//   node scripts/stitch-demo.mjs [in dir = out/demo] [out = out/demo/nomad-demo.mp4]
// Cuts are hard, except a 0.25 s dip to black where the video switches between the deck and the website.
// Prints the start/end of every segment (the timing sheet's skeleton).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const [dir = "out/demo", out = "out/demo/nomad-demo.mp4"] = process.argv.slice(2);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg", FFPROBE = process.env.FFPROBE ?? "ffprobe";
const SEG = [
  ["deck-s0.mp4", "Scene 0: the need", 0, 0], ["deck-s1.mp4", "Scene 1: pairs fail", 0, 0], ["deck-s2.mp4", "Scene 2: the loop", 0, 0],
  ["deck-s3.mp4", "Scene 3: a stranger closes the ring", 0, 0], ["deck-s4.mp4", "Scene 4: any wallet", 0, 1],
  ["web-hero.mp4", "Website: landing hero", 1, 0], ["web-replay.mp4", "Website: ring replay", 0, 0], ["web-v2.mp4", "Website: /v2?verify=1", 0, 1],
  ["deck-s5.mp4", "Scene 5: proof", 1, 0],
];
const dur = (f) => +spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).stdout.toString().trim();
const inputs = [], chains = [];
let t = 0;
SEG.forEach(([f, name, fadeIn, fadeOut], i) => {
  const p = join(dir, f); if (!existsSync(p)) throw new Error("missing " + p);
  const d = dur(p); inputs.push("-i", p);
  let fl = `[${i}:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p`;
  if (fadeIn) fl += `,fade=t=in:st=0:d=0.25`;
  if (fadeOut) fl += `,fade=t=out:st=${(d - 0.25).toFixed(3)}:d=0.25`;
  chains.push(fl + `[v${i}]`);
  console.log(`${t.toFixed(2).padStart(7)} - ${(t + d).toFixed(2).padStart(7)}  ${name}  (${d.toFixed(2)} s)`);
  t += d;
});
const graph = chains.join(";") + ";" + SEG.map((_, i) => `[v${i}]`).join("") + `concat=n=${SEG.length}:v=1:a=0[out]`;
const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[out]", "-an",
  "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out], { stdio: "inherit" });
if (r.status) process.exit(r.status);
console.log(`wrote ${out}: ${t.toFixed(2)} s`);
