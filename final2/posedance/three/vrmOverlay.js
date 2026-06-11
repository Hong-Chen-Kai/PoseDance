/**
 * vrmOverlay.js — 掛在 posedanceTest 上的 3D VRM 套皮（讀 __posedanceTestState）
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { Pose } from "kalidokit";
import {
  createSyntheticTrace,
  getSyntheticLandmarksAtTime,
} from "../proceduralSkeleton.js";

const VRM_URL = new URL("./assets/avatar-sample.vrm", import.meta.url).href;

const AVATAR_SLOTS = Object.freeze({
  user: { x: -1.35 },
  synth: { x: 0 },
  trace: { x: 1.35 },
});

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
  panel: document.getElementById("vrmPanel"),
  canvas: document.getElementById("avatar_canvas"),
  status: document.getElementById("vrmStatusBar"),
  toggle: document.getElementById("toggleVrmButton"),
  video: document.getElementById("input_video"),
};

const vrmState = {
  active: false,
  ready: false,
  vrms: { user: null, synth: null, trace: null },
  fallbackSynth: null,
  fallbackStart: 0,
  clock: null,
  scene: null,
  camera: null,
  renderer: null,
  raf: 0,
};

function setVrmStatus(text, ok = null) {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.classList.toggle("ok", ok === true);
  els.status.classList.toggle("err", ok === false);
}

function waitForTestState(maxMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (window.__posedanceTestState) {
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

function getTScore(st) {
  try {
    const t = st.player?.getCurrentTime?.();
    if (typeof t === "number" && Number.isFinite(t)) return t;
  } catch {
    /* ignore */
  }
  return null;
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
  let world = worldRaw && worldRaw.length === 33 ? mirrorWorldLandmarks(worldRaw) : mpToWorldApprox(mp);
  return applyPoseToVrm(vrm, mp, world, videoEl);
}

async function loadVRM(url) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error("VRM not found");
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
  });
  return vrm;
}

function initThree() {
  const wrap = els.canvas.parentElement;
  const w = wrap.clientWidth || 800;
  const h = wrap.clientHeight || 480;

  vrmState.scene = new THREE.Scene();
  vrmState.scene.background = new THREE.Color(0x0f172a);
  vrmState.camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 50);
  vrmState.camera.position.set(0, 1.25, 3.4);
  vrmState.camera.lookAt(0, 1, 0);

  vrmState.renderer = new THREE.WebGLRenderer({
    canvas: els.canvas,
    antialias: true,
  });
  vrmState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  vrmState.renderer.setSize(w, h, false);
  vrmState.renderer.outputColorSpace = THREE.SRGBColorSpace;

  vrmState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(1, 3, 2);
  vrmState.scene.add(dir);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(3.5, 48),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  vrmState.scene.add(floor);

  vrmState.clock = new THREE.Clock();
  window.addEventListener("resize", onVrmResize);
}

function onVrmResize() {
  if (!vrmState.renderer || !vrmState.camera || !els.canvas) return;
  const wrap = els.canvas.parentElement;
  const w = wrap.clientWidth || 800;
  const h = wrap.clientHeight || 480;
  vrmState.camera.aspect = w / h;
  vrmState.camera.updateProjectionMatrix();
  vrmState.renderer.setSize(w, h, false);
}

function placeVrm(vrm, slotKey) {
  vrm.scene.position.set(AVATAR_SLOTS[slotKey].x, 0, 0);
  vrmState.scene.add(vrm.scene);
}

async function initVrmAvatars() {
  setVrmStatus("載入 VRM…");
  vrmState.vrms.user = placeVrm(await loadVRM(VRM_URL), "user");
  setVrmStatus("載入 VRM 2/3…");
  vrmState.vrms.synth = placeVrm(await loadVRM(VRM_URL), "synth");
  setVrmStatus("載入 VRM 3/3…");
  vrmState.vrms.trace = placeVrm(await loadVRM(VRM_URL), "trace");
  vrmState.fallbackSynth = createSyntheticTrace({ bpm: 120, grooveMode: "bounce" });
  vrmState.fallbackStart = performance.now() / 1000;
  vrmState.ready = true;
  setVrmStatus("3D 就緒 · 左：使用者 · 中：程序化 · 右：錄製/demo", true);
}

function pickSources(st) {
  const tScore = getTScore(st);
  const synthTime = tScore ?? performance.now() / 1000 - vrmState.fallbackStart;

  let synthLm = null;
  let traceLm = null;

  if (st.ui?.mode === "mode2") {
    const traces = st.mode2?.traces || [];
    const synthTr = traces.find((tr) => tr?.synthetic && tr.enabled !== false);
    const recTr = traces.find((tr) => tr && !tr.synthetic && tr.enabled !== false);
    if (synthTr) synthLm = getSyntheticLandmarksAtTime(synthTr, synthTime);
    if (recTr?.data?.samples && typeof tScore === "number") {
      traceLm = getLandmarksAtTime(recTr.data.samples, tScore);
    } else if (recTr?.data?.samples) {
      traceLm = getLandmarksAtTime(recTr.data.samples, synthTime);
    }
  } else {
    const hint = st.ui?.hintMode === "hard" ? "hard" : "easy";
    const data = hint === "hard" ? st.demo?.hard : st.demo?.easy;
    if (data?.samples) {
      const t = typeof tScore === "number" ? tScore : synthTime;
      traceLm = getLandmarksAtTime(data.samples, t);
    }
  }

  if (!synthLm && vrmState.fallbackSynth) {
    synthLm = getSyntheticLandmarksAtTime(vrmState.fallbackSynth, synthTime);
  }

  return {
    userLm: st.latestUserLandmarks,
    userWorld: st.latestUserWorldLandmarks,
    synthLm,
    traceLm,
  };
}

function vrmFrame() {
  if (!vrmState.active || !vrmState.ready) return;
  vrmState.raf = requestAnimationFrame(vrmFrame);
  const delta = vrmState.clock.getDelta();
  const st = window.__posedanceTestState;
  if (!st) return;

  const { userLm, userWorld, synthLm, traceLm } = pickSources(st);

  if (userLm && vrmState.vrms.user) {
    applyLmToVrm(vrmState.vrms.user, userLm, els.video, {
      mirror: true,
      worldRaw: userWorld,
    });
  }
  if (synthLm && vrmState.vrms.synth) {
    applyLmToVrm(vrmState.vrms.synth, synthLm, null);
  }
  if (traceLm && vrmState.vrms.trace) {
    applyLmToVrm(vrmState.vrms.trace, traceLm, null);
  }

  for (const vrm of Object.values(vrmState.vrms)) {
    vrm?.update?.(delta);
  }
  vrmState.renderer.render(vrmState.scene, vrmState.camera);
}

async function showVrmPanel() {
  if (!els.panel) return;
  els.panel.hidden = false;
  vrmState.active = true;
  els.toggle?.classList.add("btn-vrm-on");
  els.toggle.textContent = "關閉 3D";

  if (!vrmState.renderer) {
    initThree();
    try {
      await initVrmAvatars();
    } catch (e) {
      console.error(e);
      setVrmStatus(`VRM 載入失敗：${e.message}`, false);
      return;
    }
  }

  onVrmResize();
  cancelAnimationFrame(vrmState.raf);
  vrmFrame();
}

function hideVrmPanel() {
  vrmState.active = false;
  cancelAnimationFrame(vrmState.raf);
  if (els.panel) els.panel.hidden = true;
  els.toggle?.classList.remove("btn-vrm-on");
  if (els.toggle) els.toggle.textContent = "3D 套皮";
}

async function boot() {
  if (els.toggle) {
    els.toggle.addEventListener("click", () => {
      if (vrmState.active) hideVrmPanel();
      else showVrmPanel();
    });
  }

  try {
    await waitForTestState();
    if (els.toggle) els.toggle.disabled = false;
  } catch (e) {
    console.warn("[VRM]", e);
    setVrmStatus("posedanceTest 未載入", false);
  }
}

boot();
