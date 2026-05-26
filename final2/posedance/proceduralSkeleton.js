/**
 * proceduralSkeleton.js
 *
 * 程序化骨架動畫生成器 — 層級 1（FK + sin/Perlin）+ 層級 2（Keyframe Pattern 隨機排程）
 *
 * 輸出格式與 MediaPipe Pose 33 點完全相同：lm[33] = [[x,y,z,visibility], ...]
 * 可直接餵入 posedanceTest.js 的 drawPoseConnections / drawPosePoints。
 */

// ─── Perlin Noise（輕量 2D，用於微抖）──────────────────────────
const _perlinGrad = (() => {
  const p = [];
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p.concat(p);
})();

function _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a, b, t) { return a + t * (b - a); }
function _grad1d(hash, x) { return (hash & 1) === 0 ? x : -x; }

function perlin1d(x) {
  const xi = Math.floor(x) & 255;
  const xf = x - Math.floor(x);
  const u = _fade(xf);
  return _lerp(_grad1d(_perlinGrad[xi], xf), _grad1d(_perlinGrad[xi + 1], xf - 1), u);
}

// ─── 數學工具 ────────────────────────────────────────────────
const DEG = Math.PI / 180;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function cosEase(t) { return 0.5 * (1 - Math.cos(Math.PI * t)); }

function dist2d(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

// ─── 基準站姿（從真實 pose_trace_easy.json 第一幀提取）──────────
// 索引對應 MediaPipe POSE_LANDMARKS 0–32
const BASE_POSE = [
  [0.5743, 0.1812, -0.326, 1], //  0 NOSE
  [0.5793, 0.1633, -0.312, 1], //  1 LEFT_EYE_INNER
  [0.5841, 0.1622, -0.312, 1], //  2 LEFT_EYE
  [0.5887, 0.1613, -0.312, 1], //  3 LEFT_EYE_OUTER
  [0.5700, 0.1652, -0.307, 1], //  4 RIGHT_EYE_INNER
  [0.5681, 0.1654, -0.307, 1], //  5 RIGHT_EYE
  [0.5661, 0.1658, -0.307, 1], //  6 RIGHT_EYE_OUTER
  [0.5990, 0.1662, -0.204, 1], //  7 LEFT_EAR
  [0.5670, 0.1709, -0.180, 1], //  8 RIGHT_EAR
  [0.5841, 0.1972, -0.283, 1], //  9 MOUTH_LEFT
  [0.5726, 0.1994, -0.277, 1], // 10 MOUTH_RIGHT
  [0.6379, 0.2736, -0.127, 1], // 11 LEFT_SHOULDER
  [0.5417, 0.2762, -0.095, 1], // 12 RIGHT_SHOULDER
  [0.6600, 0.3914, -0.158, 1], // 13 LEFT_ELBOW
  [0.5208, 0.3897, -0.142, 1], // 14 RIGHT_ELBOW
  [0.6551, 0.4769, -0.332, 1], // 15 LEFT_WRIST
  [0.5177, 0.4747, -0.339, 1], // 16 RIGHT_WRIST
  [0.6556, 0.5097, -0.381, 1], // 17 LEFT_PINKY
  [0.5112, 0.5065, -0.393, 1], // 18 RIGHT_PINKY
  [0.6475, 0.4998, -0.410, 1], // 19 LEFT_INDEX
  [0.5172, 0.5004, -0.417, 1], // 20 RIGHT_INDEX
  [0.6453, 0.4898, -0.347, 1], // 21 LEFT_THUMB
  [0.5225, 0.4895, -0.355, 1], // 22 RIGHT_THUMB
  [0.6151, 0.5247, -0.008, 1], // 23 LEFT_HIP
  [0.5626, 0.5258,  0.008, 1], // 24 RIGHT_HIP
  [0.6194, 0.7069,  0.001, 1], // 25 LEFT_KNEE
  [0.5562, 0.7013,  0.050, 1], // 26 RIGHT_KNEE
  [0.6208, 0.8641,  0.173, 1], // 27 LEFT_ANKLE
  [0.5519, 0.8553,  0.212, 1], // 28 RIGHT_ANKLE
  [0.6192, 0.8807,  0.181, 1], // 29 LEFT_HEEL
  [0.5566, 0.8726,  0.222, 1], // 30 RIGHT_HEEL
  [0.6194, 0.9255,  0.037, 1], // 31 LEFT_FOOT_INDEX
  [0.5371, 0.9058,  0.089, 1], // 32 RIGHT_FOOT_INDEX
];

// ─── 從基準姿量測肢段長度 ───────────────────────────────────
const L_UPPER_L = dist2d(BASE_POSE[11], BASE_POSE[13]); // 左上臂
const L_LOWER_L = dist2d(BASE_POSE[13], BASE_POSE[15]); // 左前臂
const L_UPPER_R = dist2d(BASE_POSE[12], BASE_POSE[14]); // 右上臂
const L_LOWER_R = dist2d(BASE_POSE[14], BASE_POSE[16]); // 右前臂

// 手指相對手腕偏移（固定不變）
const FINGER_OFFSETS_L = [17, 19, 21].map(i => [
  BASE_POSE[i][0] - BASE_POSE[15][0],
  BASE_POSE[i][1] - BASE_POSE[15][1],
]);
const FINGER_OFFSETS_R = [18, 20, 22].map(i => [
  BASE_POSE[i][0] - BASE_POSE[16][0],
  BASE_POSE[i][1] - BASE_POSE[16][1],
]);

// ─── 關節角度限制（生理範圍）──────────────────────────────────
// 角度基準：y 軸正方向（向下）= 90°，x 正方向（向右）= 0°
const UPPER_ARM_MIN = -80 * DEG;  // 舉過頭極限
const UPPER_ARM_MAX = 160 * DEG;  // 向後下極限
const ELBOW_BEND_MIN = 0;         // 不可反折
const ELBOW_BEND_MAX = 145 * DEG; // 最大彎曲

// ─── 正向動力學（FK）─────────────────────────────────────────
function fkArm(shoulder, L1, L2, thetaUpper, elbowBend, side) {
  thetaUpper = clamp(thetaUpper, UPPER_ARM_MIN, UPPER_ARM_MAX);
  elbowBend = clamp(elbowBend, ELBOW_BEND_MIN, ELBOW_BEND_MAX);

  const ex = shoulder[0] + L1 * Math.cos(thetaUpper);
  const ey = shoulder[1] + L1 * Math.sin(thetaUpper);

  // side: +1 = 左臂（肘向右彎），-1 = 右臂（肘向左彎）
  const thetaLower = thetaUpper + side * elbowBend;
  const wx = ex + L2 * Math.cos(thetaLower);
  const wy = ey + L2 * Math.sin(thetaLower);

  return { elbow: [ex, ey], wrist: [wx, wy] };
}

// ─── Pattern 定義 ────────────────────────────────────────────
// 每個 pattern 是 8 拍的角度序列（度數）
// left_upper / right_upper: 上臂角度（90=下垂, <90=舉起, >90=向後）
// left_elbow / right_elbow: 肘彎曲角度（0=伸直）
const PATTERNS = {
  sway: {
    name: "左右搖擺",
    beats: 8,
    left_upper:  [90, 55, 35, 55, 90, 110, 120, 110],
    left_elbow:  [25, 35, 45, 35, 25, 15,  10,  15],
    right_upper: [90, 110, 120, 110, 90, 55, 35, 55],
    right_elbow: [25, 15,  10,  15,  25, 35, 45, 35],
  },
  raise: {
    name: "雙手舉起放下",
    beats: 8,
    left_upper:  [90, 60, 20, -10, -10, 20, 60, 90],
    left_elbow:  [20, 30, 45,  55,  55, 45, 30, 20],
    right_upper: [90, 60, 20, -10, -10, 20, 60, 90],
    right_elbow: [20, 30, 45,  55,  55, 45, 30, 20],
  },
  wave: {
    name: "波浪擺手",
    beats: 8,
    left_upper:  [90, 40, 10, 40, 90, 90, 90, 90],
    left_elbow:  [20, 60, 90, 60, 20, 20, 20, 20],
    right_upper: [90, 90, 90, 90, 90, 40, 10, 40],
    right_elbow: [20, 20, 20, 20, 20, 60, 90, 60],
  },
  clap: {
    name: "拍手",
    beats: 8,
    left_upper:  [70, 30, 50, 70, 70, 30, 50, 70],
    left_elbow:  [80, 120, 100, 80, 80, 120, 100, 80],
    right_upper: [110, 150, 130, 110, 110, 150, 130, 110],
    right_elbow: [80, 120, 100, 80, 80, 120, 100, 80],
  },
  groove: {
    name: "律動搖擺",
    beats: 8,
    left_upper:  [85, 70, 55, 70, 95, 110, 120, 110],
    left_elbow:  [30, 50, 65, 50, 20, 10,  5,   10],
    right_upper: [95, 110, 125, 110, 85, 70, 55, 70],
    right_elbow: [20, 10,  5,   10,  30, 50, 65, 50],
  },
};

const PATTERN_KEYS = Object.keys(PATTERNS);

// ─── ProceduralSkeleton 主類 ─────────────────────────────────
export class ProceduralSkeleton {
  constructor({ bpm = 120, seed = null } = {}) {
    this.bpm = bpm;
    this.beatSec = 60 / bpm;
    this.startT = 0;

    // Scheduler 狀態
    this._schedule = [];
    this._scheduleBuiltUpToBeat = -1;
    this._rng = this._makeRng(seed);
  }

  _makeRng(seed) {
    if (seed == null) seed = Math.floor(Math.random() * 2147483647);
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  setBpm(bpm) {
    this.bpm = Math.max(40, Math.min(300, bpm));
    this.beatSec = 60 / this.bpm;
  }

  _ensureSchedule(beatIndex) {
    while (this._scheduleBuiltUpToBeat < beatIndex + 16) {
      const patternBeatStart = this._scheduleBuiltUpToBeat + 1;
      const pat = this._pickPattern();
      this._schedule.push({ beatStart: patternBeatStart, pattern: pat });
      this._scheduleBuiltUpToBeat = patternBeatStart + PATTERNS[pat].beats - 1;
    }
  }

  _pickPattern() {
    const last = this._schedule.length > 0
      ? this._schedule[this._schedule.length - 1].pattern
      : null;
    let pick;
    let attempts = 0;
    do {
      pick = PATTERN_KEYS[Math.floor(this._rng() * PATTERN_KEYS.length)];
      attempts++;
    } while (pick === last && PATTERN_KEYS.length > 1 && attempts < 10);
    return pick;
  }

  _getPatternAtBeat(beatIndex) {
    this._ensureSchedule(beatIndex);
    for (let i = this._schedule.length - 1; i >= 0; i--) {
      if (this._schedule[i].beatStart <= beatIndex) return this._schedule[i];
    }
    return this._schedule[0];
  }

  /**
   * 主要方法：給定時間 t（秒），回傳 lm[33] 格式的骨架
   * @param {number} t - YouTube currentTime 秒數
   * @returns {Array<Array<number>>} lm[33][4]
   */
  generate(t) {
    const elapsed = Math.max(0, t - this.startT);
    const beatFloat = elapsed / this.beatSec;
    const beatIndex = Math.floor(beatFloat);

    // 找到當前 pattern 與 pattern 內的拍點
    const entry = this._getPatternAtBeat(beatIndex);
    const pat = PATTERNS[entry.pattern];
    const localBeat = beatIndex - entry.beatStart;
    const localBeatClamped = clamp(localBeat, 0, pat.beats - 1);
    const nextBeat = (localBeatClamped + 1) % pat.beats;

    // 拍內插值比例（0~1）
    const frac = cosEase(beatFloat - beatIndex);

    // 計算目標角度（度 → 弧度），在相鄰兩拍之間 cos ease 插值
    const luDeg = _lerp(pat.left_upper[localBeatClamped], pat.left_upper[nextBeat], frac);
    const leDeg = _lerp(pat.left_elbow[localBeatClamped], pat.left_elbow[nextBeat], frac);
    const ruDeg = _lerp(pat.right_upper[localBeatClamped], pat.right_upper[nextBeat], frac);
    const reDeg = _lerp(pat.right_elbow[localBeatClamped], pat.right_elbow[nextBeat], frac);

    // Perlin noise 微抖（±2°）
    const noiseScale = 2.0;
    const luRad = (luDeg + noiseScale * perlin1d(t * 1.7)) * DEG;
    const leRad = (leDeg + noiseScale * perlin1d(t * 2.3 + 100)) * DEG;
    const ruRad = (ruDeg + noiseScale * perlin1d(t * 1.9 + 200)) * DEG;
    const reRad = (reDeg + noiseScale * perlin1d(t * 2.1 + 300)) * DEG;

    // ── 身體律動 ──
    const omega = (2 * Math.PI) / this.beatSec;
    const bodyBob = 0.012 * Math.sin(omega * elapsed);
    const headTilt = 0.008 * Math.sin(omega * elapsed * 0.5);
    const shoulderSway = 0.006 * Math.sin(omega * elapsed);

    // ── deep copy BASE ──
    const lm = BASE_POSE.map(p => [p[0], p[1], p[2], p[3]]);

    // 身體上下 bob（頭、臉、肩、肘、腕、髖）
    for (let i = 0; i <= 24; i++) {
      lm[i][1] += bodyBob;
    }
    // 頭部左右微晃
    for (let i = 0; i <= 10; i++) {
      lm[i][0] += headTilt;
    }
    // 肩膀微幅左右搖
    lm[11][0] += shoulderSway;
    lm[12][0] -= shoulderSway;

    // ── FK 計算手臂 ──
    const leftArm = fkArm(
      [lm[11][0], lm[11][1]], L_UPPER_L, L_LOWER_L, luRad, leRad, 1
    );
    const rightArm = fkArm(
      [lm[12][0], lm[12][1]], L_UPPER_R, L_LOWER_R, ruRad, reRad, -1
    );

    // 寫入肘、腕
    lm[13][0] = leftArm.elbow[0];  lm[13][1] = leftArm.elbow[1];
    lm[14][0] = rightArm.elbow[0]; lm[14][1] = rightArm.elbow[1];
    lm[15][0] = leftArm.wrist[0];  lm[15][1] = leftArm.wrist[1];
    lm[16][0] = rightArm.wrist[0]; lm[16][1] = rightArm.wrist[1];

    // 手指跟著手腕（保持固定偏移）
    const leftFingerIdx = [17, 19, 21];
    for (let i = 0; i < 3; i++) {
      lm[leftFingerIdx[i]][0] = lm[15][0] + FINGER_OFFSETS_L[i][0];
      lm[leftFingerIdx[i]][1] = lm[15][1] + FINGER_OFFSETS_L[i][1];
    }
    const rightFingerIdx = [18, 20, 22];
    for (let i = 0; i < 3; i++) {
      lm[rightFingerIdx[i]][0] = lm[16][0] + FINGER_OFFSETS_R[i][0];
      lm[rightFingerIdx[i]][1] = lm[16][1] + FINGER_OFFSETS_R[i][1];
    }

    // ── 防穿身約束 ──
    // 左手不超過右肩
    if (lm[15][0] < lm[12][0] - 0.02) {
      lm[15][0] = lm[12][0] - 0.02;
    }
    // 右手不超過左肩
    if (lm[16][0] > lm[11][0] + 0.02) {
      lm[16][0] = lm[11][0] + 0.02;
    }
    // 頭保持在肩上方
    const avgShoulderY = (lm[11][1] + lm[12][1]) / 2;
    if (lm[0][1] > avgShoulderY - 0.03) {
      const fix = avgShoulderY - 0.03 - lm[0][1];
      for (let i = 0; i <= 10; i++) lm[i][1] += fix;
    }

    return lm;
  }
}

// ─── 便利方法：建立一個 synthetic trace 物件 ──────────────────
export function createSyntheticTrace({ bpm = 120, name = null, seed = null } = {}) {
  const skeleton = new ProceduralSkeleton({ bpm, seed });
  return {
    id: `synth_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name: name || `程序化舞者 (${bpm} BPM)`,
    synthetic: true,
    enabled: true,
    bpm,
    _skeleton: skeleton,
  };
}

/**
 * 給 synthetic trace 產出指定時間的 landmarks
 * @param {object} trace - createSyntheticTrace 產出的物件
 * @param {number} t - YouTube currentTime
 * @returns {Array<Array<number>>|null}
 */
export function getSyntheticLandmarksAtTime(trace, t) {
  if (!trace?._skeleton) return null;
  return trace._skeleton.generate(t);
}

export { PATTERNS, PATTERN_KEYS };
