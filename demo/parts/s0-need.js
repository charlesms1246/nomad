/* Scene 0: THE NEED. Three agents, each holding one token and wanting
   another. They drop in, then each one's want pops up in turn. Peak: the
   third bubble, which closes the set of wants. */
"use strict";
registerScene({
  key: "need", loop: 9,
  cap: { t: "Every agent holds one token and needs another.",
         s: "These agents were paid in different tokens. Each one needs something it doesn't have." },
  beats: [[1.6, "a01 holds ZEC and wants USDC."], [3.4, "a02 holds USDC and wants wNEAR."], [5.2, "a03 holds wNEAR and wants ZEC."]],
  kicks: [[0.62, 0.35], [1.02, 0.3], [1.42, 0.3], [1.8, 0.18], [3.6, 0.18], [5.4, 0.3]],
  shots: [
    [0, 1.75, { p: [0, 3.4, 11], l: [0, 1.1, 0], fov: 46 }, { p: [0, 3.1, 10], l: [0, 1.1, 0], fov: 44 }],
    [1.75, 3.55, { p: [-1.3, 2.6, 8.4], l: [-2.7, 1.2, 0], fov: 32 }, { p: [-1.6, 2.5, 7.9], l: [-2.8, 1.25, 0], fov: 32 }],
    [3.55, 5.35, { p: [1.9, 2.5, 8.2], l: [0.3, 1.3, 0], fov: 32 }, { p: [1.5, 2.6, 7.7], l: [0.3, 1.35, 0], fov: 32 }],
    [5.35, 9, { p: [3.6, 2.6, 8.6], l: [1.4, 1.3, 0], fov: 36 }, { p: [0.4, 3.3, 11], l: [0, 1.1, 0], fov: 46 }],
  ],
  build(g) {
    const defs = [
      { name: "a01", holds: "ZEC", wants: "USDC", x: -2.4, t: 0.3, pop: 1.8 },
      { name: "a02", holds: "USDC", wants: "wNEAR", x: 0, t: 0.7, pop: 3.6 },
      { name: "a03", holds: "wNEAR", wants: "ZEC", x: 2.4, t: 1.1, pop: 5.4 },
    ];
    const A = defs.map(d => Object.assign(makeAgent(g, { name: d.name, holds: d.holds, wants: d.wants, tip: WHITE }), { d }));
    return { update(ph) {
      A.forEach((a, i) => {
        const d = a.d, drop = Beat.dropIn(ph, d.t, 1.7);
        const pa = ph - d.pop;
        const bub = pa < 0 ? 0 : eOutBack(seg(pa, 0, 0.45), 2.2);
        /* looks up at its own want as it appears, then back to camera */
        const lookUp = win(ph, d.pop - 0.1, d.pop + 0.25, d.pop + 1.1, d.pop + 1.6);
        /* hops once when its want lands */
        const hp = Beat.hop(ph, d.pop + 0.05, 0.16);
        a.pose({ x: d.x, z: i === 1 ? -0.3 : 0, ry: -d.x * 0.06,
          hop: drop.hop + hp.hop, squash: drop.squash * hp.squash * Beat.breathe(ph, i),
          nod: -0.32 * lookUp, look: 0.35 * lookUp, lean: Math.sin(ph * 1.3 + i) * 0.02,
          blink: Beat.blink(ph, i), bubble: bub, bubbleWob: Math.sin(ph * 1.6 + i) * 0.05 + (pa > 0 && pa < 0.6 ? Math.sin(pa * 18) * 0.12 * (1 - pa / 0.6) : 0) });
        if (a.held) a.held.spin.rotation.y = Math.sin(ph * 0.9 + i) * 0.1;
      });
    } };
  },
});
