import { PoseModel, POSE_LANDMARKS } from "./poseTask.js";

const state = {
  mode: "easy",
  videoId: null,
  player: null,
  ready: false,
  ytInitStarted: false,
  lastLoadedVideoId: null,
  demoTrace: null,
  demoName: null,

  // Pose 相關
  poseReady: false,
  cameraRunning: false,
  poseLoopActive: false,
  cameraStream: null,
  latestUserLandmarks: null,
  lastUserPoseAtT: null,
  currentPoseFlags: {
    leftHandUp: false,
    rightHandUp: false,
    bothHandsUp: false,
  },

  // 錄製相關
  recorder: {
    armed: false, // 按下開始錄製後待命
    active: false, // 延遲期結束後正式寫入 samples
    delaySec: 5,
    armStartPlayerTimeSec: null, // YouTube 進入 PLAYING 的起始 t
    startedAtIso: null,
    lastRecordedT: Number.NEGATIVE_INFINITY,
    samples: [],
  },
  recordUiUpdater: null,

  // 相似度（第一版：EMA）
  similarity: {
    visibilityThreshold: 0.5,
    k: 1.2, // 較寬鬆
    emaAlpha: 0.15,
    scoreEma: null,
    lastScoreRaw: null,
    lastMeanDist: null,
    trackingOk: false,
    validPoints: 0,
  },

  /** iframe postMessage（infoDelivery）較能跟上拖曳拉桿；getCurrentTime() 常拖到放開才更新 */
  ytInfoCurrentTime: null,
  ytInfoTimeAtMs: null,
  ytMessageBridgeInstalled: false,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

const RECORD_SAMPLE_MIN_DT = 1 / 30; // 30fps 上限
const DEMO_TRACE_PATHS_BY_MODE = {
  easy: ["./demo/pose_trace_easy.json"],
  hard: ["./demo/pose_trace_hard.json"],
};
const DEMO_SOURCE_ASPECT = 16 / 9;

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

const ACTIVE_JOINT_TO_CONNECTIONS = {
  left_arm: [
    [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_ELBOW],
    [POSE_LANDMARKS.LEFT_ELBOW, POSE_LANDMARKS.LEFT_WRIST],
    [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_INDEX],
    [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_PINKY],
    [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_THUMB],
  ],
  right_arm: [
    [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_ELBOW],
    [POSE_LANDMARKS.RIGHT_ELBOW, POSE_LANDMARKS.RIGHT_WRIST],
    [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_INDEX],
    [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_PINKY],
    [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_THUMB],
  ],
};

function buildHighlightConnections(action) {
  if (
    !action ||
    !Array.isArray(action.activeJoints) ||
    action.activeJoints.length === 0
  ) {
    return [];
  }

  const dedup = new Set();
  const result = [];

  for (const jointKey of action.activeJoints) {
    const pairs = ACTIVE_JOINT_TO_CONNECTIONS[jointKey];
    if (!Array.isArray(pairs)) continue;
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [a, b] = pair;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      result.push([a, b]);
    }
  }

  return result;
}

function findHintAction(actions, beatIndex, currentAction, leadBeats = 4) {
  if (currentAction) return currentAction;
  if (!Array.isArray(actions) || actions.length === 0) return null;
  if (typeof beatIndex !== "number") return null;

  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const a of actions) {
    if (!a || typeof a.beatIndex !== "number") continue;
    const delta = a.beatIndex - beatIndex;
    if (delta <= 0 || delta > leadBeats) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = a;
    }
  }

  return best;
}

function initDomRefs() {
  els.similarityText = $("similarityText");
  els.trackingText = $("trackingText");
  els.demoNameText = $("demoNameText");
  els.modeSelect = $("modeSelect");
  els.demoFileInput = $("demoFileInput");
  els.videoUrlInput = $("videoUrlInput");
  els.loadVideoButton = $("loadVideoButton");

  els.poseInfoText = $("poseInfoText");
  els.startCameraButton = $("startCameraButton");
  els.recordButton = $("recordButton");
  els.inputVideo = $("input_video");
  els.demoCanvas = $("demo_canvas");

  els.ytWrapper = $("ytPlayerWrapper");
  els.ytDragHandle = $("ytDragHandle");
  els.ytResizeHandle = $("ytResizeHandle");

  // HUD 偵測文字已停用，避免畫面出現動作字樣
  if (els.poseInfoText) {
    els.poseInfoText.style.display = "none";
  }

  if (els.recordButton) {
    els.recordButton.disabled = true;
    els.recordButton.textContent = "開始錄製";
  }
}

function setSimilarityUi({
  scoreText = "—",
  trackingText = "—",
  demoNameText = null,
} = {}) {
  if (els.similarityText) els.similarityText.textContent = scoreText;
  if (els.trackingText) els.trackingText.textContent = trackingText;
  if (els.demoNameText && demoNameText !== null) {
    els.demoNameText.textContent = demoNameText;
  }
}

function toLmArray(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return [];
  return landmarks.map((lm) => {
    if (!lm) return [null, null, null, null];
    const x = typeof lm.x === "number" ? lm.x : null;
    const y = typeof lm.y === "number" ? lm.y : null;
    const z = typeof lm.z === "number" ? lm.z : null;
    const v = typeof lm.visibility === "number" ? lm.visibility : null;
    return [x, y, z, v];
  });
}

function createDownload(filename, obj) {
  const text = JSON.stringify(obj);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 讓瀏覽器有時間開始下載再釋放
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function formatTsForFilename(d = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}` +
    `${pad2(d.getMonth() + 1)}` +
    `${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}` +
    `${pad2(d.getMinutes())}` +
    `${pad2(d.getSeconds())}`
  );
}

async function loadDemoTraceJson() {
  const mode = state.mode === "hard" ? "hard" : "easy";
  const candidates = [...(DEMO_TRACE_PATHS_BY_MODE[mode] || DEMO_TRACE_PATHS_BY_MODE.easy)];

  let loaded = null;
  for (const path of candidates) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !Array.isArray(data.samples)) continue;
      loaded = { path, data };
      break;
    } catch {
      // try next candidate
    }
  }

  if (!loaded) {
    console.warn(
      "[DemoTrace] 載入失敗。請確認模式對應檔存在。",
      { mode, tried: candidates, videoId: state.videoId },
    );
    state.demoTrace = null;
    return;
  }

  try {
    const { path, data } = loaded;
    if (!data || !Array.isArray(data.samples)) {
      console.warn("[DemoTrace] JSON 格式無效，缺少 samples");
      state.demoTrace = null;
      return;
    }
    state.demoTrace = data;
    state.demoName = path;
    if (!state.videoId && typeof data.videoId === "string" && data.videoId) {
      state.videoId = data.videoId;
      if (els.videoUrlInput) els.videoUrlInput.value = state.videoId;
    }
    setSimilarityUi({
      demoNameText: state.demoName || "（未載入）",
    });
    console.log("[DemoTrace] 載入成功", {
      mode,
      path,
      videoId: data.videoId,
      sampleCount: data.samples.length,
      firstT: data.samples[0]?.t,
      lastT: data.samples[data.samples.length - 1]?.t,
    });
  } catch (err) {
    console.warn("[DemoTrace] 載入失敗:", err);
    state.demoTrace = null;
  }
}

async function loadDemoTraceFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.samples)) {
      throw new Error("JSON 格式無效（缺少 samples）");
    }
    state.demoTrace = data;
    state.demoName = file.name ? `${file.name}（自訂）` : "（自訂）";
    if (!state.videoId && typeof data.videoId === "string" && data.videoId) {
      state.videoId = data.videoId;
      if (els.videoUrlInput) els.videoUrlInput.value = state.videoId;
    }
    setSimilarityUi({ demoNameText: state.demoName });
    console.log("[DemoTrace] 由檔案載入成功", {
      fileName: file.name,
      videoId: data.videoId,
      sampleCount: data.samples.length,
      firstT: data.samples[0]?.t,
      lastT: data.samples[data.samples.length - 1]?.t,
    });
  } catch (err) {
    console.warn("[DemoTrace] 檔案載入失敗:", err);
    setSimilarityUi({
      demoNameText: "（載入失敗）",
    });
  }
}

/** 依時間 t 落在哪兩筆 sample 之間，回傳線性插值係數 alpha∈[0,1]（假設 samples 依 t 遞增） */
function getDemoTimeBracket(samples, t) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  if (samples.length === 1) {
    return { left: samples[0], right: samples[0], alpha: 0 };
  }
  const firstT = samples[0]?.t ?? 0;
  const lastT = samples[samples.length - 1]?.t ?? 0;
  if (t <= firstT) {
    return { left: samples[0], right: samples[0], alpha: 0 };
  }
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
  if (tr === tl) return { left, right, alpha: 0 };
  const alpha = (t - tl) / (tr - tl);
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

/** 示範時間 t 對應的骨架（相鄰兩幀線性插值，拉桿／播放都會連續變形） */
function getDemoLandmarksAtTime(samples, t) {
  const br = getDemoTimeBracket(samples, t);
  if (!br) return null;
  const { left, right, alpha } = br;
  if (!left || !Array.isArray(left.lm)) return null;
  if (left === right || alpha <= 0) return left.lm;
  if (!right || !Array.isArray(right.lm)) return left.lm;
  return interpolateLandmarks(left.lm, right.lm, alpha);
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

function drawDemoSkeletonAtTime(currentTime) {
  if (!els.demoCanvas) return;
  const canvas = els.demoCanvas;
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

  const tEnd = state.demoTrace?.samples?.length
    ? state.demoTrace.samples[state.demoTrace.samples.length - 1]?.t
    : Infinity;
  if (!state.demoTrace || (typeof tEnd === "number" && currentTime > tEnd)) {
    ctx.restore();
    return;
  }

  const lm = getDemoLandmarksAtTime(state.demoTrace.samples, currentTime);
  if (!lm || lm.length === 0) {
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
    ) {
      continue;
    }
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

function computeSimilarity(userLandmarks, demoLmArray) {
  const sim = state.similarity;
  const visTh = sim.visibilityThreshold;
  const userNorm = normalizePose2D(
    (i) => getLmXYV(userLandmarks?.[i]),
    visTh,
  );
  const demoNorm = normalizePose2D((i) => getArrXYV(demoLmArray?.[i]), visTh);
  if (!userNorm || !demoNorm) {
    return { ok: false, reason: "weak_core" };
  }

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
  if (n < 15) return { ok: false, reason: "too_few_points", validPoints: n };
  const meanDist = sum / n;
  const scoreRaw = Math.max(0, Math.min(100, 100 * Math.exp(-sim.k * meanDist)));

  const a = sim.emaAlpha;
  const prev = typeof sim.scoreEma === "number" ? sim.scoreEma : scoreRaw;
  const scoreEma = a * scoreRaw + (1 - a) * prev;

  sim.scoreEma = scoreEma;
  sim.lastScoreRaw = scoreRaw;
  sim.lastMeanDist = meanDist;
  sim.trackingOk = true;
  sim.validPoints = n;

  return { ok: true, scoreEma, scoreRaw, meanDist, validPoints: n };
}

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace("/", "");
      return id || null;
    }
    const v = url.searchParams.get("v");
    if (v) return v;
  } catch {
    // ignore
  }
  return null;
}

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

  // 初始化為 left/top 以便拖曳
  const initRect = readRect();
  wrapper.style.left = `${Math.max(16, initRect.left)}px`;
  wrapper.style.top = `${Math.max(16, initRect.top)}px`;
  wrapper.style.right = "auto";
  wrapper.style.bottom = "auto";

  // --- Drag
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onDragMove = (e) => {
    if (!dragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    const rect = readRect();
    const w = rect.width;
    const h = rect.height;

    const nextLeft = Math.min(
      Math.max(0, startLeft + dx),
      window.innerWidth - w,
    );
    const nextTop = Math.min(
      Math.max(0, startTop + dy),
      window.innerHeight - h,
    );

    wrapper.style.left = `${nextLeft}px`;
    wrapper.style.top = `${nextTop}px`;
  };

  const stopDrag = () => {
    dragging = false;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", stopDrag);
    document.removeEventListener("touchmove", onDragMove);
    document.removeEventListener("touchend", stopDrag);
  };

  const startDrag = (e) => {
    // 避免跟 resize 打架
    if (e.target === resizeHandle) return;
    dragging = true;
    dragHandle.style.cursor = "grabbing";
    const rect = readRect();
    startLeft = rect.left;
    startTop = rect.top;
    dragStartX = e.touches ? e.touches[0].clientX : e.clientX;
    dragStartY = e.touches ? e.touches[0].clientY : e.clientY;
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", () => {
      dragHandle.style.cursor = "grab";
      stopDrag();
    });
    document.addEventListener("touchmove", onDragMove, { passive: false });
    document.addEventListener("touchend", () => {
      dragHandle.style.cursor = "grab";
      stopDrag();
    });
  };

  dragHandle.addEventListener("mousedown", startDrag);
  dragHandle.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startDrag(e);
  });

  // --- Resize
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

function resetSimilarityState() {
  const sim = state.similarity;
  sim.scoreEma = null;
  sim.lastScoreRaw = null;
  sim.lastMeanDist = null;
  sim.trackingOk = false;
  sim.validPoints = 0;
  setSimilarityUi({
    scoreText: "—",
    trackingText: "—",
    demoNameText: state.demoName || "（未載入）",
  });
}

/** @returns {boolean} 是否已呼叫 loadVideoById */
function loadVideoByIdIfReady() {
  if (
    !state.ready ||
    !state.player ||
    !state.videoId ||
    typeof state.player.loadVideoById !== "function"
  ) {
    return false;
  }
  if (state.lastLoadedVideoId === state.videoId) {
    return true;
  }
  console.log("[YouTube] loadVideoById:", state.videoId);
  state.player.loadVideoById(state.videoId);
  state.lastLoadedVideoId = state.videoId;
  setTimeout(() => sendYouTubeListeningHandshake(), 400);
  setTimeout(() => sendYouTubeListeningHandshake(), 1500);
  return true;
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

function parseYouTubeEmbedMessage(data) {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data && typeof data === "object") return data;
  return null;
}

/** 示範時間軸：合併 API 與 iframe infoDelivery（拖曳進度條時較連續） */
function getDemoTimelineTime() {
  const apiT = getPlayerTimeSafe();
  const now = performance.now();
  const msgAge =
    state.ytInfoTimeAtMs != null ? now - state.ytInfoTimeAtMs : Infinity;
  const msgT = state.ytInfoCurrentTime;
  const msgFresh = msgT != null && Number.isFinite(msgT) && msgAge < 900;
  if (msgFresh) {
    return msgT;
  }
  if (apiT != null) return apiT;
  return typeof msgT === "number" && Number.isFinite(msgT) ? msgT : 0;
}

function installYouTubeEmbedMessageBridge() {
  if (typeof window === "undefined" || state.ytMessageBridgeInstalled) return;
  state.ytMessageBridgeInstalled = true;

  window.addEventListener("message", (event) => {
    if (
      !/^https:\/\/(www\.youtube\.com|www\.youtube-nocookie\.com)(:\d+)?$/i.test(
        event.origin,
      )
    ) {
      return;
    }
    const payload = parseYouTubeEmbedMessage(event.data);
    if (!payload || payload.event !== "infoDelivery" || !payload.info) return;
    const ct = payload.info.currentTime;
    if (typeof ct !== "number" || !Number.isFinite(ct)) return;
    state.ytInfoCurrentTime = ct;
    state.ytInfoTimeAtMs = performance.now();
  });
}

function sendYouTubeListeningHandshake() {
  if (!state.player || typeof state.player.getIframe !== "function") return;
  try {
    const iframe = state.player.getIframe();
    if (!iframe?.contentWindow) return;
    const msg = JSON.stringify({
      event: "listening",
      id: 1,
      channel: "widget",
    });
    iframe.contentWindow.postMessage(msg, "*");
  } catch (err) {
    console.warn("[YouTube] listening 握手失敗（示範時間可能僅在放開拉桿時更新）:", err);
  }
}

// YouTube IFrame API callback
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
        console.log("[YouTube] Player ready, videoId =", state.videoId);
        state.ready = true;
        // apple.json 可能比 API 晚載入：這裡再補一次（若已有 videoId）
        loadVideoByIdIfReady();
        sendYouTubeListeningHandshake();
        setTimeout(() => sendYouTubeListeningHandshake(), 500);
      },
      onStateChange: (event) => {
        console.log("[YouTube] state change:", event.data);
        const rec = state.recorder;
        if (!rec.armed || rec.active) return;
        const YTGlobal = typeof window !== "undefined" ? window.YT : null;
        if (!YTGlobal || !YTGlobal.PlayerState) return;

        if (event.data === YTGlobal.PlayerState.PLAYING) {
          const t = getPlayerTimeSafe();
          if (t !== null) {
            rec.armStartPlayerTimeSec = t;
            console.log(
              `[Recorder] 倒數開始：${rec.delaySec}s（from t=${t.toFixed(3)}）`,
            );
          }
        } else {
          // 暫停/seek/buffering 期間重置倒數，等待下一次 PLAYING
          rec.armStartPlayerTimeSec = null;
        }
      },
      onError: (event) => {
        console.error("[YouTube] 播放錯誤，errorCode =", event.data);
      },
    },
  });
}

// YouTube IFrame API 會在 global 呼叫這個函式
window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  initYouTubePlayerIfPossible();
};

// --- Pose 防抖（OneEuroFilter，全身 33 點 x/y/z）
class LowPassFilter {
  constructor(alpha, initialValue = null) {
    this.alpha = alpha;
    this.initialized = initialValue !== null;
    this.s = initialValue;
  }

  setAlpha(alpha) {
    this.alpha = alpha;
  }

  filter(value) {
    if (!this.initialized) {
      this.initialized = true;
      this.s = value;
      return value;
    }
    this.s = this.alpha * value + (1 - this.alpha) * this.s;
    return this.s;
  }

  last() {
    return this.s;
  }
}

class OneEuroFilter {
  constructor(freq, minCutoff = 1.2, beta = 0.04, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;

    this.x = new LowPassFilter(1.0);
    this.dx = new LowPassFilter(1.0);
    this.lastTimeSec = null;
  }

  alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(value, timeSec) {
    if (this.lastTimeSec !== null && timeSec !== null) {
      const dt = timeSec - this.lastTimeSec;
      if (dt > 0) {
        this.freq = 1.0 / dt;
      }
    }
    this.lastTimeSec = timeSec;

    const prevX = this.x.last();
    const dValue =
      prevX === null || prevX === undefined ? 0 : (value - prevX) * this.freq;

    this.dx.setAlpha(this.alpha(this.dCutoff));
    const edValue = this.dx.filter(dValue);

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    this.x.setAlpha(this.alpha(cutoff));
    return this.x.filter(value);
  }
}

const oneEuroParams = {
  freq: 60,
  // 以 PoseModel 調好的「更跟手」為主
  minCutoff: 2.4,
  beta: 0.25,
  dCutoff: 1.0,
};

const landmarkFilterBank = Array.from({ length: 33 }, () => ({
  x: new OneEuroFilter(
    oneEuroParams.freq,
    oneEuroParams.minCutoff,
    oneEuroParams.beta,
    oneEuroParams.dCutoff,
  ),
  y: new OneEuroFilter(
    oneEuroParams.freq,
    oneEuroParams.minCutoff,
    oneEuroParams.beta,
    oneEuroParams.dCutoff,
  ),
  z: new OneEuroFilter(
    oneEuroParams.freq,
    oneEuroParams.minCutoff,
    oneEuroParams.beta,
    oneEuroParams.dCutoff,
  ),
}));

function filterLandmarksOneEuro(landmarks, meta) {
  if (!landmarks || landmarks.length === 0) return landmarks;
  const timeSec =
    meta && typeof meta.timestampUs === "number"
      ? meta.timestampUs / 1e6
      : null;

  return landmarks.map((lm, i) => {
    if (!lm) return lm;
    const bank = landmarkFilterBank[i];
    if (!bank) return lm;
    const x = typeof lm.x === "number" ? bank.x.filter(lm.x, timeSec) : lm.x;
    const y = typeof lm.y === "number" ? bank.y.filter(lm.y, timeSec) : lm.y;
    const z = typeof lm.z === "number" ? bank.z.filter(lm.z, timeSec) : lm.z;
    return { ...lm, x, y, z };
  });
}

// --- Pose 偵測

function createPoseDetectors() {
  const leftConfig = {
    visibilityThreshold: 0.5,
    // 與 PoseModel 測好的邏輯一致（向前舉、避免外展誤觸、肩膀帶狀高度）
    forwardXRatio: 0.55,
    xBlockK: 0.3,
    lowBandRatio: 0.22, // 允許手腕比肩膀略低
    highBandRatio: 0.22, // 允許手腕比肩膀略高（避免舉過頭）
  };

  const rightConfig = {
    visibilityThreshold: 0.5,
    forwardXRatio: 0.55,
    xBlockK: 0.3,
    lowBandRatio: 0.22,
    highBandRatio: 0.22,
  };

  const calculateDistance = (p1, p2) => {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const detectLeftHandUp = (landmarks) => {
    const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const leftElbow = landmarks[POSE_LANDMARKS.LEFT_ELBOW];
    const leftWrist = landmarks[POSE_LANDMARKS.LEFT_WRIST];

    if (
      !leftShoulder ||
      !rightShoulder ||
      !leftElbow ||
      !leftWrist ||
      leftShoulder.visibility < leftConfig.visibilityThreshold ||
      rightShoulder.visibility < leftConfig.visibilityThreshold ||
      leftElbow.visibility < leftConfig.visibilityThreshold ||
      leftWrist.visibility < leftConfig.visibilityThreshold
    ) {
      return false;
    }

    const shoulderWidth = calculateDistance(leftShoulder, rightShoulder);

    // 高度：肩膀附近帶狀區間
    const lowBand = shoulderWidth * leftConfig.lowBandRatio;
    const highBand = shoulderWidth * leftConfig.highBandRatio;
    const handNearShoulder =
      leftWrist.y <= leftShoulder.y + lowBand &&
      leftWrist.y >= leftShoulder.y - highBand;

    // 向前：wrist.x 接近肩 + elbow.x 稍微靠近即可
    const wristShoulderXDiff = Math.abs(leftWrist.x - leftShoulder.x);
    const elbowShoulderXDiff = Math.abs(leftElbow.x - leftShoulder.x);
    const wristForward =
      wristShoulderXDiff < shoulderWidth * leftConfig.forwardXRatio;
    const elbowSlightlyClose =
      elbowShoulderXDiff < shoulderWidth * (leftConfig.forwardXRatio + 0.1);
    const armForward = wristForward && elbowSlightlyClose;

    // 外展排除：左手向左打開不算向前舉
    const xBlocked =
      leftWrist.x < leftShoulder.x - shoulderWidth * leftConfig.xBlockK;

    return handNearShoulder && armForward && !xBlocked;
  };

  const detectRightHandUp = (landmarks) => {
    const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const rightElbow = landmarks[POSE_LANDMARKS.RIGHT_ELBOW];
    const rightWrist = landmarks[POSE_LANDMARKS.RIGHT_WRIST];

    if (
      !leftShoulder ||
      !rightShoulder ||
      !rightElbow ||
      !rightWrist ||
      leftShoulder.visibility < rightConfig.visibilityThreshold ||
      rightShoulder.visibility < rightConfig.visibilityThreshold ||
      rightElbow.visibility < rightConfig.visibilityThreshold ||
      rightWrist.visibility < rightConfig.visibilityThreshold
    ) {
      return false;
    }

    const shoulderWidth = calculateDistance(leftShoulder, rightShoulder);

    const lowBand = shoulderWidth * rightConfig.lowBandRatio;
    const highBand = shoulderWidth * rightConfig.highBandRatio;
    const handNearShoulder =
      rightWrist.y <= rightShoulder.y + lowBand &&
      rightWrist.y >= rightShoulder.y - highBand;

    const wristShoulderXDiff = Math.abs(rightWrist.x - rightShoulder.x);
    const elbowShoulderXDiff = Math.abs(rightElbow.x - rightShoulder.x);
    const wristForward =
      wristShoulderXDiff < shoulderWidth * rightConfig.forwardXRatio;
    const elbowSlightlyClose =
      elbowShoulderXDiff < shoulderWidth * (rightConfig.forwardXRatio + 0.1);
    const armForward = wristForward && elbowSlightlyClose;

    // 外展排除：右手向右打開不算向前舉
    const xBlocked =
      rightWrist.x > rightShoulder.x + shoulderWidth * rightConfig.xBlockK;

    return handNearShoulder && armForward && !xBlocked;
  };

  return { detectLeftHandUp, detectRightHandUp };
}

async function initPose() {
  if (!els.inputVideo || !els.startCameraButton) return;

  // --- 錄製狀態（同頁錄）
  const rec = state.recorder;

  const setRecordUi = () => {
    if (!els.recordButton) return;
    els.recordButton.disabled = !state.cameraRunning;
    if (!rec.armed) {
      els.recordButton.textContent = "開始錄製";
      els.recordButton.classList.remove("btn-record--active");
      return;
    }
    if (!rec.active) {
      let remainSec = rec.delaySec;
      if (rec.armStartPlayerTimeSec !== null) {
        const nowT = getPlayerTimeSafe();
        if (nowT !== null) {
          const elapsed = nowT - rec.armStartPlayerTimeSec;
          const remaining = Math.max(0, rec.delaySec - elapsed);
          // active 切換發生在 callback，UI 先維持最小 1s 避免顯示 0s 閃爍
          remainSec = Math.max(1, Math.ceil(remaining));
        }
      }
      els.recordButton.textContent = `準備錄製（${remainSec}s）`;
      els.recordButton.classList.add("btn-record--active");
      return;
    }
    els.recordButton.textContent = "停止並下載";
    els.recordButton.classList.add("btn-record--active");
  };
  state.recordUiUpdater = setRecordUi;

  const startRecording = () => {
    rec.armed = true;
    rec.active = false;
    rec.armStartPlayerTimeSec = null;
    rec.startedAtIso = new Date().toISOString();
    rec.lastRecordedT = Number.NEGATIVE_INFINITY;
    rec.samples = [];

    const YTGlobal = typeof window !== "undefined" ? window.YT : null;
    if (
      state.player &&
      typeof state.player.getPlayerState === "function" &&
      YTGlobal &&
      YTGlobal.PlayerState &&
      state.player.getPlayerState() === YTGlobal.PlayerState.PLAYING
    ) {
      const t = getPlayerTimeSafe();
      if (t !== null) rec.armStartPlayerTimeSec = t;
    }
    console.log(
      `[Recorder] 已待命，YouTube PLAYING 後延遲 ${rec.delaySec}s 才開始寫入`,
    );
    setRecordUi();
  };

  const stopAndDownloadRecording = () => {
    rec.armed = false;
    rec.active = false;
    rec.armStartPlayerTimeSec = null;
    setRecordUi();

    const videoId = state.videoId || "unknown";
    const payload = {
      version: 1,
      videoId,
      recordedAt: rec.startedAtIso || new Date().toISOString(),
      sampleCount: rec.samples.length,
      samples: rec.samples,
    };
    const filename = `pose_trace_${videoId}_${formatTsForFilename()}.json`;
    console.log("[Recorder] 停止錄製，下載:", {
      filename,
      sampleCount: rec.samples.length,
    });
    createDownload(filename, payload);
  };

  if (els.recordButton) {
    els.recordButton.addEventListener("click", () => {
      if (!state.cameraRunning) return;
      if (!rec.armed) startRecording();
      else stopAndDownloadRecording();
    });
  }

  const stopCamera = () => {
    state.poseLoopActive = false;
    state.poseReady = false;
    state.cameraRunning = false;

    if (rec.armed) {
      // 關攝影機時先停止錄製（避免拿到不完整資料）
      stopAndDownloadRecording();
    }

    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      state.cameraStream = null;
    }

    if (els.inputVideo) {
      els.inputVideo.pause();
      els.inputVideo.srcObject = null;
    }

    state.currentPoseFlags.leftHandUp = false;
    state.currentPoseFlags.rightHandUp = false;
    state.currentPoseFlags.bothHandsUp = false;
    PoseModel.setOverlayState({
      leftHandUp: false,
      rightHandUp: false,
      bothHandsUp: false,
    });

    els.startCameraButton.textContent = "啟動攝影機";
    els.startCameraButton.disabled = false;
    setRecordUi();
    console.log("攝影機已關閉");
  };

  els.startCameraButton.addEventListener("click", async () => {
    if (state.cameraRunning) {
      stopCamera();
      return;
    }

    try {
      els.startCameraButton.disabled = true;
      els.startCameraButton.textContent = "啟動中...";
      console.log("正在初始化 Pose 模型與攝影機...");

      const poseInstance = await PoseModel.init();
      if (!poseInstance) {
        throw new Error("MediaPipe PoseLandmarker 初始化失敗");
      }

      // 啟用 landmarks 前處理：OneEuroFilter 防抖（全身 33 點 x/y/z）
      PoseModel.setLandmarkPreprocessor(filterLandmarksOneEuro);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
      });
      state.cameraStream = stream;

      els.inputVideo.srcObject = stream;
      await els.inputVideo.play();

      const { detectLeftHandUp, detectRightHandUp } = createPoseDetectors();

      PoseModel.setCallback((result) => {
        if (!result || !result.landmarks) {
          state.currentPoseFlags.leftHandUp = false;
          state.currentPoseFlags.rightHandUp = false;
          state.currentPoseFlags.bothHandsUp = false;
          state.latestUserLandmarks = null;
          state.lastUserPoseAtT = null;
          PoseModel.setOverlayState({
            leftHandUp: false,
            rightHandUp: false,
            bothHandsUp: false,
          });
          return;
        }

        state.latestUserLandmarks = result.landmarks;
        const nowT = getPlayerTimeSafe();
        if (nowT !== null) state.lastUserPoseAtT = nowT;

        const detectedLeft = detectLeftHandUp(result.landmarks);
        const detectedRight = detectRightHandUp(result.landmarks);
        const detectedBoth = detectedLeft && detectedRight;

        state.currentPoseFlags.leftHandUp = detectedLeft;
        state.currentPoseFlags.rightHandUp = detectedRight;
        state.currentPoseFlags.bothHandsUp = detectedBoth;

        PoseModel.setOverlayState({
          leftHandUp: detectedLeft,
          rightHandUp: detectedRight,
          bothHandsUp: detectedBoth,
        });

        // --- Recorder: 只記錄 landmarks（t=YouTube 秒數；30fps 上限）
        if (rec.armed) {
          const t = getPlayerTimeSafe();
          if (t === null) return;
          if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return;

          if (!rec.active) {
            if (rec.armStartPlayerTimeSec === null) {
              const YTGlobal = typeof window !== "undefined" ? window.YT : null;
              if (
                state.player &&
                typeof state.player.getPlayerState === "function" &&
                YTGlobal &&
                YTGlobal.PlayerState &&
                state.player.getPlayerState() === YTGlobal.PlayerState.PLAYING
              ) {
                rec.armStartPlayerTimeSec = t;
              }
            }
            if (rec.armStartPlayerTimeSec === null) return;

            const elapsed = t - rec.armStartPlayerTimeSec;
            if (elapsed < rec.delaySec) return;

            rec.active = true;
            rec.lastRecordedT = Number.NEGATIVE_INFINITY;
            setRecordUi();
            console.log(
              `[Recorder] 正式開始錄製（延遲 ${rec.delaySec}s 完成）`,
            );
          }

          // 防止暫停時重複寫入
          if (t <= rec.lastRecordedT) return;
          if (
            t - rec.lastRecordedT < RECORD_SAMPLE_MIN_DT &&
            rec.samples.length > 0
          )
            return;

          rec.samples.push({ t, lm: toLmArray(result.landmarks) });
          rec.lastRecordedT = t;
        }

        // UI 已移除 detectedPoseText；需要的話可自行加回 DOM
      });

      let pendingFrame = null;
      let isProcessing = false;
      let lastTimestamp = 0;

      const processFrames = async () => {
        if (!state.poseLoopActive || isProcessing || !pendingFrame) return;
        isProcessing = true;
        try {
          const frame = pendingFrame;
          pendingFrame = null;

          const currentTimestampMs = performance.now();
          let timestampUs = Math.floor(currentTimestampMs * 1000);
          if (timestampUs <= lastTimestamp) {
            timestampUs = lastTimestamp + 1;
          }
          lastTimestamp = timestampUs;

          await PoseModel.detect(frame, timestampUs);
        } catch (err) {
          console.error("處理 Pose 幀失敗:", err);
        } finally {
          isProcessing = false;
          if (pendingFrame && !isProcessing) {
            requestAnimationFrame(processFrames);
          }
        }
      };

      const loop = () => {
        if (!state.poseLoopActive) return;
        if (els.inputVideo.readyState === els.inputVideo.HAVE_ENOUGH_DATA) {
          pendingFrame = els.inputVideo;
          if (!isProcessing) {
            processFrames();
          }
        }
        requestAnimationFrame(loop);
      };

      state.poseLoopActive = true;
      loop();

      state.poseReady = true;
      state.cameraRunning = true;
      els.startCameraButton.textContent = "關閉攝影機";
      els.startCameraButton.disabled = false;
      setRecordUi();
      console.log("系統就緒，請站在攝影機前，雙手入鏡。");
    } catch (err) {
      console.error(err);
      state.poseLoopActive = false;
      state.cameraRunning = false;
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach((t) => t.stop());
        state.cameraStream = null;
      }
      if (els.inputVideo) {
        els.inputVideo.srcObject = null;
      }
      els.startCameraButton.disabled = false;
      els.startCameraButton.textContent = "啟動攝影機";
      setRecordUi();
    }
  });
}

function updateUiLoop() {
  requestAnimationFrame(updateUiLoop);
  if (typeof state.recordUiUpdater === "function") {
    state.recordUiUpdater();
  }

  if (!state.ready || !state.player) {
    return;
  }

  const timelineT = getDemoTimelineTime();
  drawDemoSkeletonAtTime(timelineT);

  if (!state.demoTrace || !Array.isArray(state.demoTrace.samples)) {
    setSimilarityUi({
      scoreText: "—",
      trackingText: "請載入示範 JSON",
      demoNameText: state.demoName || "（未載入）",
    });
    return;
  }
  if (!state.latestUserLandmarks) {
    setSimilarityUi({
      scoreText: "—",
      trackingText: state.cameraRunning ? "追蹤中..." : "請啟動攝影機",
      demoNameText: state.demoName || "（未載入）",
    });
    return;
  }

  const demoLm = getDemoLandmarksAtTime(state.demoTrace.samples, timelineT);
  if (!demoLm || demoLm.length !== 33) {
    setSimilarityUi({
      scoreText: "—",
      trackingText: "示範資料不足",
      demoNameText: state.demoName || "（未載入）",
    });
    return;
  }

  const r = computeSimilarity(state.latestUserLandmarks, demoLm);
  if (!r.ok) {
    setSimilarityUi({
      scoreText: "—",
      trackingText: "Tracking weak",
      demoNameText: state.demoName || "（未載入）",
    });
    return;
  }
  setSimilarityUi({
    scoreText: `${r.scoreEma.toFixed(0)}`,
    trackingText: `OK（${r.validPoints}/33）`,
    demoNameText: state.demoName || "（未載入）",
  });
}

async function main() {
  initDomRefs();
  installYouTubeEmbedMessageBridge();
  setupYtFloatingWindow();
  if (els.modeSelect) {
    state.mode = els.modeSelect.value === "hard" ? "hard" : "easy";
  }
  resetSimilarityState();

  // 有些情況下 iframe_api 比 module 還早載入完成，導致 callback 來不及掛上。
  // 若此時已經有 YT.Player，就主動初始化一次。
  initYouTubePlayerIfPossible();

  if (els.loadVideoButton) {
    els.loadVideoButton.addEventListener("click", () => {
      console.log("[YouTube] 載入影片按鈕被點擊");
      const raw = els.videoUrlInput ? els.videoUrlInput.value : "";
      const id = extractVideoId(raw);
      if (!id) {
        console.warn("[YouTube] 無法從輸入取得 videoId，raw =", raw);
        return;
      }
      state.videoId = id;
      if (!loadVideoByIdIfReady()) {
        console.log(
          "[YouTube] player 尚未就緒，已更新 state.videoId，將在 onReady 時載入。狀態:",
          { ready: state.ready, hasPlayer: !!state.player },
        );
      }
    });
  }

  if (els.demoFileInput) {
    els.demoFileInput.addEventListener("change", async () => {
      const file = els.demoFileInput.files && els.demoFileInput.files[0];
      resetSimilarityState();
      await loadDemoTraceFromFile(file);
      state.lastLoadedVideoId = null;
      loadVideoByIdIfReady();
    });
  }

  if (els.modeSelect) {
    els.modeSelect.addEventListener("change", async () => {
      state.mode = els.modeSelect.value === "hard" ? "hard" : "easy";
      resetSimilarityState();
      try {
        await loadDemoTraceJson();
        state.lastLoadedVideoId = null;
        loadVideoByIdIfReady();
      } catch (err) {
        console.error("[DemoTrace] 切換模式載入失敗:", err);
      }
    });
  }

  try {
    await loadDemoTraceJson();
    // API 可能比 demo 先就緒：載入完 demo 後補載正確 YouTube 影片
    initYouTubePlayerIfPossible();
    loadVideoByIdIfReady();
  } catch (err) {
    console.error("[DemoTrace] 載入失敗:", err);
  }

  await initPose();
  updateUiLoop();
}

main();
