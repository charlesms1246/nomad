/* Scene 5: PROOF. A receipt prints three real testnet transaction hashes.
   Then a board of figures read LIVE from testnet RPC when the deck loads
   (rings proposed / settled from rings.nomadswarm.testnet config(), access
   keys on the rings and mandate contracts, the Verifier's code hash against
   mainnet intents.near). A row whose read fails is left out, never guessed.
   Ends on the cast and the address of the live page. */
"use strict";
const PROOF = { rings: null, settled: null, keysRings: null, keysMandate: null, hashT: null, hashM: null };
(function readChain() {
  const rpc = (net, params) => fetch(`https://rpc.${net}.fastnear.com`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: Object.assign({ finality: "final" }, params) }) })
    .then(r => r.json()).then(d => d.result);
  const view = (acct, method) => rpc("testnet", { request_type: "call_function", account_id: acct, method_name: method, args_base64: "e30=" })
    .then(r => JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))));
  const timeout = p => Promise.race([p, new Promise(r => setTimeout(r, 6000))]);
  PRELOAD.push(timeout(Promise.allSettled([
    view("rings.nomadswarm.testnet", "config").then(c => { PROOF.rings = c.rings; PROOF.settled = c.settled; }),
    rpc("testnet", { request_type: "view_access_key_list", account_id: "rings.nomadswarm.testnet" }).then(r => { PROOF.keysRings = r.keys.length; }),
    rpc("testnet", { request_type: "view_access_key_list", account_id: "mandate.nomadswarm.testnet" }).then(r => { PROOF.keysMandate = r.keys.length; }),
    rpc("testnet", { request_type: "view_account", account_id: "intents.nomadswarm.testnet" }).then(r => { PROOF.hashT = r.code_hash; }),
    rpc("mainnet", { request_type: "view_account", account_id: "intents.near" }).then(r => { PROOF.hashM = r.code_hash; }),
  ])));
})();

const HASHES = [
  { what: "Ring closed by k4, three wallet standards", h: "GALT4S7BiENHVroypTv1uQmanBAmhm9uSXbyHpShD7hR" },
  { what: "Ring with a Chain Signatures mandate leg", h: "2WgJbhRWZJhy38nCxSLeb2FPXCN4SaX9TmvhakBcPrr9" },
  { what: "Ring that filled an ERC-7683 order", h: "D6YZJqgrEVXXNVLahodBycyBBqNV1RnwnY6ptAyCRhCK" },
];
registerScene({
  key: "proof", loop: 18,
  cap: { t: "Every ring here is on testnet.",
         s: "Each hash is a real transaction. Open any of them, or let the live page re-check them." },
  beats: [[0.5, "Three closes, three real transaction hashes."], [8.6, "Read from testnet when this video was rendered."],
          [13.4, "Verify every ring at nomad.charlesms.dev/v2"]],
  kicks: [[9.0, 0.3], [9.5, 0.25], [10.0, 0.25], [10.5, 0.25], [11.0, 0.25], [13.6, 0.35]],
  shots: [
    [0, 8.4, { p: [-5.4, 2.1, 10.4], l: [-5.4, 1.95, 0], fov: 34 }, { p: [-5.4, 2.1, 10.0], l: [-5.4, 1.95, 0], fov: 34 }, t => t],
    [8.4, 13.2, { p: [3.0, 2.3, 7.4], l: [3.0, 2.25, -1.2], fov: 40 }, { p: [3.0, 2.3, 7.0], l: [3.0, 2.25, -1.2], fov: 40 }, t => t],
    [13.2, 18, { p: [3.0, 3.3, 13.4], l: [3.0, 2.2, -0.4], fov: 40 }, { p: [3.0, 3.25, 12.9], l: [3.0, 2.2, -0.4], fov: 40 }, t => t],
  ],
  build(g) {
    /* ── the printer and its paper ── */
    const PR = new THREE.Group(); PR.position.set(-4.6, 0, 0); g.add(PR);
    const pbox = new THREE.Group(); PR.add(pbox); subject(pbox, "printer");
    obox(pbox, 4.1, 1.0, 1.3, 0x3b4559, 0, 0.5, 0);
    obox(pbox, 3.8, 0.06, 0.18, 0x05070a, 0, 1.0, 0.1, { olT: 0.02 });
    const led = obox(pbox, 0.12, 0.12, 0.05, ACCENT, 1.7, 0.6, 0.66, { olT: 0.02, own: true });
    const PW = 3.6, PH = 4.2;
    const pcv = document.createElement("canvas"); pcv.width = PW * 260; pcv.height = PH * 260;
    const px = pcv.getContext("2d"); const ptex = new THREE.CanvasTexture(pcv); ptex.colorSpace = THREE.SRGBColorSpace; ptex.anisotropy = 8;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshBasicMaterial({ map: ptex, toneMapped: false, fog: false, side: THREE.DoubleSide,
      clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.0)] }));   /* nothing below the printer's slot */
    const feed = new THREE.Group(); PR.add(feed); feed.add(sheet); sheet.userData.noqa = true;
    sheet.position.z = 0.1;
    /* invisible strip on the paper's top edge so the framing QA can see where the paper ends */
    const topEdge = new THREE.Mesh(new THREE.BoxGeometry(PW, 0.12, 0.01), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    topEdge.position.set(0, PH / 2 - 0.06, 0.1); feed.add(topEdge); subject(topEdge, "receipt top");
    let lastKey = "";
    function drawPaper(ph) {
      /* typed state: which lines are visible and how many hash characters */
      const st = [];
      st.push(ph > 0.4 ? 1 : 0);
      HASHES.forEach((x, i) => { const t0 = 1.0 + i * 2.2; st.push(ph > t0 ? 1 : 0); st.push(Math.floor(clamp01((ph - t0 - 0.35) / 1.3) * 44)); });
      const key = st.join(","); if (key === lastKey) return; lastKey = key;
      const R = 260, W = pcv.width;
      px.fillStyle = "#f4f1ea"; px.fillRect(0, 0, W, pcv.height);
      /* serrated top edge */
      px.fillStyle = "#07090d"; for (let x = 0; x < W; x += 26) { px.beginPath(); px.moveTo(x, 0); px.lineTo(x + 13, 12); px.lineTo(x + 26, 0); px.fill(); }
      px.textBaseline = "top"; px.fillStyle = "#0b0d12";
      let y = 0.32 * R;
      const fit = (txt, weight, size) => { let f = size; px.font = `${weight} ${f}px 'Space Grotesk'`;
        while (px.measureText(txt).width > W - 0.34 * R && f > 8) { f -= 1; px.font = `${weight} ${f}px 'Space Grotesk'`; } };
      if (st[0]) { fit("NEAR testnet · rings.nomadswarm.testnet", 700, 0.19 * R); px.fillText("NEAR testnet · rings.nomadswarm.testnet", 0.16 * R, y); }
      y += 0.4 * R;
      px.fillStyle = "#c9c4b8"; px.fillRect(0.16 * R, y, W - 0.32 * R, 3); y += 0.22 * R;
      HASHES.forEach((x, i) => {
        if (st[1 + i * 2]) { px.fillStyle = "#4a4f5c"; px.font = `600 ${0.13 * R}px 'Space Grotesk'`; px.fillText(x.what, 0.16 * R, y); }
        y += 0.27 * R;
        const n = st[2 + i * 2];
        if (n > 0) { px.fillStyle = "#0b0d12"; fit(x.h, 700, 0.16 * R); px.fillText(x.h.slice(0, n), 0.16 * R, y); }
        y += 0.5 * R;
      });
      ptex.needsUpdate = true;
    }
    /* ── the board of live figures ── */
    const BD = new THREE.Group(); BD.position.set(3.0, 0, -1.2); g.add(BD); subject(BD, "board");
    obox(BD, 6.9, 3.7, 0.16, 0x0d1118, 0, 2.25, 0, { olT: 0.06 });
    obox(BD, 7.0, 0.07, 0.18, ACCENT, 0, 0.36, 0, { ol: false });
    obox(BD, 0.24, 0.42, 0.2, 0x262d3b, -2.4, 0.2, 0); obox(BD, 0.24, 0.42, 0.2, 0x262d3b, 2.4, 0.2, 0);
    const btitle = label(BD, [{ t: "Read from NEAR testnet", size: 0.26, weight: 700 }], { w: 6.4, h: 0.5, res: 200, align: "left", pad: 0.1 });
    btitle.position.set(0, 3.72, 0.1);
    const rows = [];
    const addRow = (big, text) => rows.push({ big, text });
    if (PROOF.rings != null) addRow(String(PROOF.rings), "rings proposed on rings.nomadswarm.testnet");
    if (PROOF.settled != null) addRow(String(PROOF.settled), "rings settled, each closed by a stranger");
    addRow("3", "wallet standards settled in one ring");
    if (PROOF.keysRings != null && PROOF.keysMandate != null) addRow(String(PROOF.keysRings + PROOF.keysMandate), "access keys on the rings and mandate contracts");
    if (PROOF.hashT && PROOF.hashM) { if (PROOF.hashT === PROOF.hashM) addRow("=", "Verifier code hash equal to mainnet intents.near"); }
    const rowMeshes = rows.map((r, i) => {
      const m = label(BD, [{ t: r.big, size: 0.36, weight: 700, color: ACCENT }], { w: 0.9, h: 0.5, res: 200, align: "right", pad: 0.05 });
      const t = label(BD, [{ t: r.text, size: 0.2, weight: 500 }], { w: 5.3, h: 0.5, res: 200, align: "left", pad: 0.05 });
      const y = 3.2 - i * 0.56;
      m.position.set(-2.75, y, 0.1); t.position.set(0.4, y, 0.1);
      return { m, t, at: 9.0 + i * 0.5 };
    });
    /* ── the cast, for the last shot ── */
    const cast = [
      makeAgent(g, { name: "a01", body: TOK.ZEC, tip: WHITE }),
      makeAgent(g, { name: "a02", body: TOK.USDC, tip: WHITE }),
      makeAgent(g, { name: "a03", body: TOK.wNEAR, tip: WHITE }),
      makeAgent(g, { name: "k4", body: 0x2b3140, visor: 0x05070a, eye: ACCENT, tip: ACCENT, stripe: ACCENT, hat: 0x0d1016 }),
    ];
    const url = new THREE.Group(); g.add(url); subject(url, "url plate");
    obox(url, 5.6, 0.7, 0.12, 0x0d1118, 0, 0, 0, { olT: 0.05 });
    obox(url, 5.66, 0.05, 0.14, ACCENT, 0, -0.37, 0, { ol: false });
    const ut = label(url, [{ t: "nomad.charlesms.dev/v2", size: 0.3, weight: 700 }], { w: 5.4, h: 0.6, res: 220 }); ut.position.z = 0.07;

    return { update(ph) {
      drawPaper(ph);
      /* the paper feeds up one line at a time: a quick mechanical step per line */
      let fed = 0;
      fed += 0.85 * eOutCubic(seg(ph, 0.3, 0.6));
      HASHES.forEach((x, i) => { const t0 = 1.0 + i * 2.2; fed += 0.4 * eOutCubic(seg(ph, t0 - 0.05, t0 + 0.25)) + 0.38 * eOutCubic(seg(ph, t0 + 0.3, t0 + 0.6)); });
      fed += 0.3 * eOutCubic(seg(ph, 7.6, 7.9));
      feed.position.set(0, 1.0 - PH / 2 + fed, 0.1);
      sheet.rotation.x = -0.04 * Math.sin(Math.min(1, fed / 4) * Math.PI);
      led.material.color.setHex(ph < 7.9 && Math.floor(ph * 6) % 2 === 0 ? ACCENT : 0x1b2130);
      PR.visible = ph < 13.2; BD.visible = ph >= 8.4;
      /* board rows land one after another: no number runs up to its value */
      rowMeshes.forEach(r => { const a = ph - r.at; const v = a < 0 ? 0 : eOutBack(seg(a, 0, 0.3), 2);
        r.m.scale.setScalar(Math.max(0.0001, v)); r.t.scale.setScalar(Math.max(0.0001, v)); r.m.visible = r.t.visible = a >= 0; });
      btitle.visible = ph > 8.5;
      /* the cast in a row in front of everything, last shot only */
      const xs = [-2.0, -0.6, 6.6, 8.0];
      cast.forEach((a, i) => { const vis = ph > 13.2; a.g.visible = vis;
        const d = Beat.dropIn(ph, 13.3 + i * 0.12, 1.2), h = Beat.hop(ph, 15.0 + i * 0.1, 0.22);
        a.pose({ x: xs[i], z: 1.2, ry: i < 2 ? 0.3 : -0.3, hop: d.hop + h.hop, squash: d.squash * h.squash * Beat.breathe(ph, i), blink: Beat.blink(ph, i + 20),
          look: Math.sin(ph * 0.7 + i) * 0.1, arms: i === 3 ? win(ph, 15.0, 15.2, 15.7, 16.0) * 0.8 : 0 }); });
      url.visible = ph > 13.5;
      url.scale.setScalar(Math.max(0.0001, eOutBack(seg(ph, 13.55, 13.9), 1.4)));
      url.position.set(3.0, 4.6, -1.0);
    } };
  },
});
