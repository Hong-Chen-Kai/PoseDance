/**
 * proceduralSkeleton.js
 *
 * 程序化骨架動畫生成器 — Pattern 手臂 + 街舞律動 Swing/Bounce（可切換）
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

function normalize2d(x, y) {
  const len = Math.hypot(x, y);
  if (len < 1e-8) return [0, 1];
  return [x / len, y / len];
}

/** 將 joint 固定在 from 起算 length 的位置（方向沿用 to→from） */
function placeAtLength(from, toward, length) {
  const [nx, ny] = normalize2d(toward[0] - from[0], toward[1] - from[1]);
  return [from[0] + nx * length, from[1] + ny * length];
}

function enforceArmGeometry(shoulder, elbow, wrist, L1, L2) {
  const elbow2 = placeAtLength(shoulder, elbow, L1);
  const wrist2 = placeAtLength(elbow2, wrist, L2);
  return { elbow: elbow2, wrist: wrist2 };
}

function enforceLegGeometry(hip, knee, ankle, L1, L2) {
  const knee2 = placeAtLength(hip, knee, L1);
  const ankle2 = placeAtLength(knee2, ankle, L2);
  return { knee: knee2, ankle: ankle2 };
}

function smootherstep(t) {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ─── 調參預設 ────────────────────────────────────────────────
const BLEND_WINDOW_BEATS = 0.75;
const SPRING_HALF_LIFE_MAX = 0.18;
const SPRING_HALF_LIFE_BEAT_RATIO = 0.25;
const NOISE_SCALE_DEG = 1.0;

// 盂肱：外展 0=垂下、90=水平、165=過頭；內/外旋（度）
const HUMERAL_ROT_NEUTRAL = 18;
const HUMERAL_ROT_MIN = -60;
const HUMERAL_ROT_MAX = 85;
const ELBOW_FLEX_MIN = 12;
const ELBOW_FLEX_MAX = 145;
const CARRYING_ANGLE_BASE = 28;
// 靜止站姿上臂略外展（對齊 BASE_POSE）
const REST_ABDUCTION_DEG = 12;

// ─── 街舞律動：Swing（上身）/ Bounce（下身）────────────────────
/** @typedef {'swing' | 'bounce' | 'both'} GrooveMode */
export const GROOVE_MODES = Object.freeze({
  SWING: "swing",
  BOUNCE: "bounce",
  BOTH: "both",
});

// 與拍同相：sin(ωt) 峰值 = 下沉最深（bounce 與 swing 共用）
const BODY_BOB_AMP = 0.008;
const HEAD_TILT_AMP = 0.006;
// Swing：左右肩一上一下（街舞上身，不作用於腿）
const SWING_AMP = 0.004;
// Bounce：骨盆/膝隨拍下沉；膝小幅外開；踝/腳跟貼地不橫移；腳掌外八僅旋轉趾跟
const BOUNCE_HIP_DROP = 0.008;
const BOUNCE_KNEE_OUT_MAX = 0.0045;
// 腳底貼地：腳跟–腳尖同 y，略外八（左 toe 往左、右 toe 往右）
const FOOT_GROUND_Y_OFFSET = 0.017;
const FOOT_TOE_SPAN_X = 0.022;

function clampElbowFlexForElevation(flexDeg, elevationDeg) {
  let maxFlex = ELBOW_FLEX_MAX;
  if (elevationDeg > 125) maxFlex = 132;
  else if (elevationDeg > 95) maxFlex = 138;
  else if (elevationDeg < 15) maxFlex = 132;
  const minFlex = elevationDeg < 20 ? 18 : ELBOW_FLEX_MIN;
  return clamp(flexDeg, minFlex, maxFlex);
}

/**
 * 從 pattern 角轉解剖意圖：
 * elevation 0=垂下、90=水平外展、165=過頭
 * sweep 前(+)/後(-) 掃掠；elbowFlex 肘屈；humeralRot 內/外旋
 */
function patternToArmIntent(upperDeg, forearmDeg) {
  const elevation = clamp(90 - upperDeg, 0, 165);
  let elbowFlex = Math.abs(forearmDeg - upperDeg);
  if (elbowFlex > 170) elbowFlex = 360 - elbowFlex;
  elbowFlex = clampElbowFlexForElevation(elbowFlex, elevation);

  const sweep = clamp(
    (forearmDeg - 90) * 0.5 + (upperDeg - 90) * 0.35,
    -80,
    80,
  );
  const humeralRot = computeHumeralRotationDeg(elevation, elbowFlex, sweep);
  return { elevation, sweep, elbowFlex, humeralRot };
}

function computeHumeralRotationDeg(elevation, elbowFlex, sweep) {
  let rot = HUMERAL_ROT_NEUTRAL;

  // 側舉 / 過頭投降：外旋（肘窩朝外、前臂可朝上）
  rot += clamp(elevation * 0.28, 0, 38) * (1 - Math.abs(sweep) / 90);
  if (elevation > 78 && elevation < 130 && elbowFlex > 55) {
    rot += 28 * clamp((elevation - 70) / 45, 0, 1) * clamp((elbowFlex - 50) / 70, 0, 1);
  }

  // 前伸直臂：略內旋
  if (sweep < -20 && elbowFlex < 45) {
    rot -= 20 * clamp(-sweep / 55, 0, 1);
  }

  // 胸前彎肘（拍手）：內旋
  if (sweep < -10 && elbowFlex > 60) {
    rot -= 42 * clamp((elbowFlex - 55) / 75, 0, 1) * clamp(-sweep / 40, 0.35, 1);
  }

  // 過頭直臂：略外旋
  if (elevation > 115 && elbowFlex < 35) rot += 12;

  // 過頭彎肘（手靠頭）：內旋
  if (elevation > 100 && elbowFlex > 55) {
    rot -= 35 * clamp((elevation - 90) / 65, 0, 1) * clamp((elbowFlex - 45) / 85, 0, 1);
  }

  // 後方動作：外旋
  if (sweep > 22) rot += 24 * clamp(sweep / 55, 0, 1);

  return clamp(rot, HUMERAL_ROT_MIN, HUMERAL_ROT_MAX);
}

/**
 * 上臂方向：pitch=elevation（0 垂下 → 165 過頭），y 向上為負（螢幕座標）
 */
function solveUpperArmDir(elevationDeg, sweepDeg, humeralRotDeg, side) {
  const pitch = (REST_ABDUCTION_DEG + elevationDeg * 0.96) * DEG;
  const yaw = sweepDeg * DEG;
  const rot = humeralRotDeg * DEG;
  const spread = 1 + clamp(elevationDeg / 100, 0, 0.35);

  const x = side * spread * (Math.sin(pitch) * Math.cos(yaw * 0.55) + Math.sin(rot) * 0.1);
  const y = Math.cos(pitch) * Math.cos(yaw * 0.38);
  const z = -Math.sin(yaw) * Math.sin(pitch) * 0.55 - Math.sin(rot) * 0.22;

  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

function pickForearmAngle(upperAngle, elbowFlex, humeralRot, side, elevation, prevForearmAngle) {
  const carrying = (CARRYING_ANGLE_BASE + humeralRot * 0.42) * DEG * side;
  const flexRad = elbowFlex * DEG;
  const candA = upperAngle + carrying + side * flexRad;
  const candB = upperAngle + carrying - side * flexRad;

  let picked;
  if (prevForearmAngle != null) {
    const da = Math.abs(Math.atan2(Math.sin(candA - prevForearmAngle), Math.cos(candA - prevForearmAngle)));
    const db = Math.abs(Math.atan2(Math.sin(candB - prevForearmAngle), Math.cos(candB - prevForearmAngle)));
    picked = da <= db ? candA : candB;
  } else if (elevation > 70 && elbowFlex > 45) {
    picked = Math.sin(candA) < Math.sin(candB) ? candA : candB;
  } else {
    picked = candA;
  }

  // 投降 / 過頭彎肘：前臂朝上方收（螢幕 y 更小）
  if (elevation > 72 && elbowFlex > 68) {
    const upAngle = -Math.PI / 2 + side * (0.12 + humeralRot * 0.004 * DEG);
    const blend = clamp((elevation - 72) / 48, 0, 1) * clamp((elbowFlex - 68) / 55, 0, 1);
    const d = Math.atan2(Math.sin(picked - upAngle), Math.cos(picked - upAngle));
    picked = picked - d * blend * 0.82;
  }

  return picked;
}

/** 純 FK：固定 L1/L2，避免 IK 二次解算造成骨長伸縮 */
function solveArmAnatomical(shoulder, L1, L2, intent, side, prevForearmAngle) {
  const { elevation, sweep, elbowFlex, humeralRot } = intent;
  const upperDir = solveUpperArmDir(elevation, sweep, humeralRot, side);
  const upperAngle = Math.atan2(upperDir.y, upperDir.x);
  const forearmAngle = pickForearmAngle(
    upperAngle, elbowFlex, humeralRot, side, elevation, prevForearmAngle,
  );

  const elbow = [
    shoulder[0] + L1 * upperDir.x,
    shoulder[1] + L1 * upperDir.y,
  ];
  const wrist = [
    elbow[0] + L2 * Math.cos(forearmAngle),
    elbow[1] + L2 * Math.sin(forearmAngle),
  ];

  return { elbow, wrist, forearmAngle, upperDir, humeralRot, elbowFlex };
}

function springHalfLifeForPattern(patternName, beatSec) {
  const base = Math.min(SPRING_HALF_LIFE_MAX, beatSec * SPRING_HALF_LIFE_BEAT_RATIO);
  if (patternName === "toyman") return Math.min(0.07, base);
  if (patternName === "armwave") return Math.min(0.2, base * 1.35);
  if (patternName === "pump" || patternName === "disco") return Math.min(0.13, base);
  return base;
}

function modulateToymanIntent(intent) {
  const snap = (v, step) => Math.round(v / step) * step;
  return {
    elevation: clamp(snap(intent.elevation, 45), 0, 165),
    sweep: clamp(snap(intent.sweep, 30), -80, 80),
    elbowFlex: clamp(snap(intent.elbowFlex, 45), 30, 135),
    humeralRot: clamp(snap(intent.humeralRot, 20), HUMERAL_ROT_MIN, HUMERAL_ROT_MAX),
  };
}

/** 波浪沿肩→肘→手傳遞（相位遞延，幅度柔和） */
function wavePhase(localBeatFloat, delayBeats, side) {
  const p = (localBeatFloat / 8 - delayBeats) * Math.PI * 2 + side * 0.35;
  return Math.sin(p);
}

function modulateArmWaveIntent(intent, localBeatFloat, side) {
  const wShoulder = wavePhase(localBeatFloat, 0, side);
  const wElbow = wavePhase(localBeatFloat, 0.32, side);
  const wHand = wavePhase(localBeatFloat, 0.62, side);
  return {
    elevation: clamp(intent.elevation + 9 * wShoulder, 0, 165),
    sweep: clamp(intent.sweep + 5 * wShoulder, -80, 80),
    elbowFlex: clamp(intent.elbowFlex + 16 * wElbow, ELBOW_FLEX_MIN, ELBOW_FLEX_MAX),
    humeralRot: clamp(intent.humeralRot + 7 * wHand, HUMERAL_ROT_MIN, HUMERAL_ROT_MAX),
  };
}

/** 手部節點波浪：pinky → index → thumb 依序起伏（不改手腕–肘長度） */
function applyHandWaveChain(lm, wristIdx, fingerIdxs, localBeatFloat, side) {
  const ampY = 0.014;
  const ampX = 0.009;
  fingerIdxs.forEach((fi, i) => {
    const w = wavePhase(localBeatFloat, 0.62 + i * 0.14, side);
    lm[fi][0] += ampX * w * side;
    lm[fi][1] += ampY * w;
  });
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

function computeBeatSin(elapsed, beatSec) {
  return Math.sin((2 * Math.PI / beatSec) * elapsed);
}

/** sin 峰值 = 1 → 下沉最深（與拍點對齊） */
function bounceDown01(beatSin) {
  return clamp((beatSin + 1) * 0.5, 0, 1);
}

/**
 * Swing（街舞上身）：左肩下、右肩上 ↔ 反相，僅 11/12，不動腿。
 */
function applySwing(lm, beatSin, amp) {
  const swing = SWING_AMP * amp * beatSin;
  lm[11][1] -= swing;
  lm[12][1] += swing;
}

/**
 * 髖–踝固定段長求膝。
 * side 'L'|'R'：左膝 x 應 ≥ 基線、右膝 x 應 ≤ 基線（外開，避免內扣）。
 */
function solveKneeFromHipAnkle(hip, ankle, L1, L2, baseKnee, side) {
  const dx = ankle[0] - hip[0];
  const dy = ankle[1] - hip[1];
  let d = Math.hypot(dx, dy);
  if (d < 1e-8) return [baseKnee[0], baseKnee[1]];
  const maxD = L1 + L2 - 1e-5;
  const minD = Math.abs(L1 - L2) + 1e-5;
  d = clamp(d, minD, maxD);
  const ux = dx / d;
  const uy = dy / d;
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h2 = L1 * L1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const midX = hip[0] + ux * a;
  const midY = hip[1] + uy * a;
  const px = -uy;
  const py = ux;
  const k1 = [midX + px * h, midY + py * h];
  const k2 = [midX - px * h, midY - py * h];
  if (h < 1e-6) return [midX, midY];
  const scoreKnee = (k) => {
    const dyDown = k[1] - baseKnee[1];
    const inward = side === "L"
      ? Math.max(0, baseKnee[0] - k[0])
      : Math.max(0, k[0] - baseKnee[0]);
    const outward = side === "L"
      ? Math.max(0, k[0] - baseKnee[0])
      : Math.max(0, baseKnee[0] - k[0]);
    return inward * 200 - outward * 10 - dyDown * 8;
  };
  return scoreKnee(k1) <= scoreKnee(k2) ? k1 : k2;
}

/** 踝釘在地面；只調膝彎與大腿長，不把踝拉離基線（避免墊腳尖感） */
function solveLegFromPlantedFoot(hip, ankleFixed, baseKnee, L1, L2, side, kneeOutMax) {
  let knee = solveKneeFromHipAnkle(hip, ankleFixed, L1, L2, baseKnee, side);
  knee = placeAtLength(hip, knee, L1);
  if (side === "L") {
    knee[0] = clamp(knee[0], baseKnee[0], baseKnee[0] + kneeOutMax);
  } else {
    knee[0] = clamp(knee[0], baseKnee[0] - kneeOutMax, baseKnee[0]);
  }
  const shinAngle = Math.atan2(
    ankleFixed[1] - knee[1],
    ankleFixed[0] - knee[0],
  );
  return { knee, ankle: [ankleFixed[0], ankleFixed[1]], shinAngle };
}

/**
 * Bounce：骨盆 y 下沉；膝微外；踝固定；腳底 29–31 / 30–32 貼地橫線不隨律動動。
 */
function applyBounce(lm, beatSin, amp) {
  const down = bounceDown01(beatSin);
  const hipDrop = BOUNCE_HIP_DROP * amp * down;
  const kneeOut = BOUNCE_KNEE_OUT_MAX * amp * down;

  const leftHip = [BASE_POSE[23][0], BASE_POSE[23][1] + hipDrop];
  const rightHip = [BASE_POSE[24][0], BASE_POSE[24][1] + hipDrop];
  const leftAnkle = [BASE_POSE[27][0], BASE_POSE[27][1]];
  const rightAnkle = [BASE_POSE[28][0], BASE_POSE[28][1]];

  const leftLeg = solveLegFromPlantedFoot(
    leftHip, leftAnkle, BASE_POSE[25], L_THIGH_L, L_SHIN_L, "L", kneeOut,
  );
  const rightLeg = solveLegFromPlantedFoot(
    rightHip, rightAnkle, BASE_POSE[26], L_THIGH_R, L_SHIN_R, "R", kneeOut,
  );

  lm[23][0] = leftHip[0];
  lm[23][1] = leftHip[1];
  lm[24][0] = rightHip[0];
  lm[24][1] = rightHip[1];
  lm[25][0] = leftLeg.knee[0];
  lm[25][1] = leftLeg.knee[1];
  lm[26][0] = rightLeg.knee[0];
  lm[26][1] = rightLeg.knee[1];
  lm[27][0] = leftLeg.ankle[0];
  lm[27][1] = leftLeg.ankle[1];
  lm[28][0] = rightLeg.ankle[0];
  lm[28][1] = rightLeg.ankle[1];

  applyPlantedFeet(lm);
}

function grooveEnablesSwing(mode) {
  return mode === GROOVE_MODES.SWING || mode === GROOVE_MODES.BOTH;
}

function grooveEnablesBounce(mode) {
  return mode === GROOVE_MODES.BOUNCE || mode === GROOVE_MODES.BOTH;
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

const L_THIGH_L = dist2d(BASE_POSE[23], BASE_POSE[25]);
const L_SHIN_L = dist2d(BASE_POSE[25], BASE_POSE[27]);
const L_THIGH_R = dist2d(BASE_POSE[24], BASE_POSE[26]);
const L_SHIN_R = dist2d(BASE_POSE[26], BASE_POSE[28]);

const BASE_PELVIS_CENTER_X = (BASE_POSE[23][0] + BASE_POSE[24][0]) / 2;

/** 左：29 腳跟–31 腳尖；右：30 腳跟–32 腳尖（貼地橫線，不隨律動旋轉） */
function buildPlantedFootPose(ankleIdx, heelIdx, toeIdx, toeDirX) {
  const groundY = BASE_POSE[ankleIdx][1] + FOOT_GROUND_Y_OFFSET;
  const heelX = BASE_POSE[heelIdx][0];
  return {
    heel: [heelX, groundY, BASE_POSE[heelIdx][2], BASE_POSE[heelIdx][3]],
    toe: [heelX + toeDirX * FOOT_TOE_SPAN_X, groundY, BASE_POSE[toeIdx][2], BASE_POSE[toeIdx][3]],
  };
}

const PLANTED_FOOT_L = buildPlantedFootPose(27, 29, 31, -1);
const PLANTED_FOOT_R = buildPlantedFootPose(28, 30, 32, 1);

function applyPlantedFeet(lm) {
  lm[29][0] = PLANTED_FOOT_L.heel[0];
  lm[29][1] = PLANTED_FOOT_L.heel[1];
  lm[29][2] = PLANTED_FOOT_L.heel[2];
  lm[31][0] = PLANTED_FOOT_L.toe[0];
  lm[31][1] = PLANTED_FOOT_L.toe[1];
  lm[31][2] = PLANTED_FOOT_L.toe[2];
  lm[30][0] = PLANTED_FOOT_R.heel[0];
  lm[30][1] = PLANTED_FOOT_R.heel[1];
  lm[30][2] = PLANTED_FOOT_R.heel[2];
  lm[32][0] = PLANTED_FOOT_R.toe[0];
  lm[32][1] = PLANTED_FOOT_R.toe[1];
  lm[32][2] = PLANTED_FOOT_R.toe[2];
}

function measureLegRest(hipIdx, kneeIdx, ankleIdx, L1, L2) {
  const hip = BASE_POSE[hipIdx];
  const knee = BASE_POSE[kneeIdx];
  const ankle = BASE_POSE[ankleIdx];
  const thighAngle = Math.atan2(knee[1] - hip[1], knee[0] - hip[0]);
  const shinAngle = Math.atan2(ankle[1] - knee[1], ankle[0] - knee[0]);
  const vUp = [hip[0] - knee[0], hip[1] - knee[1]];
  const vDown = [ankle[0] - knee[0], ankle[1] - knee[1]];
  const dot = vUp[0] * vDown[0] + vUp[1] * vDown[1];
  const interior = Math.acos(clamp(dot / (L1 * L2), -1, 1));
  const kneeFlexRestDeg = (Math.PI - interior) / DEG;
  return { thighAngle, shinAngle, interior, kneeFlexRestDeg };
}

const LEG_REST_L = measureLegRest(23, 25, 27, L_THIGH_L, L_SHIN_L);
const LEG_REST_R = measureLegRest(24, 26, 28, L_THIGH_R, L_SHIN_R);

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
// upper: 90=垂下, 越小越舉高；forearm 與 upper 差≈肘屈
const PATTERNS = {
  sway: {
    name: "左右搖擺",
    beats: 8,
    left_upper:    [90, 55, 35, 55, 90, 105, 115, 105],
    left_forearm:  [108, 118, 128, 118, 108, 125, 135, 125],
    right_upper:   [90, 105, 115, 105, 90, 55, 35, 55],
    right_forearm: [108, 125, 135, 125, 108, 118, 128, 118],
  },
  raise: {
    name: "雙手舉起",
    beats: 8,
    left_upper:    [90, 45, 10, -25, -25, 10, 45, 90],
    left_forearm:  [112, 135, 160, 175, 175, 160, 135, 112],
    right_upper:   [90, 45, 10, -25, -25, 10, 45, 90],
    right_forearm: [112, 135, 160, 175, 175, 160, 135, 112],
  },
  surrender: {
    name: "投降舉手",
    beats: 8,
    left_upper:    [90, 35, 5, -20, -20, 5, 35, 90],
    left_forearm:  [120, 155, 185, 195, 195, 185, 155, 120],
    right_upper:   [90, 35, 5, -20, -20, 5, 35, 90],
    right_forearm: [120, 155, 185, 195, 195, 185, 155, 120],
  },
  wave: {
    name: "側向擺手",
    beats: 8,
    left_upper:    [90, 35, 5, 35, 90, 90, 90, 90],
    left_forearm:  [112, 140, 160, 140, 112, 112, 112, 112],
    right_upper:   [90, 90, 90, 90, 90, 35, 5, 35],
    right_forearm: [112, 112, 112, 112, 112, 140, 160, 140],
  },
  armwave: {
    name: "手臂波浪",
    beats: 8,
    // 肩先抬至水平，肘屈延後一拍，形成肩→肘→手的波浪 keyframe
    left_upper:    [90, 58, 42, 38, 38, 42, 58, 90],
    left_forearm:  [94, 98, 108, 118, 122, 118, 108, 98],
    right_upper:   [90, 58, 42, 38, 38, 42, 58, 90],
    right_forearm: [98, 108, 118, 122, 118, 108, 98, 94],
  },
  toyman: {
    name: "Toyman機械",
    beats: 8,
    left_upper:    [90, 0, 0, 90, 0, 0, 90, 20],
    left_forearm:  [105, 90, 90, 105, 90, 90, 105, 110],
    right_upper:   [90, 90, 0, 0, 90, 90, 0, 20],
    right_forearm: [105, 105, 90, 90, 105, 105, 90, 110],
  },
  clap: {
    name: "拍手",
    beats: 8,
    left_upper:    [88, 55, 62, 88, 88, 55, 62, 88],
    left_forearm:  [125, 155, 148, 125, 125, 155, 148, 125],
    right_upper:   [88, 55, 62, 88, 88, 55, 62, 88],
    right_forearm: [125, 155, 148, 125, 125, 155, 148, 125],
  },
  groove: {
    name: "律動搖擺",
    beats: 8,
    left_upper:    [90, 70, 50, 70, 95, 110, 120, 110],
    left_forearm:  [112, 125, 138, 125, 112, 120, 128, 120],
    right_upper:   [95, 110, 120, 110, 90, 70, 50, 70],
    right_forearm: [112, 120, 128, 120, 112, 125, 138, 125],
  },
  pump: {
    name: "上下泵動",
    beats: 8,
    left_upper:    [90, 20, 90, 20, 90, 20, 90, 20],
    left_forearm:  [112, 125, 112, 125, 112, 125, 112, 125],
    right_upper:   [20, 90, 20, 90, 20, 90, 20, 90],
    right_forearm: [125, 112, 125, 112, 125, 112, 125, 112],
  },
  reach: {
    name: "伸展收回",
    beats: 8,
    left_upper:    [90, 30, 0, 0, 30, 90, 90, 90],
    left_forearm:  [108, 105, 102, 102, 105, 108, 108, 108],
    right_upper:   [90, 90, 90, 30, 0, 0, 30, 90],
    right_forearm: [108, 108, 108, 105, 102, 102, 105, 108],
  },
  twist: {
    name: "扭轉交替",
    beats: 8,
    left_upper:    [88, 45, 15, 45, 100, 115, 108, 100],
    left_forearm:  [112, 128, 140, 128, 118, 135, 130, 118],
    right_upper:   [100, 115, 108, 100, 88, 45, 15, 45],
    right_forearm: [118, 135, 130, 118, 112, 128, 140, 128],
  },
  disco: {
    name: "迪斯科指向",
    beats: 8,
    left_upper:    [90, 25, 5, 25, 90, 60, 30, 90],
    left_forearm:  [112, 130, 145, 130, 112, 125, 140, 112],
    right_upper:   [90, 60, 30, 90, 90, 25, 5, 25],
    right_forearm: [112, 125, 140, 112, 112, 130, 145, 130],
  },
};

const PATTERN_KEYS = Object.keys(PATTERNS);

// ─── 風格子集 ────────────────────────────────────────────────
const STYLE_POOLS = {
  energetic: ["raise", "surrender", "armwave", "toyman", "pump", "disco", "reach"],
  chill:     ["sway", "groove", "twist", "surrender", "wave"],
  popping:   ["toyman", "armwave", "pump", "disco"],
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
    /** @type {GrooveMode} 預設僅 Swing（上身），不帶 Bounce 腳 */
    grooveMode = GROOVE_MODES.SWING,
  } = {}) {
    this.bpm = bpm;
    this.beatSec = (60 / bpm) * rhythmMul;
    this.startT = 0;
    this.amplitudeScale = clamp(amplitudeScale, 0.4, 1.6);
    this.phaseOffsetBeats = phaseOffsetBeats;
    this.rhythmMul = rhythmMul;
    this.style = style;
    this.grooveMode = Object.values(GROOVE_MODES).includes(grooveMode)
      ? grooveMode
      : GROOVE_MODES.SWING;
    this._patternPool = STYLE_POOLS[style] || PATTERN_KEYS;

    this._schedule = [];
    this._scheduleBuiltUpToBeat = -1;
    this._rng = this._makeRng(seed);

    this._armState = {
      L: createArmIntentState(),
      R: createArmIntentState(),
    };
    this._prevForearmAngle = { L: null, R: null };
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
    this._prevForearmAngle.L = null;
    this._prevForearmAngle.R = null;
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
    const patName = entry.pattern;
    const localBeatFloat = beatFloat - entry.beatStart;

    const amp = this.amplitudeScale;
    const luDeg = 90 + (raw.lu - 90) * amp;
    const ruDeg = 90 + (raw.ru - 90) * amp;
    const lfDeg = 90 + (raw.lf - 90) * amp;
    const rfDeg = 90 + (raw.rf - 90) * amp;

    const noiseScale = patName === "armwave" ? 0.35 : 1;
    const noiseLu = NOISE_SCALE_DEG * noiseScale * perlin1d(t * 1.7);
    const noiseLf = NOISE_SCALE_DEG * noiseScale * perlin1d(t * 2.3 + 100);
    const noiseRu = NOISE_SCALE_DEG * noiseScale * perlin1d(t * 1.9 + 200);
    const noiseRf = NOISE_SCALE_DEG * noiseScale * perlin1d(t * 2.1 + 300);

    let intentL = patternToArmIntent(luDeg + noiseLu, lfDeg + noiseLf);
    let intentR = patternToArmIntent(ruDeg + noiseRu, rfDeg + noiseRf);
    if (patName === "armwave") {
      intentL = modulateArmWaveIntent(intentL, localBeatFloat, 1);
      intentR = modulateArmWaveIntent(intentR, localBeatFloat + 1.25, -1);
    } else if (patName === "toyman") {
      intentL = modulateToymanIntent(intentL);
      intentR = modulateToymanIntent(intentR);
    }

    let dt = this._prevT == null ? 1 / 60 : clamp(t - this._prevT, 1 / 240, 0.05);
    if (this._prevT != null && (t < this._prevT - 1e-4 || t - this._prevT > 0.2)) {
      this._resetArmDynamics();
      dt = 1 / 60;
    }
    this._prevT = t;

    const halfLife = springHalfLifeForPattern(patName, this.beatSec);

    const beatSin = computeBeatSin(elapsed, this.beatSec);
    const bodyBob = BODY_BOB_AMP * amp * beatSin;
    const headTilt = HEAD_TILT_AMP * amp * Math.sin((2 * Math.PI * elapsed) / (this.beatSec * 2));

    const lm = BASE_POSE.map(p => [p[0], p[1], p[2], p[3]]);

    for (let i = 0; i <= 22; i++) lm[i][1] += bodyBob;
    for (let i = 0; i <= 10; i++) lm[i][0] += headTilt;
    if (grooveEnablesSwing(this.grooveMode)) {
      applySwing(lm, beatSin, amp);
    }

    const smoothL = springArmIntent(this._armState.L, intentL, halfLife, dt);
    const smoothR = springArmIntent(this._armState.R, intentR, halfLife, dt);

    applyShoulderDrive(lm, smoothL, smoothR, amp);

    const leftShoulder = [lm[11][0], lm[11][1]];
    const rightShoulder = [lm[12][0], lm[12][1]];

    let leftArm = solveArmAnatomical(
      leftShoulder, L_UPPER_L, L_LOWER_L, smoothL, 1, this._prevForearmAngle.L,
    );
    let rightArm = solveArmAnatomical(
      rightShoulder, L_UPPER_R, L_LOWER_R, smoothR, -1, this._prevForearmAngle.R,
    );

    const leftGeo = enforceArmGeometry(leftShoulder, leftArm.elbow, leftArm.wrist, L_UPPER_L, L_LOWER_L);
    leftArm = {
      ...leftArm,
      elbow: leftGeo.elbow,
      wrist: leftGeo.wrist,
      forearmAngle: Math.atan2(leftGeo.wrist[1] - leftGeo.elbow[1], leftGeo.wrist[0] - leftGeo.elbow[0]),
    };
    const rightGeo = enforceArmGeometry(rightShoulder, rightArm.elbow, rightArm.wrist, L_UPPER_R, L_LOWER_R);
    rightArm = {
      ...rightArm,
      elbow: rightGeo.elbow,
      wrist: rightGeo.wrist,
      forearmAngle: Math.atan2(rightGeo.wrist[1] - rightGeo.elbow[1], rightGeo.wrist[0] - rightGeo.elbow[0]),
    };

    this._prevForearmAngle.L = leftArm.forearmAngle;
    this._prevForearmAngle.R = rightArm.forearmAngle;

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

    if (patName === "armwave") {
      applyHandWaveChain(lm, 15, leftFingerIdx, localBeatFloat, 1);
      applyHandWaveChain(lm, 16, rightFingerIdx, localBeatFloat + 1.25, -1);
    }

    applySimpleZ(lm, 13, 15, leftFingerIdx, leftShoulder, leftArm.wrist, L_UPPER_L, L_LOWER_L, leftArm, 1);
    applySimpleZ(lm, 14, 16, rightFingerIdx, rightShoulder, rightArm.wrist, L_UPPER_R, L_LOWER_R, rightArm, -1);

    if (grooveEnablesBounce(this.grooveMode)) {
      applyBounce(lm, beatSin, amp);
    }

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
  { amplitudeScale: 1.2, phaseOffsetBeats: 0.25, style: "popping",  rhythmMul: 1.0 },
  { amplitudeScale: 0.9, phaseOffsetBeats: 2.0, style: "chill",     rhythmMul: 2.0 },
  { amplitudeScale: 1.1, phaseOffsetBeats: 1.0, style: "energetic", rhythmMul: 0.5 },
];

let _synthCounter = 0;

// ─── 便利方法：建立一個 synthetic trace 物件 ──────────────────
export function createSyntheticTrace({
  bpm = 120,
  name = null,
  seed = null,
  grooveMode = GROOVE_MODES.SWING,
} = {}) {
  const idx = _synthCounter++;

  let preset;
  if (idx < VARIATION_PRESETS.length) {
    preset = VARIATION_PRESETS[idx];
  } else {
    preset = {
      amplitudeScale: 0.6 + Math.random() * 0.8,
      phaseOffsetBeats: Math.random() * 3,
      style: ["mixed", "energetic", "chill", "popping"][Math.floor(Math.random() * 4)],
      rhythmMul: [0.5, 1.0, 1.0, 2.0][Math.floor(Math.random() * 4)],
    };
  }

  const skeleton = new ProceduralSkeleton({ bpm, seed, grooveMode, ...preset });
  const styleTag = preset.style === "mixed" ? "" : ` [${preset.style}]`;
  const grooveTag = grooveMode === GROOVE_MODES.SWING ? "" : ` ·${grooveMode}`;
  return {
    id: `synth_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name: name || `舞者 #${idx + 1}${styleTag}${grooveTag} (${bpm} BPM)`,
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
