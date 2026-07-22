/**
 * proceduralSkeleton.js
 *
 * 程序化骨架動畫生成器 — Pattern 手臂 + 街舞律動 Swing/Bounce（可切換）
 *
 * 輸出格式與 MediaPipe Pose 33 點完全相同：lm[33] = [[x,y,z,visibility], ...]
 * 可直接餵入 posedanceTest.js 的 drawPoseConnections / drawPosePoints。
 */

/** 版本標記（主控台可確認是否載入最新檔） */
export const PROCEDURAL_SKELETON_BUILD = "arm-fk5-v2";

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
// C2：依過渡「幅度」分兩檔（之後可擴充 size / elevation 差）
const BLEND_WINDOW_BEATS_SMALL = 0.6;   // wave ↔ clap
const BLEND_WINDOW_BEATS_LARGE = 1.35;  // 任一端為 surrender 等 large
const SPRING_HALF_LIFE_MAX = 0.18;
const SPRING_HALF_LIFE_BEAT_RATIO = 0.25;
const NOISE_SCALE_DEG = 1.0;

// ─── 手臂 5 角 ROM（略保守／長輩友善；對應臨床活動度）────────
// elevation：0=垂下、90=水平、~160=過頭區
// sweep：+ = 往胸前／身體前；− = 往後／外側打開
// humeralRot：+ = 外旋；− = 內旋
// elbowFlex：伸直偏小、彎曲偏大
// forearmTwist：+ = 旋後（掌心偏上）；− = 旋前（掌心偏下）
const ELEVATION_MIN = 0;
const ELEVATION_MAX = 160;
const SWEEP_MIN = -80;
const SWEEP_MAX = 80;
const HUMERAL_ROT_NEUTRAL = 18;
const HUMERAL_ROT_MIN = -70;
const HUMERAL_ROT_MAX = 80;
const ELBOW_FLEX_MIN = 10;
const ELBOW_FLEX_MAX = 145;
const FOREARM_TWIST_MIN = -80;
const FOREARM_TWIST_MAX = 80;
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
// 腳底貼地：29→31（MP 左腳）、30→32（MP 右腳）；外八 = 腳尖遠離骨盆中線（影像 x）
// posedanceTest #overlay_canvas 有 CSS scaleX(-1)，但整張 canvas 一起鏡像，腳跟→腳尖相對方向不變
const FOOT_GROUND_Y_OFFSET = 0.017;
const FOOT_TOE_SPAN_X = 0.026;
const FOOT_TOE_FORWARD_Y = 0.006;

function clampElbowFlexForElevation(flexDeg, elevationDeg) {
  let maxFlex = ELBOW_FLEX_MAX;
  if (elevationDeg > 125) maxFlex = 132;
  else if (elevationDeg > 95) maxFlex = 138;
  else if (elevationDeg < 15) maxFlex = 132;
  const minFlex = elevationDeg < 20 ? 18 : ELBOW_FLEX_MIN;
  return clamp(flexDeg, minFlex, maxFlex);
}

function clampArmIntent(intent) {
  const elevation = clamp(intent.elevation ?? 0, ELEVATION_MIN, ELEVATION_MAX);
  const sweep = clamp(intent.sweep ?? 0, SWEEP_MIN, SWEEP_MAX);
  const humeralRot = clamp(intent.humeralRot ?? HUMERAL_ROT_NEUTRAL, HUMERAL_ROT_MIN, HUMERAL_ROT_MAX);
  const elbowFlex = clampElbowFlexForElevation(intent.elbowFlex ?? 30, elevation);
  const forearmTwist = clamp(intent.forearmTwist ?? 0, FOREARM_TWIST_MIN, FOREARM_TWIST_MAX);
  return { elevation, sweep, humeralRot, elbowFlex, forearmTwist };
}

function v3norm(v) {
  const L = Math.hypot(v.x, v.y, v.z) || 1e-8;
  return { x: v.x / L, y: v.y / L, z: v.z / L };
}

/**
 * 舊 pattern upper/forearm → 手臂 5 角（過渡期自動轉換；表暫不改）
 * elevation 0=垂下 … 160=過頭；sweep+ = 往胸前（與舊 FK yaw 相容）
 */
function patternToArmIntent(upperDeg, forearmDeg) {
  const elevation = clamp(90 - upperDeg, ELEVATION_MIN, ELEVATION_MAX);
  let elbowFlex = Math.abs(forearmDeg - upperDeg);
  if (elbowFlex > 170) elbowFlex = 360 - elbowFlex;
  elbowFlex = clampElbowFlexForElevation(elbowFlex, elevation);

  // 與改版前相容的 sweep 估測（拍手約為正值）
  let sweep = (forearmDeg - 90) * 0.5 + (upperDeg - 90) * 0.35;
  if (elevation > 25 && elevation < 95 && elbowFlex > 55) {
    sweep += 18 * clamp((elbowFlex - 55) / 50, 0, 1);
  }
  if (elevation > 95) sweep *= 0.45;
  sweep = clamp(sweep, SWEEP_MIN, SWEEP_MAX);

  const humeralRot = computeHumeralRotationDeg(elevation, elbowFlex, sweep);
  const forearmTwist = computeForearmTwistDeg(elevation, elbowFlex, sweep, humeralRot);
  return clampArmIntent({ elevation, sweep, elbowFlex, humeralRot, forearmTwist });
}

function computeHumeralRotationDeg(elevation, elbowFlex, sweep) {
  let rot = HUMERAL_ROT_NEUTRAL;

  rot += clamp(elevation * 0.28, 0, 38) * (1 - Math.abs(sweep) / 90);
  if (elevation > 78 && elevation < 130 && elbowFlex > 55) {
    rot += 28 * clamp((elevation - 70) / 45, 0, 1) * clamp((elbowFlex - 50) / 70, 0, 1);
  }

  // 胸前彎肘（拍手）：內旋
  if (sweep > 8 && elbowFlex > 55) {
    rot -= 42 * clamp((elbowFlex - 55) / 75, 0, 1) * clamp(sweep / 40, 0.35, 1);
  }

  if (elevation > 115 && elbowFlex < 35) rot += 12;

  if (elevation > 100 && elbowFlex > 55) {
    rot -= 35 * clamp((elevation - 90) / 65, 0, 1) * clamp((elbowFlex - 45) / 85, 0, 1);
  }

  if (sweep < -18) rot += 24 * clamp(-sweep / 55, 0, 1);

  return clamp(rot, HUMERAL_ROT_MIN, HUMERAL_ROT_MAX);
}

function computeForearmTwistDeg(elevation, elbowFlex, sweep, humeralRot) {
  let twist = 0;
  if (sweep > 10 && elbowFlex > 55) {
    twist -= 50 * clamp((elbowFlex - 55) / 65, 0, 1) * clamp(sweep / 50, 0.4, 1);
  }
  if (elevation > 85) {
    twist += 28 * clamp((elevation - 85) / 55, 0, 1);
  }
  twist += clamp(humeralRot, -40, 40) * 0.15;
  return clamp(twist, FOREARM_TWIST_MIN, FOREARM_TWIST_MAX);
}

/**
 * 上臂方向（沿用改版前穩定公式：elevation 控制舉高，sweep 當 yaw）
 */
function solveUpperArmDir(elevationDeg, sweepDeg, humeralRotDeg, side) {
  const pitch = (REST_ABDUCTION_DEG + elevationDeg * 0.96) * DEG;
  const yaw = sweepDeg * DEG;
  const rot = humeralRotDeg * DEG;
  const spread = 1 + clamp(elevationDeg / 100, 0, 0.35);

  const x = side * spread * (Math.sin(pitch) * Math.cos(yaw * 0.55) + Math.sin(rot) * 0.1);
  const y = Math.cos(pitch) * Math.cos(yaw * 0.38);
  const z = -Math.sin(yaw) * Math.sin(pitch) * 0.55 - Math.sin(rot) * 0.22;

  return v3norm({ x, y, z });
}

/**
 * 平面肘角兩解：依意圖選解，不黏上一幀（避免鎖死）。
 * carrying 近似肩旋對肘窩方向的影響。
 */
function pickForearmAngleFromIntent(upperAngle, elbowFlex, humeralRot, side, elevation, sweep) {
  const carrying = (28 + humeralRot * 0.42) * DEG * side;
  const flexRad = elbowFlex * DEG;
  const candA = upperAngle + carrying + side * flexRad;
  const candB = upperAngle + carrying - side * flexRad;

  let picked;
  if (elevation > 72 && elbowFlex > 68) {
    // 投降：選腕較朝上（影像 y 較小 → sin 較小）
    picked = Math.sin(candA) < Math.sin(candB) ? candA : candB;
  } else if (sweep > 12 && elbowFlex > 50) {
    // 拍手：選較往中線（左臂要 cos 較小、右臂要 cos 較大）
    picked = side > 0
      ? (Math.cos(candA) < Math.cos(candB) ? candA : candB)
      : (Math.cos(candA) > Math.cos(candB) ? candA : candB);
  } else {
    picked = candA;
  }

  if (elevation > 72 && elbowFlex > 68) {
    const upAngle = -Math.PI / 2 + side * (0.12 + humeralRot * 0.004 * DEG);
    const blend = clamp((elevation - 72) / 48, 0, 1) * clamp((elbowFlex - 68) / 55, 0, 1);
    const d = Math.atan2(Math.sin(picked - upAngle), Math.cos(picked - upAngle));
    picked = picked - d * blend * 0.82;
  }

  return picked;
}

/** FK：固定 L1/L2；上臂 3D 方向 + 平面肘角（穩定可視結果） */
function solveArmAnatomical(shoulder, L1, L2, intent, side) {
  const inv = clampArmIntent(intent);
  const upperDir = solveUpperArmDir(inv.elevation, inv.sweep, inv.humeralRot, side);
  const upperAngle = Math.atan2(upperDir.y, upperDir.x);
  const forearmAngle = pickForearmAngleFromIntent(
    upperAngle, inv.elbowFlex, inv.humeralRot, side, inv.elevation, inv.sweep,
  );

  const elbow = [
    shoulder[0] + L1 * upperDir.x,
    shoulder[1] + L1 * upperDir.y,
  ];
  let wrist = [
    elbow[0] + L2 * Math.cos(forearmAngle),
    elbow[1] + L2 * Math.sin(forearmAngle),
  ];

  // 拍手：腕再略往中線收
  if (inv.sweep > 15 && inv.elbowFlex > 50) {
    const pull = 0.028 * clamp(inv.sweep / 50, 0, 1) * clamp((inv.elbowFlex - 50) / 50, 0, 1);
    wrist[0] += -side * pull;
  }

  return {
    elbow,
    wrist,
    forearmAngle,
    upperDir,
    elevation: inv.elevation,
    sweep: inv.sweep,
    elbowFlex: inv.elbowFlex,
    humeralRot: inv.humeralRot,
    forearmTwist: inv.forearmTwist,
  };
}

function springHalfLifeForPattern(_patternName, beatSec) {
  return Math.min(SPRING_HALF_LIFE_MAX, beatSec * SPRING_HALF_LIFE_BEAT_RATIO);
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
  const t = clampArmIntent(target);
  criticalDampedSpring1D(state, "elevation", "vElev", t.elevation, halfLife, dt);
  criticalDampedSpring1D(state, "sweep", "vSweep", t.sweep, halfLife, dt);
  criticalDampedSpring1D(state, "elbowFlex", "vFlex", t.elbowFlex, halfLife, dt);
  criticalDampedSpring1D(state, "humeralRot", "vRot", t.humeralRot, halfLife, dt);
  criticalDampedSpring1D(state, "forearmTwist", "vTwist", t.forearmTwist, halfLife, dt);
  return clampArmIntent({
    elevation: state.elevation,
    sweep: state.sweep,
    elbowFlex: state.elbowFlex,
    humeralRot: state.humeralRot,
    forearmTwist: state.forearmTwist,
  });
}

function createArmIntentState() {
  const rest = patternToArmIntent(90, 100);
  return {
    elevation: rest.elevation,
    sweep: rest.sweep,
    elbowFlex: rest.elbowFlex,
    humeralRot: rest.humeralRot,
    forearmTwist: rest.forearmTwist,
    vElev: 0,
    vSweep: 0,
    vFlex: 0,
    vRot: 0,
    vTwist: 0,
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
 * hipSide 'L'|'R'：依 MP 左/右髖；膝外開 = 遠離骨盆中線（左膝 x↑、右膝 x↓）。
 */
function solveKneeFromHipAnkle(hip, ankle, L1, L2, baseKnee, hipSide) {
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
    const outward = hipSide === "L"
      ? Math.max(0, k[0] - baseKnee[0])
      : Math.max(0, baseKnee[0] - k[0]);
    const inward = hipSide === "L"
      ? Math.max(0, baseKnee[0] - k[0])
      : Math.max(0, k[0] - baseKnee[0]);
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

/**
 * 腳尖水平偏移：遠離骨盆中線 = 外八（MediaPipe 影像座標，面朝鏡頭）。
 * - MP LEFT（腳在畫面右側，x 較大）：腳尖 x > 腳跟 x
 * - MP RIGHT（腳在畫面左側，x 較小）：腳尖 x < 腳跟 x
 * 若 BASE 原始 heel→toe 已朝外則沿用；若內扣（如右腳）則強制改為朝外。
 */
function computeFootToeDeltaX(heelIdx, toeIdx) {
  const heelX = BASE_POSE[heelIdx][0];
  const baseDx = BASE_POSE[toeIdx][0] - heelX;
  const awaySign = heelX >= BASE_PELVIS_CENTER_X ? 1 : -1;
  if (Math.abs(baseDx) < 0.004) return awaySign * FOOT_TOE_SPAN_X;
  const baseSign = baseDx > 0 ? 1 : -1;
  if (baseSign === awaySign) return baseSign * FOOT_TOE_SPAN_X;
  return awaySign * FOOT_TOE_SPAN_X;
}

/** 左 29(跟)–31(尖)；右 30(跟)–32(尖)。保留少量「朝鏡頭」的 y 分量，避免腳掌完全橫向看起來像扭轉。 */
function buildPlantedFootPose(ankleIdx, heelIdx, toeIdx) {
  const groundY = Math.max(BASE_POSE[ankleIdx][1], BASE_POSE[heelIdx][1]) + FOOT_GROUND_Y_OFFSET;
  const heelX = BASE_POSE[heelIdx][0];
  const toeDx = computeFootToeDeltaX(heelIdx, toeIdx);
  const baseDy = BASE_POSE[toeIdx][1] - BASE_POSE[heelIdx][1];
  const toeForwardY = clamp(baseDy, 0, 0.02) > 0
    ? Math.min(FOOT_TOE_FORWARD_Y, baseDy * 0.2)
    : 0;
  return {
    heel: [heelX, groundY, BASE_POSE[heelIdx][2], BASE_POSE[heelIdx][3]],
    toe: [
      heelX + toeDx,
      groundY + toeForwardY,
      BASE_POSE[toeIdx][2],
      BASE_POSE[toeIdx][3],
    ],
  };
}

const PLANTED_FOOT_L = buildPlantedFootPose(27, 29, 31);
const PLANTED_FOOT_R = buildPlantedFootPose(28, 30, 32);

/**
 * 腳底釘地（所有 groove 模式、每一幀必跑）：
 * - 踝 27/28 固定基線
 * - 左 29(跟)–31(尖)、右 30(跟)–32(尖) 同一 y 橫線，略外八
 */
function applyFeetPlantedOnGround(lm) {
  lm[27][0] = BASE_POSE[27][0];
  lm[27][1] = BASE_POSE[27][1];
  lm[27][2] = BASE_POSE[27][2];
  lm[27][3] = BASE_POSE[27][3];
  lm[28][0] = BASE_POSE[28][0];
  lm[28][1] = BASE_POSE[28][1];
  lm[28][2] = BASE_POSE[28][2];
  lm[28][3] = BASE_POSE[28][3];

  lm[29][0] = PLANTED_FOOT_L.heel[0];
  lm[29][1] = PLANTED_FOOT_L.heel[1];
  lm[29][2] = PLANTED_FOOT_L.heel[2];
  lm[29][3] = PLANTED_FOOT_L.heel[3];
  lm[31][0] = PLANTED_FOOT_L.toe[0];
  lm[31][1] = PLANTED_FOOT_L.toe[1];
  lm[31][2] = PLANTED_FOOT_L.toe[2];
  lm[31][3] = PLANTED_FOOT_L.toe[3];

  lm[30][0] = PLANTED_FOOT_R.heel[0];
  lm[30][1] = PLANTED_FOOT_R.heel[1];
  lm[30][2] = PLANTED_FOOT_R.heel[2];
  lm[30][3] = PLANTED_FOOT_R.heel[3];
  lm[32][0] = PLANTED_FOOT_R.toe[0];
  lm[32][1] = PLANTED_FOOT_R.toe[1];
  lm[32][2] = PLANTED_FOOT_R.toe[2];
  lm[32][3] = PLANTED_FOOT_R.toe[3];
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
  const rotZ = Math.sin((armResult.humeralRot || 0) * DEG) * 0.035;
  const twistZ = Math.sin((armResult.forearmTwist || 0) * DEG) * 0.028;
  const chestZ = clamp((armResult.sweep || 0) / 80, -1, 1) * -0.04;
  const depthZ = -0.055 * reachNorm + rotZ + twistZ + chestZ;
  const zOffset = depthZ * sideSign + (armResult.upperDir?.z || 0) * 0.06;
  lm[elbowIdx][2] = BASE_POSE[elbowIdx][2] + zOffset * 0.45;
  lm[wristIdx][2] = BASE_POSE[wristIdx][2] + zOffset;
  for (const fi of fingerIdxs) {
    lm[fi][2] = BASE_POSE[fi][2] + zOffset * 0.85;
  }
}

// ─── Pattern 定義（刪減後 3 個；全部進同一隨機／Mix 池）────────
// upper: 90=垂下, 越小越舉高；forearm 與 upper 差≈肘屈
// 已刪：sway／disco／reach（與 wave 撞臉）、armwave／toyman（實測失敗）、
//       pump（與 wave 實測類似；之後可加大反差再救回）
//
// 目錄：
//   wave      | 左右揮手   | 半段左、半段右揮手   | 分段
//   surrender | 雙手投降舉 | 雙手過頭彎肘同舉     | 對稱
//   clap      | 胸前拍手   | 雙手胸前合開         | 對稱
const PATTERNS = {
  wave: {
    name: "左右揮手",
    size: "small",
    beats: 8,
    left_upper:    [90, 35, 5, 35, 90, 90, 90, 90],
    left_forearm:  [112, 140, 160, 140, 112, 112, 112, 112],
    right_upper:   [90, 90, 90, 90, 90, 35, 5, 35],
    right_forearm: [112, 112, 112, 112, 112, 140, 160, 140],
  },
  surrender: {
    name: "雙手投降舉",
    size: "large",
    beats: 8,
    left_upper:    [90, 35, 5, -20, -20, 5, 35, 90],
    left_forearm:  [120, 155, 185, 195, 195, 185, 155, 120],
    right_upper:   [90, 35, 5, -20, -20, 5, 35, 90],
    right_forearm: [120, 155, 185, 195, 195, 185, 155, 120],
  },
  clap: {
    name: "胸前拍手",
    size: "small",
    beats: 8,
    left_upper:    [88, 55, 62, 88, 88, 55, 62, 88],
    left_forearm:  [125, 155, 148, 125, 125, 155, 148, 125],
    right_upper:   [88, 55, 62, 88, 88, 55, 62, 88],
    right_forearm: [125, 155, 148, 125, 125, 155, 148, 125],
  },
};

/** C1：過渡用中性手臂意圖（手自然下放；與 createArmIntentState 一致） */
const REST_ARM_INTENT = patternToArmIntent(90, 100);

function patternTransitionSize(key) {
  return PATTERNS[key]?.size === "large" ? "large" : "small";
}

/** C2：pair 過渡拍數；同 pattern（lock）回傳 0 */
function blendWindowBeatsForPair(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return 0;
  if (
    patternTransitionSize(fromKey) === "large" ||
    patternTransitionSize(toKey) === "large"
  ) {
    return BLEND_WINDOW_BEATS_LARGE;
  }
  return BLEND_WINDOW_BEATS_SMALL;
}

/** C1：進出 large（如 surrender）走 rest bridge；small↔small 直接 intent 混 */
function needsRestBridge(fromKey, toKey) {
  return (
    patternTransitionSize(fromKey) === "large" ||
    patternTransitionSize(toKey) === "large"
  );
}

function lerpArmIntent(a, b, t) {
  return clampArmIntent({
    elevation: _lerp(a.elevation, b.elevation, t),
    sweep: _lerp(a.sweep, b.sweep, t),
    elbowFlex: _lerp(a.elbowFlex, b.elbowFlex, t),
    humeralRot: _lerp(a.humeralRot, b.humeralRot, t),
    forearmTwist: _lerp(a.forearmTwist ?? 0, b.forearmTwist ?? 0, t),
  });
}

/**
 * C1：A → (Rest) → B 的 intent 路徑；w∈[0,1]
 * viaRest：先收到中性，再接到 B（仍交給後續 springArmIntent）
 */
function bridgeArmIntent(from, to, w, viaRest) {
  const wClamped = clamp(w, 0, 1);
  if (!viaRest) {
    return lerpArmIntent(from, to, smootherstep(wClamped));
  }
  if (wClamped < 0.5) {
    return lerpArmIntent(from, REST_ARM_INTENT, smootherstep(wClamped * 2));
  }
  return lerpArmIntent(
    REST_ARM_INTENT,
    to,
    smootherstep((wClamped - 0.5) * 2),
  );
}

/** Mix／隨機池順序（固定輪巡與 UI 下拉共用） */
const PATTERN_KEYS = Object.keys(PATTERNS);

// B1：random 加權抽樣（與池大小無關；mix／lock 不受影響）
const RANDOM_RECENT_PENALTY = 0.45;
const RANDOM_ABSENCE_SEGMENTS_FOR_BOOST = 2;
const RANDOM_ABSENCE_BOOST = 1.25;
const RANDOM_ABSENCE_BOOST_MAX = 1.5;

function segmentsSinceLastPlayed(schedule, key) {
  if (schedule.length === 0) return Number.POSITIVE_INFINITY;
  for (let i = schedule.length - 1; i >= 0; i--) {
    if (schedule[i].pattern === key) return schedule.length - 1 - i;
  }
  return schedule.length;
}

function computeRandomPatternWeight(key, schedule, last, secondLast) {
  if (key === last) return 0;
  let w = 1;
  if (secondLast != null && key === secondLast) w *= RANDOM_RECENT_PENALTY;
  const absence = segmentsSinceLastPlayed(schedule, key);
  if (absence >= RANDOM_ABSENCE_SEGMENTS_FOR_BOOST) {
    const steps = Math.min(3, absence - RANDOM_ABSENCE_SEGMENTS_FOR_BOOST + 1);
    const boost = Math.min(
      RANDOM_ABSENCE_BOOST_MAX,
      1 + (RANDOM_ABSENCE_BOOST - 1) * steps,
    );
    w *= boost;
  }
  return w;
}

function pickWeightedFromPool(pool, weights, rng) {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return pool[0];
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** @typedef {'random' | 'mix' | string} PatternMode — random／mix／或單一 pattern key */

// ─── ProceduralSkeleton 主類 ─────────────────────────────────
export class ProceduralSkeleton {
  constructor({
    bpm = 120,
    seed = null,
    amplitudeScale = 1.0,
    phaseOffsetBeats = 0,
    rhythmMul = 1.0,
    /** @type {GrooveMode} */
    grooveMode = GROOVE_MODES.SWING,
    /**
     * 動作編排：
     * - random：同池加權隨機（禁連續重複＋近期降權＋缺席補償）
     * - mix：依 PATTERN_KEYS 固定輪巡
     * - 其他：鎖定該 pattern key（檢視用）
     * @type {PatternMode}
     */
    patternMode = "random",
  } = {}) {
    this.bpm = bpm;
    this.beatSec = (60 / bpm) * rhythmMul;
    this.startT = 0;
    this.amplitudeScale = clamp(amplitudeScale, 0.4, 1.6);
    this.phaseOffsetBeats = phaseOffsetBeats;
    this.rhythmMul = rhythmMul;
    this.grooveMode = Object.values(GROOVE_MODES).includes(grooveMode)
      ? grooveMode
      : GROOVE_MODES.SWING;

    const mode = String(patternMode || "random");
    if (mode === "random" || mode === "mix") {
      this.patternMode = mode;
      this._lockedPattern = null;
    } else if (PATTERNS[mode]) {
      this.patternMode = "lock";
      this._lockedPattern = mode;
    } else {
      this.patternMode = "random";
      this._lockedPattern = null;
    }
    this._patternPool = PATTERN_KEYS;
    this._mixIndex = 0;

    this._schedule = [];
    this._scheduleBuiltUpToBeat = -1;
    this._rng = this._makeRng(seed);

    this._armState = {
      L: createArmIntentState(),
      R: createArmIntentState(),
    };
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
    if (this.patternMode === "lock" && this._lockedPattern) {
      return this._lockedPattern;
    }
    if (this.patternMode === "mix") {
      const pick = this._patternPool[this._mixIndex % this._patternPool.length];
      this._mixIndex += 1;
      return pick;
    }
    return this._pickPatternWeightedRandom();
  }

  /** B1：pool-agnostic 加權隨機（僅 patternMode === "random"） */
  _pickPatternWeightedRandom() {
    const pool = this._patternPool;
    if (pool.length === 1) return pool[0];

    const last = this._schedule.length > 0
      ? this._schedule[this._schedule.length - 1].pattern
      : null;
    const secondLast = this._schedule.length > 1
      ? this._schedule[this._schedule.length - 2].pattern
      : null;

    const weights = pool.map((key) =>
      computeRandomPatternWeight(key, this._schedule, last, secondLast),
    );
    return pickWeightedFromPool(pool, weights, this._rng);
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
    return this._sampleAnglesForPattern(pat, localBeatFloat);
  }

  /**
   * C1/C2：在 intent 層做過渡（可走 rest bridge），再交給 springArmIntent。
   * 不再對 raw upper/forearm 做硬 lerp。
   */
  _resolveArmIntents(beatFloat, entry, amp, t) {
    const fromKey = entry.pattern;
    const pat = PATTERNS[fromKey];
    const localBeatFloat = beatFloat - entry.beatStart;
    const raw = this._sampleAnglesForPattern(pat, localBeatFloat);

    const noiseLu = NOISE_SCALE_DEG * perlin1d(t * 1.7);
    const noiseLf = NOISE_SCALE_DEG * perlin1d(t * 2.3 + 100);
    const noiseRu = NOISE_SCALE_DEG * perlin1d(t * 1.9 + 200);
    const noiseRf = NOISE_SCALE_DEG * perlin1d(t * 2.1 + 300);

    const toIntent = (u, f, nu, nf) =>
      patternToArmIntent(90 + (u - 90) * amp + nu, 90 + (f - 90) * amp + nf);

    let intentL = toIntent(raw.lu, raw.lf, noiseLu, noiseLf);
    let intentR = toIntent(raw.ru, raw.rf, noiseRu, noiseRf);

    const nextBeatStart = entry.beatStart + pat.beats;
    this._ensureSchedule(nextBeatStart);
    const nextEntry = this._getPatternAtBeat(nextBeatStart);
    const toKey = nextEntry.pattern;

    let blendBeats = blendWindowBeatsForPair(fromKey, toKey);
    // 避免短 pattern 整段都被過渡吃掉
    blendBeats = Math.min(blendBeats, Math.max(0, pat.beats * 0.45));

    let blending = false;
    let blendProgress = 0;

    if (blendBeats > 1e-6 && localBeatFloat >= pat.beats - blendBeats) {
      blending = true;
      blendProgress = (localBeatFloat - (pat.beats - blendBeats)) / blendBeats;
      const nextPat = PATTERNS[toKey];
      // 固定對準下一招第 0 拍（起手），避免過渡追到中段、進段又從開頭播造成瞬移／合不起來
      const nextRaw = this._sampleAnglesForPattern(nextPat, 0);
      const nextL = toIntent(nextRaw.lu, nextRaw.lf, noiseLu, noiseLf);
      const nextR = toIntent(nextRaw.ru, nextRaw.rf, noiseRu, noiseRf);
      const viaRest = needsRestBridge(fromKey, toKey);
      intentL = bridgeArmIntent(intentL, nextL, blendProgress, viaRest);
      intentR = bridgeArmIntent(intentR, nextR, blendProgress, viaRest);
    }

    return {
      intentL,
      intentR,
      fromKey,
      toKey,
      blending,
      blendProgress,
      blendBeats,
    };
  }

  /** E4：查詢當下 pattern（不推進骨架） */
  getPatternInfoAt(t) {
    const elapsed = Math.max(0, t - this.startT);
    const beatFloat = elapsed / this.beatSec + this.phaseOffsetBeats;
    const beatIndex = Math.floor(beatFloat);
    const entry = this._getPatternAtBeat(beatIndex);
    const fromKey = entry.pattern;
    const pat = PATTERNS[fromKey];
    const localBeatFloat = beatFloat - entry.beatStart;
    const nextBeatStart = entry.beatStart + pat.beats;
    this._ensureSchedule(nextBeatStart);
    const nextEntry = this._getPatternAtBeat(nextBeatStart);
    const toKey = nextEntry.pattern;
    let blendBeats = blendWindowBeatsForPair(fromKey, toKey);
    blendBeats = Math.min(blendBeats, Math.max(0, pat.beats * 0.45));
    const blending =
      blendBeats > 1e-6 && localBeatFloat >= pat.beats - blendBeats;
    const blendProgress = blending
      ? (localBeatFloat - (pat.beats - blendBeats)) / blendBeats
      : 0;
    return {
      key: fromKey,
      name: pat?.name || fromKey,
      nextKey: toKey,
      nextName: PATTERNS[toKey]?.name || toKey,
      localBeat: localBeatFloat,
      beats: pat.beats,
      blending,
      blendProgress,
      blendBeats,
      viaRest: blending ? needsRestBridge(fromKey, toKey) : false,
    };
  }

  _resetArmDynamics() {
    this._armState.L = createArmIntentState();
    this._armState.R = createArmIntentState();
  }

  /**
   * 主要方法：給定時間 t（秒），回傳 lm[33] 格式的骨架
   */
  generate(t) {
    const elapsed = Math.max(0, t - this.startT);
    const beatFloat = (elapsed / this.beatSec) + this.phaseOffsetBeats;
    const beatIndex = Math.floor(beatFloat);

    const entry = this._getPatternAtBeat(beatIndex);
    const amp = this.amplitudeScale;
    const resolved = this._resolveArmIntents(beatFloat, entry, amp, t);
    const intentL = resolved.intentL;
    const intentR = resolved.intentR;
    const patName = entry.pattern;

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
      leftShoulder, L_UPPER_L, L_LOWER_L, smoothL, 1,
    );
    let rightArm = solveArmAnatomical(
      rightShoulder, L_UPPER_R, L_LOWER_R, smoothR, -1,
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

    lm[13][0] = leftArm.elbow[0];  lm[13][1] = leftArm.elbow[1];
    lm[14][0] = rightArm.elbow[0]; lm[14][1] = rightArm.elbow[1];
    lm[15][0] = leftArm.wrist[0];  lm[15][1] = leftArm.wrist[1];
    lm[16][0] = rightArm.wrist[0]; lm[16][1] = rightArm.wrist[1];

    // 手指：隨前臂平面角 + forearmTwist（小手臂旋轉）
    const BASE_FOREARM_ANGLE = Math.PI / 2;
    const leftFingerIdx = [17, 19, 21];
    const lTwist = (leftArm.forearmTwist || 0) * DEG * 0.55;
    const lRot = leftArm.forearmAngle - BASE_FOREARM_ANGLE + lTwist;
    const lCos = Math.cos(lRot), lSin = Math.sin(lRot);
    for (let i = 0; i < 3; i++) {
      const ox = FINGER_OFFSETS_L[i][0], oy = FINGER_OFFSETS_L[i][1];
      lm[leftFingerIdx[i]][0] = lm[15][0] + ox * lCos - oy * lSin;
      lm[leftFingerIdx[i]][1] = lm[15][1] + ox * lSin + oy * lCos;
    }
    const rightFingerIdx = [18, 20, 22];
    const rTwist = (rightArm.forearmTwist || 0) * DEG * 0.55;
    const rRot = rightArm.forearmAngle - BASE_FOREARM_ANGLE - rTwist;
    const rCos = Math.cos(rRot), rSin = Math.sin(rRot);
    for (let i = 0; i < 3; i++) {
      const ox = FINGER_OFFSETS_R[i][0], oy = FINGER_OFFSETS_R[i][1];
      lm[rightFingerIdx[i]][0] = lm[16][0] + ox * rCos - oy * rSin;
      lm[rightFingerIdx[i]][1] = lm[16][1] + ox * rSin + oy * rCos;
    }

    applySimpleZ(lm, 13, 15, leftFingerIdx, leftShoulder, leftArm.wrist, L_UPPER_L, L_LOWER_L, leftArm, 1);
    applySimpleZ(lm, 14, 16, rightFingerIdx, rightShoulder, rightArm.wrist, L_UPPER_R, L_LOWER_R, rightArm, -1);

    if (grooveEnablesBounce(this.grooveMode)) {
      applyBounce(lm, beatSin, amp);
    }

    // 腳底每幀覆寫，避免 BASE 複製的垂直腳尖或 bounce 拉動腳跟
    applyFeetPlantedOnGround(lm);

    const avgShoulderY = (lm[11][1] + lm[12][1]) / 2;
    if (lm[0][1] > avgShoulderY - 0.03) {
      const fix = avgShoulderY - 0.03 - lm[0][1];
      for (let i = 0; i <= 10; i++) lm[i][1] += fix;
    }

    return lm;
  }
}

// ─── 自動遞增差異預設（同一動作池；差異靠幅度／相位／節奏）──
// 數值精细调另案；此處先維持可用差異，不再用 style 分流動作池
const VARIATION_PRESETS = [
  { amplitudeScale: 1.0, phaseOffsetBeats: 0,    rhythmMul: 1.0 },
  { amplitudeScale: 0.7, phaseOffsetBeats: 1.5,  rhythmMul: 1.0 },
  { amplitudeScale: 1.3, phaseOffsetBeats: 0.5,  rhythmMul: 1.0 },
  { amplitudeScale: 1.2, phaseOffsetBeats: 0.25, rhythmMul: 1.0 },
  { amplitudeScale: 0.9, phaseOffsetBeats: 2.0,  rhythmMul: 2.0 },
  { amplitudeScale: 1.1, phaseOffsetBeats: 1.0,  rhythmMul: 0.5 },
];

let _synthCounter = 0;

function patternModeLabel(patternMode) {
  if (patternMode === "random") return "";
  if (patternMode === "mix") return " ·Mix";
  if (PATTERNS[patternMode]) return ` ·${PATTERNS[patternMode].name}`;
  return "";
}

function grooveModeLabel(grooveMode) {
  if (grooveMode === GROOVE_MODES.BOTH) return " ·swing + bounce";
  if (grooveMode === GROOVE_MODES.BOUNCE) return " ·bounce";
  return "";
}

// ─── 便利方法：建立一個 synthetic trace 物件 ──────────────────
export function createSyntheticTrace({
  bpm = 120,
  name = null,
  seed = null,
  grooveMode = GROOVE_MODES.SWING,
  /** @type {PatternMode} */
  patternMode = "random",
} = {}) {
  const idx = _synthCounter++;

  let preset;
  if (idx < VARIATION_PRESETS.length) {
    preset = { ...VARIATION_PRESETS[idx] };
  } else {
    preset = {
      amplitudeScale: 0.6 + Math.random() * 0.8,
      phaseOffsetBeats: Math.random() * 3,
      rhythmMul: [0.5, 1.0, 1.0, 2.0][Math.floor(Math.random() * 4)],
    };
  }

  const skeleton = new ProceduralSkeleton({
    bpm,
    seed,
    ...preset,
    grooveMode,
    patternMode,
  });
  const modeTag = patternModeLabel(patternMode);
  const grooveTag = grooveModeLabel(grooveMode);
  return {
    id: `synth_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name: name || `舞者 #${idx + 1}${modeTag}${grooveTag} (${bpm} BPM)`,
    synthetic: true,
    enabled: true,
    bpm,
    patternMode,
    grooveMode,
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

/** E4：查詢當下 pattern 名稱／過渡狀態 */
export function getSyntheticPatternInfoAtTime(trace, t) {
  if (!trace?._skeleton?.getPatternInfoAt) return null;
  return trace._skeleton.getPatternInfoAt(t);
}

export { PATTERNS, PATTERN_KEYS };
