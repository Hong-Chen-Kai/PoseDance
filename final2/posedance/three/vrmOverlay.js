/**
 * vrmOverlay.js — 可開關的 VRM 套皮層（Mode 1 / 2，跟隨 getDrawRect）
 * 姿勢驅動：Kalidokit Pose.solve（MediaPipe 33 點 → VRM Humanoid）
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { Pose as KalidoPose } from "kalidokit";
import { getSyntheticLandmarksAtTime } from "../proceduralSkeleton.js";

/** 預設套皮：CoolTiger.vrm（100Avatars · CC0），失敗時依序 fallback */
const VRM_URLS = [
  new URL("./assets/CoolTiger.vrm", import.meta.url).href,
  new URL("./assets/01.vrm", import.meta.url).href,
  new URL("./assets/avatar-sample.vrm", import.meta.url).href,
];
const VRM_ASSET_BASE = new URL("./assets/", import.meta.url).href;

/** Kalidokit 輸出骨名 → three-vrm normalized bone 名 */
const KALIDOKIT_TO_VRM = {
  Hips: "hips",
  Spine: "spine",
  Chest: "chest",
  Neck: "neck",
  Head: "head",
  LeftUpperArm: "leftUpperArm",
  LeftLowerArm: "leftLowerArm",
  LeftHand: "leftHand",
  RightUpperArm: "rightUpperArm",
  RightLowerArm: "rightLowerArm",
  RightHand: "rightHand",
  LeftUpperLeg: "leftUpperLeg",
  LeftLowerLeg: "leftLowerLeg",
  RightUpperLeg: "rightUpperLeg",
  RightLowerLeg: "rightLowerLeg",
};

const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();

const els = {
  canvas: document.getElementById("avatar_canvas"),
  toggle: document.getElementById("toggleVrmButton"),
  video: document.getElementById("input_video"),
  wrap: document.querySelector(".camera-wrapper"),
};

const vrmState = {
  active: false,
  ready: false,
  scene: null,
  camera: null,
  renderer: null,
  clock: null,
  raf: 0,
  pool: new Map(),
  poolKey: "",
  vrmBufferPromise: null,
  skinApplied: false,
};

function waitForTestState(maxMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (window.__posedanceTestState && window.__posedanceTestApi) {
        resolve(window.__posedanceTestState);
        return;
      }
      if (performance.now() - t0 > maxMs) {
        reject(new Error("__posedanceTestState 未就緒"));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function setSkinActive(on) {
  const st = window.__posedanceTestState;
  if (st?.ui) st.ui.vrmSkinActive = Boolean(on);
}

function getTScore(st) {
  try {
    const t = st.player?.getCurrentTime?.();
    if (typeof t === "number" && Number.isFinite(t)) return t;
  } catch {
    /* ignore */
  }
  return performance.now() / 1000;
}

function getDemoTimeBracket(samples, t) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  if (samples.length === 1) return { left: samples[0], right: samples[0], alpha: 0 };
  const firstT = samples[0]?.t ?? 0;
  const lastT = samples[samples.length - 1]?.t ?? 0;
  if (t <= firstT) return { left: samples[0], right: samples[0], alpha: 0 };
  if (t >= lastT) {
    const last = samples[samples.length - 1];
    return { left: last, right: last, alpha: 0 };
  }
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((samples[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  const right = samples[lo];
  const left = samples[lo - 1];
  const tl = left?.t ?? 0;
  const tr = right?.t ?? tl;
  const alpha = tr === tl ? 0 : (t - tl) / (tr - tl);
  return { left, right, alpha };
}

function interpolateLandmarks(lmA, lmB, alpha) {
  if (!lmA || !Array.isArray(lmA)) return lmB;
  if (!lmB || !Array.isArray(lmB)) return lmA;
  const out = [];
  for (let i = 0; i < 33; i += 1) {
    const a = lmA[i];
    const b = lmB[i];
    if (!a && !b) {
      out.push(null);
      continue;
    }
    if (!a) {
      out.push(b);
      continue;
    }
    if (!b) {
      out.push(a);
      continue;
    }
    const [ax, ay, az, av] = a;
    const [bx, by, bz, bv] = b;
    out.push([
      ax + (bx - ax) * alpha,
      ay + (by - ay) * alpha,
      typeof az === "number" && typeof bz === "number" ? az + (bz - az) * alpha : (az ?? bz),
      typeof av === "number" && typeof bv === "number" ? av + (bv - av) * alpha : (av ?? bv),
    ]);
  }
  return out;
}

function getLandmarksAtTime(samples, t) {
  const br = getDemoTimeBracket(samples, t);
  if (!br) return null;
  const { left, right, alpha } = br;
  if (!left || !Array.isArray(left.lm)) return null;
  if (left === right || alpha <= 0) return left.lm;
  if (!right || !Array.isArray(right.lm)) return left.lm;
  return interpolateLandmarks(left.lm, right.lm, alpha);
}

function lmPointToMp(p) {
  if (!p) return { x: 0, y: 0, z: 0, visibility: 0 };
  if (typeof p.x === "number") {
    return {
      x: p.x,
      y: p.y,
      z: p.z ?? 0,
      visibility: p.visibility ?? 1,
    };
  }
  const [x, y, z, v] = p;
  return { x, y, z: z ?? 0, visibility: v ?? 1 };
}

/** 統一為 MediaPipe 影像座標格式（0–1，Kalidokit lm2d） */
function lmToMp2d(lm) {
  if (!lm || lm.length !== 33) return null;
  return lm.map(lmPointToMp);
}

function applyPoseOffsetToMp(mp, offset) {
  if (!mp || !offset || typeof offset.dx !== "number" || typeof offset.dy !== "number") {
    return mp;
  }
  return mp.map((p) => {
    if (!p) return p;
    return { ...p, x: p.x + offset.dx, y: p.y + offset.dy };
  });
}

/**
 * 預錄 trace 無 worldLandmarks 時，由影像座標推估 pseudo-world（Kalidokit lm3d）
 * 以髖中心為原點、Y 軸朝上，供 calcArms / calcLegs / calcHips 使用。
 */
function mp2dToPseudoWorld(mp2d) {
  if (!mp2d || mp2d.length !== 33) return null;
  const hipL = mp2d[23];
  const hipR = mp2d[24];
  if (!hipL || !hipR) return mp2d;

  const cx = (hipL.x + hipR.x) * 0.5;
  const cy = (hipL.y + hipR.y) * 0.5;
  const cz = ((hipL.z ?? 0) + (hipR.z ?? 0)) * 0.5;
  const scale = 2;

  return mp2d.map((p) => {
    if (!p) return p;
    return {
      x: (p.x - cx) * scale,
      y: -(p.y - cy) * scale,
      z: -((p.z ?? 0) - cz) * scale,
      visibility: p.visibility ?? 1,
    };
  });
}

function worldLmToMp3d(world) {
  if (!world || world.length !== 33) return null;
  return world.map(lmPointToMp);
}

function getKalidokitSolveOptions(slot) {
  const video = slot?.video;
  if (video?.videoWidth > 0 && video?.videoHeight > 0) {
    return { runtime: "mediapipe", video, enableLegs: true };
  }
  // 預錄 trace / demo：landmark 已是 0–1 正規化
  return { runtime: "mediapipe", imageSize: { width: 1, height: 1 }, enableLegs: true };
}

function solveKalidokitPose(mp2d, mp3d, solveOptions) {
  if (!mp2d || mp2d.length !== 33) return null;
  const lm3d = mp3d?.length === 33 ? mp3d : mp2dToPseudoWorld(mp2d);
  if (!lm3d) return null;
  try {
    return KalidoPose.solve(lm3d, mp2d, solveOptions);
  } catch (e) {
    console.warn("[VRM] Kalidokit Pose.solve 失敗", e);
    return null;
  }
}

function rigKalidokitRotation(vrm, kalidoName, rotation, dampener = 1) {
  const boneName = KALIDOKIT_TO_VRM[kalidoName];
  if (!boneName || !rotation) return;
  const bone = vrm.humanoid?.getNormalizedBoneNode?.(boneName);
  if (!bone) return;
  bone.rotation.set(
    (rotation.x ?? 0) * dampener,
    (rotation.y ?? 0) * dampener,
    (rotation.z ?? 0) * dampener,
  );
}

function rigKalidokitHips(vrm, hips) {
  const bone = vrm.humanoid?.getNormalizedBoneNode?.("hips");
  if (!bone || !hips) return;
  if (hips.rotation) {
    rigKalidokitRotation(vrm, "Hips", hips.rotation, 0.7);
  }
  if (hips.position) {
    bone.position.set(
      hips.position.x ?? 0,
      (hips.position.y ?? 0) + 0.05,
      -(hips.position.z ?? 0),
    );
  }
}

/** Kalidokit 輸出 → VRM normalized bones（與官方 demo 相同骨名對應） */
function applyKalidokitPoseToVrm(vrm, rigged) {
  if (!vrm?.humanoid || !rigged) return false;

  vrm.humanoid.resetNormalizedPose?.();
  vrm.scene.position.set(0, 0, 0);
  vrm.scene.scale.setScalar(1);

  rigKalidokitHips(vrm, rigged.Hips);
  rigKalidokitRotation(vrm, "Spine", rigged.Spine, 0.45);

  rigKalidokitRotation(vrm, "RightUpperArm", rigged.RightUpperArm, 1);
  rigKalidokitRotation(vrm, "RightLowerArm", rigged.RightLowerArm, 1);
  rigKalidokitRotation(vrm, "LeftUpperArm", rigged.LeftUpperArm, 1);
  rigKalidokitRotation(vrm, "LeftLowerArm", rigged.LeftLowerArm, 1);
  rigKalidokitRotation(vrm, "RightHand", rigged.RightHand, 1);
  rigKalidokitRotation(vrm, "LeftHand", rigged.LeftHand, 1);

  rigKalidokitRotation(vrm, "RightUpperLeg", rigged.RightUpperLeg, 1);
  rigKalidokitRotation(vrm, "RightLowerLeg", rigged.RightLowerLeg, 1);
  rigKalidokitRotation(vrm, "LeftUpperLeg", rigged.LeftUpperLeg, 1);
  rigKalidokitRotation(vrm, "LeftLowerLeg", rigged.LeftLowerLeg, 1);

  return true;
}

function applyLmToVrm(vrm, lm, worldLm, solveOptions, poseOffset) {
  let mp2d = lmToMp2d(lm);
  if (!mp2d) return false;
  mp2d = applyPoseOffsetToMp(mp2d, poseOffset);
  // 有拖曳 offset 時改由 offset 後的 2D 推估 3D，避免 2D/3D 不一致
  const mp3d =
    poseOffset != null ? null : worldLm ? worldLmToMp3d(worldLm) : null;
  const rigged = solveKalidokitPose(mp2d, mp3d, solveOptions);
  if (!rigged) return false;
  return applyKalidokitPoseToVrm(vrm, rigged);
}

async function fetchVrmBuffer() {
  if (!vrmState.vrmBufferPromise) {
    vrmState.vrmBufferPromise = (async () => {
      let lastErr = null;
      for (const url of VRM_URLS) {
        try {
          const res = await fetch(url, { cache: "force-cache" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const label = new URL(url).pathname.split("/").pop() ?? url;
          console.info(`[VRM] 使用 ${label} 套皮（Kalidokit 驅動）`);
          if (!label.includes("CoolTiger")) {
            console.warn(`[VRM] CoolTiger.vrm 未找到，改用 ${label}`);
          }
          vrmState.loadedUrl = url;
          return buf;
        } catch (e) {
          lastErr = e;
          console.warn("[VRM] 載入失敗", url, e);
        }
      }
      throw lastErr ?? new Error("無可用 VRM 資源");
    })();
  }
  return vrmState.vrmBufferPromise;
}

async function createVrmInstance() {
  const buffer = await fetchVrmBuffer();
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, VRM_ASSET_BASE, resolve, reject);
  });
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error("VRM not found in glTF");
  VRMUtils.rotateVRM0(vrm);
  VRMUtils.removeUnnecessaryJoints(vrm.scene);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
  });
  return vrm;
}

function disposeVrmEntry(entry) {
  if (!entry?.vrm) return;
  vrmState.scene?.remove(entry.vrm.scene);
  try {
    VRMUtils.deepDispose(entry.vrm.scene);
  } catch {
    /* ignore */
  }
}

function initThree() {
  const wrap = els.wrap || els.canvas?.parentElement;
  const w = wrap?.clientWidth || 800;
  const h = wrap?.clientHeight || 480;

  vrmState.scene = new THREE.Scene();
  vrmState.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  vrmState.camera.position.set(0, 1, 5);
  vrmState.camera.lookAt(0, 1, 0);

  vrmState.renderer = new THREE.WebGLRenderer({
    canvas: els.canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  });
  vrmState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  vrmState.renderer.setSize(w, h, false);
  vrmState.renderer.outputColorSpace = THREE.SRGBColorSpace;
  vrmState.renderer.setClearColor(0x000000, 0);
  vrmState.renderer.setClearAlpha(0);
  vrmState.renderer.autoClear = false;
  if (els.canvas) els.canvas.style.background = "transparent";

  vrmState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.15));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(1, 3, 2);
  vrmState.scene.add(dir);

  vrmState.clock = new THREE.Clock();
  window.addEventListener("resize", onVrmResize);
}

function onVrmResize() {
  if (!vrmState.renderer) return;
  const wrap = els.wrap || els.canvas?.parentElement;
  const w = wrap?.clientWidth || 800;
  const h = wrap?.clientHeight || 480;
  vrmState.renderer.setSize(w, h, false);
}

function frameVrmToViewport(vrm, camera, rect) {
  vrm.scene.updateMatrixWorld(true);
  _box.setFromObject(vrm.scene);
  if (_box.isEmpty()) return;

  _box.getCenter(_center);
  _box.getSize(_size);

  const margin = 1.1;
  const viewAspect = rect.dw / Math.max(1, rect.dh);
  let halfH = Math.max(_size.y * 0.5 * margin, 0.35);
  let halfW = Math.max(_size.x * 0.5 * margin, 0.2);

  if (halfW / halfH > viewAspect) halfH = halfW / viewAspect;
  else halfW = halfH * viewAspect;

  camera.left = _center.x - halfW;
  camera.right = _center.x + halfW;
  camera.top = _center.y + halfH;
  camera.bottom = _center.y - halfH;
  camera.near = 0.01;
  camera.far = 100;
  camera.position.set(_center.x, _center.y, _center.z + 5);
  camera.lookAt(_center);
  camera.updateProjectionMatrix();
}

function setViewportFromRect(renderer, rect) {
  const dpr = renderer.getPixelRatio();
  const canvasH = renderer.domElement.height;
  const x = Math.max(0, Math.floor(rect.ox * dpr));
  const w = Math.max(1, Math.floor(rect.dw * dpr));
  const h = Math.max(1, Math.floor(rect.dh * dpr));
  const y = Math.max(0, Math.floor(canvasH - (rect.oy + rect.dh) * dpr));
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
}


function firstTraceLandmarks(tr, tScore) {
  if (tr.synthetic) {
    return getSyntheticLandmarksAtTime(tr, tScore);
  }
  if (tr?.data?.samples?.length) {
    return getLandmarksAtTime(tr.data.samples, tScore) ?? tr.data.samples[0]?.lm ?? null;
  }
  return null;
}

function collectMode2Slots(st, api) {
  const layout = api.getOverlayLayout();
  if (!layout) return [];
  const { defaultRects } = layout;
  const tScore = getTScore(st);
  const slots = [];
  const { SKELETON_IDS, mode2TraceSkeletonId, getDrawRect } = api;

  for (const tr of st.mode2?.traces || []) {
    if (!tr || tr.enabled === false) continue;
    const id = mode2TraceSkeletonId(tr.id);
    const rect = getDrawRect(id, defaultRects);
    if (!rect) continue;
    const lm = firstTraceLandmarks(tr, tScore);
    if (!lm) continue;
    slots.push({ id, rect, lm, video: null, world: null });
  }

  if (st.latestUserLandmarks) {
    const rect = getDrawRect(SKELETON_IDS.m2_user, defaultRects);
    if (rect) {
      slots.push({
        id: SKELETON_IDS.m2_user,
        rect,
        lm: st.latestUserLandmarks,
        video: els.video,
        world: st.latestUserWorldLandmarks,
      });
    }
  }

  return slots;
}

function collectMode1Slots(st, api) {
  const layout = api.getOverlayLayout();
  if (!layout) return [];
  const { defaultRects } = layout;
  const tScore = getTScore(st);
  const { SKELETON_IDS, getDrawRect, getDemoTraceByMode, getDemoLandmarksAtTime } = api;
  const slots = [];

  const hintMode =
    st.ui?.hintMode === "hard" || st.ui?.hintMode === "user" ? st.ui.hintMode : "easy";
  const trace = st.recorder?.armed ? null : getDemoTraceByMode(hintMode);
  const demoLm =
    st.ui?.mode1DemoEnabled && trace?.samples && typeof tScore === "number"
      ? getDemoLandmarksAtTime(trace.samples, tScore)
      : null;

  if (demoLm) {
    const demoIds = [
      SKELETON_IDS.m1_demo_0,
      SKELETON_IDS.m1_demo_1,
      SKELETON_IDS.m1_demo_2,
      SKELETON_IDS.m1_demo_3,
    ];
    for (const id of demoIds) {
      const rect = getDrawRect(id, defaultRects);
      if (!rect) continue;
      slots.push({ id, rect, lm: demoLm, video: null, world: null });
    }
  }

  if (st.latestUserLandmarks) {
    const rect = getDrawRect(SKELETON_IDS.m1_user, defaultRects);
    if (rect) {
      slots.push({
        id: SKELETON_IDS.m1_user,
        rect,
        lm: st.latestUserLandmarks,
        video: els.video,
        world: st.latestUserWorldLandmarks,
      });
    }
  }

  return slots;
}

function collectSlots(st, api) {
  if (st.ui?.mode === "mode2") return collectMode2Slots(st, api);
  return collectMode1Slots(st, api);
}

async function syncVrmPool(neededIds) {
  for (const [id, entry] of vrmState.pool.entries()) {
    if (!neededIds.has(id)) {
      disposeVrmEntry(entry);
      vrmState.pool.delete(id);
    }
  }

  const pending = [];
  for (const id of neededIds) {
    if (vrmState.pool.has(id)) continue;
    vrmState.pool.set(id, { loading: true, vrm: null });
    pending.push(
      createVrmInstance()
        .then((vrm) => {
          vrm.scene.visible = false;
          vrmState.scene.add(vrm.scene);
          vrmState.pool.set(id, { loading: false, vrm });
        })
        .catch((e) => {
          console.error("[VRM] load failed", id, e);
          vrmState.pool.delete(id);
        }),
    );
  }

  if (pending.length) await Promise.all(pending);
  vrmState.ready = [...neededIds].every((id) => vrmState.pool.get(id)?.vrm);
}

function schedulePoolSync(neededIds) {
  const key = [...neededIds].sort().join("|");
  if (key === vrmState.poolKey) return;
  vrmState.poolKey = key;
  syncVrmPool(neededIds);
}

function updateSkinUi(drawn) {
  if (drawn > 0) {
    vrmState.skinApplied = true;
    setSkinActive(true);
    if (els.toggle) els.toggle.textContent = "關閉套皮";
    return;
  }
  vrmState.skinApplied = false;
  setSkinActive(false);
  if (vrmState.active && els.toggle) els.toggle.textContent = "載入套皮…";
}

function vrmFrame() {
  if (!vrmState.active) return;
  vrmState.raf = requestAnimationFrame(vrmFrame);

  const st = window.__posedanceTestState;
  const api = window.__posedanceTestApi;
  if (!st || !api || !vrmState.renderer) return;

  const slots = collectSlots(st, api);
  const neededIds = new Set(slots.map((s) => s.id));
  schedulePoolSync(neededIds);

  const renderer = vrmState.renderer;
  const scene = vrmState.scene;
  const camera = vrmState.camera;
  const delta = vrmState.clock.getDelta();

  renderer.setScissorTest(true);
  renderer.clear(true, true, true);

  let drawn = 0;
  for (const slot of slots) {
    const vrm = vrmState.pool.get(slot.id)?.vrm;
    if (!vrm) continue;

    const poseOffset = st.interact?.poseOffsets?.[slot.id] ?? null;
    const posed = applyLmToVrm(
      vrm,
      slot.lm,
      slot.world,
      getKalidokitSolveOptions(slot),
      poseOffset,
    );
    if (!posed) continue;
    vrm.update?.(delta);

    for (const [, e] of vrmState.pool) {
      if (e?.vrm?.scene) e.vrm.scene.visible = e.vrm === vrm;
    }

    frameVrmToViewport(vrm, camera, slot.rect);
    setViewportFromRect(renderer, slot.rect);
    renderer.render(scene, camera);
    drawn += 1;
  }

  const fullW = renderer.domElement.width;
  const fullH = renderer.domElement.height;
  renderer.setViewport(0, 0, fullW, fullH);
  renderer.setScissorTest(false);

  updateSkinUi(drawn);
}

async function ensureRendererReady() {
  if (!vrmState.renderer) initThree();
  onVrmResize();
}

async function showVrmSkin() {
  await ensureRendererReady();
  if (els.canvas) els.canvas.hidden = false;

  vrmState.active = true;
  vrmState.skinApplied = false;
  setSkinActive(false);
  els.toggle?.classList.add("btn-vrm-on");
  if (els.toggle) els.toggle.textContent = "載入套皮…";

  cancelAnimationFrame(vrmState.raf);
  vrmFrame();
}

function hideVrmSkin() {
  vrmState.active = false;
  vrmState.skinApplied = false;
  setSkinActive(false);
  cancelAnimationFrame(vrmState.raf);

  if (els.canvas) els.canvas.hidden = true;
  if (vrmState.renderer) vrmState.renderer.clear(true, true, true);

  els.toggle?.classList.remove("btn-vrm-on");
  if (els.toggle) els.toggle.textContent = "3D 套皮";
}

async function boot() {
  if (els.toggle) {
    els.toggle.addEventListener("click", () => {
      if (vrmState.active) hideVrmSkin();
      else showVrmSkin();
    });
  }

  try {
    await waitForTestState();
    if (els.toggle) els.toggle.disabled = false;
    fetchVrmBuffer().catch((e) => console.warn("[VRM] 預載失敗（按套皮時會重試）", e));
  } catch (e) {
    console.warn("[VRM]", e);
  }
}

boot();
