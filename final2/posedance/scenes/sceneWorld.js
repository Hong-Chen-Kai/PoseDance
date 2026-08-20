/**
 * sceneWorld.js — posedance 語意場景（游泳）
 *
 * - 舞台錨點＋相機 lookAt 木台；太陽／積雲保留
 * - 大面積 toon 海：弧形岸線、白沫交界、浪往沙灘緩推
 * - 參考 stylized / toon water 交界白沫感
 */

import * as THREE from "three";

export const SCENE_LABELS = Object.freeze({
  none: "none",
  swim: "swim",
});

/** 骨架／相機共用的站立錨點（木台中心） */
export const STAGE_ANCHOR = Object.freeze({
  x: 0,
  y: 0.14,
  z: 4.0,
});

const PALETTE = Object.freeze({
  skyTop: "#4FC3F7",
  skyHorizon: "#FFD54F",
  skyBottom: "#FFF8E1",
  sand: 0xffe0a3,
  wetSand: 0xe8c888,
  shallow: new THREE.Color("#40E0D0"),
  deep: new THREE.Color("#1E88E5"),
  mid: new THREE.Color("#00ACC1"),
  foam: new THREE.Color("#ffffff"),
  fog: 0xe8f4ff,
  trunk: 0xc49a6c,
  leaf: 0x66bb6a,
  leafTip: 0xa5d6a7,
  deck: 0xd4a574,
  deckEdge: 0xb8895a,
  cloud: 0xf4f7fb,
});

/**
 * 沙海交界基準（世界 z；海更負、沙更正）
 * 弧形振幅保持溫和，避免交界「跑掉」
 */
const SHORE_Z = 0.35;

function makeSkyTexture() {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, PALETTE.skyTop);
  g.addColorStop(0.42, "#81D4FA");
  g.addColorStop(0.62, PALETTE.skyHorizon);
  g.addColorStop(1, PALETTE.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function makeSunSpriteTexture() {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,250,1)");
  g.addColorStop(0.12, "rgba(255,240,170,1)");
  g.addColorStop(0.35, "rgba(255,210,90,0.85)");
  g.addColorStop(0.62, "rgba(255,190,70,0.35)");
  g.addColorStop(1, "rgba(255,180,60,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createLowPolyPalmTree() {
  const tree = new THREE.Group();
  const matOptions = { flatShading: true, roughness: 0.85, metalness: 0.05 };

  const trunkMat = new THREE.MeshStandardMaterial({
    color: PALETTE.trunk,
    ...matOptions,
  });
  const trunkGroup = new THREE.Group();
  const segments = 4;
  for (let i = 0; i < segments; i += 1) {
    const rTop = 0.09 - i * 0.012;
    const rBot = 0.12 - i * 0.012;
    const geo = new THREE.CylinderGeometry(
      Math.max(0.04, rTop),
      Math.max(0.05, rBot),
      0.55,
      6,
    );
    const mesh = new THREE.Mesh(geo, trunkMat);
    mesh.position.y = i * 0.48 + 0.28;
    mesh.position.x = Math.sin(i * 0.1) * i * 0.04;
    mesh.rotation.z = i * 0.05;
    trunkGroup.add(mesh);
  }
  tree.add(trunkGroup);

  const leafMat = new THREE.MeshStandardMaterial({
    color: PALETTE.leaf,
    emissive: PALETTE.leafTip,
    emissiveIntensity: 0.18,
    side: THREE.DoubleSide,
    ...matOptions,
  });
  const leafGroup = new THREE.Group();
  // 樹冠壓低，確保進畫面
  leafGroup.position.set(0, segments * 0.48 + 0.2, 0);

  const leafCount = 8;
  for (let i = 0; i < leafCount; i += 1) {
    // 扁長葉片：往外、往下垂
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.06, 1.35),
      leafMat,
    );
    const ang = (i * Math.PI * 2) / leafCount;
    leaf.position.set(Math.sin(ang) * 0.35, -0.05, Math.cos(ang) * 0.35);
    leaf.rotation.y = ang;
    leaf.rotation.x = -0.85; // 明顯下垂
    leaf.rotation.z = Math.sin(ang * 2) * 0.15;
    leafGroup.add(leaf);

    // 第二層略短葉
    const leaf2 = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.05, 1.0),
      leafMat,
    );
    const ang2 = ang + Math.PI / leafCount;
    leaf2.position.set(Math.sin(ang2) * 0.2, 0.08, Math.cos(ang2) * 0.2);
    leaf2.rotation.y = ang2;
    leaf2.rotation.x = -0.55;
    leafGroup.add(leaf2);
  }

  const nutMat = new THREE.MeshStandardMaterial({
    color: 0x6b4423,
    flatShading: true,
    roughness: 0.9,
  });
  for (let i = 0; i < 2; i += 1) {
    const nut = new THREE.Mesh(new THREE.DodecahedronGeometry(0.1, 0), nutMat);
    nut.position.set(i === 0 ? -0.12 : 0.12, -0.08, 0.08);
    leafGroup.add(nut);
  }

  tree.add(leafGroup);
  tree.userData.leafGroup = leafGroup;
  return tree;
}

/** 樹下散落椰子 */
function createGroundCoconuts(count = 3) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8d6e4a,
    flatShading: true,
    roughness: 0.88,
  });
  const matDark = new THREE.MeshStandardMaterial({
    color: 0x5d4037,
    flatShading: true,
    roughness: 0.9,
  });
  for (let i = 0; i < count; i += 1) {
    const nut = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.12 + (i % 2) * 0.03, 0),
      i % 2 === 0 ? mat : matDark,
    );
    const a = (i / count) * Math.PI * 1.2 - 0.3;
    nut.position.set(Math.cos(a) * 0.45, 0.1, Math.sin(a) * 0.35 + 0.15);
    nut.rotation.set(i * 0.4, i * 0.7, i * 0.2);
    group.add(nut);
  }
  return group;
}

/** 低面數海螺（螺旋感、夠大才看得到） */
function createConch() {
  const shell = new THREE.Group();
  const matBody = new THREE.MeshStandardMaterial({
    color: 0xf2d2b6,
    flatShading: true,
    roughness: 0.7,
  });
  const matLip = new THREE.MeshStandardMaterial({
    color: 0xffc4a8,
    flatShading: true,
    roughness: 0.55,
    emissive: 0x3a1810,
    emissiveIntensity: 0.08,
  });

  // 螺旋：漸小球體沿曲線
  for (let i = 0; i < 6; i += 1) {
    const t = i / 5;
    const r = 0.14 * (1 - t * 0.55);
    const ang = t * Math.PI * 1.6;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 6, 5),
      i % 2 === 0 ? matBody : matLip,
    );
    mesh.position.set(
      Math.cos(ang) * t * 0.16,
      0.06 + t * 0.12,
      Math.sin(ang) * t * 0.12 + t * 0.08,
    );
    mesh.scale.set(1.15, 0.85, 1.05);
    shell.add(mesh);
  }

  const opening = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 6, 4, 0, Math.PI),
    matLip,
  );
  opening.position.set(0.1, 0.08, 0.02);
  opening.rotation.y = -0.6;
  opening.scale.set(1.1, 0.7, 0.9);
  shell.add(opening);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 5), matBody);
  tip.position.set(-0.02, 0.2, 0.14);
  tip.rotation.x = 0.9;
  shell.add(tip);

  return shell;
}

/** 紅白救生圈（平放沙灘） */
function createLifebuoy() {
  const buoy = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({
    color: 0xe53935,
    flatShading: true,
    roughness: 0.55,
  });
  const white = new THREE.MeshStandardMaterial({
    color: 0xfff8f0,
    flatShading: true,
    roughness: 0.5,
  });

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.11, 8, 20), red);
  ring.rotation.x = Math.PI / 2;
  buoy.add(ring);

  // 白色色塊（四段）
  for (let i = 0; i < 4; i += 1) {
    const stripe = new THREE.Mesh(
      new THREE.TorusGeometry(0.38, 0.115, 6, 8, Math.PI * 0.28),
      white,
    );
    stripe.rotation.x = Math.PI / 2;
    stripe.rotation.z = (i / 4) * Math.PI * 2;
    stripe.position.y = 0.002;
    buoy.add(stripe);
  }

  // 小繩結感
  const knotMat = new THREE.MeshStandardMaterial({
    color: 0xd4a574,
    flatShading: true,
    roughness: 0.85,
  });
  for (const a of [0, Math.PI]) {
    const knot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.14), knotMat);
    knot.position.set(Math.cos(a) * 0.38, 0.06, Math.sin(a) * 0.38);
    buoy.add(knot);
  }

  return buoy;
}

function createPebble(scale = 1) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.08, 0.15, 0.42 + (scale % 1) * 0.15),
    flatShading: true,
    roughness: 0.92,
  });
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.1 * scale, 0), mat);
  rock.scale.set(1.2, 0.55, 0.9);
  rock.position.y = 0.03 * scale;
  return rock;
}

function scatterBeachProps(root) {
  const coconutSpots = [
    [-3.4, 2.5],
    [-4.5, 0.85],
    [3.7, 2.2],
  ];
  for (const [x, z] of coconutSpots) {
    const g = createGroundCoconuts(3);
    g.position.set(x, 0, z);
    g.scale.setScalar(1.1);
    root.add(g);
  }

  // 救生圈：右側靠岸一帶，避開木台與海螺
  const buoy = createLifebuoy();
  buoy.position.set(3.4, 0.08, 1.6);
  buoy.rotation.y = -0.55;
  buoy.scale.setScalar(1);
  root.add(buoy);

  // 海螺：散開——左前、左後、右中，互不擠在一起
  const conchSpots = [
    [-3.6, 4.6, 0.6, 2.1], // 左、偏後（觀眾側）
    [-2.8, 1.4, 1.2, 1.85], // 左、偏海
    [2.6, 4.8, -0.9, 2.0], // 右、偏後
  ];
  for (const [x, z, rot, sc] of conchSpots) {
    const s = createConch();
    s.position.set(x, 0.02, z);
    s.rotation.y = rot;
    s.rotation.x = -0.25;
    s.scale.setScalar(sc);
    root.add(s);
  }

  const rockSpots = [
    [-2.2, 3.8, 0.8],
    [0.9, 2.9, 1.1],
    [2.6, 4.2, 0.6],
    [-1.2, 5.2, 1.3],
    [1.8, 2.2, 0.7],
    [-3.1, 3.5, 0.9],
    [0.3, 3.4, 0.5],
  ];
  for (const [x, z, sc] of rockSpots) {
    const r = createPebble(sc);
    r.position.set(x, 0, z);
    r.rotation.y = x + z;
    root.add(r);
  }
}

function createLowPolyCloud() {
  const cloud = new THREE.Group();
  const cloudMat = new THREE.MeshBasicMaterial({
    color: PALETTE.cloud,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    fog: false, // 不被霧吃掉
  });
  const configs = [
    { r: 1.15, x: 0, y: 0, z: 0 },
    { r: 0.85, x: 1.05, y: -0.08, z: 0.15 },
    { r: 0.75, x: -1.05, y: -0.12, z: -0.08 },
    { r: 0.55, x: 0.45, y: 0.35, z: -0.12 },
  ];
  for (const cfg of configs) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(cfg.r, 0),
      cloudMat,
    );
    mesh.position.set(cfg.x, cfg.y, cfg.z);
    cloud.add(mesh);
  }
  cloud.scale.set(1, 0.55, 0.85);
  return cloud;
}

function createStageDeck() {
  const deck = new THREE.Group();
  // 略加大，骨架站立更清楚
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(2.8, 0.14, 1.9),
    new THREE.MeshStandardMaterial({
      color: PALETTE.deck,
      flatShading: true,
      roughness: 0.78,
      metalness: 0.05,
    }),
  );
  top.position.y = 0.09;
  deck.add(top);

  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(3.0, 0.07, 2.1),
    new THREE.MeshStandardMaterial({
      color: PALETTE.deckEdge,
      flatShading: true,
      roughness: 0.85,
    }),
  );
  rim.position.y = 0.02;
  deck.add(rim);

  const grooveMat = new THREE.MeshStandardMaterial({
    color: 0x9a7048,
    flatShading: true,
    roughness: 0.9,
  });
  for (const x of [-0.5, 0, 0.5]) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 1.65), grooveMat);
    g.position.set(x, 0.165, 0);
    deck.add(g);
  }
  return deck;
}

/** 弧形岸線（海／濕沙／沙 共用；比上一版再彎一點） */
const SHORE_GLSL = /* glsl */ `
float shoreLineZ(float x, float shoreZ) {
  return shoreZ
    + sin(x * 0.17) * 0.62
    + sin(x * 0.08 + 1.7) * 0.32
    + sin(x * 0.38 + 0.5) * 0.14;
}
`;

const OCEAN_VERT = /* glsl */ `
uniform float uTime;
varying float vWave;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUv;

vec3 gerstnerOffset(vec3 p, vec2 dir, float steepness, float wavelength, float t) {
  float k = 6.28318530718 / wavelength;
  float c = sqrt(9.8 / k);
  float f = k * (dot(dir, p.xz) - c * t * 0.32);
  float a = steepness / k;
  return vec3(dir.x * a * cos(f), a * sin(f), dir.y * a * cos(f));
}

// 平緩起伏（幅度縮小）
vec3 displace(vec3 p, float t) {
  vec3 d = vec3(0.0);
  d += gerstnerOffset(p, normalize(vec2(0.55, 0.85)), 0.08, 10.0, t);
  d += gerstnerOffset(p, normalize(vec2(-0.75, 0.65)), 0.05, 6.0, t);
  d += gerstnerOffset(p, normalize(vec2(0.25, 0.97)), 0.03, 3.8, t);
  return p + d;
}

void main() {
  vUv = uv;
  vec3 p0 = position;
  vec3 p = displace(p0, uTime);
  vWave = p.y - p0.y;

  float e = 0.5;
  vec3 px = displace(p0 + vec3(e, 0.0, 0.0), uTime);
  vec3 pz = displace(p0 + vec3(0.0, 0.0, e), uTime);
  vNormalW = normalize(cross(pz - p, px - p));

  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const OCEAN_FRAG = /* glsl */ `
uniform float uTime;
uniform float uShoreZ;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform float uWireMix;
varying float vWave;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUv;

${SHORE_GLSL}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

void main() {
  float sz = shoreLineZ(vWorldPos.x, uShoreZ);
  float intoOcean = sz - vWorldPos.z;

  // 與沙共用同一條 shoreLineZ：只畫海側
  if (intoOcean < -0.04) discard;
  float alpha = smoothstep(-0.04, 0.1, intoOcean);
  if (alpha < 0.02) discard;

  float depth = max(intoOcean, 0.0);
  float d1 = smoothstep(0.0, 5.0, depth);
  float d2 = smoothstep(5.0, 16.0, depth);
  vec3 water = mix(uShallow, uMid, d1);
  water = mix(water, uDeep, d2);

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  water = mix(water, vec3(0.75, 0.96, 1.0), fres * 0.5);

  vec2 flowUv = vWorldPos.xz * 0.2;
  flowUv += vec2(uTime * 0.03, -uTime * 0.045);
  float n1 = valueNoise(flowUv * 2.8);
  float n2 = valueNoise(flowUv * 5.5 + 11.0);
  float flow = smoothstep(0.42, 0.7, n1 * 0.5 + n2 * 0.5);
  water += uFoam * flow * 0.1;
  water = mix(water, water * vec3(0.92, 1.05, 1.08), flow * 0.2);

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  water += uFoam * smoothstep(0.88, 0.97, max(dot(N, H), 0.0)) * 0.75;

  float crest = smoothstep(0.04, 0.12, vWave);
  water = mix(water, uFoam, crest * 0.25);

  // 交界白沫：鎖在同一條岸線
  float band = exp(-pow(intoOcean - 0.4, 2.0) * 1.8);
  float along = valueNoise(vec2(vWorldPos.x * 0.65 - uTime * 0.4, intoOcean * 1.5));
  float shoreFoam = band * mix(0.55, 1.0, smoothstep(0.32, 0.72, along));
  water = mix(water, uFoam, clamp(shoreFoam * 0.9, 0.0, 0.95));

  water = mix(water, mix(water, vec3(0.55, 0.88, 1.0), 0.45), uWireMix);
  gl_FragColor = vec4(water, alpha);
}
`;

/** 沙：岸線海側挖空，與海對齊同一條交界 */
const SAND_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SAND_FRAG = /* glsl */ `
uniform float uShoreZ;
uniform vec3 uColor;
varying vec3 vWorldPos;

${SHORE_GLSL}

void main() {
  float sz = shoreLineZ(vWorldPos.x, uShoreZ);
  // 海側不要沙（與海洋 discard 互補）
  if (vWorldPos.z < sz + 0.02) discard;
  gl_FragColor = vec4(uColor, 1.0);
}
`;

const WET_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WET_FRAG = /* glsl */ `
uniform float uShoreZ;
uniform vec3 uColor;
varying vec3 vWorldPos;

${SHORE_GLSL}

void main() {
  float sz = shoreLineZ(vWorldPos.x, uShoreZ);
  float d = vWorldPos.z - sz; // 沙灘側
  if (d < 0.02 || d > 0.95) discard;
  float fade = smoothstep(0.02, 0.28, d) * (1.0 - smoothstep(0.65, 0.95, d));
  gl_FragColor = vec4(uColor, 0.8 * fade);
}
`;

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createSceneWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0b1220, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  // 略加大 FOV，留出天空給太陽／雲
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
  applyStageCamera();

  const hemi = new THREE.HemisphereLight(0xfff6e0, 0x7ec8e8, 1.45);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xfff0c8, 1.55);
  sunLight.position.set(-6, 16, 8);
  scene.add(sunLight);
  const fill = new THREE.DirectionalLight(0xffe0b2, 0.35);
  fill.position.set(8, 6, 4);
  scene.add(fill);

  /** @type {THREE.Group | null} */
  let activeRoot = null;
  let activeLabel = SCENE_LABELS.none;
  /** @type {{
   *   oceanMat: THREE.ShaderMaterial,
   *   skyTex: THREE.Texture,
   *   sunTex: THREE.Texture,
   *   trees: THREE.Group[],
   *   clouds: THREE.Group[],
   *   stageAnchor: { x: number, y: number, z: number }
   * } | null} */
  let swimRes = null;

  const clock = new THREE.Clock();
  const sunDir = new THREE.Vector3(-0.45, 0.75, 0.35).normalize();

  function applyStageCamera() {
    // 稍高稍遠，木台在畫面下半清楚可見
    camera.position.set(0, 2.65, 9.3);
    // 視線略抬，木台仍在畫面中下、天空可見
    camera.lookAt(STAGE_ANCHOR.x, 1.15, STAGE_ANCHOR.z - 1.8);
  }

  function setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function clearActive() {
    if (activeRoot) {
      scene.remove(activeRoot);
      activeRoot.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        const mats = obj.material
          ? Array.isArray(obj.material)
            ? obj.material
            : [obj.material]
          : [];
        for (const m of mats) m.dispose?.();
      });
      activeRoot = null;
    }
    if (swimRes) {
      swimRes.skyTex?.dispose?.();
      swimRes.sunTex?.dispose?.();
      swimRes = null;
    }
    activeLabel = SCENE_LABELS.none;
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x0b1220, 1);
  }

  function buildSwimWorld() {
    const root = new THREE.Group();
    root.name = "swimWorld";

    const skyTex = makeSkyTexture();
    scene.background = skyTex;
    // 霧遠一點，避免吃掉太陽／雲
    scene.fog = new THREE.Fog(PALETTE.fog, 42, 100);

    const sunTex = makeSunSpriteTexture();
    const sunMat = new THREE.SpriteMaterial({
      map: sunTex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
      // 一般混合較不易在亮天空「加完看不見」
      blending: THREE.NormalBlending,
      opacity: 1,
    });
    const sunSprite = new THREE.Sprite(sunMat);
    // 必須落在俯視相機的上半視野（勿放太高太遠）
    sunSprite.position.set(-4.2, 4.6, -6.5);
    sunSprite.scale.set(9, 9, 1);
    sunSprite.renderOrder = 10;
    root.add(sunSprite);

    // 大海：前緣需蓋過弧形岸最大凸起（約 +1.1）
    const oceanDepth = 38;
    const oceanFrontZ = SHORE_Z + 1.35;
    const oceanCenterZ = oceanFrontZ - oceanDepth * 0.5;
    const oceanGeo = new THREE.PlaneGeometry(90, oceanDepth, 128, 80);
    oceanGeo.rotateX(-Math.PI / 2);
    const oceanMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShoreZ: { value: SHORE_Z },
        uShallow: { value: PALETTE.shallow.clone() },
        uMid: { value: PALETTE.mid.clone() },
        uDeep: { value: PALETTE.deep.clone() },
        uFoam: { value: PALETTE.foam.clone() },
        uSunDir: { value: sunDir.clone() },
        uWireMix: { value: 0 },
      },
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    const ocean = new THREE.Mesh(oceanGeo, oceanMat);
    ocean.position.set(0, 0.028, oceanCenterZ);
    ocean.renderOrder = 0;
    root.add(ocean);

    // 沙灘：與海共用 shoreLineZ，海側挖空對齊交界
    const sandMat = new THREE.ShaderMaterial({
      uniforms: {
        uShoreZ: { value: SHORE_Z },
        uColor: { value: new THREE.Color(PALETTE.sand) },
      },
      vertexShader: SAND_VERT,
      fragmentShader: SAND_FRAG,
    });
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 14, 1, 1).rotateX(-Math.PI / 2),
      sandMat,
    );
    sand.position.set(0, 0.04, 5.0);
    sand.renderOrder = 1;
    root.add(sand);

    const wetMat = new THREE.ShaderMaterial({
      uniforms: {
        uShoreZ: { value: SHORE_Z },
        uColor: { value: new THREE.Color(PALETTE.wetSand) },
      },
      vertexShader: WET_VERT,
      fragmentShader: WET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const wet = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 4, 1, 1).rotateX(-Math.PI / 2),
      wetMat,
    );
    wet.position.set(0, 0.045, SHORE_Z + 0.5);
    wet.renderOrder = 2;
    root.add(wet);

    const deck = createStageDeck();
    deck.position.set(STAGE_ANCHOR.x, 0.05, STAGE_ANCHOR.z);
    deck.name = "stageDeck";
    root.add(deck);

    const treeLeft = createLowPolyPalmTree();
    treeLeft.position.set(-3.6, 0, 2.8);
    treeLeft.rotation.y = 0.4;
    treeLeft.scale.set(1.35, 1.35, 1.35);
    root.add(treeLeft);

    const treeLeftBack = createLowPolyPalmTree();
    treeLeftBack.position.set(-4.8, 0, 1.0);
    treeLeftBack.rotation.y = 0.1;
    treeLeftBack.scale.set(1.1, 1.1, 1.1);
    root.add(treeLeftBack);

    const treeRight = createLowPolyPalmTree();
    treeRight.position.set(3.9, 0, 2.5);
    treeRight.rotation.y = -0.55;
    treeRight.scale.set(1.45, 1.45, 1.45);
    root.add(treeRight);

    const trees = [treeLeft, treeLeftBack, treeRight];

    scatterBeachProps(root);

    // 積雲：降高度、拉近，對齊目前相機上半天空
    const cloud1 = createLowPolyCloud();
    cloud1.position.set(-5.5, 4.4, -8);
    cloud1.scale.multiplyScalar(1.55);
    cloud1.userData.baseX = cloud1.position.x;
    root.add(cloud1);

    const cloud2 = createLowPolyCloud();
    cloud2.position.set(5.2, 4.9, -9.5);
    cloud2.scale.multiplyScalar(1.85);
    cloud2.userData.baseX = cloud2.position.x;
    root.add(cloud2);

    const cloud3 = createLowPolyCloud();
    cloud3.position.set(0.8, 5.2, -11);
    cloud3.scale.multiplyScalar(1.35);
    cloud3.userData.baseX = cloud3.position.x;
    root.add(cloud3);

    const cloud4 = createLowPolyCloud();
    cloud4.position.set(-2.2, 4.1, -7.2);
    cloud4.scale.multiplyScalar(1.15);
    cloud4.userData.baseX = cloud4.position.x;
    root.add(cloud4);

    const clouds = [cloud1, cloud2, cloud3, cloud4];

    return {
      root,
      oceanMat,
      skyTex,
      sunTex,
      trees,
      clouds,
      stageAnchor: { ...STAGE_ANCHOR },
    };
  }

  /**
   * @param {"none" | "swim"} label
   */
  function setScene(label) {
    const next = label === SCENE_LABELS.swim ? SCENE_LABELS.swim : SCENE_LABELS.none;
    if (next === activeLabel) return activeLabel;

    clearActive();

    if (next === SCENE_LABELS.swim) {
      const built = buildSwimWorld();
      activeRoot = built.root;
      scene.add(activeRoot);
      swimRes = {
        oceanMat: built.oceanMat,
        skyTex: built.skyTex,
        sunTex: built.sunTex,
        trees: built.trees,
        clouds: built.clouds,
        stageAnchor: built.stageAnchor,
      };
      activeLabel = SCENE_LABELS.swim;
      applyStageCamera();
    } else {
      applyStageCamera();
    }

    return activeLabel;
  }

  function setOceanWireframe(on) {
    if (!swimRes?.oceanMat) return;
    swimRes.oceanMat.wireframe = Boolean(on);
    swimRes.oceanMat.uniforms.uWireMix.value = on ? 0.55 : 0;
  }

  function getStageAnchor() {
    return swimRes?.stageAnchor
      ? { ...swimRes.stageAnchor }
      : { ...STAGE_ANCHOR };
  }

  function frame() {
    const t = clock.getElapsedTime();
    if (activeLabel === SCENE_LABELS.swim && swimRes) {
      swimRes.oceanMat.uniforms.uTime.value = t;

      if (swimRes.trees) {
        swimRes.trees.forEach((tree, idx) => {
          const leaves = tree.userData.leafGroup;
          if (!leaves) return;
          leaves.rotation.z = Math.sin(t * 1.5 + idx) * 0.05;
          leaves.rotation.x = Math.cos(t * 1.2 + idx) * 0.035;
        });
      }

      if (swimRes.clouds) {
        swimRes.clouds.forEach((cloud, idx) => {
          const baseX =
            typeof cloud.userData.baseX === "number"
              ? cloud.userData.baseX
              : cloud.position.x;
          cloud.position.x = baseX + Math.sin(t * 0.15 + idx) * 0.45;
        });
      }
    }
    renderer.render(scene, camera);
  }

  function dispose() {
    clearActive();
    renderer.dispose();
  }

  return {
    setSize,
    setScene,
    setOceanWireframe,
    getStageAnchor,
    frame,
    dispose,
    getLabel: () => activeLabel,
    renderer,
    scene,
    camera,
  };
}
