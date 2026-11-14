/* Scene 3: ONE TRANSACTION. The three signed legs stand ready. k4, a
   stranger, walks in and presses close_ring. In one frame every token moves
   along its arc (the peak, and the biggest kick in the deck). The agents'
   tips fly to k4. Then the plate lands: one execute_intents. */
"use strict";
registerScene({
  key: "close", loop: 13,
  cap: { t: "Anyone can close the ring.",
         s: "k4 calls close_ring on the rings contract, and the contract makes one execute_intents call." },
  beats: [[0.5, "k4 isn't one of the agents. Anyone may close a ring."], [4.1, "One execute_intents call settles every leg, or none of them."],
          [5.55, "Each agent's signed tip goes to k4 for closing it."], [7.3, "Every token moved in one transaction, on NEAR testnet."]],
  kicks: [[2.62, 0.2], [4.1, 0.95], [4.85, 0.55], [6.45, 0.25], [7.62, 0.45]],
  shots: [
    [0, 2.7, { p: [3.8, 3.0, 11.8], l: [3.4, 0.8, 0.6], fov: 40 }, { p: [3.6, 2.8, 11.1], l: [3.4, 0.8, 0.8], fov: 40 }],
    [2.7, 4.12, { p: [3.8, 2.2, 9.4], l: [3.6, 0.8, 2.4], fov: 32 }, { p: [3.8, 2.15, 9.0], l: [3.6, 0.8, 2.4], fov: 32 }],
    [4.12, 5.6, { p: [1.2, 7.0, 9.6], l: [1.2, 0.5, 1.4], fov: 46 }, { p: [1.1, 6.6, 9.1], l: [1.2, 0.5, 1.4], fov: 46 }],
    [5.6, 7.15, { p: [6.2, 3.0, 9.0], l: [2.2, 0.45, 1.6], fov: 40 }, { p: [5.9, 2.9, 8.6], l: [2.2, 0.45, 1.6], fov: 40 }],
    [7.15, 13, { p: [1.9, 3.7, 10.8], l: [1.4, 1.6, 0.6], fov: 46 }, { p: [1.3, 3.6, 10.1], l: [1.3, 1.6, 0.6], fov: 45 }, t => t],
  ],
  build(g) {
    const R = makeRingCast(g, RING3);
    /* the legs were signed in the last scene: a small badge each */
    const cards = RING3.map(() => label(g, [{ t: "signed", size: 0.15, weight: 700, color: ACCENT }],
      { w: 0.8, h: 0.28, res: 300, bg: 0x0d1118, border: ACCENT, borderW: 0.02, radius: 0.05 }));
    cards.forEach((c, i) => subject(c, "badge " + RING3[i].name));
    /* the stranger: a black bot with blue eyes and a cap */
    const k4 = makeAgent(g, { name: "k4", body: 0x2b3140, visor: 0x05070a, eye: ACCENT, tip: ACCENT, stripe: ACCENT, hat: 0x0d1016 });
    /* the close_ring pedestal */
    const PX = 4.6, PZ = 3.5;
    const ped = new THREE.Group(); ped.position.set(PX, 0, PZ); g.add(ped); subject(ped, "podium");
    obox(ped, 0.6, 0.56, 0.6, 0x3b4559, 0, 0.28, 0);
    obox(ped, 0.72, 0.08, 0.72, 0x262d3b, 0, 0.6, 0);
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.12, 24), matU(ACCENT)); hull(btn, 1.18);
    btn.position.set(0.1, 0.7, 0); ped.add(btn);
    const pl = label(ped, [{ t: "close_ring", weight: 700, size: 0.11 }], { w: 0.9, h: 0.22, res: 400, bg: 0x0d1118, radius: 0.03 });
    pl.position.set(0, 0.3, 0.306); pl.scale.setScalar(0.62);
    const pedGlow = glowSprite(ACCENT, 1.6, 0); pedGlow.position.set(0.1, 0.8, 0); ped.add(pedGlow);
    /* the payoff: one accent flash over the ring */
    const flash = glowSprite(ACCENT, 9, 0); flash.position.set(0, 0.8, 0.2); g.add(flash);
    const bursts = RING3.map((d, i) => makeBurst(g, TOK[d.gives], 14, { seed: i * 9 }));
    /* tips: one small cube of each giver's token, flying to k4 */
    const tips = RING3.map(d => { const t = makeToken(g, d.gives, 0.16); t.g.children[0].children.slice(1).forEach(c => c.visible = false); return t; });
    /* the plate */
    const plate = new THREE.Group(); g.add(plate); subject(plate, "plate");
    obox(plate, 4.3, 1.2, 0.14, 0x0d1118, 0, 0, 0, { olT: 0.05 });
    obox(plate, 4.38, 0.06, 0.16, ACCENT, 0, -0.62, 0, { ol: false });
    const ptxt = label(plate, [{ t: "Settled in one", size: 0.3, weight: 600 }, { t: "execute_intents call", size: 0.3, weight: 600 }],
      { w: 4.1, h: 1.1, res: 220, gap: 0.22 });
    ptxt.position.z = 0.08;

    const K4A = { x: 7.4, z: -2.6 }, K4B = { x: 4.6, z: 2.72 };
    const T_PRESS = 4.1, T_FLY = 4.15, T_LAND = 4.85, T_TIP0 = 5.6, T_TIP1 = 6.4;
    const k4Hold = () => holdPos({ x: K4B.x, z: K4B.z, ry: -Math.PI / 2, hop: 0 });
    const tipCurves = R.P.map((P, i) => { const a = holdPos(P), b = V(PX - 0.24 + i * 0.19, 0.72, PZ + 0.25);
      const m = a.clone().add(b).multiplyScalar(0.5); m.y += 2.2; return new THREE.QuadraticBezierCurve3(a, m, b); });

    return { update(ph) {
      /* ── the ring agents ── */
      R.agents.forEach((a, i) => {
        const P = R.P[i], j = R.to.indexOf(i);       /* j gives to i */
        const catchHop = Beat.hop(ph, T_LAND + 0.1 + i * 0.05, 0.2);
        const startle = ph > T_PRESS ? Math.exp(-(ph - T_PRESS) * 7) : 0;
        const watchK4 = win(ph, 0.6, 1.2, 3.6, 4.0);
        const tipToss = win(ph, T_TIP0 - 0.3, T_TIP0, T_TIP0 + 0.1, T_TIP0 + 0.4);
        a.pose({ ...P, hop: catchHop.hop, squash: catchHop.squash * (1 - startle * 0.12) * Beat.breathe(ph, i),
          look: watchK4 * (P.x < 2 ? -0.5 : 0.3) + Math.sin(ph * 0.8 + i) * 0.05, nod: -startle * 0.15,
          arms: tipToss * 0.5, blink: Beat.blink(ph, i + 3) });
        R.arcs[i].set(1);
        /* token i: giver's hands → arc → receiver's hands, all on the same frames */
        const tk = R.tokens[i];
        if (ph < T_FLY) { tk.g.position.copy(holdPos(P)); tk.spin.rotation.set(0, Math.sin(ph * 0.9 + i) * 0.1, 0); tk.g.scale.setScalar(1); }
        else if (ph < T_LAND) flyOn(tk, R.arcs[i].curve, eInOut(seg(ph, T_FLY, T_LAND)));
        else { const Pr = R.P[R.to[i]]; const rh = Beat.hop(ph, T_LAND + 0.1 + R.to[i] * 0.05, 0.2);
          tk.g.position.copy(holdPos({ ...Pr, hop: rh.hop })); tk.spin.rotation.set(0, 0, 0);
          const la = ph - T_LAND, sq = la < 0.5 ? 1 - 0.3 * Math.exp(-la * 10) * Math.cos(la * 26) : 1;
          tk.g.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq)); }
        bursts[i].g.position.copy(holdPos(R.P[R.to[i]])); bursts[i].update(ph - T_LAND);
        /* signed cards above, cleared once settled */
        const c = cards[i], gone = eInBack(seg(ph, T_LAND + 0.3, T_LAND + 0.7));
        c.position.set(P.x, 1.9 + gone * 0.3, P.z); c.rotation.y = -P.x * 0.05;
        c.scale.setScalar(Math.max(0.0001, 1 - gone)); c.visible = gone < 0.999;
        /* tips */
        const tp = tips[i];
        if (ph < T_TIP0) tp.g.visible = false;
        else { tp.g.visible = true; const u = eInOut(seg(ph, T_TIP0 + i * 0.08, T_TIP1 + i * 0.08));
          flyOn(tp, tipCurves[i], u, ph - (T_TIP1 + i * 0.08)); }
      });
      /* ── k4: walk in on a slight arc, look, wind up, press ── */
      const w = eInOut(seg(ph, 0.3, 2.6));
      const kx = lerp(K4A.x, K4B.x, w), kz = lerp(K4A.z, K4B.z, w) + Math.sin(w * Math.PI) * 0.35;
      const walking = ph > 0.3 && ph < 2.6;
      const arrive = ph > 2.6 ? 1 - 0.2 * Math.exp(-(ph - 2.6) * 9) * Math.cos((ph - 2.6) * 22) : 1;
      const crouch = win(ph, 3.2, 3.85, 3.95, 4.1);
      const raise = win(ph, 3.2, 3.8, 3.92, 4.05);
      const press = win(ph, 3.95, 4.08, 4.4, 4.8);
      const proud = Beat.hop(ph, 6.55, 0.3);
      const turn = lerp(Math.atan2(K4B.x - K4A.x, K4B.z - K4A.z), -0.15, eInOut(seg(ph, 2.2, 2.9)));
      k4.pose({ x: kx, z: kz, ry: turn, step: walking ? ph * 10 : null,
        hop: (walking ? Math.abs(Math.sin(ph * 10)) * 0.07 : 0) + proud.hop,
        squash: arrive * (1 - crouch * 0.16) * proud.squash * Beat.breathe(ph, 7),
        arms: raise * 1.0 + press * 0.35, lean: 0, tilt: press * 0.22 - crouch * 0.05,
        look: win(ph, 2.7, 3.0, 3.3, 3.5) * -0.7 + (win(ph, 8.2, 8.5, 9.2, 9.5) + win(ph, 11.0, 11.3, 11.9, 12.2)) * -0.35,
        nod: win(ph, 2.7, 3.0, 3.3, 3.5) * 0.15 + (win(ph, 8.2, 8.5, 9.2, 9.5) + win(ph, 11.0, 11.3, 11.9, 12.2)) * 0.32,
        blink: Beat.blink(ph, 5) });
      /* the button goes down on the press frame */
      const down = ph >= T_PRESS ? Math.max(0, 1 - (ph - T_PRESS) / 0.5) : 0;
      btn.position.y = 0.7 - 0.06 * (ph >= T_PRESS && ph < T_PRESS + 0.5 ? 1 : 0) * (down > 0 ? 1 : 0);
      pedGlow.material.opacity = ph >= T_PRESS ? 0.9 * Math.exp(-(ph - T_PRESS) * 3) : 0;
      flash.material.opacity = ph >= T_FLY ? 0.75 * Math.exp(-(ph - T_FLY) * 1.6) + 0.1 * seg(ph, T_FLY, T_LAND) : 0;
      R.ring.material.opacity = 0.3 + (ph >= T_FLY ? 0.5 * Math.exp(-(ph - T_FLY) * 2) : 0);
      /* ── the plate drops in and lands ── */
      const pd = seg(ph, 7.25, 7.62);
      plate.visible = ph > 7.2;
      const settle = ph > 7.62 ? Math.exp(-(ph - 7.62) * 6) * Math.sin((ph - 7.62) * 20) * 0.12 : 0;
      plate.position.set(0.4, lerp(3.6, 3.25, eInCubic(pd)) + settle, -0.6);
      plate.rotation.z = (1 - pd) * 0.12 + settle * 0.3;
    } };
  },
});
