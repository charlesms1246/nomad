/* Scene 2: THE LOOP. The three agents stand in a circle. Arcs draw
   a01 → a03 (ZEC), a03 → a02 (wNEAR), a02 → a01 (USDC): every want is met.
   Then each agent signs its own leg; a stamp lands on each card in turn.
   Nothing moves yet: settlement is the next scene. */
"use strict";
const RING3 = [
  { name: "a01", gives: "ZEC", gets: "USDC" },
  { name: "a02", gives: "USDC", gets: "wNEAR" },
  { name: "a03", gives: "wNEAR", gets: "ZEC" },
];
registerScene({
  key: "loop", loop: 12.5,
  cap: { t: "A loop works where pairs fail.",
         s: "a01's ZEC goes to a03, a03's wNEAR to a02, and a02's USDC back to a01." },
  beats: [[0.8, "Around the loop, every want is met."], [3.7, "Each agent signs only its own leg: what it gives and what it gets."], [9.3, "All three legs are signed. Nothing has moved yet."]],
  kicks: [[0.5, 0.2], [1.75, 0.22], [2.45, 0.22], [3.15, 0.22], [4.7, 0.4], [6.5, 0.4], [8.3, 0.4]],
  shots: [
    [0, 3.55, { p: [0, 6.6, 8.6], l: [0, 0.7, 0], fov: 42 }, { p: [2.4, 6.0, 8.0], l: [0, 0.7, 0], fov: 42 }],
    [3.55, 5.45, { p: [-2.1, 2.6, 8.9], l: [-2.9, 1.15, 1.15], fov: 34 }, { p: [-2.2, 2.55, 8.5], l: [-2.9, 1.15, 1.15], fov: 34 }],
    [5.45, 7.25, { p: [2.1, 2.6, 8.9], l: [2.9, 1.15, 1.15], fov: 34 }, { p: [2.2, 2.55, 8.5], l: [2.9, 1.15, 1.15], fov: 34 }],
    [7.25, 9.05, { p: [0.3, 3.3, 8.6], l: [0, 0.95, -1.0], fov: 38 }, { p: [0.2, 3.2, 8.2], l: [0, 0.95, -1.0], fov: 38 }],
    [9.05, 12.5, { p: [0, 3.6, 9.0], l: [0, 1.35, 0], fov: 42 }, { p: [-1.4, 3.9, 8.5], l: [0, 1.3, 0], fov: 42 }],
  ],
  build(g) {
    const R = makeRingCast(g, RING3);
    const ringLine = R.ring;
    const order = [0, 2, 1];                 /* arcs draw a01→a03, a03→a02, a02→a01 */
    const arcT = [1.0, 1.7, 2.4];
    const stampT = [4.7, 6.5, 8.3];          /* signing order: a01, a03, a02 (follows the camera) */
    const cards = RING3.map((d, i) => {
      const c = makeCard(g, [{ t: d.name, mono: true, weight: 700, size: 0.12 }, `gives ${d.gives}`, `gets ${d.gets}`], { w: 1.55, h: 0.7, size: 0.11 });
      const s = makeStamp(g, ACCENT); s.g.rotation.x = Math.PI / 2;
      return { c, s };
    });
    return { update(ph) {
      R.agents.forEach((a, i) => {
        const P = R.P[i], si = order.indexOf(i);
        const h = Beat.hop(ph, 0.3 + i * 0.12, 0.22);
        const st = stampT[si];
        const sign = win(ph, st - 0.8, st - 0.4, st + 0.3, st + 0.8);   /* raises its arms to sign */
        const glad = Beat.hop(ph, st + 0.25, 0.14);
        a.pose({ ...P, hop: h.hop + glad.hop, squash: h.squash * glad.squash * Beat.breathe(ph, i),
          arms: sign * 0.6, nod: -0.3 * sign - 0.12 * win(ph, arcT[0], arcT[0] + 0.4, 3.2, 3.6),
          look: Math.sin(ph * 0.8 + i) * 0.08, blink: Beat.blink(ph, i) });
        /* its token sits in its hands */
        const tk = R.tokens[i]; tk.g.position.copy(holdPos({ ...P, hop: h.hop + glad.hop }));
        tk.spin.rotation.set(0, Math.sin(ph * 0.9 + i) * 0.1, 0); tk.g.scale.setScalar(1);
        /* arcs draw in turn, each from the giver */
        const k = order.indexOf(i);
        R.arcs[i].set(eInOut(seg(ph, arcT[k], arcT[k] + 0.75)));
        /* its card rises out of it, then the stamp */
        const { c, s } = cards[i];
        const rise = eOutBack(seg(ph, 3.6 + k * 0.12, 4.15 + k * 0.12), 1.6);
        c.g.position.set(P.x, lerp(0.9, 2.15, rise), P.z + 0.0);
        c.g.scale.setScalar(Math.max(0.0001, rise));
        c.g.rotation.y = -P.x * 0.05;
        const landed = s.at(ph, st, 0.5);
        s.g.position.set(P.x + c.mark.position.x, c.g.position.y + c.mark.position.y, P.z + 0.06);
        const vis = win(ph, st - 1.0, st - 0.8, st + 0.75, st + 1.0);
        s.g.scale.setScalar(Math.max(0.0001, vis)); s.g.visible = vis > 0.001;
        c.setMark(landed ? eOutBack(seg(ph, st, st + 0.25), 2.5) : 0);
        /* the card dips under the stamp */
        const dip = ph > st && ph < st + 0.5 ? Math.exp(-(ph - st) * 10) * Math.sin((ph - st) * 25) * 0.05 : 0;
        c.flip.rotation.x = -dip * 2; c.flip.position.z = -dip;
      });
      ringLine.material.opacity = 0.32 * seg(ph, 3.0, 3.6);
    } };
  },
});
