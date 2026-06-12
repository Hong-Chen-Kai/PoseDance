/**
 * vrmOverlay.js — 可開關的 VRM 套皮層（Mode 1 / 2，跟隨 getDrawRect）
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { Pose } from "kalidokit";
import { getSyntheticLandmarksAtTime } from "../proceduralSkeleton.js";

const VRM_URL = new URL("./assets/avatar-sample.vrm", import.meta.url).href;
const VRM_ASSET_BASE = new URL("./assets/", import.meta.url).href;
const REF_VIEWPORT_H = 280;

const BONE_MAP = Object.freeze({
  Hips: "hips",
  Spine: "spine",
  Chest: "chest",
  RightUpperArm: "rightUpperArm",
  RightLowerArm: "rightLowerArm",
  LeftUpperArm: "leftUpperArm",
  LeftLowerArm: "leftLowerArm",
  RightUpperLeg: "rightUpperLeg",
  RightLowerLeg: "rightLowerLeg",
  LeftUpperLeg: "leftUpperLeg",
  LeftLowerLeg: "leftLowerLeg",
});

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

function lmArrayToMp(lm) {
  if (!lm || lm.length !== 33) return null;
  if (typeof lm[0]?.x === "number") return lm;
  return lm.map((p) => {
    if (!p) return { x: 0, y: 0, z: 0, visibility: 0 };
    const [x, y, z, v] = p;
    return { x, y, z: z ?? 0, visibility: v ?? 1 };
  });
}

function mpToWorldApprox(mp) {
  if (!mp) return null;
  const hipL = mp[23];
  const hipR = mp[24];
  const cx = hipL && hipR ? (hipL.x + hipR.x) / 2 : 0.5;
  const cy = hipL && hipR ? (hipL.y + hipR.y) / 2 : 0.5;
  const scale = 2;
  return mp.map((p) => ({
    x: (p.x - cx) * scale,
    y: -(p.y - cy) * scale,
    z: -(p.z ?? 0) * scale,
    visibility: p.visibility,
  }));
}

function mirrorMpLandmarks(mp) {
  if (!mp) return null;
  return mp.map((p) => ({ ...p, x: 1 - p.x }));
}

function mirrorWorldLandmarks(world) {
  if (!world) return null;
  return world.map((p) => ({
    x: -(p.x ?? 0),
    y: p.y ?? 0,
    z: p.z ?? 0,
    visibility: p.visibility ?? 1,
  }));
}

function rigRotation(vrm, boneKey, rotation, dampener = 1, lerpAmount = 0.35) {
  if (!vrm || !rotation) return;
  const boneName = BONE_MAP[boneKey];
  if (!boneName) return;
  const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!bone) return;
  const euler = new THREE.Euler(
    rotation.x * dampener,
    rotation.y * dampener,
    rotation.z * dampener,
  );
  const q = new THREE.Quaternion().setFromEuler(euler);
  bone.quaternion.slerp(q, lerpAmount);
}

function rigPosition(vrm, boneKey, position, lerpAmount = 0.07) {
  if (!vrm || !position) return;
  const boneName = BONE_MAP[boneKey];
  if (!boneName) return;
  const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!bone) return;
  bone.position.lerp(new THREE.Vector3(position.x, position.y, position.z), lerpAmount);
}

function applyPoseToVrm(vrm, pose2D, pose3D, videoEl) {
  if (!vrm || !pose2D) return false;
  const world = pose3D || mpToWorldApprox(pose2D);
  const solveOpts = { runtime: "mediapipe", enableLegs: true };
  if (videoEl?.videoWidth > 0) solveOpts.video = videoEl;
  else solveOpts.imageSize = { width: 640, height: 480 };

  let rigged;
  try {
    rigged = Pose.solve(world, pose2D, solveOpts);
  } catch {
    return false;
  }
  if (!rigged) return false;

  rigRotation(vrm, "Hips", rigged.Hips?.rotation, 0.7);
  rigPosition(vrm, "Hips", {
    x: rigged.Hips?.position?.x ?? 0,
    y: (rigged.Hips?.position?.y ?? 0) + 0.05,
    z: -(rigged.Hips?.position?.z ?? 0),
  });
  rigRotation(vrm, "Chest", rigged.Spine, 0.25);
  rigRotation(vrm, "Spine", rigged.Spine, 0.45);
  rigRotation(vrm, "RightUpperArm", rigged.RightUpperArm);
  rigRotation(vrm, "RightLowerArm", rigged.RightLowerArm);
  rigRotation(vrm, "LeftUpperArm", rigged.LeftUpperArm);
  rigRotation(vrm, "LeftLowerArm", rigged.LeftLowerArm);
  rigRotation(vrm, "LeftUpperLeg", rigged.LeftUpperLeg);
  rigRotation(vrm, "LeftLowerLeg", rigged.LeftLowerLeg);
  rigRotation(vrm, "RightUpperLeg", rigged.RightUpperLeg);
  rigRotation(vrm, "RightLowerLeg", rigged.RightLowerLeg);
  return true;
}

function applyLmToVrm(vrm, lm, videoEl, { mirror = false, worldRaw = null } = {}) {
  let mp = lmArrayToMp(lm);
  if (!mp) return false;
  if (mirror) mp = mirrorMpLandmarks(mp);
  const world =
    worldRaw && worldRaw.length === 33 ? mirrorWorldLandmarks(worldRaw) : mpToWorldApprox(mp);
  return applyPoseToVrm(vrm, mp, world, videoEl);
}

async function fetchVrmBuffer() {
  if (!vrmState.vrmBufferPromise) {
    vrmState.vrmBufferPromise = fetch(VRM_URL, { cache: "force-cache" }).then(async (res) => {
      if (!res.ok) throw new Error(`VRM HTTP ${res.status}：${VRM_URL}`);
      return res.arrayBuffer();
    });
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
  vrmState.camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 50);
  vrmState.camera.position.set(0, 1.05, 3.2);
  vrmState.camera.lookAt(0, 0.95, 0);

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
  if (!vrmState.renderer || !vrmState.camera) return;
  const wrap = els.wrap || els.canvas?.parentElement;
  const w = wrap?.clientWidth || 800;
  const h = wrap?.clientHeight || 480;
  vrmState.camera.aspect = w / h;
  vrmState.camera.updateProjectionMatrix();
  vrmState.renderer.setSize(w, h, false);
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

function applyRectScale(vrm, rect) {
  const s = THREE.MathUtils.clamp(rect.dh / REF_VIEWPORT_H, 0.42, 1.85);
  vrm.scene.scale.setScalar(s);
}

function updateCameraForRect(rect) {
  const cam = vrmState.camera;
  cam.aspect = rect.dw / Math.max(1, rect.dh);
  cam.position.set(0, 1.05, 3.2);
  cam.lookAt(0, 0.95, 0);
  cam.updateProjectionMatrix();
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
    slots.push({ id, rect, lm, mirror: false, video: null, world: null });
  }

  if (st.latestUserLandmarks) {
    const rect = getDrawRect(SKELETON_IDS.m2_user, defaultRects);
    if (rect) {
      slots.push({
        id: SKELETON_IDS.m2_user,
        rect,
        lm: st.latestUserLandmarks,
        mirror: true,
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
      slots.push({ id, rect, lm: demoLm, mirror: false, video: null, world: null });
    }
  }

  if (st.latestUserLandmarks) {
    const rect = getDrawRect(SKELETON_IDS.m1_user, defaultRects);
    if (rect) {
      slots.push({
        id: SKELETON_IDS.m1_user,
        rect,
        lm: st.latestUserLandmarks,
        mirror: true,
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

    applyLmToVrm(vrm, slot.lm, slot.video, {
      mirror: slot.mirror,
      worldRaw: slot.world,
    });
    applyRectScale(vrm, slot.rect);
    vrm.update?.(delta);

    for (const [, e] of vrmState.pool) {
      if (e?.vrm?.scene) e.vrm.scene.visible = e.vrm === vrm;
    }

    updateCameraForRect(slot.rect);
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
