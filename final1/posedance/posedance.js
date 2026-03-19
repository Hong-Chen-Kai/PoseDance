import { PoseModel, POSE_LANDMARKS } from "./poseTask.js";

const state = {
  // 節奏相關
  beats: [],
  countInBeats: 16,
  actions: [],
  videoId: null,
  player: null,
  ready: false,

  // Pose 相關
  poseReady: false,
  cameraRunning: false,
  poseLoopActive: false,
  cameraStream: null,
  currentPoseFlags: {
    leftHandUp: false,
    rightHandUp: false,
    bothHandsUp: false,
  },

  // 判定相關
  successCount: 0,
  lastJudgeResult: "none", // none | success | fail
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

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
  if (!action || !Array.isArray(action.activeJoints) || action.activeJoints.length === 0) {
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
  els.successCountText = $("successCountText");
  els.judgeTag = $("judgeTag");
  els.judgeResultTag = $("judgeResultTag");
  els.videoUrlInput = $("videoUrlInput");
  els.loadVideoButton = $("loadVideoButton");

  els.poseInfoText = $("poseInfoText");
  els.startCameraButton = $("startCameraButton");
  els.inputVideo = $("input_video");
  els.demoVideo = $("demo_video");

  els.ytWrapper = $("ytPlayerWrapper");
  els.ytDragHandle = $("ytDragHandle");
  els.ytResizeHandle = $("ytResizeHandle");
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

async function loadAppleJson() {
  // 從 beatTest 資料夾共用 apple.json
  const res = await fetch("../beatTest/apple.json");
  if (!res.ok) {
    throw new Error(`載入 apple.json 失敗: ${res.status}`);
  }
  const data = await res.json();
  state.beats = Array.isArray(data.beats) ? data.beats : [];
  state.countInBeats =
    typeof data.countInBeats === "number" ? data.countInBeats : 16;
  state.actions = Array.isArray(data.actions) ? data.actions : [];
  state.videoId =
    typeof data.videoId === "string" && data.videoId
      ? data.videoId
      : "dQw4w9WgXcQ";
  console.log(
    "[apple.json] 載入成功",
    {
      videoId: state.videoId,
      beatsLength: state.beats.length,
      actionsLength: state.actions.length,
    },
  );
  if (els.videoUrlInput && state.videoId) {
    els.videoUrlInput.value = state.videoId;
  }
}

// YouTube IFrame API callback
window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  state.player = new YT.Player("player", {
    height: "180",
    width: "320",
    videoId: state.videoId || "dQw4w9WgXcQ",
    playerVars: {
      playsinline: 1,
    },
    events: {
      onReady: () => {
        console.log("[YouTube] Player ready, videoId =", state.videoId);
        state.ready = true;
        // 若使用者在 player 準備好之前已經輸入了新的 videoId，這裡主動載入
        if (state.videoId && typeof state.player.loadVideoById === "function") {
          console.log("[YouTube] onReady 時載入影片:", state.videoId);
          state.player.loadVideoById(state.videoId);
        }
      },
      onStateChange: (event) => {
        console.log("[YouTube] state change:", event.data);
      },
      onError: (event) => {
        console.error("[YouTube] 播放錯誤，errorCode =", event.data);
      },
    },
  });
};

function findBeatIndex(currentTime, beats) {
  if (!beats || beats.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < beats.length; i += 1) {
    if (beats[i] <= currentTime) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}

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
    meta && typeof meta.timestampUs === "number" ? meta.timestampUs / 1e6 : null;

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

  const stopCamera = () => {
    state.poseLoopActive = false;
    state.poseReady = false;
    state.cameraRunning = false;

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

    if (els.poseInfoText) {
      els.poseInfoText.textContent = "攝影機已關閉";
    }
    els.startCameraButton.textContent = "啟動攝影機";
    els.startCameraButton.disabled = false;
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
          if (els.poseInfoText) {
            els.poseInfoText.textContent = "等待姿態檢測...";
          }
          PoseModel.setOverlayState({
            leftHandUp: false,
            rightHandUp: false,
            bothHandsUp: false,
          });
          return;
        }

        const detectedLeft = detectLeftHandUp(result.landmarks);
        const detectedRight = detectRightHandUp(result.landmarks);
        const detectedBoth = detectedLeft && detectedRight;

        state.currentPoseFlags.leftHandUp = detectedLeft;
        state.currentPoseFlags.rightHandUp = detectedRight;
        state.currentPoseFlags.bothHandsUp = detectedBoth;

        if (els.poseInfoText) {
          els.poseInfoText.textContent = detectedBoth
            ? "偵測：雙手同時 UP"
            : `偵測：左手=${detectedLeft ? "UP" : "-"}，右手=${
                detectedRight ? "UP" : "-"
              }`;
        }

        PoseModel.setOverlayState({
          leftHandUp: detectedLeft,
          rightHandUp: detectedRight,
          bothHandsUp: detectedBoth,
        });

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
    }
  });
}

function updateUiLoop() {
  requestAnimationFrame(updateUiLoop);

  if (!state.ready || !state.player || !state.beats.length) {
    return;
  }

  let currentTime = 0;
  try {
    currentTime = state.player.getCurrentTime();
  } catch {
    return;
  }

  const beatIndex = findBeatIndex(currentTime, state.beats);
  const beatNumber = beatIndex >= 0 ? beatIndex + 1 : 0;
  const barIndex = beatNumber > 0 ? Math.floor((beatNumber - 1) / 8) : 0;

  const phase =
    beatIndex >= 0 && beatIndex < state.countInBeats ? "ready" : "dance";

  const action = state.actions.find((a) => a.beatIndex === beatIndex);
  const hintAction = findHintAction(state.actions, beatIndex, action, 4);
  const highlightConnections = buildHighlightConnections(hintAction);
  PoseModel.setOverlayState({
    highlightConnections,
    hideActionLabels: false,
  });

  if (els.successCountText) {
    els.successCountText.textContent = String(state.successCount);
  }

  if (els.judgeTag) {
    if (action) {
      els.judgeTag.textContent = "判定拍";
      els.judgeTag.className = "tag judge-on";
    } else {
      els.judgeTag.textContent = "非判定拍";
      els.judgeTag.className = "tag";
    }
  }

  // 動作提示照片已移除（改由示範骨架影片引導）

  // 判定成功/失敗（只在有 action 且 phase 為 dance 時）
  if (els.judgeResultTag) {
    if (action && phase === "dance") {
      let detectedPose = "none";
      if (state.currentPoseFlags.bothHandsUp) {
        detectedPose = "bothHandsUp";
      } else if (state.currentPoseFlags.leftHandUp) {
        detectedPose = "leftHandUp";
      } else if (state.currentPoseFlags.rightHandUp) {
        detectedPose = "rightHandUp";
      }

      const expected = action.poseId;
      const success = detectedPose === expected;

      if (success) {
        if (state.lastJudgeResult !== "success") {
          state.successCount += 1;
        }
        state.lastJudgeResult = "success";
        els.judgeResultTag.textContent = "成功";
        els.judgeResultTag.className = "tag judge-success";
        PoseModel.setOverlayState({ hideActionLabels: true });
      } else {
        state.lastJudgeResult = "fail";
        els.judgeResultTag.textContent = "失敗";
        els.judgeResultTag.className = "tag judge-fail";
        PoseModel.setOverlayState({ hideActionLabels: false });
      }
    } else if (!action) {
      state.lastJudgeResult = "none";
      els.judgeResultTag.textContent = "尚未判定";
      els.judgeResultTag.className = "tag";
      PoseModel.setOverlayState({ hideActionLabels: false });
    }
  }
}

async function main() {
  initDomRefs();
  setupYtFloatingWindow();

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
      // 若 player 已就緒，直接切換影片；否則記住 videoId，等 onReady 時載入
      if (state.ready && state.player && typeof state.player.loadVideoById === "function") {
        console.log("[YouTube] 呼叫 loadVideoById:", id);
        state.player.loadVideoById(id);
      } else {
        console.log(
          "[YouTube] player 尚未就緒，已更新 state.videoId，將在 onReady 時載入。狀態:",
          { ready: state.ready, hasPlayer: !!state.player },
        );
      }
    });
  }

  try {
    await loadAppleJson();
  } catch (err) {
    console.error("[apple.json] 載入失敗:", err);
  }

  await initPose();
  updateUiLoop();
}

main();
