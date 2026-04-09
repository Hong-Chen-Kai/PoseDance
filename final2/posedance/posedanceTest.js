import { PoseModel, POSE_LANDMARKS } from "./poseTask.js";

const DEMO_SOURCE_ASPECT = 16 / 9;
/** 以模組 URL 解析，避免部署子路徑或與 HTML 不同層級時 fetch 404 */
const DEMO_TRACE_PATHS = {
  easy: new URL("./demo/pose_trace_easy.json", import.meta.url).href,
  hard: new URL("./demo/pose_trace_hard.json", import.meta.url).href,
};

const DEMO_POSE_CONNECTIONS = [
  [POSE_LANDMARKS.LEFT_EYE, POSE_LANDMARKS.RIGHT_EYE],
  [POSE_LANDMARKS.LEFT_EYE, POSE_LANDMARKS.NOSE],
  [POSE_LANDMARKS.RIGHT_EYE, POSE_LANDMARKS.NOSE],
  [POSE_LANDMARKS.LEFT_EYE, POSE_LANDMARKS.LEFT_EAR],
  [POSE_LANDMARKS.RIGHT_EYE, POSE_LANDMARKS.RIGHT_EAR],
  [POSE_LANDMARKS.MOUTH_LEFT, POSE_LANDMARKS.MOUTH_RIGHT],
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.RIGHT_SHOULDER],
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_ELBOW],
  [POSE_LANDMARKS.LEFT_ELBOW, POSE_LANDMARKS.LEFT_WRIST],
  [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_ELBOW],
  [POSE_LANDMARKS.RIGHT_ELBOW, POSE_LANDMARKS.RIGHT_WRIST],
  [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_INDEX],
  [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_PINKY],
  [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_THUMB],
  [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_INDEX],
  [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_PINKY],
  [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_THUMB],
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_HIP],
  [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_HIP],
  [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.RIGHT_HIP],
  [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.LEFT_KNEE],
  [POSE_LANDMARKS.LEFT_KNEE, POSE_LANDMARKS.LEFT_ANKLE],
  [POSE_LANDMARKS.LEFT_ANKLE, POSE_LANDMARKS.LEFT_HEEL],
  [POSE_LANDMARKS.LEFT_ANKLE, POSE_LANDMARKS.LEFT_FOOT_INDEX],
  [POSE_LANDMARKS.LEFT_HEEL, POSE_LANDMARKS.LEFT_FOOT_INDEX],
  [POSE_LANDMARKS.RIGHT_HIP, POSE_LANDMARKS.RIGHT_KNEE],
  [POSE_LANDMARKS.RIGHT_KNEE, POSE_LANDMARKS.RIGHT_ANKLE],
  [POSE_LANDMARKS.RIGHT_ANKLE, POSE_LANDMARKS.RIGHT_HEEL],
  [POSE_LANDMARKS.RIGHT_ANKLE, POSE_LANDMARKS.RIGHT_FOOT_INDEX],
  [POSE_LANDMARKS.RIGHT_HEEL, POSE_LANDMARKS.RIGHT_FOOT_INDEX],
];

const state = {
  player: null,
  ready: false,
  ytInitStarted: false,
  videoId: null,
  lastLoadedVideoId: null,

  demo: { easy: null, hard: null },

  ui: {
    hintMode: "easy",
  },

  // Pose
  poseReady: false,
  cameraRunning: false,
  poseLoopActive: false,
  cameraStream: null,
  latestUserLandmarks: null,

  // Similarity (Phase 1: time window only)
  similarity: {
    visibilityThreshold: 0.5,
    k: 1.2,
    windowSec: 0.25,
    sigmaTimeSec: 0.12,
    tauDist: 0.12,
    minValidPoints: 15,
    historySec: 4,
    energyE0: 0.08,
    energyE1: 0.35,
    energyMinWeight: 0.1,
  },

  // Rolling overall buffers (Phase 1)
  overall: {
    easy: [],
    hard: [],
  },

  orange: {
    active: false,
    enterGoodSec: 0,
    exitBadSec: 0,
    window: [],
    lastT: null,
    enterThreshold: 85,
    enterRequireSec: 3,
    enterInstantMajorityRatio: 0.6,
    exitThreshold: 80,
    exitRequireSec: 1.5,
    exitInstantMajorityRatio: 0.6,
  },
};

const els = {};
function $(id) {
  return document.getElementById(id);
}

function initDomRefs() {
  els.similarityEasyText = $("similarityEasyText");
  els.similarityHardText = $("similarityHardText");
  els.overallEasyText = $("overallEasyText");
  els.overallHardText = $("overallHardText");
  els.videoUrlInput = $("videoUrlInput");
  els.hintModeSelect = $("hintModeSelect");
  els.loadVideoButton = $("loadVideoButton");
  els.startCameraButton = $("startCameraButton");
  els.poseInfoText = $("poseInfoText");

  els.inputVideo = $("input_video");
  els.outputCanvas = $("output_canvas");
  els.overlayCanvas = $("overlay_canvas");
  els.demoCanvasEasy = $("demo_canvas_easy");
  els.demoCanvasHard = $("demo_canvas_hard");

  els.ytWrapper = $("ytPlayerWrapper");
  els.ytDragHandle = $("ytDragHandle");
  els.ytResizeHandle = $("ytResizeHandle");

  if (els.poseInfoText) els.poseInfoText.style.display = "none";
}

function setUi({
  easy = "—",
  hard = "—",
  overallEasy = "—",
  overallHard = "—",
} = {}) {
  if (els.similarityEasyText) els.similarityEasyText.textContent = easy;
  if (els.similarityHardText) els.similarityHardText.textContent = hard;
  if (els.overallEasyText) els.overallEasyText.textContent = overallEasy;
  if (els.overallHardText) els.overallHardText.textContent = overallHard;
}

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be")
      return url.pathname.replace("/", "") || null;
    const v = url.searchParams.get("v");
    if (v) return v;
  } catch {
    // ignore
  }
  return null;
}

function loadVideoByIdIfReady() {
  if (
    !state.ready ||
    !state.player ||
    !state.videoId ||
    typeof state.player.loadVideoById !== "function"
  ) {
    return false;
  }
  if (state.lastLoadedVideoId === state.videoId) return true;
  state.player.loadVideoById(state.videoId);
  state.lastLoadedVideoId = state.videoId;
  return true;
}

function initYouTubePlayerIfPossible() {
  if (state.ytInitStarted) return;
  if (state.player) return;
  const YTGlobal = typeof window !== "undefined" ? window.YT : null;
  if (!YTGlobal || typeof YTGlobal.Player !== "function") return;

  state.ytInitStarted = true;
  state.player = new YT.Player("player", {
    height: "180",
    width: "320",
    videoId: state.videoId || "dQw4w9WgXcQ",
    playerVars: {
      playsinline: 1,
      enablejsapi: 1,
      origin:
        typeof window !== "undefined" ? window.location.origin : undefined,
    },
    events: {
      onReady: () => {
        state.ready = true;
        loadVideoByIdIfReady();
      },
      onError: (event) => {
        console.error("[YouTube] errorCode =", event.data);
      },
    },
  });
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  initYouTubePlayerIfPossible();
};

function setupYtFloatingWindow() {
  if (!els.ytWrapper) return;

  const wrapper = els.ytWrapper;
  const dragHandle = els.ytDragHandle || wrapper;
  const resizeHandle = els.ytResizeHandle;

  const minW = 200;
  const minH = 140;
  const maxW = Math.min(window.innerWidth - 16, 720);
  const maxH = Math.min(window.innerHeight - 16, 540);

  const readRect = () => wrapper.getBoundingClientRect();

  const initRect = readRect();
  wrapper.style.left = `${Math.max(16, initRect.left)}px`;
  wrapper.style.top = `${Math.max(16, initRect.top)}px`;
  wrapper.style.right = "auto";
  wrapper.style.bottom = "auto";

  if (dragHandle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - startX;
      const dy = clientY - startY;
      const nextLeft = Math.min(
        Math.max(0, startLeft + dx),
        window.innerWidth - readRect().width,
      );
      const nextTop = Math.min(
        Math.max(0, startTop + dy),
        window.innerHeight - readRect().height,
      );
      wrapper.style.left = `${nextLeft}px`;
      wrapper.style.top = `${nextTop}px`;
    };

    const stop = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", stop);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", stop);
      dragHandle.style.cursor = "grab";
    };

    const start = (e) => {
      dragging = true;
      dragHandle.style.cursor = "grabbing";
      const rect = readRect();
      startLeft = rect.left;
      startTop = rect.top;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", stop);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", stop);
    };

    dragHandle.addEventListener("mousedown", start);
    dragHandle.addEventListener("touchstart", (e) => {
      e.preventDefault();
      start(e);
    });
  }

  if (resizeHandle) {
    let resizing = false;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let startW = 0;
    let startH = 0;

    const onResizeMove = (e) => {
      if (!resizing) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - resizeStartX;
      const dy = clientY - resizeStartY;
      const nextW = Math.min(Math.max(minW, startW + dx), maxW);
      const nextH = Math.min(Math.max(minH, startH + dy), maxH);
      wrapper.style.width = `${nextW}px`;
      wrapper.style.height = `${nextH}px`;
    };

    const stopResize = () => {
      resizing = false;
      document.removeEventListener("mousemove", onResizeMove);
      document.removeEventListener("mouseup", stopResize);
      document.removeEventListener("touchmove", onResizeMove);
      document.removeEventListener("touchend", stopResize);
    };

    const startResize = (e) => {
      resizing = true;
      const rect = readRect();
      startW = rect.width;
      startH = rect.height;
      resizeStartX = e.touches ? e.touches[0].clientX : e.clientX;
      resizeStartY = e.touches ? e.touches[0].clientY : e.clientY;
      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup", stopResize);
      document.addEventListener("touchmove", onResizeMove, { passive: false });
      document.addEventListener("touchend", stopResize);
    };

    resizeHandle.addEventListener("mousedown", startResize);
    resizeHandle.addEventListener("touchstart", (e) => {
      e.preventDefault();
      startResize(e);
    });
  }
}

async function loadDemoTrace(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const hint =
      res.status === 404 ? "（請確認已 commit / push demo JSON 至儲存庫）" : "";
    throw new Error(`HTTP ${res.status} 載入失敗：${url} ${hint}`.trim());
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.samples))
    throw new Error(`格式無效（需含 samples[]）：${url}`);
  return data;
}

function computeContainRect(width, height, sourceAspect) {
  const canvasAspect = width / Math.max(1, height);
  if (canvasAspect > sourceAspect) {
    const drawH = height;
    const drawW = drawH * sourceAspect;
    return { ox: (width - drawW) / 2, oy: 0, dw: drawW, dh: drawH };
  }
  const drawW = width;
  const drawH = drawW / sourceAspect;
  return { ox: 0, oy: (height - drawH) / 2, dw: drawW, dh: drawH };
}

function getDemoTimeBracket(samples, t) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  if (samples.length === 1)
    return { left: samples[0], right: samples[0], alpha: 0 };
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
      typeof az === "number" && typeof bz === "number"
        ? az + (bz - az) * alpha
        : (az ?? bz),
      typeof av === "number" && typeof bv === "number"
        ? av + (bv - av) * alpha
        : (av ?? bv),
    ]);
  }
  return out;
}

function getDemoLandmarksAtTime(samples, t) {
  const br = getDemoTimeBracket(samples, t);
  if (!br) return null;
  const { left, right, alpha } = br;
  if (!left || !Array.isArray(left.lm)) return null;
  if (left === right || alpha <= 0) return left.lm;
  if (!right || !Array.isArray(right.lm)) return left.lm;
  return interpolateLandmarks(left.lm, right.lm, alpha);
}

function drawDemoSkeletonAtTime(trace, canvas, currentTime) {
  if (!trace || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = Math.max(1, Math.floor(canvas.clientWidth));
  const h = Math.max(1, Math.floor(canvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.floor(w * dpr));
  const targetH = Math.max(1, Math.floor(h * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const tEnd = trace?.samples?.length
    ? trace.samples[trace.samples.length - 1]?.t
    : Infinity;
  if (typeof tEnd === "number" && currentTime > tEnd) {
    ctx.restore();
    return;
  }

  const lm = getDemoLandmarksAtTime(trace.samples, currentTime);
  if (!lm) {
    ctx.restore();
    return;
  }

  const rect = computeContainRect(w, h, DEMO_SOURCE_ASPECT);
  ctx.strokeStyle = "rgba(34, 197, 94, 0.95)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const [a, b] of DEMO_POSE_CONNECTIONS) {
    const pa = lm[a];
    const pb = lm[b];
    if (!pa || !pb) continue;
    const [ax, ay, , av] = pa;
    const [bx, by, , bv] = pb;
    if (
      typeof ax !== "number" ||
      typeof ay !== "number" ||
      typeof bx !== "number" ||
      typeof by !== "number"
    )
      continue;
    if (
      (typeof av === "number" && av <= 0.5) ||
      (typeof bv === "number" && bv <= 0.5)
    )
      continue;
    ctx.beginPath();
    ctx.moveTo(rect.ox + ax * rect.dw, rect.oy + ay * rect.dh);
    ctx.lineTo(rect.ox + bx * rect.dw, rect.oy + by * rect.dh);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
  for (const point of lm) {
    if (!point) continue;
    const [x, y, , v] = point;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (typeof v === "number" && v <= 0.5) continue;
    ctx.beginPath();
    ctx.arc(rect.ox + x * rect.dw, rect.oy + y * rect.dh, 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.restore();
}

function getLmXYV(lm) {
  if (!lm) return null;
  const x = typeof lm.x === "number" ? lm.x : null;
  const y = typeof lm.y === "number" ? lm.y : null;
  const v = typeof lm.visibility === "number" ? lm.visibility : null;
  if (x === null || y === null) return null;
  return { x, y, v };
}

function getArrXYV(arr) {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const [x, y, , v] = arr;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y, v: typeof v === "number" ? v : null };
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function center2(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const PARTS = Object.freeze({
  leftArm: "leftArm",
  rightArm: "rightArm",
  leftLeg: "leftLeg",
  rightLeg: "rightLeg",
  torso: "torso",
});

const PART_POINT_SETS = Object.freeze({
  [PARTS.leftArm]: [
    POSE_LANDMARKS.LEFT_SHOULDER,
    POSE_LANDMARKS.LEFT_ELBOW,
    POSE_LANDMARKS.LEFT_WRIST,
    POSE_LANDMARKS.LEFT_THUMB,
    POSE_LANDMARKS.LEFT_INDEX,
    POSE_LANDMARKS.LEFT_PINKY,
  ],
  [PARTS.rightArm]: [
    POSE_LANDMARKS.RIGHT_SHOULDER,
    POSE_LANDMARKS.RIGHT_ELBOW,
    POSE_LANDMARKS.RIGHT_WRIST,
    POSE_LANDMARKS.RIGHT_THUMB,
    POSE_LANDMARKS.RIGHT_INDEX,
    POSE_LANDMARKS.RIGHT_PINKY,
  ],
  [PARTS.leftLeg]: [
    POSE_LANDMARKS.LEFT_HIP,
    POSE_LANDMARKS.LEFT_KNEE,
    POSE_LANDMARKS.LEFT_ANKLE,
    POSE_LANDMARKS.LEFT_HEEL,
    POSE_LANDMARKS.LEFT_FOOT_INDEX,
  ],
  [PARTS.rightLeg]: [
    POSE_LANDMARKS.RIGHT_HIP,
    POSE_LANDMARKS.RIGHT_KNEE,
    POSE_LANDMARKS.RIGHT_ANKLE,
    POSE_LANDMARKS.RIGHT_HEEL,
    POSE_LANDMARKS.RIGHT_FOOT_INDEX,
  ],
  [PARTS.torso]: [
    POSE_LANDMARKS.LEFT_SHOULDER,
    POSE_LANDMARKS.RIGHT_SHOULDER,
    POSE_LANDMARKS.LEFT_HIP,
    POSE_LANDMARKS.RIGHT_HIP,
  ],
});

function partOfConnection(a, b) {
  const inSet = (set) => set.includes(a) && set.includes(b);
  if (inSet(PART_POINT_SETS[PARTS.leftArm])) return PARTS.leftArm;
  if (inSet(PART_POINT_SETS[PARTS.rightArm])) return PARTS.rightArm;
  if (inSet(PART_POINT_SETS[PARTS.leftLeg])) return PARTS.leftLeg;
  if (inSet(PART_POINT_SETS[PARTS.rightLeg])) return PARTS.rightLeg;
  return PARTS.torso;
}

function normalizePose2D(getPoint, visTh) {
  const lHip = getPoint(POSE_LANDMARKS.LEFT_HIP);
  const rHip = getPoint(POSE_LANDMARKS.RIGHT_HIP);
  const lSh = getPoint(POSE_LANDMARKS.LEFT_SHOULDER);
  const rSh = getPoint(POSE_LANDMARKS.RIGHT_SHOULDER);
  if (!lHip || !rHip || !lSh || !rSh) return null;
  if (
    (typeof lHip.v === "number" && lHip.v < visTh) ||
    (typeof rHip.v === "number" && rHip.v < visTh) ||
    (typeof lSh.v === "number" && lSh.v < visTh) ||
    (typeof rSh.v === "number" && rSh.v < visTh)
  ) {
    return null;
  }
  const hipC = center2(lHip, rHip);
  const shC = center2(lSh, rSh);
  const scale = dist2(shC, hipC);
  if (!Number.isFinite(scale) || scale < 1e-6) return null;

  const pts = [];
  for (let i = 0; i < 33; i += 1) {
    const p = getPoint(i);
    if (!p) {
      pts.push(null);
      continue;
    }
    const vOk = typeof p.v !== "number" || p.v >= visTh;
    if (!vOk) {
      pts.push(null);
      continue;
    }
    pts.push({
      x: (p.x - hipC.x) / scale,
      y: (p.y - hipC.y) / scale,
      v: p.v,
    });
  }
  return { pts };
}

function computeDemoEnergyForTrace(trace) {
  const cfg = state.similarity;
  const visTh = cfg.visibilityThreshold;
  const samples = trace?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return;

  let prevNorm = null;
  let prevT = null;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s || !Array.isArray(s.lm) || s.lm.length !== 33) continue;
    const t = typeof s.t === "number" && Number.isFinite(s.t) ? s.t : null;
    const norm = normalizePose2D((k) => getArrXYV(s.lm?.[k]), visTh);
    if (!norm || t === null) {
      s.E_ref = 0;
      prevNorm = null;
      prevT = null;
      continue;
    }

    let E = 0;
    if (prevNorm && typeof prevT === "number") {
      const dt = Math.max(1e-3, t - prevT);
      const dists = [];
      for (let j = 0; j < 33; j += 1) {
        const a = prevNorm.pts[j];
        const b = norm.pts[j];
        if (!a || !b) continue;
        const d = dist2(a, b);
        if (!Number.isFinite(d)) continue;
        dists.push(d / dt);
      }
      if (dists.length) {
        dists.sort((x, y) => x - y);
        E = dists[Math.floor(dists.length / 2)];
      }
    }

    s.E_ref = Number.isFinite(E) ? E : 0;
    prevNorm = norm;
    prevT = t;
  }
}

function computeDemoPartEnergyForTrace(trace) {
  const cfg = state.similarity;
  const visTh = cfg.visibilityThreshold;
  const samples = trace?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return;

  let prevNorm = null;
  let prevT = null;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s || !Array.isArray(s.lm) || s.lm.length !== 33) continue;
    const t = typeof s.t === "number" && Number.isFinite(s.t) ? s.t : null;
    const norm = normalizePose2D((k) => getArrXYV(s.lm?.[k]), visTh);
    if (!norm || t === null) {
      s.E_part = {
        [PARTS.leftArm]: 0,
        [PARTS.rightArm]: 0,
        [PARTS.leftLeg]: 0,
        [PARTS.rightLeg]: 0,
        [PARTS.torso]: 0,
      };
      prevNorm = null;
      prevT = null;
      continue;
    }

    const out = {
      [PARTS.leftArm]: 0,
      [PARTS.rightArm]: 0,
      [PARTS.leftLeg]: 0,
      [PARTS.rightLeg]: 0,
      [PARTS.torso]: 0,
    };

    if (prevNorm && typeof prevT === "number") {
      const dt = Math.max(1e-3, t - prevT);
      for (const [part, idxs] of Object.entries(PART_POINT_SETS)) {
        const dists = [];
        for (const j of idxs) {
          const a = prevNorm.pts[j];
          const b = norm.pts[j];
          if (!a || !b) continue;
          const d = dist2(a, b);
          if (!Number.isFinite(d)) continue;
          dists.push(d / dt);
        }
        if (dists.length) {
          dists.sort((x, y) => x - y);
          out[part] = dists[Math.floor(dists.length / 2)];
        }
      }
    }

    s.E_part = out;
    prevNorm = norm;
    prevT = t;
  }
}

function computeMeanDist(userLandmarks, demoLmArray) {
  const cfg = state.similarity;
  const visTh = cfg.visibilityThreshold;
  const userNorm = normalizePose2D((i) => getLmXYV(userLandmarks?.[i]), visTh);
  const demoNorm = normalizePose2D((i) => getArrXYV(demoLmArray?.[i]), visTh);
  if (!userNorm || !demoNorm) return { ok: false, reason: "weak_core" };

  let sum = 0;
  let n = 0;
  for (let i = 0; i < 33; i += 1) {
    const a = userNorm.pts[i];
    const b = demoNorm.pts[i];
    if (!a || !b) continue;
    const d = dist2(a, b);
    if (!Number.isFinite(d)) continue;
    sum += d;
    n += 1;
  }
  if (n < cfg.minValidPoints)
    return { ok: false, reason: "too_few_points", validPoints: n };
  return { ok: true, meanDist: sum / n, validPoints: n };
}

function lowerBoundByT(samples, t) {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function getCandidateRange(samples, t, windowSec) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const startT = t - windowSec;
  const endT = t + windowSec;
  const i0 = Math.max(0, lowerBoundByT(samples, startT));
  const i1 = Math.min(samples.length, lowerBoundByT(samples, endT + 1e-9));
  if (i1 <= i0) return null;
  return { i0, i1 };
}

function gaussian(dt, sigma) {
  if (!Number.isFinite(dt) || !Number.isFinite(sigma) || sigma <= 0) return 1;
  const x = dt / sigma;
  return Math.exp(-0.5 * x * x);
}

function computeWindowScoreD(userLandmarks, trace, t) {
  const cfg = state.similarity;
  if (!trace?.samples) return { ok: false, reason: "no_trace" };
  const samples = trace.samples;
  const range = getCandidateRange(samples, t, cfg.windowSec);
  if (!range) return { ok: false, reason: "no_candidates" };

  let sumW = 0;
  let sumD = 0;
  let sumWE = 0;
  let bestD = Infinity;
  let bestN = 0;

  for (let i = range.i0; i < range.i1; i += 1) {
    const s = samples[i];
    if (!s || !Array.isArray(s.lm) || s.lm.length !== 33) continue;
    const r = computeMeanDist(userLandmarks, s.lm);
    if (!r.ok) continue;
    const dt = Math.abs((typeof s.t === "number" ? s.t : t) - t);
    const wTime = gaussian(dt, cfg.sigmaTimeSec);
    const wPose = Math.exp(-r.meanDist / Math.max(1e-6, cfg.tauDist));
    const w = wTime * wPose;
    sumW += w;
    sumD += w * r.meanDist;
    sumWE +=
      w *
      (typeof s.E_ref === "number" && Number.isFinite(s.E_ref) ? s.E_ref : 0);
    if (r.meanDist < bestD) {
      bestD = r.meanDist;
      bestN = r.validPoints;
    }
  }

  if (!(sumW > 0)) return { ok: false, reason: "no_valid_candidates" };
  const meanDist = sumD / sumW;
  const ErefWin = sumWE / sumW;
  const score = Math.max(0, Math.min(100, 100 * Math.exp(-cfg.k * meanDist)));
  return { ok: true, score, meanDist, validPoints: bestN, ErefWin };
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function computeEnergyGateWeight(E) {
  const cfg = state.similarity;
  const E0 = cfg.energyE0;
  const E1 = Math.max(E0 + 1e-6, cfg.energyE1);
  const minW = cfg.energyMinWeight;
  const u = clamp01((E - E0) / (E1 - E0));
  return minW + (1 - minW) * u;
}

function pushOverall(buffer, nowT, score, w) {
  const cfg = state.similarity;
  const historySec = cfg.historySec;
  if (!Number.isFinite(nowT) || !Number.isFinite(score)) return null;
  const ww = Number.isFinite(w) ? w : 1;
  buffer.push({ t: nowT, score, w: ww });

  const cutoff = nowT - historySec;
  while (buffer.length && buffer[0].t < cutoff) buffer.shift();

  let sumW = 0;
  let sum = 0;
  for (const it of buffer) {
    if (!it) continue;
    const iw = Number.isFinite(it.w) ? it.w : 1;
    const is = Number.isFinite(it.score) ? it.score : null;
    if (is === null) continue;
    sumW += iw;
    sum += iw * is;
  }
  if (!(sumW > 0)) return null;
  return sum / sumW;
}

function computeActiveParts(trace, t) {
  const cfg = state.similarity;
  const samples = trace?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return new Set();
  const range = getCandidateRange(samples, t, cfg.windowSec);
  if (!range) return new Set();

  const sum = {
    [PARTS.leftArm]: 0,
    [PARTS.rightArm]: 0,
    [PARTS.leftLeg]: 0,
    [PARTS.rightLeg]: 0,
    [PARTS.torso]: 0,
  };
  let sumW = 0;

  for (let i = range.i0; i < range.i1; i += 1) {
    const s = samples[i];
    if (!s || !s.E_part) continue;
    const dt = Math.abs((typeof s.t === "number" ? s.t : t) - t);
    const w = gaussian(dt, cfg.sigmaTimeSec);
    sumW += w;
    sum[PARTS.leftArm] += w * (s.E_part[PARTS.leftArm] || 0);
    sum[PARTS.rightArm] += w * (s.E_part[PARTS.rightArm] || 0);
    sum[PARTS.leftLeg] += w * (s.E_part[PARTS.leftLeg] || 0);
    sum[PARTS.rightLeg] += w * (s.E_part[PARTS.rightLeg] || 0);
    sum[PARTS.torso] += w * (s.E_part[PARTS.torso] || 0);
  }

  if (!(sumW > 0)) return new Set();
  const avg = {
    [PARTS.leftArm]: sum[PARTS.leftArm] / sumW,
    [PARTS.rightArm]: sum[PARTS.rightArm] / sumW,
    [PARTS.leftLeg]: sum[PARTS.leftLeg] / sumW,
    [PARTS.rightLeg]: sum[PARTS.rightLeg] / sumW,
    [PARTS.torso]: sum[PARTS.torso] / sumW,
  };

  const vals = Object.values(avg);
  const maxE = Math.max(...vals, 0);
  const absTh = 0.12;
  const relTh = 0.6;

  const active = new Set();
  for (const [part, v] of Object.entries(avg)) {
    if (v >= absTh && v >= maxE * relTh) active.add(part);
  }
  return active;
}

function drawPoseConnections(
  ctx,
  points,
  getXYV,
  rect,
  colorByConnection,
  lineWidth = 3,
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  for (const [a, b] of DEMO_POSE_CONNECTIONS) {
    const pa = getXYV(points?.[a]);
    const pb = getXYV(points?.[b]);
    if (!pa || !pb) continue;
    if ((typeof pa.v === "number" && pa.v < 0.5) || (typeof pb.v === "number" && pb.v < 0.5)) continue;
    const c = typeof colorByConnection === "function" ? colorByConnection(a, b) : "rgba(255,255,255,0.95)";
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.moveTo(rect.ox + pa.x * rect.dw, rect.oy + pa.y * rect.dh);
    ctx.lineTo(rect.ox + pb.x * rect.dw, rect.oy + pb.y * rect.dh);
    ctx.stroke();
  }
}

function drawPosePoints(ctx, points, getXYV, rect, color, radius = 3.5) {
  ctx.fillStyle = color;
  for (let i = 0; i < 33; i += 1) {
    const p = getXYV(points?.[i]);
    if (!p) continue;
    if (typeof p.v === "number" && p.v < 0.5) continue;
    ctx.beginPath();
    ctx.arc(
      rect.ox + p.x * rect.dw,
      rect.oy + p.y * rect.dh,
      radius,
      0,
      2 * Math.PI,
    );
    ctx.fill();
  }
}

function getDemoTraceByMode(mode) {
  return mode === "hard" ? state.demo.hard : state.demo.easy;
}

function updateOrangeState(nowT, instantScore, overallScore) {
  const st = state.orange;
  if (!Number.isFinite(nowT)) return st.active;
  const dt = typeof st.lastT === "number" ? Math.max(0, nowT - st.lastT) : 0;
  st.lastT = nowT;

  const enterThr = st.enterThreshold;
  const exitThr = st.exitThreshold;

  const enterOkOverall =
    typeof overallScore === "number" && overallScore >= enterThr;
  const enterOkInstant =
    typeof instantScore === "number" && instantScore >= enterThr;

  const exitOkOverall = typeof overallScore === "number" && overallScore >= exitThr;
  const exitOkInstant = typeof instantScore === "number" && instantScore >= exitThr;

  st.window.push({ t: nowT, enterOk: enterOkInstant, exitOk: exitOkInstant });
  const winSec = st.active ? Math.max(st.exitRequireSec, 0.5) : Math.max(st.enterRequireSec, 0.5);
  const cutoff = nowT - winSec;
  while (st.window.length && st.window[0].t < cutoff) st.window.shift();

  let enterRatio = 0;
  let exitRatio = 0;
  if (st.window.length) {
    let enterN = 0;
    let exitN = 0;
    for (const it of st.window) {
      if (it.enterOk) enterN += 1;
      if (it.exitOk) exitN += 1;
    }
    enterRatio = enterN / st.window.length;
    exitRatio = exitN / st.window.length;
  }

  if (!st.active) {
    const ok = enterOkOverall && enterRatio >= st.enterInstantMajorityRatio;
    if (ok) st.enterGoodSec += dt;
    else st.enterGoodSec = 0;
    if (st.enterGoodSec >= st.enterRequireSec) {
      st.active = true;
      st.exitBadSec = 0;
      st.window = [];
    }
    return st.active;
  }

  // active: stay blue unless clearly deviating for a while
  const okStay = exitOkOverall && exitRatio >= st.exitInstantMajorityRatio;
  if (!okStay) st.exitBadSec += dt;
  else st.exitBadSec = 0;

  if (st.exitBadSec >= st.exitRequireSec) {
    st.active = false;
    st.enterGoodSec = 0;
    st.window = [];
  }

  return st.active;
}

function drawUserOverlay() {
  if (!els.outputCanvas || !els.inputVideo) return;
  const ctx = els.outputCanvas.getContext("2d");
  if (!ctx) return;

  const w = Math.max(1, Math.floor(els.outputCanvas.clientWidth));
  const h = Math.max(1, Math.floor(els.outputCanvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.floor(w * dpr));
  const targetH = Math.max(1, Math.floor(h * dpr));
  if (
    els.outputCanvas.width !== targetW ||
    els.outputCanvas.height !== targetH
  ) {
    els.outputCanvas.width = targetW;
    els.outputCanvas.height = targetH;
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
}

async function initPose() {
  if (!els.startCameraButton) return;

  els.startCameraButton.addEventListener("click", async () => {
    if (state.cameraRunning) {
      state.poseLoopActive = false;
      state.cameraRunning = false;
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach((t) => t.stop());
        state.cameraStream = null;
      }
      if (els.inputVideo) els.inputVideo.srcObject = null;
      els.startCameraButton.textContent = "啟動攝影機";
      state.latestUserLandmarks = null;
      drawUserOverlay();
      return;
    }

    try {
      els.startCameraButton.disabled = true;
      const poseInstance = await PoseModel.init();
      if (!poseInstance) throw new Error("MediaPipe PoseLandmarker 初始化失敗");

      PoseModel.setCallback((result) => {
        if (
          !result ||
          !Array.isArray(result.landmarks) ||
          result.landmarks.length !== 33
        ) {
          state.latestUserLandmarks = null;
          return;
        }
        state.latestUserLandmarks = result.landmarks;
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      state.cameraStream = stream;
      els.inputVideo.srcObject = stream;
      await els.inputVideo.play();

      // Pose loop
      let lastTimestamp = 0;
      let isProcessing = false;
      let pendingFrame = null;

      const processFrames = async () => {
        if (isProcessing || !pendingFrame) return;
        isProcessing = true;
        const frame = pendingFrame;
        pendingFrame = null;
        try {
          const currentTimestampMs = performance.now();
          let timestampUs = Math.floor(currentTimestampMs * 1000);
          if (timestampUs <= lastTimestamp) timestampUs = lastTimestamp + 1;
          lastTimestamp = timestampUs;
          await PoseModel.detect(frame, timestampUs);
        } catch (err) {
          console.error("Pose detect failed:", err);
        } finally {
          isProcessing = false;
          if (pendingFrame && !isProcessing)
            requestAnimationFrame(processFrames);
        }
      };

      const loop = () => {
        if (!state.poseLoopActive) return;
        if (els.inputVideo.readyState === els.inputVideo.HAVE_ENOUGH_DATA) {
          pendingFrame = els.inputVideo;
          if (!isProcessing) processFrames();
        }
        requestAnimationFrame(loop);
      };

      state.poseLoopActive = true;
      loop();
      state.cameraRunning = true;
      els.startCameraButton.textContent = "關閉攝影機";
      els.startCameraButton.disabled = false;
    } catch (err) {
      console.error(err);
      els.startCameraButton.disabled = false;
      els.startCameraButton.textContent = "啟動攝影機";
    }
  });
}

function getPlayerTimeSafe() {
  if (!state.player || typeof state.player.getCurrentTime !== "function")
    return null;
  try {
    const t = state.player.getCurrentTime();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function updateUiLoop() {
  requestAnimationFrame(updateUiLoop);

  const tRaw = getPlayerTimeSafe();
  const tDemo = typeof tRaw === "number" && Number.isFinite(tRaw) ? tRaw : 0;

  drawDemoSkeletonAtTime(state.demo.easy, els.demoCanvasEasy, tDemo);
  drawDemoSkeletonAtTime(state.demo.hard, els.demoCanvasHard, tDemo);

  const ytOk = Boolean(state.ready && state.player);
  const tScore =
    ytOk && typeof tRaw === "number" && Number.isFinite(tRaw) ? tRaw : null;

  if (!state.latestUserLandmarks) {
    setUi({ easy: "—", hard: "—", overallEasy: "—", overallHard: "—" });
    return;
  }

  if (tScore === null) {
    setUi({ easy: "—", hard: "—", overallEasy: "—", overallHard: "—" });
    return;
  }

  const rEasy = computeWindowScoreD(
    state.latestUserLandmarks,
    state.demo.easy,
    tScore,
  );
  const rHard = computeWindowScoreD(
    state.latestUserLandmarks,
    state.demo.hard,
    tScore,
  );

  const okEasy = rEasy.ok ? rEasy.score.toFixed(0) : "—";
  const okHard = rHard.ok ? rHard.score.toFixed(0) : "—";

  let overallEasy = "—";
  let overallEasyNum = null;
  if (rEasy.ok) {
    const wg = computeEnergyGateWeight(rEasy.ErefWin);
    const ov = pushOverall(state.overall.easy, tScore, rEasy.score, wg);
    if (typeof ov === "number") {
      overallEasyNum = ov;
      overallEasy = ov.toFixed(0);
    }
  }

  let overallHard = "—";
  let overallHardNum = null;
  if (rHard.ok) {
    const wg = computeEnergyGateWeight(rHard.ErefWin);
    const ov = pushOverall(state.overall.hard, tScore, rHard.score, wg);
    if (typeof ov === "number") {
      overallHardNum = ov;
      overallHard = ov.toFixed(0);
    }
  }

  setUi({
    easy: okEasy,
    hard: okHard,
    overallEasy,
    overallHard,
  });

  // ---- Interactive overlay coloring (test only)
  const hintMode = state.ui.hintMode === "hard" ? "hard" : "easy";
  const trace = getDemoTraceByMode(hintMode);
  const demoLm = trace?.samples ? getDemoLandmarksAtTime(trace.samples, tScore) : null;
  const activeParts = trace ? computeActiveParts(trace, tScore) : new Set();
  const selectedInstant =
    hintMode === "hard" ? (rHard.ok ? rHard.score : null) : (rEasy.ok ? rEasy.score : null);
  const selectedOverall = hintMode === "hard" ? overallHardNum : overallEasyNum;
  const isOrange = updateOrangeState(tScore, selectedInstant, selectedOverall);

  if (els.overlayCanvas) {
    const ctx = els.overlayCanvas.getContext("2d");
    if (ctx) {
      const w = Math.max(1, Math.floor(els.overlayCanvas.clientWidth));
      const h = Math.max(1, Math.floor(els.overlayCanvas.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.floor(w * dpr));
      const targetH = Math.max(1, Math.floor(h * dpr));
      if (els.overlayCanvas.width !== targetW || els.overlayCanvas.height !== targetH) {
        els.overlayCanvas.width = targetW;
        els.overlayCanvas.height = targetH;
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Draw in the same contain-rect as the camera video (object-fit: contain)
      const videoAspect =
        els.inputVideo && els.inputVideo.videoWidth && els.inputVideo.videoHeight
          ? els.inputVideo.videoWidth / Math.max(1, els.inputVideo.videoHeight)
          : w / Math.max(1, h);
      const stageRect = computeContainRect(w, h, videoAspect);

      // User skeleton (white / red hints / blue when good)
      const blueColor = "rgba(59,130,246,0.95)";
      const whiteColor = "rgba(255,255,255,0.92)";
      const redColor = "rgba(239,68,68,0.95)";
      const baseColor = isOrange ? blueColor : whiteColor;
      const colorByConn = (a, b) => {
        if (isOrange) return blueColor;
        const part = partOfConnection(a, b);
        return activeParts.has(part) ? redColor : whiteColor;
      };
      drawPoseConnections(ctx, state.latestUserLandmarks, getLmXYV, stageRect, colorByConn, 3);
      drawPosePoints(ctx, state.latestUserLandmarks, getLmXYV, stageRect, baseColor, 3.5);

      // Demo overlay (green / blue) on top so it's always visible
      if (demoLm) {
        const demoColor = isOrange ? blueColor : "rgba(34,197,94,0.95)";
        drawPoseConnections(
          ctx,
          demoLm,
          getArrXYV,
          stageRect,
          () => demoColor,
          5,
        );
        drawPosePoints(ctx, demoLm, getArrXYV, stageRect, demoColor, 4.5);
      }

      ctx.restore();
    }
  }
}

async function main() {
  initDomRefs();
  // debug handle for DevTools
  window.__posedanceTestState = state;
  setupYtFloatingWindow();
  initYouTubePlayerIfPossible();

  try {
    const [easy, hard] = await Promise.all([
      loadDemoTrace(DEMO_TRACE_PATHS.easy),
      loadDemoTrace(DEMO_TRACE_PATHS.hard),
    ]);
    state.demo.easy = easy;
    state.demo.hard = hard;

    computeDemoEnergyForTrace(state.demo.easy);
    computeDemoEnergyForTrace(state.demo.hard);
    computeDemoPartEnergyForTrace(state.demo.easy);
    computeDemoPartEnergyForTrace(state.demo.hard);

    if (!state.videoId && typeof easy.videoId === "string" && easy.videoId) {
      state.videoId = easy.videoId;
      if (els.videoUrlInput) els.videoUrlInput.value = easy.videoId;
    }
    loadVideoByIdIfReady();
  } catch (err) {
    console.error("[DemoTrace] load failed:", err);
  }

  if (els.hintModeSelect) {
    els.hintModeSelect.addEventListener("change", () => {
      const v = els.hintModeSelect.value === "hard" ? "hard" : "easy";
      state.ui.hintMode = v;
      state.orange.active = false;
      state.orange.enterGoodSec = 0;
      state.orange.exitBadSec = 0;
      state.orange.window = [];
      state.orange.lastT = null;
    });
  }

  if (els.loadVideoButton) {
    els.loadVideoButton.addEventListener("click", () => {
      const raw = els.videoUrlInput ? els.videoUrlInput.value : "";
      const id = extractVideoId(raw);
      if (!id) return;
      state.videoId = id;
      state.lastLoadedVideoId = null;
      loadVideoByIdIfReady();
    });
  }

  await initPose();
  updateUiLoop();
}

main();
