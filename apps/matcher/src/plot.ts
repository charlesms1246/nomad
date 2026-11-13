// Tiny dependency-free SVG charts for out/*.svg (sim sweep, race).
const W = 640, H = 360, M = { l: 56, r: 140, t: 40, b: 48 };
const COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function frame(title: string, xLabel: string, yLabel: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#fff"/>
<text x="${M.l}" y="22" font-size="14" font-weight="600">${esc(title)}</text>
<text x="${(M.l + W - M.r) / 2}" y="${H - 10}" text-anchor="middle" fill="#555">${esc(xLabel)}</text>
<text transform="translate(16 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle" fill="#555">${esc(yLabel)}</text>
${body}
</svg>`;
}

export function svgLines(o: { title: string; xLabel: string; yLabel: string; series: { name: string; points: [number, number][] }[] }) {
  const all = o.series.flatMap((s) => s.points);
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(10, Math.ceil(Math.max(...ys) / 10) * 10);
  const px = (x: number) => M.l + ((Math.log(x) - Math.log(x0)) / (Math.log(x1) - Math.log(x0) || 1)) * (W - M.l - M.r);
  const py = (y: number) => H - M.b - (y / y1) * (H - M.t - M.b);
  let body = "";
  for (let g = 0; g <= 4; g++) {
    const y = (y1 * g) / 4;
    body += `<line x1="${M.l}" x2="${W - M.r}" y1="${py(y)}" y2="${py(y)}" stroke="#eee"/><text x="${M.l - 6}" y="${py(y) + 4}" text-anchor="end" fill="#777">${y.toFixed(0)}</text>`;
  }
  for (const x of [...new Set(xs)]) body += `<text x="${px(x)}" y="${H - M.b + 16}" text-anchor="middle" fill="#777">${x}</text>`;
  o.series.forEach((s, i) => {
    const c = COLORS[i % COLORS.length];
    body += `<polyline fill="none" stroke="${c}" stroke-width="2" points="${s.points.map((p) => `${px(p[0])},${py(p[1])}`).join(" ")}"/>`;
    for (const p of s.points) body += `<circle cx="${px(p[0])}" cy="${py(p[1])}" r="3" fill="${c}"/>`;
    body += `<rect x="${W - M.r + 12}" y="${M.t + i * 20}" width="10" height="10" fill="${c}"/><text x="${W - M.r + 28}" y="${M.t + i * 20 + 9}">${esc(s.name)}</text>`;
  });
  return frame(o.title, o.xLabel, o.yLabel, body);
}

export function svgBars(o: { title: string; xLabel: string; bars: [string, number][] }) {
  const max = Math.max(1, ...o.bars.map((b) => b[1]));
  const bw = (W - M.l - M.r) / Math.max(1, o.bars.length);
  let body = "";
  o.bars.forEach(([k, n], i) => {
    const h = (n / max) * (H - M.t - M.b);
    const x = M.l + i * bw + bw * 0.15;
    body += `<rect x="${x}" y="${H - M.b - h}" width="${bw * 0.7}" height="${h}" fill="${COLORS[0]}"/>`;
    body += `<text x="${x + bw * 0.35}" y="${H - M.b - h - 4}" text-anchor="middle">${n}</text>`;
    body += `<text x="${x + bw * 0.35}" y="${H - M.b + 16}" text-anchor="middle" fill="#777">${esc(k)}</text>`;
  });
  return frame(o.title, o.xLabel, "rings", body);
}
