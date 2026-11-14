/* makeEnvironment — the world the staging sits inside: a horizon, a distant
   skyline of machine racks, and a whisper of atmosphere behind every set.
   ─────────────────────────────────────────────────────────────────────────
   The scenes used to end in blackness a few floor-tiles out, which reads as
   an unfinished stage rather than as night. This asset closes the world:

     · GROUND    a dark plane running ~450 units back, so the stage floor
                 sits ON something and the fog has a surface to eat
     · HORIZON   a faint accent-cast glow band where that ground meets the
                 sky — the one warm line that says "there is a world out
                 there", sitting behind every silhouette
     · SKYLINE   three depth layers of far-off machine racks (this is a deck
                 about blockchains — a field of machines, not a city).
                 Heights vary, towers cluster with gaps between the blocks,
                 and the far layer sits close enough to BG in value that the
                 fog resolves it with no visible edge to the world
     · LIGHTS    a few dim LED strips on the near racks and beacons on the
                 tall far ones — a sleeping datacenter, not a light show
     · MOTES     a handful of slow drifting glow motes for parallax on the
                 crane moves

   IT IS A BACKDROP. Everything is silhouette-dark (between BG and the stage
   tone), nothing is outlined (crisp ink edges would pull focus), nothing
   pulses faster than a ~12 s breath, and the near layer keeps a gap down the
   middle so the staging always owns the centre of the frame. If a viewer's
   eye goes to the scenery, turn the density down.

   API
     const env = makeEnvironment(parent, opts)
       opts (all optional — makeEnvironment(g) alone gives the default look):
         kind     'racks'  squat machine cabinets (default)
                  'spires' taller, thinner towers — reads more skyline
                  'ridge'  low wide blocks only, no lights — pure horizon
         tint     hex cast blended ~22% into the silhouettes and ground, so
                  a scene's mood (see SCENE_TINT) carries into its backdrop.
                  Default: none (pure BG-family greens).
         accent   hex for the horizon glow, LED strips and beacons.
                  Default: the deck ACCENT (0x83e637).
         density  0..1.5 multiplier on tower/light counts (default 1).
                  0 keeps only ground + horizon.
         motes    drifting mote count (default 8, 0 disables).
         horizon  false to skip the glow band (default true).
         ground   false to skip the ground plane (default true).
         seed     integer for the deterministic layout (default 7). Same
                  seed, same world, frame for frame — screenshots reproduce.
     Returns { g, update(t, dt) }:
       g          THREE.Group under `parent` — leave it at origin; the layout
                  is composed for the deck's 5–15 unit camera distances
       update     drive every frame. All motion is t-analytic (pure sine),
                  so a given t always produces the same frame.

   COST (density 1): 3 InstancedMesh layers + 1 LED strip mesh + ground +
   horizon = 6 draw calls and ~1.5k triangles, plus ~13 glow sprites
   (beacons + motes) at one draw each. Cheap enough to live behind all seven
   scenes. NOTE: the skyline spans x ±~75 which is wider than the deck's
   80-unit set gap — safe, because the deck renders only the current set's
   group; do not make two sets visible at once.

   Nothing here throws: build errors return an inert stub and update()
   swallows garbage — a decorative backdrop must never take the deck down.
   No Math.random anywhere; the layout comes from a seeded PRNG.

   GLOBALS THIS FILE DEPENDS ON (from index.html's staging surface):
     THREE, BG, ACCENT, glowSprite
   Nothing else. Silhouette shades are local constants. */

"use strict";

function makeEnvironment(parent, opts) {
  /* inert stub — the shape callers rely on, should the build ever fail */
  const stub = () => ({ g: (typeof THREE !== "undefined" && THREE.Group)
    ? new THREE.Group() : { visible: false }, update: () => {} });
  try {

  const o = opts || {};
  const KIND    = (o.kind === "spires" || o.kind === "ridge") ? o.kind : "racks";
  const DENS    = Number.isFinite(o.density) ? Math.max(0, Math.min(1.5, o.density)) : 1;
  const SEED    = Number.isFinite(o.seed) ? (o.seed | 0) : 7;
  const NMOTES  = Number.isFinite(o.motes) ? Math.max(0, Math.min(24, o.motes | 0)) : 8;
  const BGC     = (typeof BG === "number") ? BG : 0x07090d;
  const ACC     = Number.isFinite(o.accent) ? o.accent
                : (typeof ACCENT === "number") ? ACCENT : 0x3987e5;
  const TINT    = Number.isFinite(o.tint) ? new THREE.Color(o.tint) : null;

  /* deterministic PRNG — mulberry32. Same seed, same skyline, every load. */
  let _s = SEED || 7;
  const R = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0;
    let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const rr = (a, b) => a + R() * (b - a);

  /* silhouette shades — a value ramp from "just above the stage" down to
     "almost the sky". The fog (FogExp2 0.004) does the rest of the fade. */
  const shade = hex => { const c = new THREE.Color(hex);
    if (TINT) c.lerp(TINT, 0.22); return c; };
  const NEAR_C = shade(0x121722), MID_C = shade(0x0e121b), FAR_C = shade(0x0b0e15);
  const GROUND_C = shade(0x090b10);
  const accCss = a => "rgba(" + ((ACC >> 16) & 255) + "," + ((ACC >> 8) & 255) +
    "," + (ACC & 255) + "," + a + ")";

  const g = new THREE.Group();
  if (parent && parent.add) parent.add(g);

  /* ── ground: the world has a floor. Fog-affected, so its far edge melts
     into the sky with no seam — that melt line IS the horizon. ─────────── */
  if (o.ground !== false) {
    const gr = new THREE.Mesh(new THREE.PlaneGeometry(1300, 640),
      new THREE.MeshBasicMaterial({ color: GROUND_C, depthWrite: false }));
    gr.rotation.x = -Math.PI / 2;
    gr.position.set(0, -0.22, -160);       /* runs from behind camera to z -470 */
    gr.renderOrder = -3;                   /* under the set's gridFloor (-2) */
    g.add(gr);
  }

  /* ── horizon glow: a wide, faint accent band where ground meets sky.
     Fog OFF (at z -240 fog would eat it) — its dimness is baked in. Towers
     depth-test against it, so the skyline reads as shapes AGAINST the glow. */
  if (o.horizon !== false) {
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 256;
    const x = cv.getContext("2d");
    const gd = x.createLinearGradient(0, 0, 0, 256);
    gd.addColorStop(0.00, accCss(0));
    gd.addColorStop(0.40, accCss(0.06));
    gd.addColorStop(0.58, accCss(0.18));
    gd.addColorStop(0.74, accCss(0.42));   /* the line itself */
    gd.addColorStop(0.86, accCss(0.10));
    gd.addColorStop(1.00, accCss(0));
    x.fillStyle = gd; x.fillRect(0, 0, 512, 256);
    /* horizontal falloff — the band must DIE OUT before its geometric edge,
       or a hard vertical seam walks into wide frames */
    const hf = x.createLinearGradient(0, 0, 512, 0);
    hf.addColorStop(0, "rgba(0,0,0,0)");   hf.addColorStop(0.22, "rgba(0,0,0,1)");
    hf.addColorStop(0.78, "rgba(0,0,0,1)"); hf.addColorStop(1, "rgba(0,0,0,0)");
    x.globalCompositeOperation = "destination-in";
    x.fillStyle = hf; x.fillRect(0, 0, 512, 256);
    const tex = new THREE.CanvasTexture(cv);
    const hz = new THREE.Mesh(new THREE.PlaneGeometry(1400, 46),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.34,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    hz.position.set(0, 11, -240);          /* band straddles y ~0..23 */
    g.add(hz);
  }

  /* ── skyline: three instanced layers. Towers cluster (machines come in
     blocks) with gaps between clusters; the near layer keeps a clear avenue
     down the middle so nothing crowds in behind the staging. ───────────── */
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const towers = [];                       /* kept for LED/beacon placement */

  function layer(n, col, zA, zB, xR, wA, wB, hMax, dA, dB, gap) {
    n = Math.round(n * DENS);
    if (n <= 0) return;
    /* 6 cluster centres across the span, jittered */
    const NC = 6, cw = rr(5, 8), cx = [];
    for (let i = 0; i < NC; i++)
      cx.push(-xR + (i + 0.5) * (2 * xR / NC) + (R() - 0.5) * xR * 0.22);
    const list = [];
    for (let i = 0; i < n; i++) {
      const x = cx[(R() * NC) | 0] + (R() + R() - 1) * cw;
      if (gap && Math.abs(x) < gap) continue;         /* the centre avenue */
      const w = rr(wA, wB), d = rr(dA, dB);
      let h = 0.7 + Math.pow(R(), 1.7) * hMax;        /* mostly low, few tall */
      if (x < -8) h = Math.min(h, hMax * 0.5);        /* keep the top-left
        corner of the frame (the title block) clear of tall shapes */
      list.push({ x, z: rr(zA, zB), w, h, d });
    }
    if (!list.length) return;
    const im = new THREE.InstancedMesh(boxGeo,
      new THREE.MeshBasicMaterial({ color: col }), list.length);
    const M = new THREE.Matrix4(), C = new THREE.Color();
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      M.makeScale(t.w, t.h, t.d);
      M.setPosition(t.x, t.h / 2 - 0.2, t.z);         /* feet in the ground */
      im.setMatrixAt(i, M);
      if (typeof im.setColorAt === "function") {      /* subtle value jitter */
        C.copy(col).multiplyScalar(rr(0.82, 1.14)); im.setColorAt(i, C); }
      towers.push(t);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    g.add(im);
  }

  /* per-kind proportions: racks are squat cabinets, spires reach higher,
     ridge is a low landform. Every height stays under ~9 units — far enough
     and dim enough that nothing climbs into the caption or title bands. */
  if (KIND === "spires") {
    layer(22, NEAR_C, -30, -52,  34, 0.9, 1.9, 4.6, 0.9, 1.8, 7);
    layer(36, MID_C,  -64, -104, 48, 1.1, 2.6, 7.5, 1.1, 2.4, 0);
    layer(50, FAR_C, -120, -205, 72, 1.6, 3.6, 9.0, 1.6, 3.4, 0);
  } else if (KIND === "ridge") {
    layer(10, NEAR_C, -34, -52,  36, 3.5, 8.0, 1.6, 3.0, 6.0, 8);
    layer(14, MID_C,  -66, -104, 50, 4.0, 9.0, 3.0, 3.5, 7.0, 0);
    layer(18, FAR_C, -122, -205, 74, 5.0, 11.0, 5.0, 4.0, 8.0, 0);
  } else { /* racks */
    layer(24, NEAR_C, -30, -52,  34, 1.6, 3.8, 3.1, 1.2, 2.8, 7);
    layer(38, MID_C,  -64, -104, 48, 2.0, 5.0, 5.5, 1.6, 3.4, 0);
    layer(52, FAR_C, -120, -205, 72, 2.5, 7.0, 8.0, 2.0, 4.5, 0);
  }

  /* ── LED strips: thin lit slots on some near/mid racks — what says
     "machines, running" instead of "empty buildings". Static; fog dims the
     far ones. One instanced mesh, desaturated accent, modest opacity. ──── */
  if (KIND !== "ridge" && DENS > 0) {
    const cands = towers.filter(t => t.z > -105 && t.h > 1.5);
    const slots = [];
    for (const t of cands) {
      if (R() > 0.42 || slots.length >= Math.round(20 * DENS)) continue;
      slots.push({ x: t.x + (R() - 0.5) * t.w * 0.45,
        y0: 0.12, h: t.h * rr(0.35, 0.6), z: t.z + t.d / 2 + 0.03 });
    }
    if (slots.length) {
      const ledCol = new THREE.Color(ACC).lerp(new THREE.Color(0x9aa8c4), 0.35);
      const im = new THREE.InstancedMesh(boxGeo,
        new THREE.MeshBasicMaterial({ color: ledCol, transparent: true,
          opacity: 0.5, depthWrite: false }), slots.length);
      const M = new THREE.Matrix4();
      for (let i = 0; i < slots.length; i++) { const s = slots[i];
        M.makeScale(0.07, s.h, 0.05);
        M.setPosition(s.x, s.y0 + s.h / 2, s.z);
        im.setMatrixAt(i, M); }
      im.instanceMatrix.needsUpdate = true;
      g.add(im);
    }
  }

  /* ── beacons: dim points on the tallest far towers — the sleeping fleet.
     Breathe on a ~12 s sine; slow enough that it never reads as a beat. ── */
  const beacons = [];
  if (KIND !== "ridge" && DENS > 0 && typeof glowSprite === "function") {
    const far = towers.filter(t => t.z < -110)
      .sort((a, b) => b.h - a.h).slice(0, 5);
    far.forEach((t, i) => {
      const s = glowSprite(i % 2 ? 0xb0bccf : ACC, 1.1, 0.09);
      s.position.set(t.x, t.h + rr(0.2, 0.7), t.z);
      if (s.material) s.material.fog = false;   /* dimness is baked in */
      g.add(s); beacons.push({ s, o0: 0.09, ph: rr(0, 9) });
    });
  }

  /* ── motes: slow drifting glow points between stage and skyline, for
     parallax on the crane moves. Analytic drift — same t, same frame. ──── */
  const motes = [];
  if (NMOTES > 0 && typeof glowSprite === "function") {
    for (let i = 0; i < NMOTES; i++) {
      const s = glowSprite(i % 3 ? ACC : 0xc4cedf, rr(0.28, 0.55), rr(0.045, 0.08));
      const bx = rr(-22, 22), by = rr(0.8, 6), bz = rr(-12, -38);
      s.position.set(bx, by, bz);
      g.add(s);
      motes.push({ s, bx, by, bz, ax: rr(0.5, 1.3), ay: rr(0.25, 0.6),
        w1: rr(0.04, 0.09), w2: rr(0.05, 0.1), p1: rr(0, 9), p2: rr(0, 9) });
    }
  }

  /* ── drive. Cheap: a sine per mote axis, a sine per beacon. ───────────── */
  function update(t) {
    try {
      if (!Number.isFinite(t)) return;
      for (const m of motes) {
        m.s.position.x = m.bx + Math.sin(t * m.w1 + m.p1) * m.ax;
        m.s.position.y = m.by + Math.sin(t * m.w2 + m.p2) * m.ay;
      }
      for (const b of beacons)
        if (b.s.material)
          b.s.material.opacity = b.o0 * (0.78 + 0.22 * Math.sin(t * 0.5 + b.ph));
    } catch (_) { /* scenery must never take a frame down */ }
  }

  return { g, update };

  } catch (err) { return stub(); }
}
