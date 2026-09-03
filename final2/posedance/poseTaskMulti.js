/**
 * MediaPipe Pose Landmarker 雙人版
 * Full + numPoses: 2；OneEuroFilter 每人獨立；人數改變時重置 filter。
 * 不評分、不切場景。poseTask.js 維持單人不動。
 */

export const POSE_LANDMARKS = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

const POSE_CONNECTIONS = [
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

/** 第 0 人紅、第 1 人橘 */
const PERSON_STYLES = [
  { line: "#E53935", joint: "#FFCDD2", lineWidth: 3, radius: 5 },
  { line: "#FB8C00", joint: "#FFE0B2", lineWidth: 3, radius: 5 },
];

const NUM_POSES = 2;
const MODEL_COMPLEXITY = 1; // Full

const ONE_EURO = {
  freq: 60,
  minCutoff: 2.4,
  beta: 0.25,
  dCutoff: 1.0,
};

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
      if (dt > 0) this.freq = 1.0 / dt;
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

function createLandmarkFilterBank() {
  return Array.from({ length: 33 }, () => ({
    x: new OneEuroFilter(
      ONE_EURO.freq,
      ONE_EURO.minCutoff,
      ONE_EURO.beta,
      ONE_EURO.dCutoff,
    ),
    y: new OneEuroFilter(
      ONE_EURO.freq,
      ONE_EURO.minCutoff,
      ONE_EURO.beta,
      ONE_EURO.dCutoff,
    ),
    z: new OneEuroFilter(
      ONE_EURO.freq,
      ONE_EURO.minCutoff,
      ONE_EURO.beta,
      ONE_EURO.dCutoff,
    ),
  }));
}

function filterLandmarksWithBank(landmarks, bank, timeSec) {
  if (!landmarks || landmarks.length === 0) return landmarks;
  return landmarks.map((lm, i) => {
    if (!lm) return lm;
    const slot = bank[i];
    if (!slot) return lm;
    const x = typeof lm.x === "number" ? slot.x.filter(lm.x, timeSec) : lm.x;
    const y = typeof lm.y === "number" ? slot.y.filter(lm.y, timeSec) : lm.y;
    const z = typeof lm.z === "number" ? slot.z.filter(lm.z, timeSec) : lm.z;
    return { ...lm, x, y, z };
  });
}

function getModelPath(complexity) {
  const models = {
    0: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    1: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    2: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
  };
  return models[complexity] || models[1];
}

export const PoseModelMulti = {
  instance: null,
  callback: null,
  vision: null,
  lastTimestampUs: 0,
  lastPersonCount: 0,
  filterBanks: [createLandmarkFilterBank(), createLandmarkFilterBank()],
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,

  resetFilters() {
    this.filterBanks = [createLandmarkFilterBank(), createLandmarkFilterBank()];
    this.lastPersonCount = 0;
    console.log("[PoseMulti] filter 已重置（下一組／人數改變）");
  },

  _maybeResetOnCountChange(count) {
    if (count !== this.lastPersonCount) {
      this.filterBanks = [
        createLandmarkFilterBank(),
        createLandmarkFilterBank(),
      ];
      this.lastPersonCount = count;
      if (count >= 0) {
        console.log("[PoseMulti] 人數改變，已重置 filter", { count });
      }
    }
  },

  async init() {
    if (this.instance) return this.instance;

    try {
      const { FilesetResolver, PoseLandmarker } = await import(
        "@mediapipe/tasks-vision"
      );
      if (!FilesetResolver || !PoseLandmarker) {
        console.error("MediaPipe Tasks Vision 未載入");
        return null;
      }

      this.vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
      );

      const modelPath = getModelPath(MODEL_COMPLEXITY);
      this.instance = await PoseLandmarker.createFromOptions(this.vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: NUM_POSES,
        minPoseDetectionConfidence: this.minPoseDetectionConfidence,
        minPosePresenceConfidence: this.minPosePresenceConfidence,
        minTrackingConfidence: this.minTrackingConfidence,
        outputSegmentationMasks: false,
      });

      this.resetFilters();
      console.log(
        "✅ PoseLandmarker 雙人初始化完成（Full, numPoses=2, GPU）",
      );
      return this.instance;
    } catch (error) {
      console.error("PoseLandmarker 雙人初始化失敗:", error);
      return null;
    }
  },

  setCallback(callback) {
    this.callback = callback;
  },

  computeContainTransform(video, canvas) {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const cw = video.clientWidth || canvas.width || vw;
    const ch = video.clientHeight || canvas.height || vh;
    const scale = Math.min(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (cw - dw) / 2;
    const oy = (ch - dh) / 2;
    return { ox, oy, dw, dh, cw, ch };
  },

  drawConnectors(ctx, video, canvas, landmarks, connections, options = {}) {
    const { color = "#E53935", lineWidth = 3 } = options;
    const t = this.computeContainTransform(video, canvas);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const [start, end] of connections) {
      const startPoint = landmarks[start];
      const endPoint = landmarks[end];
      if (
        startPoint &&
        endPoint &&
        startPoint.visibility > 0.5 &&
        endPoint.visibility > 0.5
      ) {
        ctx.beginPath();
        ctx.moveTo(t.ox + startPoint.x * t.dw, t.oy + startPoint.y * t.dh);
        ctx.lineTo(t.ox + endPoint.x * t.dw, t.oy + endPoint.y * t.dh);
        ctx.stroke();
      }
    }
  },

  drawLandmarks(ctx, video, canvas, landmarks, options = {}) {
    const { color = "#FFCDD2", radius = 5 } = options;
    const t = this.computeContainTransform(video, canvas);
    ctx.fillStyle = color;
    for (const landmark of landmarks) {
      if (landmark && landmark.visibility > 0.5) {
        const x = t.ox + landmark.x * t.dw;
        const y = t.oy + landmark.y * t.dh;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  },

  onResults(results) {
    const canvas = document.querySelector("#output_canvas");
    const video = document.querySelector("#input_video");
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = video.clientWidth || video.videoWidth;
    const displayH = video.clientHeight || video.videoHeight;
    const nextW = Math.max(1, Math.floor(displayW * dpr));
    const nextH = Math.max(1, Math.floor(displayH * dpr));
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);

    const rawList = Array.isArray(results?.landmarks) ? results.landmarks : [];
    const count = rawList.length;
    this._maybeResetOnCountChange(count);

    const timeSec =
      typeof this.lastTimestampUs === "number"
        ? this.lastTimestampUs / 1e6
        : null;

    const allLandmarks = [];
    const allWorldLandmarks = [];

    for (let i = 0; i < count && i < NUM_POSES; i += 1) {
      let poseLandmarks = rawList[i];
      if (!poseLandmarks) continue;
      const bank = this.filterBanks[i];
      if (bank) {
        poseLandmarks = filterLandmarksWithBank(poseLandmarks, bank, timeSec);
      }
      allLandmarks.push(poseLandmarks);
      allWorldLandmarks.push(results.worldLandmarks?.[i] || null);

      const style = PERSON_STYLES[i] || PERSON_STYLES[0];
      this.drawConnectors(ctx, video, canvas, poseLandmarks, POSE_CONNECTIONS, {
        color: style.line,
        lineWidth: style.lineWidth,
      });
      this.drawLandmarks(ctx, video, canvas, poseLandmarks, {
        color: style.joint,
        radius: style.radius,
      });
    }

    if (this.callback) {
      this.callback({
        allLandmarks,
        allWorldLandmarks,
        count: allLandmarks.length,
      });
    }

    ctx.restore();
  },

  async detect(video, timestamp) {
    if (!this.instance) return;
    this.lastTimestampUs = timestamp;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    try {
      const results = this.instance.detectForVideo(video, timestamp);
      this.onResults(results);
    } catch (error) {
      console.error("雙人檢測失敗:", error);
    }
  },
};
