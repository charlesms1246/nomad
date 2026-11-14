// Stitch the demo video (silent, 1920x1080, 30 fps, H.264):
//   cold open (the scene-3 settle with one line on screen) -> push-through transition -> deck scenes 0-4 -> the real site (landing hero, ring
//   replay, /dashboard workshop, /rings?verify=1) -> deck scene 5 -> the proof figures -> end card.
//   node scripts/stitch-demo.mjs [in dir = out/demo] [out = out/demo/nomad-demo.mp4]
// Inputs: deck-s0..s5.mp4 and cold-s3.mp4 (scripts/render-demo.mjs; cold-s3 is scene 3 from 3.0 s with DECK_QUERY=nocap),
// web-*.mp4 and web-rings.json (scripts/record-site.mjs), cards/*.png (scripts/demo-cards.mjs), logo-*.mp4 (scripts/demo-logo.mjs).
// Cuts are hard. Website shots and cards get a slow push-in (zoompan on a 4K upscale, so the motion stays smooth)
// toward the element that matters; the replay keeps each stage's moment of change and drops the still tails.
// Prints the start/end of every block (the timing sheet's skeleton).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir = "out/demo", out = "out/demo/nomad-demo.mp4"] = process.argv.slice(2);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const shots = JSON.parse(readFileSync(join(dir, "web-rings.json"), "utf8"));

/* each block: a clip (file + [from, to] pieces) or a still card (png + secs); optional push-in zoom [z0, z1, cx, cy];
   optional overlay png faded in at a time */
const BLOCKS = [
  { name: "Cold open: the settle", file: "cold-s3.mp4", pieces: [[0.3, 3.3]], overlay: { png: "cards/cold-title.png", at: 0.15, out: 2.75 } },
  /* transition into scene 0: an accelerating push-through toward the ring with motion blur, a white flash, then a
     pull-back that lands on scene 0's first frame (so scene 0 itself starts unchanged at 4.4 s) */
  { name: "Transition: push-through", file: "cold-s3.mp4", pieces: [[3.3, 4.1]], zexpr: ["1+1.9*pow(on/(N-1),2.4)", 0.45, 0.55], blur: 4, flashOut: 0.14 },
  { name: "Transition: land on scene 0", png: "cards/s0-first.png", secs: 0.6, zexpr: ["1+0.9*pow(1-on/(N-1),2.6)", 0.5, 0.5], blur: 3, flashIn: 0.16 },
  { name: "Scene 0: the need", file: "deck-s0.mp4", pieces: [[0, 8.2]] },
  { name: "Scene 1: pairs fail", file: "deck-s1.mp4", pieces: [[0, 8.6]] },
  { name: "Scene 2: the loop", file: "deck-s2.mp4", pieces: [[0, 11.6]] },
  { name: "Scene 3: a stranger closes the ring", file: "deck-s3.mp4", pieces: [[0, 11.5]] },
  { name: "Scene 4: any wallet", file: "deck-s4.mp4", pieces: [[0, 21]] },
  { name: "Website: landing hero", file: "web-hero.mp4", pieces: [[0.5, 5.5]], zoom: [1.0, 1.1, 0.5, 0.42] },
  { name: "Website: ring replay", file: "web-replay.mp4",
    pieces: [[0.3, 2.6], [3.2, 7.0], [8.4, 11.2], [12.0, 15.4], [16.2, 18.6], [19.4, 21.2]], zoom: [1.0, 1.14, 0.5, 0.44] },
  { name: "Website: /dashboard workshop", file: "web-dashboard.mp4", pieces: [[0, 12.5]], zoom: [1.0, 1.07, 0.47, 0.42] },
  ...shots.map((s, i) => ({ name: `Website: /rings?verify=1 shot ${i + 1}`, file: s.file, pieces: [[0, s.secs]], zoom: [1.0, 1.12, s.cx, s.cy] })),
  { name: "Scene 5: proof", file: "deck-s5.mp4", pieces: [[0, 15.5]] },
  { name: "Figure: 27 rings settled, 0 failed", png: "cards/num-1.png", secs: 2.4, zoom: [1.0, 1.06, 0.5, 0.45] },
  { name: "Figure: 3 wallet standards in one ring", png: "cards/num-2.png", secs: 2.4, zoom: [1.0, 1.06, 0.5, 0.45] },
  { name: "Figure: 0 access keys", png: "cards/num-3.png", secs: 2.4, zoom: [1.0, 1.06, 0.5, 0.45] },
  { name: "End card", file: "logo-end.mp4", pieces: [[0, 4.0]], zoom: [1.0, 1.03, 0.5, 0.5], fadeOut: 0.6 },
];

const inputs = [], chains = [];
let n = 0, t = 0;
const add = (args) => { inputs.push(...args); return n++; };
const zoomFilter = ([z0, z1, cx, cy], frames) =>
  `scale=3840:2160:flags=bicubic,zoompan=z='${z0}+(${(z1 - z0).toFixed(4)})*on/${Math.max(1, frames - 1)}'` +
  `:x='max(0,min(iw-iw/zoom,${cx}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${cy}*ih-ih/zoom/2))':d=1:s=1920x1080:fps=30`;
BLOCKS.forEach((b, bi) => {
  let secs;
  if (b.png) {
    const p = join(dir, b.png); if (!existsSync(p)) throw new Error("missing " + p);
    const i = add(["-loop", "1", "-framerate", "30", "-t", String(b.secs), "-i", p]);
    secs = b.secs;
    chains.push(`[${i}:v]fps=30,scale=1920:1080,format=yuv420p,setsar=1[p${bi}]`);
  } else {
    const p = join(dir, b.file); if (!existsSync(p)) throw new Error("missing " + p);
    const parts = b.pieces.map(([a, z], k) => {
      const i = add(["-ss", a.toFixed(3), "-t", (z - a).toFixed(3), "-i", p]);
      chains.push(`[${i}:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[c${bi}_${k}]`);
      return `[c${bi}_${k}]`;
    });
    secs = b.pieces.reduce((s, [a, z]) => s + (z - a), 0);
    chains.push(parts.length > 1 ? `${parts.join("")}concat=n=${parts.length}:v=1:a=0[p${bi}]` : `${parts[0]}null[p${bi}]`);
  }
  const frames = Math.round(secs * 30);
  let f = `[p${bi}]`;
  if (b.zoom) { chains.push(`${f}${zoomFilter(b.zoom, frames)},setsar=1,format=yuv420p[z${bi}]`); f = `[z${bi}]`; }
  if (b.zexpr) {
    const [ze, cx, cy] = b.zexpr, z = ze.replaceAll("N", String(frames));
    chains.push(`${f}scale=3840:2160:flags=bicubic,zoompan=z='${z}':x='max(0,min(iw-iw/zoom,${cx}*iw-iw/zoom/2))'` +
      `:y='max(0,min(ih-ih/zoom,${cy}*ih-ih/zoom/2))':d=1:s=1920x1080:fps=30,setsar=1,format=yuv420p[ze${bi}]`); f = `[ze${bi}]`;
  }
  if (b.blur) { chains.push(`${f}tmix=frames=${b.blur}[bl${bi}]`); f = `[bl${bi}]`; }
  if (b.flashOut) { chains.push(`${f}fade=t=out:st=${(secs - b.flashOut).toFixed(3)}:d=${b.flashOut}:color=white[fw${bi}]`); f = `[fw${bi}]`; }
  if (b.flashIn) { chains.push(`${f}fade=t=in:st=0:d=${b.flashIn}:color=white[fi${bi}]`); f = `[fi${bi}]`; }
  if (b.overlay) {
    const oi = add(["-loop", "1", "-framerate", "30", "-t", secs.toFixed(3), "-i", join(dir, b.overlay.png)]);
    chains.push(`[${oi}:v]format=rgba,fade=t=in:st=${b.overlay.at}:d=0.2:alpha=1${b.overlay.out != null ? `,fade=t=out:st=${b.overlay.out}:d=0.2:alpha=1` : ""}[o${bi}]`);
    chains.push(`${f}[o${bi}]overlay=0:0:shortest=1,format=yuv420p[ov${bi}]`); f = `[ov${bi}]`;
  }
  if (b.fadeOut) { chains.push(`${f}fade=t=out:st=${(secs - b.fadeOut).toFixed(3)}:d=${b.fadeOut}[fo${bi}]`); f = `[fo${bi}]`; }
  chains.push(`${f}trim=end_frame=${frames},setpts=PTS-STARTPTS[v${bi}]`);
  console.log(`${t.toFixed(2).padStart(7)} - ${(t + secs).toFixed(2).padStart(7)}  ${b.name}  (${secs.toFixed(2)} s)`);
  t += secs;
});
const graph = chains.join(";") + ";" + BLOCKS.map((_, i) => `[v${i}]`).join("") + `concat=n=${BLOCKS.length}:v=1:a=0[out]`;
const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[out]", "-an",
  "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out], { stdio: "inherit" });
if (r.status) process.exit(r.status);
console.log(`wrote ${out}: ${t.toFixed(2)} s`);
