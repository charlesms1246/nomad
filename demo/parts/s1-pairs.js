/* Scene 1: PAIRS FAIL. a01 offers its ZEC to a02 for USDC. a02 wants
   wNEAR, not ZEC: it shakes its head and the ZEC bounces back. The refusal
   is the peak, and it is held. */
"use strict";
registerScene({
  key: "pairs", loop: 9.5,
  cap: { t: "Two agents can't trade.",
         s: "One wants what the other has, but not the other way round. The same is true of every pair here." },
  beats: [[0.5, "a01 offers its ZEC to a02 for USDC."], [2.7, "a02 wants wNEAR, not ZEC. No trade."], [5.8, "No two of them can swap with each other."]],
  kicks: [[2.55, 0.45], [3.95, 0.35]],
  shots: [
    [0, 2.6, { p: [-2.4, 2.5, 7.4], l: [-0.1, 0.8, 0], fov: 36 }, { p: [-2.0, 2.4, 6.9], l: [0, 0.8, 0], fov: 35 }],
    [2.6, 3.85, { p: [0.2, 2.2, 7.2], l: [0.5, 0.95, 0], fov: 36 }, { p: [0.3, 2.15, 6.8], l: [0.5, 0.95, 0], fov: 36 }],
    [3.85, 9.5, { p: [0.3, 2.7, 8.2], l: [0, 1.0, 0], fov: 40 }, { p: [0.1, 2.6, 7.5], l: [0, 1.0, 0], fov: 40 }, t => t],
  ],
  build(g) {
    const a1 = makeAgent(g, { name: "a01", wants: "USDC", body: TOK.ZEC, tip: WHITE });
    const a2 = makeAgent(g, { name: "a02", holds: "USDC", wants: "wNEAR", tip: WHITE });
    /* a01's ZEC is a free token so it can fly */
    const zec = makeToken(g, "ZEC", 0.4);
    const cross = makeCross(g, 0.7);
    const P1 = { x: -1.5, z: 0, ry: 0.85 }, P2 = { x: 1.5, z: 0, ry: -0.85 };
    const home = holdPos({ ...P1, hop: 0 }), meet = V(0.75, 1.05, 0.55);
    const outC = new THREE.QuadraticBezierCurve3(home.clone(), V(-0.2, 2.1, 0.5), meet.clone());
    const backC = new THREE.QuadraticBezierCurve3(meet.clone(), V(-0.4, 1.8, 0.6), home.clone());
    return { update(ph) {
      /* a01 walks in, offers, throws, recoils */
      const walk = eInOut(seg(ph, 0, 1.0));
      const x1 = lerp(-2.6, P1.x, walk);
      const windup = win(ph, 1.45, 1.75, 1.75, 1.95);           /* lean back before the throw */
      const thrust = win(ph, 1.75, 1.9, 2.1, 2.5);
      const recoil = ph > 3.95 ? Math.exp(-(ph - 3.95) * 4) * Math.sin((ph - 3.95) * 14) : 0;
      const land = Beat.hop(ph, 3.95, 0.0);
      const sulk = win(ph, 4.6, 5.2, 8.6, 9.3);
      a1.pose({ x: x1, z: P1.z, ry: P1.ry, step: walk < 1 ? ph * 11 : null,
        hop: walk < 1 ? Math.abs(Math.sin(ph * 11)) * 0.06 : 0,
        squash: (1 - windup * 0.1) * (ph > 3.95 ? 1 - 0.18 * Math.exp(-(ph - 3.95) * 8) * Math.cos((ph - 3.95) * 20) : 1) * Beat.breathe(ph),
        lean: -windup * 0.18 + thrust * 0.16 + recoil * 0.12, tilt: -windup * 0.1 + thrust * 0.15,
        arms: thrust * 0.55, nod: sulk * 0.22, look: sulk * -0.25,
        blink: Beat.blink(ph), bubble: eOutBack(seg(ph, 0.4, 0.85), 2), bubbleWob: Math.sin(ph * 1.7) * 0.05 });
      /* a02: watches, then shakes its head; its want pulses on the refusal */
      const shake = Beat.shake(ph, 2.6, 1.1);
      const flinch = ph > 2.5 ? Math.exp(-(ph - 2.5) * 6) : 0;
      const pulse = ph > 2.6 && ph < 3.4 ? Math.sin(seg(ph, 2.6, 3.4) * Math.PI) * 0.18 : 0;
      a2.pose({ ...P2, look: shake + win(ph, 1.6, 2.0, 2.4, 2.6) * 0.25, lean: -flinch * 0.12,
        squash: (1 - flinch * 0.08) * Beat.breathe(ph, 2), nod: sulk * 0.15,
        blink: Beat.blink(ph, 2), bubble: eOutBack(seg(ph, 0.6, 1.05), 2) + pulse, bubbleWob: Math.sin(ph * 1.5 + 2) * 0.05 + shake * 0.2 });
      /* the ZEC: held → out on an arc → stopped short → back on an arc */
      const hp = holdPos({ x: x1, z: P1.z, ry: P1.ry, hop: 0 });
      if (ph < 1.9) { zec.g.position.copy(hp).add(V(thrust * 0.1, 0, thrust * 0.1)); zec.spin.rotation.set(0, Math.sin(ph) * 0.2, 0); zec.g.scale.setScalar(1); }
      else if (ph < 2.55) flyOn(zec, outC, eOutCubic(seg(ph, 1.9, 2.55)));
      else if (ph < 3.2) { /* stopped in mid-air in front of a02: refusal hold, jitter */
        const a = ph - 2.55; zec.g.position.copy(meet).add(V(Math.sin(a * 40) * 0.04 * Math.exp(-a * 5), 0, 0));
        const sq = 1 - 0.28 * Math.exp(-a * 9) * Math.cos(a * 24); zec.g.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq)); }
      else if (ph < 3.95) flyOn(zec, backC, eInOut(seg(ph, 3.2, 3.95)));
      else flyOn(zec, backC, 1, ph - 3.95);
      /* the cross: pops on contact, holds through the refusal */
      const cx = ph < 2.55 ? 0 : eOutBack(seg(ph, 2.55, 2.85), 2.5) * (1 - seg(ph, 5.4, 5.7));
      cross.scale.setScalar(Math.max(0.0001, cx)); cross.position.set(0.75, 1.75, 0.6);
      cross.rotation.z = (1 - seg(ph, 2.55, 2.85)) * 0.6;
    } };
  },
});
