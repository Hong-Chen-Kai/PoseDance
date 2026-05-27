/**
 * proceduralSkeleton.js
 *
 * 程序化骨架動畫生成器 — 角度驅動 + Pattern blend + 2D IK + Spring 平滑
 *
 * 輸出格式與 MediaPipe Pose 33 點完全相同：lm[33] = [[x,y,z,visibility], ...]
 * 可直接餵入 posedanceTest.js 的 drawPoseConnections / drawPosePoints。
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

function smootherstep(t) {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ─── 調參預設（第一版寫死，不暴露 UI 滑桿）────────────────────
const BLEND_WINDOW_BEATS = 0.75;
const SOFT_IK_RATIO = 0.08;
const SPRING_HALF_LIFE_MAX = 0.18;
const SPRING_HALF_LIFE_BEAT_RATIO = 0.25;
const NOISE_SCALE_DEG = 1.2;

// 盂肱關節：外旋約 0–90°、內旋約 0–70°（主動，依文獻近似）
const HUMERAL_ROT_NEUTRAL = 15;
const HUMERAL_ROT_MIN = -55;
const HUMERAL_ROT_MAX = 75;
const ELBOW_FLEX_MIN = 12;
const ELBOW_FLEX_MAX = 140;
const CARRYING_ANGLE_BASE = 32;

function softIKDistance(d, L1, L2, softness) {
  const maxReach = L1 + L2 - 1e-4;
  const minReach = Math.abs(L1 - L2) + 1e-4;
  d = clamp(d, minReach, maxReach);
  if (softness <= 0 || d <= maxReach - softness) return d;
  const t = (d - (maxReach - softness)) / softness;
  return maxReach - softness * Math.exp(-3 * t);
}

function pickElbowSolution(elbow1, elbow2, shoulder, pole, prevElbow) {
  const score = (elbow) => {
    const dx = elbow[0] - shoulder[0];
    const dy = elbow[1] - shoulder[1];
    const px = pole[0] - shoulder[0];
    const py = pole[1] - shoulder[1];
    let s = dx * px + dy * py;
    if (prevElbow) s -= dist2d(elbow, prevElbow) * 80;
    return s;
  };
  return score(elbow1) >= score(elbow2) ? elbow1 : elbow2;
}

function solveTwoBoneIK2D(shoulder, target, L1, L2, pole, prevElbow) {
  let dx = target[0] - shoulder[0];
  let dy = target[1] - shoulder[1];
  let dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) {
    dist = 1e-6;
    dx = 0;
    dy = 1e-6;
  }

  const softness = SOFT_IK_RATIO * (L1 + L2);
  dist = softIKDistance(dist, L1, L2, softness);

  const minReach = Math.abs(L1 - L2) + 1e-5;
  const maxReach = L1 + L2 - 1e-5;
  dist = clamp(dist, minReach, maxReach);

  const baseAngle = Math.atan2(dy, dx);
  const cosOffset = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const offset = Math.acos(cosOffset);

  const elbow1 = [
    shoulder[0] + L1 * Math.cos(baseAngle + offset),
    shoulder[1] + L1 * Math.sin(baseAngle + offset),
  ];
  const elbow2 = [
    shoulder[0] + L1 * Math.cos(baseAngle - offset),
    shoulder[1] + L1 * Math.sin(baseAngle - offset),
  ];
  const elbow = pickElbowSolution(elbow1, elbow2, shoulder, pole, prevElbow);

  const toWristAngle = Math.atan2(
    shoulder[1] + dist * Math.sin(baseAngle) - elbow[1],
    shoulder[0] + dist * Math.cos(baseAngle) - elbow[0],
  );
  const wrist = [
    elbow[0] + L2 * Math.cos(toWristAngle),
    elbow[1] + L2 * Math.sin(toWristAngle),
  ];
  const forearmAngle = Math.atan2(wrist[1] - elbow[1], wrist[0] - elbow[0]);
  return { elbow, wrist, forearmAngle };
}

function clampElbowFlexForElevation(flexDeg, elevationDeg) {
  let maxFlex = ELBOW_FLEX_MAX;
  if (elevationDeg > 120) maxFlex = 118;
  else if (elevationDeg > 95) maxFlex = 128;
  else if (elevationDeg < 15) maxFlex = 132;
  const minFlex = elevationDeg < 20 ? 18 : ELBOW_FLEX_MIN;
  return clamp(flexDeg, minFlex, maxFlex);
}

/**
 * 從 pattern 的 upper/forearm 角轉成解剖意圖：
 * elevation 抬舉、sweep 前後掃掠、elbowFlex 肘屈、humeralRot 肱骨內/外旋
 */
function patternToArmIntent(upperDeg, forearmDeg) {
  const elevation = clamp(90 - upperDeg, 0, 165);
  let elbowFlex = Math.abs(forearmDeg - upperDeg);
  if (elbowFlex > 170) elbowFlex = 360 - elbowFlex;
  elbowFlex = clampElbowFlexForElevation(elbowFlex, elevation);

  const sweep = clamp((forearmDeg - 90) * 0.55 + (upperDeg - 90) * 0.2, -72, 72);
  const humeralRot = computeHumeralRotationDeg(elevation, elbowFlex, sweep);
  return { elevation, sweep, elbowFlex, humeralRot };
}

function computeHumeralRotationDeg(elevation, elbowFlex, sweep) {
  let rot = HUMERAL_ROT_NEUTRAL;

  // 側舉 / 律動：外旋增加，肘窩朝外
  rot += clamp(elevation * 0.22, 0, 28) * (1 - Math.abs(sweep) / 85);

  // 前伸直臂：略內旋
  if (sweep < -22 && elbowFlex < 45) {
    rot -= 18 * clamp(-sweep / 55, 0, 1);
  }

  // 胸前彎肘（拍手、抱胸）：內旋
  if (sweep < -12 && elbowFlex > 65) {
    rot -= 38 * clamp((elbowFlex - 55) / 75, 0, 1) * clamp(-sweep / 45, 0.4, 1);
  }

  // 過頭直臂：中性略外旋
  if (elevation > 105 && elbowFlex < 40) rot += 8;

  // 過頭彎肘（手靠頭）：內旋
  if (elevation > 95 && elbowFlex > 58) {
    rot -= 42 * clamp((elevation - 85) / 70, 0, 1) * clamp((elbowFlex - 50) / 80, 0, 1);
  }

  // 後方動作：外旋
  if (sweep > 24) rot += 22 * clamp(sweep / 55, 0, 1);

  return clamp(rot, HUMERAL_ROT_MIN, HUMERAL_ROT_MAX);
}

function solveUpperArmDir(elevationDeg, sweepDeg, humeralRotDeg, side) {
  const e = elevationDeg * DEG;
  const s = sweepDeg * DEG;
  const rot = humeralRotDeg * DEG;
  const cosE = Math.cos(e);
  const sinE = Math.sin(e);
  const cosS = Math.cos(s);
  const sinS = Math.sin(s);

  const y = cosE * Math.max(0.25, cosS);
  const x = side * (sinE * 0.82 + cosE * sinS * 0.28 + Math.sin(rot) * 0.12);
  const z = -sinE * sinS * 0.5 - Math.sin(rot) * 0.18;

  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

function computeAnatomicalPole(shoulder, upperDir, humeralRotDeg, side) {
  const rot = humeralRotDeg * DEG;
  const ext = side * (0.038 + Math.sin(rot) * 0.028);
  const down = 0.055 + Math.cos(rot) * 0.018;
  const perpX = -upperDir.y * side * 0.04;
  const perpY = upperDir.x * side * 0.04;
  return [shoulder[0] + ext + perpX, shoulder[1] + down + perpY];
}

function solveArmAnatomical(shoulder, L1, L2, intent, side, prevElbow) {
  const { elevation, sweep, elbowFlex, humeralRot } = intent;
  const upperDir = solveUpperArmDir(elevation, sweep, humeralRot, side);
  const pole = computeAnatomicalPole(shoulder, upperDir, humeralRot, side);

  const upperAngle = Math.atan2(upperDir.y, upperDir.x);
  const carrying = (CARRYING_ANGLE_BASE + humeralRot * 0.55) * DEG * side;
  const sweepDamp = 1 - 0.28 * Math.abs(Math.sin(sweep * DEG));
  const flexRad = elbowFlex * DEG * sweepDamp;
  const forearmAngle = upperAngle + carrying + side * flexRad;

  const elbow = [
    shoulder[0] + L1 * upperDir.x,
    shoulder[1] + L1 * upperDir.y,
  ];
  const wrist = [
    elbow[0] + L2 * Math.cos(forearmAngle),
    elbow[1] + L2 * Math.sin(forearmAngle),
  ];

  const ik = solveTwoBoneIK2D(shoulder, wrist, L1, L2, pole, prevElbow);
  return { ...ik, upperDir, humeralRot, elbowFlex };
}

function criticalDampedSpring1D(state, key, vKey, target, halfLife, dt) {
  if (halfLife <= 1e-6 || dt <= 0) {
    state[key] = target;
    state[vKey] = 0;
    return;
  }
  const omega = 0.6931471805599453 / halfLife;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = state[key] - target;
  const temp = (state[vKey] + omega * change) * dt;
  state[vKey] = (state[vKey] - omega * temp) * exp;
  state[key] = target + (change + temp) * exp;
}

function springArmIntent(state, target, halfLife, dt) {
  criticalDampedSpring1D(state, "elevation", "vElev", target.elevation, halfLife, dt);
  criticalDampedSpring1D(state, "sweep", "vSweep", target.sweep, halfLife, dt);
  criticalDampedSpring1D(state, "elbowFlex", "vFlex", target.elbowFlex, halfLife, dt);
  criticalDampedSpring1D(state, "humeralRot", "vRot", target.humeralRot, halfLife, dt);
  return {
    elevation: state.elevation,
    sweep: state.sweep,
    elbowFlex: state.elbowFlex,
    humeralRot: state.humeralRot,
  };
}

function createArmIntentState() {
  const rest = patternToArmIntent(90, 100);
  return {
    elevation: rest.elevation,
    sweep: rest.sweep,
    elbowFlex: rest.elbowFlex,
    humeralRot: rest.humeralRot,
    vElev: 0,
    vSweep: 0,
    vFlex: 0,
    vRot: 0,
  };
}

function applyShoulderDrive(lm, intentL, intentR, amp) {
  const liftL = clamp(intentL.elevation / 90, 0, 1) * 0.014 * amp;
  const liftR = clamp(intentR.elevation / 90, 0, 1) * 0.014 * amp;
  lm[11][0] += liftL * 0.35;
  lm[11][1] -= liftL;
  lm[12][0] -= liftR * 0.35;
  lm[12][1] -= liftR;
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

function applySimpleZ(lm, elbowIdx, wristIdx, fingerIdxs, shoulder, wrist, L1, L2, armResult, sideSign) {
  const reachNorm = clamp(dist2d(shoulder, wrist) / (L1 + L2), 0, 1);
  const rotZ = Math.sin(armResult.humeralRot * DEG) * 0.035;
  const depthZ = -0.055 * reachNorm + rotZ;
  const zOffset = depthZ * sideSign + (armResult.upperDir?.z || 0) * 0.06;
  lm[elbowIdx][2] = BASE_POSE[elbowIdx][2] + zOffset * 0.45;
  lm[wristIdx][2] = BASE_POSE[wristIdx][2] + zOffset;
  for (const fi of fingerIdxs) {
    lm[fi][2] = BASE_POSE[fi][2] + zOffset * 0.85;
  }
}

// ─── Pattern 定義 ────────────────────────────────────────────
// upper: 90=下垂, 越小越抬舉；forearm: 與 upper 差值≈肘屈（經 anatomy 轉換）
const PATTERNS = {
  sway: {
    name: "左右搖擺",
    beats: 8,
    left_upper:    [90, 62, 42, 62, 90, 98, 102, 98],
    left_forearm:  [105, 108, 112, 108, 105, 112, 118, 112],
    right_upper:   [90, 98, 102, 98, 90, 62, 42, 62],
    right_forearm: [105, 112, 118, 112, 105, 108, 112, 108],
  },
  raise: {
    name: "雙手舉起放下",
    beats: 8,
    left_upper:    [90, 55, 25, 5, 5, 25, 55, 90],
    left_forearm:  [105, 115, 125, 130, 130, 125, 115, 105],
    right_upper:   [90, 55, 25, 5, 5, 25, 55, 90],
    right_forearm: [105, 115, 125, 130, 130, 125, 115, 105],
  },
  wave: {
    name: "波浪擺手",
    beats: 8,
    left_upper:    [90, 45, 20, 45, 90, 90, 90, 90],
    left_forearm:  [108, 125, 135, 125, 108, 108, 108, 108],
    right_upper:   [90, 90, 90, 90, 90, 45, 20, 45],
    right_forearm: [108, 108, 108, 108, 108, 125, 135, 125],
  },
  clap: {
    name: "拍手",
    beats: 8,
    left_upper:    [88, 68, 72, 88, 88, 68, 72, 88],
    left_forearm:  [118, 145, 138, 118, 118, 145, 138, 118],
    right_upper:   [88, 68, 72, 88, 88, 68, 72, 88],
    right_forearm: [118, 145, 138, 118, 118, 145, 138, 118],
  },
  groove: {
    name: "律動搖擺",
    beats: 8,
    left_upper:    [90, 78, 68, 78, 92, 100, 104, 100],
    left_forearm:  [108, 118, 128, 118, 108, 115, 120, 115],
    right_upper:   [92, 100, 104, 100, 90, 78, 68, 78],
    right_forearm: [108, 115, 120, 115, 108, 118, 128, 118],
  },
  pump: {
    name: "上下泵動",
    beats: 8,
    left_upper:    [90, 35, 90, 35, 90, 35, 90, 35],
    left_forearm:  [108, 115, 108, 115, 108, 115, 108, 115],
    right_upper:   [35, 90, 35, 90, 35, 90, 35, 90],
    right_forearm: [115, 108, 115, 108, 115, 108, 115, 108],
  },
  reach: {
    name: "伸展收回",
    beats: 8,
    left_upper:    [90, 40, 15, 15, 40, 90, 90, 90],
    left_forearm:  [108, 108, 105, 105, 108, 108, 108, 108],
    right_upper:   [90, 90, 90, 40, 15, 15, 40, 90],
    right_forearm: [108, 108, 108, 108, 105, 105, 108, 108],
  },
  twist: {
    name: "扭轉交替",
    beats: 8,
    left_upper:    [88, 52, 28, 52, 96, 104, 100, 96],
    left_forearm:  [108, 118, 125, 118, 115, 125, 122, 115],
    right_upper:   [96, 104, 100, 96, 88, 52, 28, 52],
    right_forearm: [115, 125, 122, 115, 108, 118, 125, 118],
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

    this._armState = {
      L: createArmIntentState(),
      R: createArmIntentState(),
    };
    this._prevElbow = { L: null, R: null };
    this._prevT = null;
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

  _sampleAnglesForPattern(pat, localBeatFloat) {
    const beats = pat.beats;
    const idx = Math.floor(localBeatFloat) % beats;
    const next = (idx + 1) % beats;
    const frac = cosEase(localBeatFloat - Math.floor(localBeatFloat));
    return {
      lu: _lerp(pat.left_upper[idx], pat.left_upper[next], frac),
      lf: _lerp(pat.left_forearm[idx], pat.left_forearm[next], frac),
      ru: _lerp(pat.right_upper[idx], pat.right_upper[next], frac),
      rf: _lerp(pat.right_forearm[idx], pat.right_forearm[next], frac),
    };
  }

  _sampleArmAngles(beatFloat, entry) {
    const pat = PATTERNS[entry.pattern];
    const localBeatFloat = beatFloat - entry.beatStart;
    let angles = this._sampleAnglesForPattern(pat, localBeatFloat);

    if (localBeatFloat >= pat.beats - BLEND_WINDOW_BEATS) {
      const w = smootherstep((localBeatFloat - (pat.beats - BLEND_WINDOW_BEATS)) / BLEND_WINDOW_BEATS);
      const nextBeatStart = entry.beatStart + pat.beats;
      this._ensureSchedule(nextBeatStart);
      const nextEntry = this._getPatternAtBeat(nextBeatStart);
      const nextPat = PATTERNS[nextEntry.pattern];
      const nextLocal = localBeatFloat - (pat.beats - BLEND_WINDOW_BEATS);
      const nextAngles = this._sampleAnglesForPattern(nextPat, nextLocal);
      angles = {
        lu: _lerp(angles.lu, nextAngles.lu, w),
        lf: _lerp(angles.lf, nextAngles.lf, w),
        ru: _lerp(angles.ru, nextAngles.ru, w),
        rf: _lerp(angles.rf, nextAngles.rf, w),
      };
    }

    return angles;
  }

  _resetArmDynamics() {
    this._armState.L = createArmIntentState();
    this._armState.R = createArmIntentState();
    this._prevElbow.L = null;
    this._prevElbow.R = null;
  }

  /**
   * 主要方法：給定時間 t（秒），回傳 lm[33] 格式的骨架
   */
  generate(t) {
    const elapsed = Math.max(0, t - this.startT);
    const beatFloat = (elapsed / this.beatSec) + this.phaseOffsetBeats;
    const beatIndex = Math.floor(beatFloat);

    const entry = this._getPatternAtBeat(beatIndex);
    const raw = this._sampleArmAngles(beatFloat, entry);

    const amp = this.amplitudeScale;
    const luDeg = 90 + (raw.lu - 90) * amp;
    const ruDeg = 90 + (raw.ru - 90) * amp;
    const lfDeg = 90 + (raw.lf - 90) * amp;
    const rfDeg = 90 + (raw.rf - 90) * amp;

    const noiseLu = NOISE_SCALE_DEG * perlin1d(t * 1.7);
    const noiseLf = NOISE_SCALE_DEG * perlin1d(t * 2.3 + 100);
    const noiseRu = NOISE_SCALE_DEG * perlin1d(t * 1.9 + 200);
    const noiseRf = NOISE_SCALE_DEG * perlin1d(t * 2.1 + 300);

    const intentL = patternToArmIntent(luDeg + noiseLu, lfDeg + noiseLf);
    const intentR = patternToArmIntent(ruDeg + noiseRu, rfDeg + noiseRf);

    let dt = this._prevT == null ? 1 / 60 : clamp(t - this._prevT, 1 / 240, 0.05);
    if (this._prevT != null && (t < this._prevT - 1e-4 || t - this._prevT > 0.2)) {
      this._resetArmDynamics();
      dt = 1 / 60;
    }
    this._prevT = t;

    const halfLife = Math.min(SPRING_HALF_LIFE_MAX, this.beatSec * SPRING_HALF_LIFE_BEAT_RATIO);

    const omega = (2 * Math.PI) / this.beatSec;
    const bodyBob = 0.008 * amp * Math.sin(omega * elapsed);
    const headTilt = 0.006 * amp * Math.sin(omega * elapsed * 0.5);
    const shoulderLift = 0.004 * amp * Math.sin(omega * elapsed);

    const lm = BASE_POSE.map(p => [p[0], p[1], p[2], p[3]]);

    for (let i = 0; i <= 24; i++) lm[i][1] += bodyBob;
    for (let i = 0; i <= 10; i++) lm[i][0] += headTilt;
    lm[11][1] -= shoulderLift;
    lm[12][1] += shoulderLift;

    applyShoulderDrive(lm, intentL, intentR, amp);

    const leftShoulder = [lm[11][0], lm[11][1]];
    const rightShoulder = [lm[12][0], lm[12][1]];

    const smoothL = springArmIntent(this._armState.L, intentL, halfLife, dt);
    const smoothR = springArmIntent(this._armState.R, intentR, halfLife, dt);

    const leftArm = solveArmAnatomical(
      leftShoulder, L_UPPER_L, L_LOWER_L, smoothL, 1, this._prevElbow.L,
    );
    const rightArm = solveArmAnatomical(
      rightShoulder, L_UPPER_R, L_LOWER_R, smoothR, -1, this._prevElbow.R,
    );

    this._prevElbow.L = leftArm.elbow;
    this._prevElbow.R = rightArm.elbow;

    lm[13][0] = leftArm.elbow[0];  lm[13][1] = leftArm.elbow[1];
    lm[14][0] = rightArm.elbow[0]; lm[14][1] = rightArm.elbow[1];
    lm[15][0] = leftArm.wrist[0];  lm[15][1] = leftArm.wrist[1];
    lm[16][0] = rightArm.wrist[0]; lm[16][1] = rightArm.wrist[1];

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

    applySimpleZ(lm, 13, 15, leftFingerIdx, leftShoulder, leftArm.wrist, L_UPPER_L, L_LOWER_L, leftArm, 1);
    applySimpleZ(lm, 14, 16, rightFingerIdx, rightShoulder, rightArm.wrist, L_UPPER_R, L_LOWER_R, rightArm, -1);

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
