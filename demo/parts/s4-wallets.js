/* Scene 4: ANY WALLET. Three sets, hard cuts between them.
   A (x 0)  : ring f5d3e16f as settled on testnet: a01 (NEAR, nep413) gives USDC,
              0x810d…f371 (Ethereum wallet, erc191) gives USDT, 045329…66c2
              (Solana-style key, raw_ed25519) gives ZEC. One settle, then the
              real /v2 card for that ring rises on a monitor.
   B (x 20) : the mandate vault. A 0.15 USDC leg is signed through Chain
              Signatures; a 0.16 USDC leg is refused with the contract's real
              error text (tx Ht9SdVao…). The refusal is held.
   C (x 40) : the ERC-7683 order from 0xecb3…0452 is stamped "verified on
              chain", and the real /v2 card of the ring that filled it rises. */
"use strict";
const RINGW = [
  { name: "a01", gives: "USDC", gets: "USDT", tag: [{ t: "NEAR account", size: 0.2 }, { t: "nep413", size: 0.17, color: MUTED, weight: 500 }] },
  { name: "0x810d…f371", gives: "USDT", gets: "ZEC", hat: 0x1b2130, tag: [{ t: "Ethereum wallet", size: 0.2 }, { t: "erc191", size: 0.17, color: MUTED, weight: 500 }] },
  { name: "045329…66c2", gives: "ZEC", gets: "USDC", stripe: 0xb39dff, tag: [{ t: "Solana-style key", size: 0.2 }, { t: "raw_ed25519", size: 0.17, color: MUTED, weight: 500 }] },
];
registerScene({
  key: "wallets", loop: 21,
  cap: { t: "Any wallet can sign a leg.",
         s: "NEAR accounts, Ethereum wallets and Solana-style keys settle in the same ring." },
  beats: [[0.4, "One ring on testnet, three wallet standards."], [2.4, "k4 closed it. All three legs settled in one call."],
          [4.2, "The live page re-checks that close on chain."], [7.4, "A mandate signs through NEAR Chain Signatures."],
          [10.5, "Over its daily budget: refused before any signature."], [14.0, "An ERC-7683 order from an Ethereum wallet."],
          [16.0, "The rings contract checks its EIP-712 signature on chain."]],
  kicks: [[2.45, 0.6], [3.1, 0.4], [8.6, 0.35], [10.45, 0.55], [11.65, 0.3], [14.25, 0.4], [16.0, 0.45]],
  shots: [
    [0, 2.35, { p: [0, 3.7, 10.4], l: [0, 1.0, 0], fov: 42 }, { p: [0, 3.5, 9.8], l: [0, 1.0, 0], fov: 42 }],
    [2.35, 4.0, { p: [0, 7.4, 8.6], l: [0, 0.4, 0.3], fov: 46 }, { p: [0, 7.0, 8.2], l: [0, 0.4, 0.3], fov: 46 }],
    [4.0, 7.2, { p: [0, 3.0, -5.0], l: [0, 3.0, -12], fov: 40 }, { p: [0, 3.0, -5.35], l: [0, 3.0, -12], fov: 40 }, t => t],
    [7.2, 9.7, { p: [18.2, 2.6, 7.8], l: [19.5, 1.35, 0], fov: 36 }, { p: [18.4, 2.55, 7.4], l: [19.5, 1.35, 0], fov: 36 }],
    [9.7, 11.3, { p: [19.3, 2.3, 6.8], l: [19.4, 1.35, 0], fov: 34 }, { p: [19.3, 2.25, 6.5], l: [19.4, 1.35, 0], fov: 34 }],
    [11.3, 13.7, { p: [20.0, 3.0, 10.2], l: [20.0, 1.9, 0], fov: 40 }, { p: [20.0, 2.95, 9.7], l: [20.0, 1.9, 0], fov: 40 }, t => t],
    [13.7, 16.9, { p: [39.2, 2.0, 6.6], l: [39.2, 1.45, 0], fov: 34 }, { p: [39.2, 2.0, 6.2], l: [39.2, 1.45, 0], fov: 34 }],
    [16.9, 18.6, { p: [40.9, 2.5, 9.6], l: [40.9, 1.7, -0.4], fov: 40 }, { p: [40.9, 2.45, 9.2], l: [40.9, 1.7, -0.4], fov: 40 }],
    [18.6, 21, { p: [42.32, 2.05, 4.35], l: [42.9, 2.05, -0.6], fov: 40 }, { p: [42.36, 2.05, 4.05], l: [42.9, 2.05, -0.6], fov: 40 }, t => t],
  ],
  build(g) {
    /* ── A: the three-wallet ring ── */
    const R = makeRingCast(g, RINGW.map(d => ({ ...d, tag: undefined })));
    const tags = RINGW.map((d, i) => { const t = label(g, d.tag, { w: 2.0, h: 0.62, res: 240, gap: 0.2 }); subject(t, "tag " + d.name); return t; });
    const T_FLY = 2.45, T_LAND = 3.1;
    const bursts = RINGW.map((d, i) => makeBurst(g, TOK[d.gives], 12, { seed: i * 5 }));
    const mon = makeMonitor(g, "./assets/screens/v2-ring-f5d3e16fca.png", 6.4, { aspect: 2304 / 1124, standH: 1.4, name: "monitor A" });
    /* ── B: the mandate vault ── */
    const B = new THREE.Group(); B.position.x = 20; g.add(B); gridFloor(B, 40);
    const vault = new THREE.Group(); B.add(vault); subject(vault, "vault");
    obox(vault, 2.3, 1.9, 1.3, 0x3b4559, 0, 0.95, 0);
    obox(vault, 2.0, 1.6, 0.06, 0x2f3747, 0, 0.95, 0.66, { olT: 0.03 });
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.1, 28), mat(0x1b2130)); hull(dial, 1.15);
    dial.rotation.x = Math.PI / 2; dial.position.set(0.62, 1.0, 0.72); vault.add(dial);
    obox(dial, 0.06, 0.12, 0.3, WHITE, 0, 0.06, 0.18, { olT: 0.015 });
    obox(vault, 0.9, 0.08, 0.1, 0x05070a, -0.15, 1.45, 0.7, { olT: 0.02 });            /* the slot */
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), matU(0x55627a)); hull(lamp, 1.2);
    lamp.position.set(0, 2.07, 0); vault.add(lamp);
    const lampGlow = glowSprite(ACCENT, 1.4, 0); lampGlow.position.set(0, 2.07, 0.1); vault.add(lampGlow);
    const vname = label(vault, [{ t: "mandate.nomadswarm.testnet", size: 0.125, weight: 600 }, { t: "signs for 0x9915…bf9b", size: 0.1, weight: 500, color: 0xc4cedf }],
      { w: 1.9, h: 0.42, res: 300, gap: 0.25 });
    vname.position.set(0, 0.4, 0.7);
    const card1 = makeCard(B, [{ t: "Leg for 0x9915…bf9b", size: 0.1, weight: 700 }, "give 0.15 USDC", "get 0.149999 USDT"],
      { w: 1.45, h: 0.86, size: 0.095, markText: "signed by MPC", markColor: ACCENT, markY: -0.3, markW: 1.0 });
    const card2 = makeCard(B, [{ t: "Leg for 0x9915…bf9b", size: 0.1, weight: 700 }, "give 0.16 USDC"],
      { w: 1.45, h: 0.86, size: 0.095, markText: "refused", markColor: RED, markY: -0.3 });
    [card1, card2].forEach((c, i) => subject(c.g, "mandate card " + (i + 1)));
    const err = new THREE.Group(); B.add(err); subject(err, "error plate");
    obox(err, 5.0, 0.62, 0.1, 0x170b0d, 0, 0, 0, { olT: 0.04 });
    obox(err, 5.06, 0.05, 0.12, RED, 0, -0.33, 0, { ol: false });
    const etxt = label(err, [{ t: "over daily budget: spent 400200 + 160000 > 550100", size: 0.17, weight: 600, color: 0xffb4b6 }], { w: 4.9, h: 0.5, res: 300 });
    etxt.position.z = 0.06;
    /* ── C: the ERC-7683 order ── */
    const C = new THREE.Group(); C.position.x = 40; g.add(C); gridFloor(C, 40);
    const order = makeCard(C, [{ t: "ERC-7683 order", size: 0.17, weight: 700 }, { t: "from 0xecb3…0452", size: 0.13, weight: 500 },
      { t: "give up to 1 USDC", size: 0.14 }, { t: "min want 0.285 wNEAR", size: 0.14 }],
      { w: 2.3, h: 1.7, size: 0.14, markText: "verified on chain", markColor: ACCENT, markY: -0.6, markW: 1.3 });
    subject(order.g, "order card");
    const ostamp = makeStamp(C, ACCENT); ostamp.g.rotation.x = Math.PI / 2;
    const monC = makeMonitor(C, "./assets/screens/v2-ring-a44df021aa.png", 3.9, { aspect: 2304 / 1248, standH: 0.9, name: "monitor C" });
    const tokC = makeToken(C, "USDC", 0.42);

    return { update(ph) {
      /* A */
      R.agents.forEach((a, i) => {
        const P = R.P[i], h = Beat.hop(ph, 0.25 + i * 0.12, 0.2), c = Beat.hop(ph, T_LAND + 0.08 + i * 0.05, 0.18);
        const lookUp = win(ph, 4.3, 4.8, 6.4, 6.9);
        a.pose({ ...P, hop: h.hop + c.hop, squash: h.squash * c.squash * Beat.breathe(ph, i), blink: Beat.blink(ph, i + 11),
          look: lookUp * (P.x < 0 ? 0.6 : P.x > 0 ? -0.6 : 0), nod: -lookUp * 0.25 });
        const k = (i + 0) % 3;
        R.arcs[i].set(eInOut(seg(ph, 0.5 + k * 0.25, 1.3 + k * 0.25)));
        const tk = R.tokens[i];
        if (ph < T_FLY) { tk.g.position.copy(holdPos(P)); tk.spin.rotation.set(0, 0, 0); tk.g.scale.setScalar(1); }
        else if (ph < T_LAND) flyOn(tk, R.arcs[i].curve, eInOut(seg(ph, T_FLY, T_LAND)));
        else { tk.g.position.copy(holdPos({ ...R.P[R.to[i]], hop: Beat.hop(ph, T_LAND + 0.08 + R.to[i] * 0.05, 0.18).hop }));
          flyOn(tk, R.arcs[i].curve, 1, ph - T_LAND); tk.g.position.copy(holdPos({ ...R.P[R.to[i]], hop: Beat.hop(ph, T_LAND + 0.08 + R.to[i] * 0.05, 0.18).hop })); }
        bursts[i].g.position.copy(holdPos(R.P[R.to[i]])); bursts[i].update(ph - T_LAND);
        tags[i].position.set(P.x, 2.0 + h.hop + c.hop, P.z); tags[i].rotation.y = -P.x * 0.04;
        const tv = eOutBack(seg(ph, 0.3 + i * 0.15, 0.7 + i * 0.15), 2);
        tags[i].scale.setScalar(Math.max(0.0001, tv));
      });
      /* the monitor rises behind the ring: anticipation dip, rise, settle */
      const mr = seg(ph, 4.0, 4.75);
      mon.g.position.set(0, 3.0, -12); mon.g.visible = ph > 3.95;
      mon.g.scale.setScalar(Math.max(0.0001, eOutBack(seg(ph, 4.1, 4.6), 0.5)));
      /* B */
      const in1 = eOutCubic(seg(ph, 7.4, 8.2)), up1 = eOutBack(seg(ph, 8.6, 9.2), 1.6);
      card1.g.visible = ph > 7.3;
      card1.g.position.set(lerp(-2.6, -0.15, in1), 1.45 + up1 * 0.85 + (ph > 8.2 && ph < 8.6 ? -0.05 : 0), 0.95 - up1 * 0.0);
      card1.g.rotation.y = (1 - in1) * 0.3; card1.g.rotation.z = (1 - in1) * -0.08;
      card1.setMark(ph > 8.6 ? eOutBack(seg(ph, 8.65, 8.9), 2.5) : 0);
      const gone1 = eInBack(seg(ph, 9.35, 9.65));
      card1.g.position.x += gone1 * -3.2; card1.g.visible = ph > 7.3 && gone1 < 0.999;
      const in2 = eOutCubic(seg(ph, 9.75, 10.4));
      const ej = ph > 10.45 ? eOutBack(seg(ph, 10.45, 11.0), 1.4) : 0;
      card2.g.visible = ph > 9.65;
      card2.g.position.set(lerp(-2.6, -0.15, in2) - ej * 1.9, 1.45 + Math.sin(ej * Math.PI) * 0.35, 0.95 + ej * 0.15);
      card2.g.rotation.z = ej * 0.12 * Math.exp(-(ph - 10.45) * 2);
      card2.setMark(ph > 10.5 ? eOutBack(seg(ph, 10.5, 10.75), 2.5) : 0);
      const ok = win(ph, 8.3, 8.4, 9.3, 9.6), no = ph > 10.4 ? 1 : 0;
      lamp.material.color.setHex(no ? RED : ok > 0.5 ? ACCENT : 0x55627a);
      lampGlow.material.color.setHex(no ? RED : ACCENT);
      lampGlow.material.opacity = no ? 0.55 + 0.25 * Math.max(0, Math.sin((ph - 10.4) * 6)) : ok * 0.7;
      const shake = ph > 10.4 && ph < 11.0 ? Math.sin((ph - 10.4) * 50) * 0.04 * (1 - (ph - 10.4) / 0.6) : 0;
      vault.position.x = shake;
      dial.rotation.z = ph > 7.6 && ph < 8.3 ? (ph - 7.6) * 6 : ph >= 8.3 ? 4.2 : 0;
      const ed = seg(ph, 11.35, 11.65);
      err.visible = ph > 11.3;
      err.position.set(0, lerp(3.5, 3.0, eInCubic(ed)) + (ph > 11.65 ? Math.exp(-(ph - 11.65) * 6) * Math.sin((ph - 11.65) * 20) * 0.08 : 0), 0.2);
      /* C */
      const od = seg(ph, 13.9, 14.25);
      order.g.visible = ph > 13.85 && ph < 18.6;
      order.g.scale.setScalar(Math.max(0.0001, eOutBack(od, 1.2)));
      order.g.position.set(-0.6, 1.55 + (ph > 14.25 ? Math.exp(-(ph - 14.25) * 7) * Math.sin((ph - 14.25) * 22) * 0.08 : 0), 0);
      order.g.rotation.z = (1 - od) * -0.08;
      const landed = ostamp.at(ph, 16.0, 0.55);
      ostamp.g.position.set(-0.6 + order.mark.position.x, order.g.position.y + order.mark.position.y, 0.08);
      const sv = win(ph, 15.0, 15.2, 16.75, 17.0); ostamp.g.scale.setScalar(Math.max(0.0001, sv)); ostamp.g.visible = sv > 0.001;
      order.setMark(landed ? eOutBack(seg(ph, 16.0, 16.25), 2.5) : 0);
      const mc = seg(ph, 17.0, 17.7);
      monC.g.visible = ph > 16.95;
      monC.g.position.set(2.9, 2.0, -0.6); monC.g.rotation.y = -0.12;
      monC.g.scale.setScalar(Math.max(0.0001, eOutBack(mc, 1.3)));
      tokC.g.visible = false;
    } };
  },
});
