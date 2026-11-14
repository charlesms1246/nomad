/* cast.js: the characters and props every scene shares.
   All state is set per frame by the scene from ph; nothing here keeps time.
   Depends on the engine globals: THREE, obox, hull, label, softShadow, mat,
   TOK, WHITE, INK, ACCENT, MUTED, eOutBack, clamp01. */
"use strict";

/* ── a token: an outlined cube in the token's colour with its symbol on the
   front face. size ~0.4 for a held token. ── */
function makeToken(parent, sym, size = 0.4) {
  const g = new THREE.Group(); parent.add(g);
  const spin = new THREE.Group(); g.add(spin);
  const cube = obox(spin, size, size, size, TOK[sym], 0, 0, 0, { olT: size * 0.09 });
  const k = size / 0.4;
  const fs = (sym.length > 4 ? 0.112 : sym.length > 3 ? 0.13 : 0.155) * k;
  const front = label(spin, [{ t: sym, size: fs, weight: 700 }], { w: size * 0.98, h: size * 0.5, res: 1000 });
  front.position.z = size / 2 + 0.004;
  const back = front.clone(); back.rotation.y = Math.PI; back.position.z = -size / 2 - 0.004; spin.add(back);
  g.userData = { sym, size };
  const tok = { g, spin, cube }; TOKENS.push(tok);
  return tok;
}

/* ── an agent: a voxel bot. Returns { g, pose(p), held, bubble } ──
   pose p: { x, z, ry, hop, squash, lean, tilt, arms (0 holding .. 1 raised),
             blink, look, step (walk phase, radians) } */
function makeAgent(parent, o = {}) {
  const BODY = o.body ?? (o.holds ? TOK[o.holds] : 0xe6eaf1), VISOR = o.visor ?? 0x0d1118, EYE = o.eye ?? 0xf2f4f8;
  const g = new THREE.Group(); parent.add(g); subject(g, o.name || "agent");
  const shadow = softShadow(g, 0.62);
  const rig = new THREE.Group(); g.add(rig);          /* squash / hop / lean */
  const feet = [obox(rig, 0.22, 0.12, 0.3, 0x1b2130, -0.17, 0.06, 0.02),
                obox(rig, 0.22, 0.12, 0.3, 0x1b2130, 0.17, 0.06, 0.02)];
  const upper = new THREE.Group(); upper.position.y = 0.12; rig.add(upper);
  obox(upper, 0.72, 0.62, 0.52, BODY, 0, 0.31, 0);
  if (o.stripe != null) obox(upper, 0.74, 0.1, 0.54, o.stripe, 0, 0.42, 0, { ol: false });
  const head = new THREE.Group(); head.position.y = 0.64; upper.add(head);
  obox(head, 0.8, 0.52, 0.58, BODY, 0, 0.27, 0);
  if (o.hat != null) { obox(head, 0.86, 0.1, 0.64, o.hat, 0, 0.56, 0); obox(head, 0.5, 0.18, 0.46, o.hat, 0, 0.66, 0); }
  obox(head, 0.64, 0.26, 0.05, VISOR, 0, 0.27, 0.29, { olT: 0.03 });
  const eyes = new THREE.Group(); eyes.position.set(0, 0.27, 0.325); head.add(eyes);
  const eyeL = obox(eyes, 0.09, 0.12, 0.02, EYE, -0.14, 0, 0, { ol: false });
  const eyeR = obox(eyes, 0.09, 0.12, 0.02, EYE, 0.14, 0, 0, { ol: false });
  /* antenna */
  obox(head, 0.05, 0.16, 0.05, 0x1b2130, 0.24, 0.6, 0, { olT: 0.02 });
  const tip = obox(head, 0.1, 0.1, 0.1, o.tip ?? ACCENT, 0.24, 0.71, 0, { olT: 0.025 });
  /* arms pivot at the shoulder */
  const arms = [-1, 1].map(sx => { const p = new THREE.Group(); p.position.set(sx * 0.44, 0.55, 0); upper.add(p);
    obox(p, 0.14, 0.4, 0.14, BODY, 0, -0.18, 0); obox(p, 0.15, 0.12, 0.15, 0x1b2130, 0, -0.38, 0); return p; });
  /* what it holds sits in front of the chest */
  const hold = new THREE.Group(); hold.position.set(0, 0.3, 0.52); upper.add(hold);
  let held = null;
  if (o.holds) held = makeToken(hold, o.holds, 0.46);

  /* name plate on the floor in front of it */
  let plate = null;
  if (o.name) { plate = label(g, [{ t: o.name, size: 0.2, weight: 700, color: o.nameColor ?? WHITE }],
      { w: Math.max(1.3, o.name.length * 0.135), h: 0.32, res: 300 });
    plate.rotation.x = -Math.PI / 2 + 0.55; plate.position.set(0, 0.03, 0.72);
    subject(plate, "label " + o.name, { owner: rig }); }
  /* a tag above the head (wallet standard etc.) */
  let tag = null;
  if (o.tag) { tag = label(g, o.tag, { w: 2.6, h: 0.62, res: 220, size: 0.21, gap: 0.25 });
    tag.position.set(0, 2.05, 0); }

  /* thought bubble: what it wants */
  let bubble = null;
  if (o.wants) {
    const bg = new THREE.Group(); bg.position.set(0.62, 1.7, 0.1); g.add(bg);
    const puffs = [[-0.42, -0.42, 0.07], [-0.28, -0.26, 0.1]].map(([x, y, r]) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat(WHITE)); hull(m, 1.35); m.position.set(x, y, 0); bg.add(m); return m; });
    const body = obox(bg, 0.78, 0.66, 0.22, WHITE, 0.08, 0.12, 0, { olT: 0.04 });
    const tok = makeToken(bg, o.wants, 0.4); tok.g.position.set(0.08, 0.12, 0.24);
    bubble = { g: bg, puffs, body, tok };
    bg.scale.setScalar(0.0001);
  }

  const seed = AGENT_SEED++;
  const P = { x: 0, z: 0, ry: 0, hop: 0, squash: 1, lean: 0, tilt: 0, arms: 0, blink: 0, look: 0, nod: 0, step: null, bubble: 0, bubbleWob: 0 };
  function pose(p) {
    const q = Object.assign({}, P, p);
    g.position.set(q.x, 0, q.z); g.rotation.y = q.ry;
    const sq = q.squash, wide = 1 / Math.sqrt(Math.max(0.3, sq));
    rig.scale.set(wide, sq, wide);
    rig.position.y = q.hop;
    rig.rotation.z = q.lean; rig.rotation.x = q.tilt;
    shadow.scale.setScalar(Math.max(0.0001, 1 - Math.min(1, q.hop * 0.3)));
    shadow.visible = q.hop < 3;
    rig.visible = q.hop < 30;
    if (plate) plate.visible = rig.visible && (q.hop < 0.6 || q.step != null);
    head.rotation.y = q.look; head.rotation.x = q.nod;
    eyes.scale.y = q.blink > 0.5 ? 0.15 : 1;
    tip.scale.setScalar(1 + 0.18 * Math.max(0, Math.sin(NOW * 2.1 + seed * 1.3)));
    const ar = -q.arms * 2.6 - 0.9 * (1 - q.arms) * (held ? 1 : 0);
    arms[0].rotation.x = ar; arms[1].rotation.x = ar;
    arms[0].rotation.z = -0.12; arms[1].rotation.z = 0.12;
    if (q.step != null) { const s = Math.sin(q.step);
      feet[0].position.z = 0.02 + s * 0.14; feet[1].position.z = 0.02 - s * 0.14;
      feet[0].position.y = 0.06 + Math.max(0, s) * 0.08; feet[1].position.y = 0.06 + Math.max(0, -s) * 0.08;
    } else { feet[0].position.set(-0.17, 0.06, 0.02); feet[1].position.set(0.17, 0.06, 0.02); }
    if (bubble) {
      const b = q.bubble; bubble.g.scale.setScalar(Math.max(0.0001, b));
      bubble.g.visible = b > 0.001;
      bubble.g.rotation.z = q.bubbleWob;
      bubble.tok.spin.rotation.y = Math.sin(q.bubbleWob * 3) * 0.3;
    }
  }
  pose({});
  return { g, rig, upper, head, hold, get held() { return held; }, set held(v) { held = v; }, bubble, tag, plate, tip, pose };
}

let AGENT_SEED = 0;
/* standard character beats, each a pure function of time since the cue */
const Beat = {
  /* drop in from above: anticipation is the fall, squash on land, settle */
  dropIn(ph, t0, h = 3) {
    const a = ph - t0;
    if (a < 0) return { hop: 40, squash: 1 };
    const fall = 0.32;
    if (a < fall) { const u = a / fall; return { hop: h * (1 - u * u), squash: 1.12 }; }
    const b = a - fall;
    const sq = 1 - 0.32 * Math.exp(-b * 9) * Math.cos(b * 22);
    return { hop: 0, squash: sq };
  },
  /* small hop in place: crouch, jump, land squash */
  hop(ph, t0, h = 0.35) {
    const a = ph - t0;
    if (a < -0.18 || a > 0.85) return { hop: 0, squash: 1 };
    if (a < 0) return { hop: 0, squash: 1 - 0.14 * eOutCubic((a + 0.18) / 0.18) };
    if (a < 0.4) { const u = a / 0.4; return { hop: 4 * h * u * (1 - u), squash: 1.1 - 0.1 * u }; }
    const b = a - 0.4; return { hop: 0, squash: 1 - 0.2 * Math.exp(-b * 10) * Math.cos(b * 20) };
  },
  /* blinks every 2.4-4 s, staggered per agent */
  blink(ph, seed = 0) { const per = 2.4 + hash(seed + 1) * 1.6; const c = (ph + hash(seed + 7) * per) % per; return c > per - 0.13 ? 1 : 0; },
  breathe(ph, seed = 0) { return 1 + Math.sin(ph * 2.0 + seed * 1.9) * 0.015; },
  /* refusal: a quick head shake */
  shake(ph, t0, dur = 0.9) { const a = ph - t0; if (a < 0 || a > dur) return 0;
    return Math.sin(a * 24) * 0.45 * (1 - a / dur); },
};

/* ── an arc between two floor points, drawn by frac. Tube + arrowhead. ── */
function makeArc(parent, a, b, color, h = 1.2, o = {}) {
  const fw = o.front ?? 0.9;
  const c1 = a.clone().add(new THREE.Vector3(0, h, fw)), c2 = b.clone().add(new THREE.Vector3(0, h, fw));
  if (o.bend) { const side = new THREE.Vector3(b.z - a.z, 0, a.x - b.x).normalize().multiplyScalar(o.bend); c1.add(side); c2.add(side); }
  const curve = new THREE.CubicBezierCurve3(a.clone(), c1, c2, b.clone());
  const SEG = 64, RAD = 8, r = o.r ?? 0.045;
  const geo = new THREE.TubeGeometry(curve, SEG, r, RAD, false);
  const tube = new THREE.Mesh(geo, matU(color));
  const olGeo = new THREE.TubeGeometry(curve, SEG, r + 0.03, RAD, false);
  const ol = new THREE.Mesh(olGeo, INKMAT);
  const g = new THREE.Group(); g.add(ol); g.add(tube); parent.add(g);
  const head = new THREE.Mesh(new THREE.ConeGeometry(r * 3.2, r * 7, 12), matU(color)); hull(head, 1.25);
  g.add(head);
  const per = RAD * 6;
  const T0 = o.t0 ?? 0.12, T1 = o.t1 ?? 0.86;   /* trimmed so it stops short of the hands */
  function set(frac) {
    const f = clamp01(frac), e = T0 + (T1 - T0) * f;
    const n0 = Math.floor(T0 * SEG) * per, n = Math.max(0, Math.floor(e * SEG) * per - n0);
    geo.setDrawRange(n0, n); olGeo.setDrawRange(n0, n);
    g.visible = f > 0.001;
    const u = Math.max(0.001, e), p = curve.getPoint(u), tg = curve.getTangent(u);
    head.position.copy(p);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tg.normalize());
    head.scale.setScalar(f > 0.02 ? 1 : 0.0001);
  }
  set(0);
  return { g, curve, set };
}

/* ── a leg card: what one agent signs. lines: [{t,...}] ── */
function makeCard(parent, lines, o = {}) {
  const W = o.w ?? 1.5, H = o.h ?? 0.86;
  const g = new THREE.Group(); parent.add(g);
  const flip = new THREE.Group(); g.add(flip);
  obox(flip, W, H, 0.04, o.paper ?? 0xf4f1ea, 0, 0, 0, { olT: 0.035 });
  const text = label(flip, lines, { w: W * 0.94, h: H * 0.9, res: 300, color: INK, size: o.size ?? 0.14, align: "left", pad: 0.08, gap: 0.35 });
  text.position.z = 0.024;
  /* the stamp mark: hidden until the stamp lands */
  const mt = o.markText ?? "signed", mw = o.markW ?? 0.62;
  const mark = label(flip, [{ t: mt, size: Math.min(0.15, (mw - 0.1) / (mt.length * 0.56)), weight: 700, color: o.markColor ?? ACCENT }],
    { w: o.markW ?? 0.62, h: 0.24, res: 300, bg: "rgba(0,0,0,0)", border: o.markColor ?? ACCENT, borderW: 0.025, radius: 0.04 });
  mark.position.set(W / 2 - (o.markW ?? 0.62) / 2 - 0.05, o.markY ?? 0, 0.03); mark.rotation.z = 0.16;
  mark.scale.setScalar(0.0001);
  return { g, flip, text, mark,
    setMark(v) { mark.scale.setScalar(Math.max(0.0001, v)); mark.visible = v > 0.001; } };
}

/* ── a rubber stamp. update(ph, tDown): lift (anticipation), slam, rebound ── */
function makeStamp(parent, color = ACCENT) {
  const g = new THREE.Group(); parent.add(g);
  const body = new THREE.Group(); g.add(body);
  obox(body, 0.5, 0.12, 0.34, 0x1b2130, 0, 0.06, 0, { olT: 0.03 });
  obox(body, 0.46, 0.04, 0.3, color, 0, -0.01, 0, { olT: 0.02 });
  obox(body, 0.12, 0.34, 0.12, 0x2a3140, 0, 0.29, 0, { olT: 0.03 });
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat(color)); hull(knob, 1.2);
  knob.position.y = 0.52; body.add(knob);
  /* after it rebounds, the stamp leaves upward (world up) and shrinks, so the mark it made is
     never covered: exit(a) is the offset; markAt is when the mark may show */
  const markAt = 0.62;
  function exit(ph, tDown) { const a = ph - tDown; return { up: eInCubic(seg(a, 0.35, 0.62)) * 1.4, s: 1 - seg(a, 0.45, 0.62) }; }
  /* returns the y offset above contact for time a = ph - tDown */
  function at(ph, tDown, rest = 0.9) {
    const a = ph - tDown;
    let y, sq = 1;
    if (a < -0.75) y = rest;
    else if (a < -0.2) y = rest + 0.35 * eOutCubic((a + 0.75) / 0.55);       /* lift: anticipation */
    else if (a < 0) y = (rest + 0.35) * (1 - eInCubic((a + 0.2) / 0.2));     /* slam */
    else if (a < 0.18) { y = 0; sq = 1 - 0.25 * Math.sin((a / 0.18) * Math.PI); }   /* contact squash */
    else if (a < 0.7) y = rest * eOutBack(seg(a, 0.18, 0.7), 1.3);
    else y = rest;
    body.position.y = y; body.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    return a >= 0;
  }
  return { g, at, exit, markAt };
}

/* a flat floor ring under a group of agents */
function floorRing(parent, r, color, op = 0.35) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.03, r + 0.03, 96),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.01; parent.add(m); return m;
}

/* place n agents on a circle (front agent at angle a0), facing the centre */
function circlePos(i, n, r, a0 = Math.PI / 2) {
  const a = a0 + (i / n) * Math.PI * 2;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, face: Math.atan2(-Math.cos(a), -Math.sin(a)) };
}

/* world position of what an agent holds, for pose {x,z,ry,hop} */
function holdPos(p, out = new THREE.Vector3()) {
  return out.set(p.x + Math.sin(p.ry) * 0.56, 0.44 + (p.hop || 0), p.z + Math.cos(p.ry) * 0.56);
}
/* a token flying on a curve: arc rise is in the curve itself; adds a spin
   and a squash on landing. u in 0..1 (already eased by the caller). */
function flyOn(tok, curve, u, landAge = -1) {
  tok.g.position.copy(curve.getPoint(clamp01(u)));
  tok.spin.rotation.y = u * Math.PI * 2; tok.spin.rotation.x = Math.sin(u * Math.PI) * 0.6;
  let sq = 1;
  if (landAge >= 0 && landAge < 0.5) sq = 1 - 0.3 * Math.exp(-landAge * 10) * Math.cos(landAge * 26);
  tok.g.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
}
/* a red refusal cross: two crossed bars */
function makeCross(parent, s = 0.6) {
  const g = new THREE.Group(); parent.add(g);
  obox(g, s, s * 0.2, s * 0.2, RED, 0, 0, 0, { rz: Math.PI / 4, olT: 0.04 });
  obox(g, s, s * 0.2, s * 0.2, RED, 0, 0, 0.01, { rz: -Math.PI / 4, olT: 0.04 });
  g.scale.setScalar(0.0001); return g;
}

/* the three-agent ring shared by scenes 2-4.
   defs: [{ name, gives, gets, ...agent opts }]. Each agent's token flies to
   the agent that wants it. Returns { agents, tokens, arcs, P, to } where
   P[i] is agent i's pose base and to[i] the index receiving agent i's token. */
function makeRingCast(g, defs, o = {}) {
  const r = o.r ?? 2.3, a0 = o.a0 ?? (150 * Math.PI / 180);
  const P = defs.map((d, i) => { const c = circlePos(i, defs.length, r, a0); return { x: c.x, z: c.z, ry: o.faceIn ? c.face : -c.x * 0.14, hop: 0 }; });
  const agents = defs.map((d, i) => makeAgent(g, Object.assign({ tip: WHITE, body: TOK[d.gives] }, d, { holds: undefined, wants: o.bubbles ? d.gets : undefined })));
  const tokens = defs.map(d => makeToken(g, d.gives, 0.46));
  const to = defs.map(d => defs.findIndex(e => e.gets === d.gives));
  /* floor arrows around the circle, each in the colour of the token it carries;
     tokens fly on a high curve above them (never through a body) */
  const ang = defs.map((d, i) => a0 + (i / defs.length) * Math.PI * 2);
  const gap = o.gap ?? 0.42;
  const arcs = defs.map((d, i) => {
    let A = ang[i], B = ang[to[i]];
    /* go the short way round */
    while (B - A > Math.PI) B -= Math.PI * 2; while (A - B > Math.PI) B += Math.PI * 2;
    const s = Math.sign(B - A);
    const fa = makeFloorArc(g, r, A + s * gap, B - s * gap, TOK[d.gives]);
    const a = holdPos(P[i]), b = holdPos(P[to[i]]);
    fa.curve = new THREE.CubicBezierCurve3(a.clone(), a.clone().add(V(0, 2.2, 0.35)), b.clone().add(V(0, 2.2, 0.35)), b.clone());
    return fa;
  });
  const ring = floorRing(g, r, ACCENT, 0.0);
  return { agents, tokens, arcs, P, to, ring };
}

/* a flat arrow on the floor along a circle of radius r, from angle a0 to a1
   (radians; runs either way). Ribbon + arrowhead, outlined. set(frac). */
function makeFloorArc(parent, r, a0, a1, color, o = {}) {
  const W = o.w ?? 0.17, N = 48, y = o.y ?? 0.02;
  function ribbon(w, yy, col, order) {
    const pos = [], idx = [];
    for (let k = 0; k <= N; k++) { const a = a0 + (a1 - a0) * k / N;
      pos.push(Math.cos(a) * (r - w), yy, Math.sin(a) * (r - w), Math.cos(a) * (r + w), yy, Math.sin(a) * (r + w)); }
    for (let k = 0; k < N; k++) { const i = k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, depthWrite: false }));
    m.renderOrder = order; return m;
  }
  const g = new THREE.Group(); parent.add(g);
  const ink = ribbon(W + 0.035, y, OUTLINE, 0), body = ribbon(W, y + 0.004, color, 1);
  g.add(ink); g.add(body);
  /* arrowhead: a flat triangle, outlined */
  const tri = (s) => { const sh = new THREE.Shape(); sh.moveTo(0, s * 1.25); sh.lineTo(-s, -s * 0.55); sh.lineTo(s, -s * 0.55); sh.closePath(); return new THREE.ShapeGeometry(sh); };
  const head = new THREE.Group(); g.add(head);
  const hi = new THREE.Mesh(tri(0.36), new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.DoubleSide, depthWrite: false })); hi.renderOrder = 2;
  const hb = new THREE.Mesh(tri(0.27), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false })); hb.renderOrder = 3; hb.position.y = 0.06;
  hi.rotation.x = hb.rotation.x = -Math.PI / 2; head.add(hi); head.add(hb);
  const dir = Math.sign(a1 - a0);
  function set(frac) {
    const f = clamp01(frac), n = Math.floor(f * N) * 6;
    ink.geometry.setDrawRange(0, n); body.geometry.setDrawRange(0, n);
    g.visible = f > 0.001;
    const a = a0 + (a1 - a0) * f;
    head.position.set(Math.cos(a) * r, y + 0.01, Math.sin(a) * r);
    /* tangent along the direction of travel */
    const tx = -Math.sin(a) * dir, tz = Math.cos(a) * dir;
    head.rotation.y = Math.atan2(tx, tz);
    head.children.forEach(c => { c.rotation.z = 0; });
    hi.rotation.set(-Math.PI / 2, 0, 0); hb.rotation.set(-Math.PI / 2, 0, 0);
    head.scale.setScalar(f > 0.03 ? 1 : 0.0001);
  }
  set(0);
  return { g, set };
}

/* a voxel monitor showing a real screenshot of the product. The texture is
   preloaded (PRELOAD) so the first rendered frame already has it. */
const PRELOAD = [];
function makeMonitor(parent, url, w = 4, o = {}) {
  const g = new THREE.Group(); parent.add(g);
  const tex = new THREE.Texture(); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  const img = new Image();
  const aspect = o.aspect ?? 2;
  const h = w / aspect;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: false }));
  PRELOAD.push(new Promise(r => { img.onload = () => { tex.image = img; tex.needsUpdate = true;
    const a = img.width / img.height; screen.scale.y = aspect / a; frame.scale.y = (h * aspect / a + 0.24) / (h + 0.24); r(); };
    img.onerror = r; img.src = url; }));
  const frame = obox(g, w + 0.24, h + 0.24, 0.16, 0x1b2130, 0, 0, -0.06, { olT: 0.05 });
  screen.position.z = 0.03; g.add(screen);
  if (o.stand !== false) { const s1 = obox(g, 0.22, o.standH ?? 1.2, 0.18, 0x262d3b, 0, -(h / 2) - (o.standH ?? 1.2) / 2, -0.1);
    const s2 = obox(g, 1.3, 0.1, 0.7, 0x262d3b, 0, -(h / 2) - (o.standH ?? 1.2), -0.1);
    [s1, s2].forEach(m => m.traverse(c => c.userData.noqa = true)); }
  subject(g, o.name ?? "monitor");
  return { g, screen };
}
