/* Заставка: камера спускается из облаков к фабрике, пролетает над швеями и вещами с сайта,
   вылетает к небу, и проявляется надпись GLUHOVA NATALYA. Нужен js/three.min.js (глобальный THREE). */
(function () {
  "use strict";
  const T = window.THREE;
  const box = document.getElementById("intro");
  if (!T || !box) return window.gnIntroDone && window.gnIntroDone();

  const mobile = Math.min(innerWidth, innerHeight) < 700;
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: !mobile, powerPreference: "high-performance" });
  } catch (e) { return window.gnIntroDone(); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  box.prepend(renderer.domElement);

  const scene = new T.Scene();
  const HORIZON = new T.Color("#dcebfb");
  scene.fog = new T.Fog(HORIZON, 160, 900);
  const camera = new T.PerspectiveCamera(mobile ? 62 : 50, innerWidth / innerHeight, 0.1, 3000);

  // ---------- Небо ----------
  const sky = new T.Mesh(
    new T.SphereGeometry(1500, 32, 16),
    new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new T.Color("#4f8fdc") }, mid: { value: new T.Color("#9cc7f2") }, bottom: { value: HORIZON }, sun: { value: new T.Vector3(0.45, 0.55, -0.7).normalize() } },
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sun; varying vec3 vP;" +
        "void main(){ float h = vP.y; vec3 c = h > 0.25 ? mix(mid, top, smoothstep(0.25,1.0,h)) : mix(bottom, mid, smoothstep(-0.05,0.25,h));" +
        "float s = max(dot(vP, sun), 0.0); c += vec3(1.0,0.93,0.78) * (pow(s, 600.0) * 1.5 + pow(s, 12.0) * 0.25); gl_FragColor = vec4(c,1.0); }",
    })
  );
  scene.add(sky);

  // ---------- Свет: солнечно ----------
  scene.add(new T.HemisphereLight("#cfe4ff", "#c9b48f", 0.9));
  const sun = new T.DirectionalLight("#fff3dc", 2.4);
  sun.position.set(90, 160, -120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 10, far: 500 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  const inner = new T.PointLight("#fff1dd", 0, 120, 1.5); // тёплый свет внутри цеха
  inner.position.set(0, 9, 0);
  scene.add(inner);

  // ---------- Текстуры ----------
  function canvasTex(w, h, draw) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }
  const puff = canvasTex(128, 128, (g, w) => {
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.45, "rgba(255,255,255,.75)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, w);
  });
  const grass = canvasTex(256, 256, (g, w) => {
    g.fillStyle = "#8fb46a"; g.fillRect(0, 0, w, w);
    for (let i = 0; i < 2500; i++) { g.fillStyle = `hsla(${85 + Math.random() * 25},40%,${38 + Math.random() * 18}%,.35)`; g.fillRect(Math.random() * w, Math.random() * w, 2, 2); }
  });
  grass.wrapS = grass.wrapT = T.RepeatWrapping; grass.repeat.set(60, 60);
  const wood = canvasTex(256, 256, (g, w) => {
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? "#d8c2a2" : "#d2b995"; g.fillRect(0, i * 32, w, 32); g.fillStyle = "rgba(90,60,30,.12)"; g.fillRect(0, i * 32, w, 1); }
  });
  wood.wrapS = wood.wrapT = T.RepeatWrapping; wood.repeat.set(8, 4);
  const brick = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#efe4d3"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(150,120,90,.18)";
    for (let y = 0; y < h; y += 16) for (let x = (y / 16) % 2 ? -16 : 0; x < w; x += 32) g.strokeRect(x + 0.5, y + 0.5, 32, 16);
  });
  brick.wrapS = brick.wrapT = T.RepeatWrapping; brick.repeat.set(10, 2);

  // ---------- Облака ----------
  const clouds = new T.Group();
  scene.add(clouds);
  const cloudMats = [
    new T.SpriteMaterial({ map: puff, color: "#ffffff", transparent: true, depthWrite: false, fog: false }),
    new T.SpriteMaterial({ map: puff, color: "#e3ebf5", transparent: true, depthWrite: false, fog: false }),
  ];
  function cloud(x, y, z, size) {
    const g = new T.Group();
    const n = 9 + Math.floor(Math.random() * 7);
    for (let i = 0; i < n; i++) {
      const lower = Math.random() < 0.35;
      const s = new T.Sprite(cloudMats[lower ? 1 : 0]);
      const k = size * (0.55 + Math.random() * 0.6);
      s.scale.set(k, k * 0.8, 1);
      s.position.set((Math.random() - 0.5) * size * 1.6, (lower ? -0.25 : 0.05) * size + Math.random() * size * 0.3, (Math.random() - 0.5) * size * 0.9);
      g.add(s);
    }
    g.position.set(x, y, z);
    clouds.add(g);
    return g;
  }
  for (let i = 0; i < (mobile ? 26 : 40); i++) {
    const a = Math.random() * Math.PI * 2, r = 60 + Math.random() * 380;
    cloud(Math.cos(a) * r, 95 + Math.random() * 70, Math.sin(a) * r, 26 + Math.random() * 30);
  }
  // облака, сквозь которые камера пролетает в начале
  [[-14, 175, 60, 34], [16, 160, 30, 30], [-6, 140, 10, 28], [10, 125, -10, 24]].forEach((c) => cloud(...c));

  // ---------- Земля, деревья ----------
  const ground = new T.Mesh(new T.PlaneGeometry(2400, 2400), new T.MeshLambertMaterial({ map: grass }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const path = new T.Mesh(new T.PlaneGeometry(14, 120), new T.MeshLambertMaterial({ color: "#e8dcc8" }));
  path.rotation.x = -Math.PI / 2; path.position.set(0, 0.03, 70); path.receiveShadow = true; scene.add(path);
  const treeMat = new T.MeshLambertMaterial({ color: "#5e8a4a" }), trunkMat = new T.MeshLambertMaterial({ color: "#7a5a3e" });
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 220;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 12 && z > 20) continue;
    const t = new T.Group();
    const h = 6 + Math.random() * 6;
    const trunk = new T.Mesh(new T.CylinderGeometry(0.35, 0.5, h * 0.4, 6), trunkMat); trunk.position.y = h * 0.2;
    const crown = new T.Mesh(new T.SphereGeometry(h * 0.38, 10, 8), treeMat); crown.position.y = h * 0.62; crown.scale.y = 1.15;
    crown.castShadow = trunk.castShadow = true;
    t.add(trunk, crown); t.position.set(x, 0, z); scene.add(t);
  }

  // ---------- Фабрика ----------
  const W = 64, D = 34, H = 11;
  const fab = new T.Group(); scene.add(fab);
  const wallMat = new T.MeshStandardMaterial({ map: brick, roughness: 0.9 });
  const trimMat = new T.MeshStandardMaterial({ color: "#c9b79c", roughness: 0.8 });
  const winMat = new T.MeshStandardMaterial({ color: "#a9c8e6", roughness: 0.15, metalness: 0.3, emissive: "#2b3d52", emissiveIntensity: 0.15 });
  function wall(w, h, x, z, ry) {
    const m = new T.Mesh(new T.BoxGeometry(w, h, 0.6), wallMat);
    m.position.set(x, h / 2, z); m.rotation.y = ry; m.castShadow = m.receiveShadow = true; fab.add(m);
    const n = Math.floor(w / 6);
    for (let i = 0; i < n; i++) {
      const win = new T.Mesh(new T.PlaneGeometry(3.2, 4.6), winMat);
      const off = -w / 2 + (i + 0.5) * (w / n);
      win.position.set(x + Math.cos(ry) * off + Math.sin(ry) * 0.31, 5.6, z - Math.sin(ry) * off + Math.cos(ry) * 0.31);
      win.rotation.y = ry; fab.add(win);
    }
  }
  wall(W, H, 0, D / 2, 0); wall(W, H, 0, -D / 2, Math.PI); wall(D, H, W / 2, 0, Math.PI / 2); wall(D, H, -W / 2, 0, -Math.PI / 2);
  // карниз — рамка по периметру (внутрь видно сверху)
  [[W + 1.6, 1.4, 0, D / 2], [W + 1.6, 1.4, 0, -D / 2], [1.4, D + 1.6, W / 2, 0], [1.4, D + 1.6, -W / 2, 0]].forEach(([w, d, x, z]) => {
    const c = new T.Mesh(new T.BoxGeometry(w, 0.8, d), trimMat); c.position.set(x, H, z); c.castShadow = true; fab.add(c);
  });
  // ворота и вывеска
  const door = new T.Mesh(new T.PlaneGeometry(7, 7.5), new T.MeshStandardMaterial({ color: "#3d3a36", roughness: 0.6 }));
  door.position.set(0, 3.75, D / 2 + 0.32); fab.add(door);
  const sign = new T.Mesh(new T.PlaneGeometry(22, 2.6), new T.MeshBasicMaterial({
    map: canvasTex(1024, 128, (g, w, h) => { g.fillStyle = "#f7f2ea"; g.fillRect(0, 0, w, h); g.fillStyle = "#1a1a1a"; g.font = "60px 'Cormorant Garamond', Georgia, serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("G L U H O V A   N A T A L Y A", w / 2, h / 2 + 4); }),
  }));
  sign.position.set(0, 9, D / 2 + 0.34); fab.add(sign);

  // крыша-«пила» со стеклянными фонарями: прозрачная, исчезает, когда камера внутри
  const roof = new T.Group(); fab.add(roof);
  const roofMat = new T.MeshStandardMaterial({ color: "#d9cdb9", roughness: 0.85, transparent: true });
  const glassMat = new T.MeshStandardMaterial({ color: "#cfe5f7", roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35 });
  const teeth = 6, tw = W / teeth;
  for (let i = 0; i < teeth; i++) {
    const x0 = -W / 2 + i * tw;
    const tooth = new T.Group(); tooth.position.set(x0 + tw / 2, H + 2, 0); tooth.rotation.z = Math.atan2(4, tw); roof.add(tooth);
    const slope = new T.Mesh(new T.PlaneGeometry(Math.hypot(tw, 4), D), roofMat);
    slope.rotation.x = -Math.PI / 2; slope.castShadow = true; tooth.add(slope);
    const glass = new T.Mesh(new T.PlaneGeometry(D, 4), glassMat);
    glass.position.set(x0 + tw, H + 2, 0); glass.rotation.y = -Math.PI / 2; roof.add(glass);
  }
  roofMat.side = glassMat.side = T.DoubleSide;
  // труба
  const chimney = new T.Mesh(new T.CylinderGeometry(1.2, 1.6, 12, 16), new T.MeshStandardMaterial({ color: "#b8876a", roughness: 0.9 }));
  chimney.position.set(-W / 2 + 6, H + 6, -D / 2 + 5); chimney.castShadow = true; fab.add(chimney);

  // пол цеха
  const floor = new T.Mesh(new T.PlaneGeometry(W - 1, D - 1), new T.MeshStandardMaterial({ map: wood, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.05; floor.receiveShadow = true; fab.add(floor);

  // ---------- Швеи, машинки, вещи с сайта ----------
  const imgs = (window.GN_INTRO_IMGS || []).slice(0, 24);
  const loader = new T.TextureLoader();
  const loads = [];
  const garmentMats = imgs.map((u) => {
    let ok; loads.push(new Promise((r) => (ok = r)));
    const t = loader.load(u, ok, undefined, ok); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
    return new T.MeshStandardMaterial({ map: t, roughness: 0.75 });
  });
  const garment = (i) => garmentMats.length ? garmentMats[i % garmentMats.length] : new T.MeshStandardMaterial({ color: "#efe8dd" });

  const tableMat = new T.MeshStandardMaterial({ color: "#f4efe7", roughness: 0.6 });
  const legMat = new T.MeshStandardMaterial({ color: "#8d7b66", roughness: 0.5, metalness: 0.4 });
  const machineMat = new T.MeshStandardMaterial({ color: "#fbfbf8", roughness: 0.35 });
  const machineDark = new T.MeshStandardMaterial({ color: "#2f2f2f", roughness: 0.4 });
  const skins = ["#f1d2bb", "#e6bfa3", "#d9a988", "#f3dccb"].map((c) => new T.MeshStandardMaterial({ color: c, roughness: 0.7 }));
  const aprons = ["#e9d7d1", "#d7e2ea", "#ede3cf", "#d9d4e8", "#cfe0d4", "#f0d9de"].map((c) => new T.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  const hairMat = new T.MeshStandardMaterial({ color: "#3a2a22", roughness: 0.8 });
  const chairMat = new T.MeshStandardMaterial({ color: "#6f6257", roughness: 0.7 });
  const arms = [];
  const sew = (k, x, z) => {
    const g = new T.Group(); g.position.set(x, 0, z); fab.add(g);
    const top = new T.Mesh(new T.BoxGeometry(3.4, 0.15, 1.8), tableMat); top.position.y = 1.5; top.castShadow = top.receiveShadow = true; g.add(top);
    [[-1.55, -0.75], [1.55, -0.75], [-1.55, 0.75], [1.55, 0.75]].forEach(([a, b]) => { const l = new T.Mesh(new T.BoxGeometry(0.08, 1.5, 0.08), legMat); l.position.set(a, 0.75, b); g.add(l); });
    // машинка
    const base = new T.Mesh(new T.BoxGeometry(1.3, 0.25, 0.55), machineMat); base.position.set(0.5, 1.7, -0.2); base.castShadow = true; g.add(base);
    const post = new T.Mesh(new T.BoxGeometry(0.28, 0.65, 0.42), machineMat); post.position.set(1.0, 2.05, -0.2); g.add(post);
    const arm = new T.Mesh(new T.BoxGeometry(1.1, 0.25, 0.38), machineMat); arm.position.set(0.5, 2.3, -0.2); arm.castShadow = true; g.add(arm);
    const head = new T.Mesh(new T.BoxGeometry(0.2, 0.42, 0.3), machineMat); head.position.set(0.02, 2.05, -0.2); g.add(head);
    const wheel = new T.Mesh(new T.CylinderGeometry(0.2, 0.2, 0.08, 16), machineDark); wheel.rotation.z = Math.PI / 2; wheel.position.set(1.18, 2.2, -0.2); g.add(wheel);
    // ткань-вещь на столе (фото с сайта лежит сверху)
    const cloth = new T.Mesh(new T.PlaneGeometry(1.3, 1.73), garment(k)); cloth.rotation.x = -Math.PI / 2; cloth.rotation.z = -Math.PI / 2 + (Math.random() - 0.5) * 0.3; cloth.position.set(-0.8, 1.585, 0.05); cloth.receiveShadow = true; g.add(cloth);
    // швея
    const p = new T.Group(); p.position.set(0.1, 0, 1.45); g.add(p);
    const chair = new T.Mesh(new T.BoxGeometry(0.9, 0.12, 0.8), chairMat); chair.position.y = 1.05; p.add(chair);
    const cl = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 1.05, 6), legMat); cl.position.y = 0.52; p.add(cl);
    const body = new T.Mesh(new T.CapsuleGeometry(0.42, 0.8, 4, 10), aprons[k % aprons.length]); body.position.set(0, 1.95, 0); body.rotation.x = -0.25; body.castShadow = true; p.add(body);
    const hd = new T.Mesh(new T.SphereGeometry(0.3, 16, 12), skins[k % skins.length]); hd.position.set(0, 2.85, -0.3); hd.castShadow = true; p.add(hd);
    const hair = new T.Mesh(new T.SphereGeometry(0.32, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat); hair.position.copy(hd.position); hair.rotation.x = 0.5; p.add(hair);
    const bun = new T.Mesh(new T.SphereGeometry(0.14, 10, 8), hairMat); bun.position.set(0, 3.0, 0.0); p.add(bun);
    for (const sx of [-1, 1]) {
      const a = new T.Mesh(new T.CapsuleGeometry(0.1, 0.65, 3, 6), skins[k % skins.length]);
      a.position.set(sx * 0.45, 2.0, -0.55); a.rotation.x = -1.2; p.add(a); arms.push({ m: a, ph: Math.random() * 6, base: -1.2 });
    }
  };
  let k = 0;
  const rowsZ = [-11, -4, 4, 11];
  for (const z of rowsZ) for (let x = -26; x <= 26; x += 6.5) { if (Math.abs(x) < 3) continue; sew(k++, x, z); }

  // центральный длинный стол с разложенными вещами — над ним пролетает камера
  const runway = new T.Mesh(new T.BoxGeometry(46, 0.2, 3.6), tableMat); runway.position.set(0, 1.4, 0); runway.castShadow = runway.receiveShadow = true; fab.add(runway);
  for (let i = 0; i < 12; i++) {
    const c = new T.Mesh(new T.PlaneGeometry(2.4, 3.2), garment(i + 3));
    c.rotation.x = -Math.PI / 2; c.rotation.z = -Math.PI / 2 + (i % 2 ? 0.04 : -0.04);
    c.position.set(-20.5 + i * 3.73, 1.515, 0); c.receiveShadow = true; fab.add(c);
  }
  // вешалки с вещами вдоль стены
  const rail = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 40, 8), legMat); rail.rotation.z = Math.PI / 2; rail.position.set(0, 6.2, -D / 2 + 2.2); fab.add(rail);
  for (let i = 0; i < 12; i++) {
    const c = new T.Mesh(new T.PlaneGeometry(2.6, 3.47), garment(i + 9)); c.position.set(-18 + i * 3.3, 4.3, -D / 2 + 2.3); fab.add(c);
  }

  // ---------- Маршрут камеры ----------
  const V = (x, y, z) => new T.Vector3(x, y, z);
  // [время, где камера, куда смотрит]
  const KEYS = [
    [0, V(-30, 210, 150), V(0, 140, 0)],
    [1.8, V(-12, 165, 95), V(0, 90, 0)],
    [3.4, V(0, 112, 62), V(0, 25, 0)],
    [4.8, V(4, 62, 36), V(0, 4, 0)],
    [6.0, V(0, 32, 8), V(-6, 0, 0)],
    [7.0, V(-8, 15, 1), V(-16, 1.5, 0)],
    [8.0, V(-17, 6.5, 0), V(-6, 1.5, 0)],
    [9.2, V(-4, 6, 0.5), V(8, 1.5, 0)],
    [10.2, V(11, 6.5, 1), V(22, 1.5, 0)],
    [11.0, V(21, 9, -1), V(32, 9, -4)],
    [11.8, V(25, 20, -5), V(45, 40, -45)],
    [12.6, V(20, 36, -2), V(65, 85, -150)],
    [13.4, V(12, 44, 8), V(90, 120, -260)],
  ];
  const posCurve = new T.CatmullRomCurve3(KEYS.map((k) => k[1]), false, "catmullrom", 0.4);
  const lookCurve = new T.CatmullRomCurve3(KEYS.map((k) => k[2]), false, "catmullrom", 0.4);
  const DUR = 15.5, TEXT_AT = 12.6, LAST = KEYS[KEYS.length - 1][0];
  const smooth = (x) => x * x * (3 - 2 * x);
  const timeMap = (t) => {
    t = Math.min(Math.max(t, 0), LAST);
    let i = 0; while (i < KEYS.length - 2 && t > KEYS[i + 1][0]) i++;
    let f = (t - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0]);
    if (i === 0) f = f * f; // мягкий старт
    if (i === KEYS.length - 2) f = 1 - (1 - f) * (1 - f); // мягкая остановка
    return (i + f) / (KEYS.length - 1);
  };

  // ---------- Надпись ----------
  const title = box.querySelector(".in-t");
  let textShown = false;

  // ---------- Цикл ----------
  let t0 = null, done = false, raf = 0;
  const clock = new T.Clock();
  function renderAt(t, dt, el) {
    const u = timeMap(t);
    camera.position.copy(posCurve.getPoint(u));
    camera.lookAt(lookCurve.getPoint(u));
    // внутри цеха: крыша прозрачная, включается тёплый свет
    const insideK = Math.min(1, Math.max(0, (42 - camera.position.y) / 18));
    roofMat.opacity = 1 - insideK * 0.92; glassMat.opacity = 0.35 * (1 - insideK * 0.9);
    roof.visible = roofMat.opacity > 0.03;
    inner.intensity = insideK * 60;
    clouds.children.forEach((c, i) => { c.position.x += dt * (0.6 + (i % 3) * 0.25); });
    arms.forEach((a) => { a.m.rotation.x = a.base + Math.sin(el * 9 + a.ph) * 0.12; });
    renderer.render(scene, camera);
  }
  function frame(now) {
    if (done) return;
    if (t0 === null) t0 = now;
    const t = Math.min((now - t0) / 1000, DUR);
    renderAt(t, clock.getDelta(), clock.elapsedTime);
    if (!textShown && t >= TEXT_AT) { textShown = true; title.classList.add("on"); }
    if (t >= DUR) return finish();
    raf = requestAnimationFrame(frame);
  }
  window.gnIntroRender = (t) => { done = true; renderAt(t, 0.016, t); if (t >= TEXT_AT) title.classList.add("on"); else title.classList.remove("on"); };
  function finish() {
    if (done) return; done = true; cancelAnimationFrame(raf);
    window.gnIntroDone && window.gnIntroDone();
    setTimeout(() => { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); }, 1200);
  }
  window.gnIntroStop = finish;
  addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // старт после загрузки фото вещей (не дольше 2,5 с)
  const ready = Promise.race([
    Promise.all(loads),
    new Promise((ok) => setTimeout(ok, 2500)),
  ]);
  renderer.compile(scene, camera);
  ready.then(() => { box.classList.add("go"); raf = requestAnimationFrame(frame); });
})();
