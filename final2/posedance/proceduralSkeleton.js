/**
 * proceduralSkeleton.js
 *
 * 程序化骨架動畫生成器 — FK + 角度驅動 + Pattern 隨機排程 + 差異化機制
 *
 * 輸出格式與 MediaPipe Pose 33 點完全相同：lm[33] = [[x,y,z,visibility], ...]
 * 可直接餵入 posedanceTest.js 的 drawPoseConnections / drawPosePoints。
 *
 * 技術參考：
 * - Ken Perlin, GDC 2002 "Procedural Emotion Shaders" — 角度層修改 + FK
 * - Morrey et al. 1981 / Sardelli 2011 — 肘關節功能範圍 30°-130°
 * - StatPearls NCBI — 盂肱關節屈曲 100°-120°
 * - DanceAnyWay (arXiv 2303.03870) — beat-level + repletion-level 多樣性
 */

// ─── Perlin Noise（輕量 1D，用於微抖）──────────────────────────
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
const L_UPPER_L = dist2d(BASE_POSE[11], BASE_POSE[13]);
const L_LOWER_L = dist2d(BASE_POSE[13], BASE_POSE[15]);
const L_UPPER_R = dist2d(BASE_POSE[12], BASE_POSE[14]);
const L_LOWER_R = dist2d(BASE_POSE[14], BASE_POSE[16]);

const FINGER_OFFSETS_L = [17, 19, 21].map(i => [
  BASE_POSE[i][0] - BASE_POSE[15][0],
  BASE_POSE[i][1] - BASE_POSE[15][1],
]);
const FINGER_OFFSETS_R = [18, 20, 22].map(i => [
  BASE_POSE[i][0] - BASE_POSE[16][0],
  BASE_POSE[i][1] - BASE_POSE[16][1],
]);

// ─── 關節角度限制（基於生物力學文獻）───────────────────────────
// 角度語義：90° = 自然下垂, <90° = 向外/向上舉, >90° = 向內/向後
// 盂肱關節主動活動範圍 100-120°，舞蹈允許舉到頭頂附近
const UPPER_ARM_MIN = -60 * DEG;
const UPPER_ARM_MAX = 110 * DEG;
// 肘關節功能範圍 0-145°，設 140° 讓舉手時前臂能自然下垂
const ELBOW_BEND_MIN = 0;
const ELBOW_BEND_MAX = 140 * DEG;

// ─── 正向動力學（FK）─────────────────────────────────────────
// side: +1 = 左臂, -1 = 右臂
// 角度語義統一：90° = 下垂, <90° = 外展/上舉, >90° = 內收/向後
// 右臂通過 PI-theta 鏡像，使兩臂共用相同角度值
// thetaForearm: 前臂的絕對目標方向（同語義），FK 內部計算所需肘彎並 clamp
function fkArm(shoulder, L1, L2, thetaUpper, thetaForearm, side) {
  thetaUpper = clamp(thetaUpper, UPPER_ARM_MIN, UPPER_ARM_MAX);

  const actualUpper = side > 0 ? thetaUpper : (Math.PI - thetaUpper);

  const ex = shoulder[0] + L1 * Math.cos(actualUpper);
  const ey = shoulder[1] + L1 * Math.sin(actualUpper);

  const targetForearm = side > 0 ? thetaForearm : (Math.PI - thetaForearm);
  let bendAngle = (targetForearm - actualUpper) * side;
  bendAngle = clamp(bendAngle, ELBOW_BEND_MIN, ELBOW_BEND_MAX);

  const actualLower = actualUpper + side * bendAngle;
  const wx = ex + L2 * Math.cos(actualLower);
  const wy = ey + L2 * Math.sin(actualLower);

  return { elbow: [ex, ey], wrist: [wx, wy], forearmAngle: actualLower };
}

// ─── Pattern 定義 ────────────────────────────────────────────
// 每個 pattern 是 8 拍的角度序列（度數）
// left_upper / right_upper: 上臂方向（90=下垂, <90=舉起, >90=後伸）
// left_forearm / right_forearm: 前臂絕對方向（同語義）
// 兩臂共用語義 — FK 內部自動鏡像右臂
const PATTERNS = {
  sway: {
    name: "左右搖擺",
    beats: 8,
    left_upper:    [90, 55, 20, 55, 90, 95, 100, 95],
    left_forearm:  [100, 95, 90, 95, 100, 105, 108, 105],
    right_upper:   [90, 95, 100, 95, 90, 55, 20, 55],
    right_forearm: [100, 105, 108, 105, 100, 95, 90, 95],
  },
  raise: {
    name: "雙手舉起放下",
    beats: 8,
    left_upper:    [90, 45, 0, -40, -40, 0, 45, 90],
    left_forearm:  [100, 90, 80, 70, 70, 80, 90, 100],
    right_upper:   [90, 45, 0, -40, -40, 0, 45, 90],
    right_forearm: [100, 90, 80, 70, 70, 80, 90, 100],
  },
  wave: {
    name: "波浪擺手",
    beats: 8,
    left_upper:    [90, 30, -20, 30, 90, 90, 90, 90],
    left_forearm:  [100, 55, 25, 55, 100, 100, 100, 100],
    right_upper:   [90, 90, 90, 90, 90, 30, -20, 30],
    right_forearm: [100, 100, 100, 100, 100, 55, 25, 55],
  },
  clap: {
    name: "拍手",
    beats: 8,
    left_upper:    [85, 60, 70, 85, 85, 60, 70, 85],
    left_forearm:  [110, 145, 130, 110, 110, 145, 130, 110],
    right_upper:   [85, 60, 70, 85, 85, 60, 70, 85],
    right_forearm: [110, 145, 130, 110, 110, 145, 130, 110],
  },
  groove: {
    name: "律動搖擺",
    beats: 8,
    left_upper:    [88, 75, 65, 75, 92, 100, 105, 100],
    left_forearm:  [100, 105, 115, 105, 100, 108, 112, 108],
    right_upper:   [92, 100, 105, 100, 88, 75, 65, 75],
    right_forearm: [100, 108, 112, 108, 100, 105, 115, 105],
  },
  pump: {
    name: "上下泵動",
    beats: 8,
    left_upper:    [90, 15, 90, 15, 90, 15, 90, 15],
    left_forearm:  [100, 20, 100, 20, 100, 20, 100, 20],
    right_upper:   [15, 90, 15, 90, 15, 90, 15, 90],
    right_forearm: [20, 100, 20, 100, 20, 100, 20, 100],
  },
  reach: {
    name: "伸展收回",
    beats: 8,
    left_upper:    [90, 30, 0, 0, 30, 90, 90, 90],
    left_forearm:  [100, 30, 0, 0, 30, 100, 100, 100],
    right_upper:   [90, 90, 90, 30, 0, 0, 30, 90],
    right_forearm: [100, 100, 100, 30, 0, 0, 30, 100],
  },
  twist: {
    name: "扭轉交替",
    beats: 8,
    left_upper:    [85, 40, 10, 40, 95, 105, 100, 95],
    left_forearm:  [100, 85, 90, 85, 108, 118, 112, 108],
    right_upper:   [95, 105, 100, 95, 85, 40, 10, 40],
    right_forearm: [108, 118, 112, 108, 100, 85, 90, 85],
  },
};

const PATTERN_KEYS = Object.keys(PATTERNS);

// ─── 風格子集 ────────────────────────────────────────────────
const STYLE_POOLS = {
  energetic: ["raise", "wave", "pump", "reach"],
  chill:     ["sway", "groove", "twist"],
  mixed:     PATTERN_KEYS,
};

// ─── ProceduralSkeleton 主類 ─────────────────────────────────
export class ProceduralSkeleton {
  constructor({
    bpm = 120,
    seed = null,
    amplitudeScale = 1.0,
    phaseOffsetBeats = 0,
    style = "mixed",
    rhythmMul = 1.0,
  } = {}) {
    this.bpm = bpm;
    this.beatSec = (60 / bpm) * rhythmMul;
    this.startT = 0;
    this.amplitudeScale = clamp(amplitudeScale, 0.4, 1.6);
    this.phaseOffsetBeats = phaseOffsetBeats;
    this.rhythmMul = rhythmMul;
    this.style = style;
    this._patternPool = STYLE_POOLS[style] || PATTERN_KEYS;

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
    this.beatSec = (60 / this.bpm) * this.rhythmMul;
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
    const pool = this._patternPool;
    const last = this._schedule.length > 0
      ? this._schedule[this._schedule.length - 1].pattern
      : null;
    let pick;
    let attempts = 0;
    do {
      pick = pool[Math.floor(this._rng() * pool.length)];
      attempts++;
    } while (pick === last && pool.length > 1 && attempts < 10);
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
   */
  generate(t) {
    const elapsed = Math.max(0, t - this.startT);
    const beatFloat = (elapsed / this.beatSec) + this.phaseOffsetBeats;
    const beatIndex = Math.floor(beatFloat);

    const entry = this._getPatternAtBeat(beatIndex);
    const pat = PATTERNS[entry.pattern];
    const localBeat = beatIndex - entry.beatStart;
    const localBeatClamped = clamp(localBeat, 0, pat.beats - 1);
    const nextBeat = (localBeatClamped + 1) % pat.beats;

    const frac = cosEase(beatFloat - beatIndex);

    // 插值原始角度（上臂 + 前臂絕對方向）
    const luDegRaw = _lerp(pat.left_upper[localBeatClamped], pat.left_upper[nextBeat], frac);
    const lfDegRaw = _lerp(pat.left_forearm[localBeatClamped], pat.left_forearm[nextBeat], frac);
    const ruDegRaw = _lerp(pat.right_upper[localBeatClamped], pat.right_upper[nextBeat], frac);
    const rfDegRaw = _lerp(pat.right_forearm[localBeatClamped], pat.right_forearm[nextBeat], frac);

    // 振幅縮放：偏離靜止值 90°（下垂）的部分乘以 amplitudeScale
    const amp = this.amplitudeScale;
    const luDeg = 90 + (luDegRaw - 90) * amp;
    const ruDeg = 90 + (ruDegRaw - 90) * amp;
    const lfDeg = 90 + (lfDegRaw - 90) * amp;
    const rfDeg = 90 + (rfDegRaw - 90) * amp;

    // Perlin noise 微抖（±2°）
    const noiseScale = 2.0;
    const luRad = (luDeg + noiseScale * perlin1d(t * 1.7)) * DEG;
    const lfRad = (lfDeg + noiseScale * perlin1d(t * 2.3 + 100)) * DEG;
    const ruRad = (ruDeg + noiseScale * perlin1d(t * 1.9 + 200)) * DEG;
    const rfRad = (rfDeg + noiseScale * perlin1d(t * 2.1 + 300)) * DEG;

    // ── 身體律動（幅度隨 amplitudeScale 縮放）──
    const omega = (2 * Math.PI) / this.beatSec;
    const bodyBob = 0.008 * amp * Math.sin(omega * elapsed);
    const headTilt = 0.006 * amp * Math.sin(omega * elapsed * 0.5);
    const shoulderLift = 0.004 * amp * Math.sin(omega * elapsed);

    // ── deep copy BASE ──
    const lm = BASE_POSE.map(p => [p[0], p[1], p[2], p[3]]);

    // 身體上下 bob
    for (let i = 0; i <= 24; i++) {
      lm[i][1] += bodyBob;
    }
    // 頭部左右微晃
    for (let i = 0; i <= 10; i++) {
      lm[i][0] += headTilt;
    }
    // 肩膀 y 軸微幅上提（左右交替）
    lm[11][1] -= shoulderLift;
    lm[12][1] += shoulderLift;

    // ── FK 計算手臂（傳入上臂角度 + 前臂目標方向）──
    const leftArm = fkArm(
      [lm[11][0], lm[11][1]], L_UPPER_L, L_LOWER_L, luRad, lfRad, 1
    );
    const rightArm = fkArm(
      [lm[12][0], lm[12][1]], L_UPPER_R, L_LOWER_R, ruRad, rfRad, -1
    );

    lm[13][0] = leftArm.elbow[0];  lm[13][1] = leftArm.elbow[1];
    lm[14][0] = rightArm.elbow[0]; lm[14][1] = rightArm.elbow[1];
    lm[15][0] = leftArm.wrist[0];  lm[15][1] = leftArm.wrist[1];
    lm[16][0] = rightArm.wrist[0]; lm[16][1] = rightArm.wrist[1];

    // 手指跟著前臂方向旋轉（BASE_POSE 中前臂約 90° = 朝下）
    const BASE_FOREARM_ANGLE = Math.PI / 2;
    const leftFingerIdx = [17, 19, 21];
    const lRot = leftArm.forearmAngle - BASE_FOREARM_ANGLE;
    const lCos = Math.cos(lRot), lSin = Math.sin(lRot);
    for (let i = 0; i < 3; i++) {
      const ox = FINGER_OFFSETS_L[i][0], oy = FINGER_OFFSETS_L[i][1];
      lm[leftFingerIdx[i]][0] = lm[15][0] + ox * lCos - oy * lSin;
      lm[leftFingerIdx[i]][1] = lm[15][1] + ox * lSin + oy * lCos;
    }
    const rightFingerIdx = [18, 20, 22];
    const rRot = rightArm.forearmAngle - BASE_FOREARM_ANGLE;
    const rCos = Math.cos(rRot), rSin = Math.sin(rRot);
    for (let i = 0; i < 3; i++) {
      const ox = FINGER_OFFSETS_R[i][0], oy = FINGER_OFFSETS_R[i][1];
      lm[rightFingerIdx[i]][0] = lm[16][0] + ox * rCos - oy * rSin;
      lm[rightFingerIdx[i]][1] = lm[16][1] + ox * rSin + oy * rCos;
    }

    // 頭保持在肩上方（安全約束）
    const avgShoulderY = (lm[11][1] + lm[12][1]) / 2;
    if (lm[0][1] > avgShoulderY - 0.03) {
      const fix = avgShoulderY - 0.03 - lm[0][1];
      for (let i = 0; i <= 10; i++) lm[i][1] += fix;
    }

    return lm;
  }
}

// ─── 自動遞增差異預設 ────────────────────────────────────────
const VARIATION_PRESETS = [
  { amplitudeScale: 1.0, phaseOffsetBeats: 0,   style: "mixed",     rhythmMul: 1.0 },
  { amplitudeScale: 0.7, phaseOffsetBeats: 1.5, style: "chill",     rhythmMul: 1.0 },
  { amplitudeScale: 1.3, phaseOffsetBeats: 0.5, style: "energetic", rhythmMul: 1.0 },
  { amplitudeScale: 0.9, phaseOffsetBeats: 2.0, style: "chill",     rhythmMul: 2.0 },
  { amplitudeScale: 1.1, phaseOffsetBeats: 1.0, style: "energetic", rhythmMul: 0.5 },
];

let _synthCounter = 0;

// ─── 便利方法：建立一個 synthetic trace 物件 ──────────────────
export function createSyntheticTrace({ bpm = 120, name = null, seed = null } = {}) {
  const idx = _synthCounter++;

  let preset;
  if (idx < VARIATION_PRESETS.length) {
    preset = VARIATION_PRESETS[idx];
  } else {
    preset = {
      amplitudeScale: 0.6 + Math.random() * 0.8,
      phaseOffsetBeats: Math.random() * 3,
      style: ["mixed", "energetic", "chill"][Math.floor(Math.random() * 3)],
      rhythmMul: [0.5, 1.0, 1.0, 2.0][Math.floor(Math.random() * 4)],
    };
  }

  const skeleton = new ProceduralSkeleton({ bpm, seed, ...preset });
  const styleTag = preset.style === "mixed" ? "" : ` [${preset.style}]`;
  return {
    id: `synth_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name: name || `程序化舞者 #${idx + 1}${styleTag} (${bpm} BPM)`,
    synthetic: true,
    enabled: true,
    bpm,
    _skeleton: skeleton,
  };
}

/**
 * 給 synthetic trace 產出指定時間的 landmarks
 */
export function getSyntheticLandmarksAtTime(trace, t) {
  if (!trace?._skeleton) return null;
  return trace._skeleton.generate(t);
}

export { PATTERNS, PATTERN_KEYS };
