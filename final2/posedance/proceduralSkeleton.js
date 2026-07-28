/**
 * proceduralSkeleton.js
 *
 * 程序化骨架動畫生成器 — Pattern 手臂 + 街舞律動 Swing/Bounce（可切換）
 *
 * 輸出格式與 MediaPipe Pose 33 點完全相同：lm[33] = [[x,y,z,visibility], ...]
 * 可直接餵入 posedanceTest.js 的 drawPoseConnections / drawPosePoints。
 *
 * 手臂 FK：隱形 Three.js Bone（armSkeletonThree.js）
 */

import { getArmFkThree, ARM_FK_THREE_BUILD } from "./armSkeletonThree.js";

/** 版本標記（主控台可確認是否載入最新檔） */
export const PROCEDURAL_SKELETON_BUILD = `groove-d1-v4+${ARM_FK_THREE_BUILD}`;

// ─── Perlin Noise（輕量 1D；固定置換表 → 同 seed 可跨機重現）──
// Ken Perlin 經典 256 permutation（非 Math.random 洗牌）
const _PERLIN_PERM = new Uint8Array([
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
  52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
  207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
  119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
  129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
  218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
  81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
  184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
  222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
]);
const _perlinGrad = (() => {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) {
    p[i] = _PERLIN_PERM[i];
    p[i + 256] = _PERLIN_PERM[i];
  }
  return p;
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

// ─── 調參預設 ────────────────────────────────────────────────
// C2：依過渡「幅度」分兩檔（之後可擴充 size / elevation 差）
const BLEND_WINDOW_BEATS_SMALL = 1.85;  // wave ↔ clap（略放慢）
const BLEND_WINDOW_BEATS_LARGE = 2.9;   // 進出 large
/** 高 BPM 時過渡真實秒數下限 */
const MIN_BLEND_SEC_SMALL = 1.15;
const MIN_BLEND_SEC_LARGE = 1.55;
const SPRING_HALF_LIFE_MAX = 0.20;
const SPRING_HALF_LIFE_BEAT_RATIO = 0.28;
const SPRING_HALF_LIFE_CATCHUP_MAX = 0.40;
const NOISE_SCALE_DEG = 1.0;
/**
 * C1 soft-rest 峰值。0 = 關閉（Direct pose-to-pose，不經腰部下潛）。
 */
const REST_BRIDGE_PEAK = 0.0;
/** 意圖角速度上限（°/s）：全時連續；v9 略快，這裡再收一點 */
const INTENT_MAX_DEG_PER_SEC = 95;
const INTENT_MAX_DEG_PER_SEC_LARGE = 80;
/** 腕／肘：只擋單幀暴衝 */
const ARM_POINT_MAX_STEP_JUMP = 0.075;
const ARM_POINT_MAX_SPEED_NORMAL = 0.70;

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
// ─── 律動：Swing（上身）/ Bounce（下沉）；無 both、無獨立 bodyBob／headTilt ──
/** @typedef {'swing' | 'bounce'} GrooveMode */
/** @typedef {'down' | 'up'} BounceDir */
export const GROOVE_MODES = Object.freeze({
  SWING: "swing",
  BOUNCE: "bounce",
});
export const BOUNCE_DIRS = Object.freeze({
  DOWN: "down",
  UP: "up",
});

/** 正規化舊值 both → bounce */
function normalizeGrooveMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === GROOVE_MODES.SWING) return GROOVE_MODES.SWING;
  if (m === "both") return GROOVE_MODES.BOUNCE;
  return GROOVE_MODES.BOUNCE;
}

function normalizeBounceDir(dir) {
  return String(dir || "").toLowerCase() === BOUNCE_DIRS.UP
    ? BOUNCE_DIRS.UP
    : BOUNCE_DIRS.DOWN;
}

// Swing：肩對角 Y + X 圓弧 + 骨盆重心橫移 + 頭延遲／極限微沉（2D 可見；不做 Z twist）
/** 完整左右一輪佔幾拍（2＝一拍偏一邊、下一拍換邊） */
const SWING_PERIOD_BEATS = 2;
const SWING_AMP = 0.0055;
const SWING_ARC = 0.0014;
const SWING_HIP_FOLLOW = 0.002;
const SWING_HIP_WEIGHT_X = 0.002;
const SWING_HEAD_FOLLOW = 0.0022;
const SWING_HEAD_DROP = 0.0012;
const SWING_KNEE_OUT_MAX = 0.0015;
// Bounce：非對稱下沉 + 動能鏈 + 小重心（腳釘地）
const BOUNCE_HIP_DROP = 0.015;
const BOUNCE_SHOULDER_DROP = 0.007;
const BOUNCE_HEAD_DROP = 0.005;
const BOUNCE_KNEE_OUT_MAX = 0.007;
const BOUNCE_HIP_SWAY_X = 0.0055;
/** 動能鏈延遲（以「拍」為單位，跟 BPM） */
const CHAIN_LAG_SHOULDER_BEATS = 0.06;
const CHAIN_LAG_HEAD_BEATS = 0.12;
// 腳底貼地：29→31（MP 左腳）、30→32（MP 右腳）
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

function springHalfLifeForPattern(_patternName, beatSec) {
  return Math.min(SPRING_HALF_LIFE_MAX, beatSec * SPRING_HALF_LIFE_BEAT_RATIO);
}

/** 依角度誤差平滑調 half-life；不再用 blending 開關翻倍（避免硬度驟變） */
function springHalfLifeForArms(baseHalfLife, _blending, stateL, stateR, intentL, intentR) {
  let hl = baseHalfLife;
  const elevErr = Math.max(
    Math.abs((stateL?.elevation ?? 0) - (intentL?.elevation ?? 0)),
    Math.abs((stateR?.elevation ?? 0) - (intentR?.elevation ?? 0)),
  );
  const t = clamp(elevErr / 90, 0, 1);
  return _lerp(hl, Math.max(hl, SPRING_HALF_LIFE_CATCHUP_MAX), t * t);
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

/**
 * 非對稱 Bounce 波形：0=站高、1=最沉。
 * 前段快速下沉、後段緩衝回彈（避免純 sin 機械感）。
 */
function computeSnappyDrop01(elapsed, beatSec) {
  const bs = Math.max(1e-6, beatSec);
  const p = elapsed / bs;
  const phase = p - Math.floor(p); // [0, 1)，含負 lag
  if (phase < 0.38) {
    const t = phase / 0.38;
    return t * t;
  }
  const t = (phase - 0.38) / 0.62;
  // 平滑回彈到 0
  return Math.cos(t * Math.PI * 0.5);
}

/** down：拍點偏沉；up：拍點偏高（沉量反相） */
function bounceDropAmount(elapsed, beatSec, bounceDir) {
  const drop = computeSnappyDrop01(elapsed, beatSec);
  return bounceDir === BOUNCE_DIRS.UP ? 1 - drop : drop;
}

function grooveWaveAt(elapsed, beatSec, lagBeats) {
  return computeSnappyDrop01(elapsed - lagBeats * beatSec, beatSec);
}

/**
 * Swing：肩 Y 對角 + X 反相圓弧、骨盆重心橫移、頭延遲＋極限微沉。
 * 週期預設 2 拍一輪（一拍偏一邊），比 Bounce 跟拍更從容。
 * 髖位移後以釘地腿解；不做 Z twist。
 */
function applySwing(lm, elapsed, beatSec, amp) {
  const periodSec = Math.max(1e-6, beatSec * SWING_PERIOD_BEATS);
  const swingSin = computeBeatSin(elapsed, periodSec);
  const swingCos = Math.cos((2 * Math.PI / periodSec) * elapsed);

  const swingY = SWING_AMP * amp * swingSin;
  // 與 Y 正交：左右肩反相 X → 橢圓軌跡（升起側略往中線／對側略外）
  const swingArc = SWING_ARC * amp * swingCos;

  lm[11][1] -= swingY;
  lm[12][1] += swingY;
  lm[11][0] += swingArc;
  lm[12][0] -= swingArc;

  // 骨盆：Y 對角 + 雙髖同向 X 重心（左肩上 → 重心略往左）
  const hipY = SWING_HIP_FOLLOW * amp * swingSin;
  const hipX = SWING_HIP_WEIGHT_X * amp * swingSin;
  const leftHip = [BASE_POSE[23][0] + hipX, BASE_POSE[23][1] + hipY];
  const rightHip = [BASE_POSE[24][0] + hipX, BASE_POSE[24][1] - hipY];
  const kneeOut = SWING_KNEE_OUT_MAX * amp * Math.abs(swingSin);
  writePlantedLegsFromHips(lm, leftHip, rightHip, kneeOut);

  // 頭：相對音樂拍延遲；左右極限處微沉（abs）
  const headSin = computeBeatSin(
    elapsed - CHAIN_LAG_HEAD_BEATS * beatSec,
    periodSec,
  );
  const headX = SWING_HEAD_FOLLOW * amp * headSin;
  const headY = SWING_HEAD_DROP * amp * Math.abs(headSin);
  for (let i = 0; i <= 10; i++) {
    lm[i][0] += headX;
    lm[i][1] += headY;
  }
}

/**
 * Bounce：非對稱下沉 + 動能鏈（髖→肩→頭）+ 小左右重心；踝釘地。
 */
function applyBounce(lm, elapsed, beatSec, amp, bounceDir) {
  const dropHip = bounceDropAmount(elapsed, beatSec, bounceDir);
  const dropShoulder = bounceDir === BOUNCE_DIRS.UP
    ? 1 - grooveWaveAt(elapsed, beatSec, CHAIN_LAG_SHOULDER_BEATS)
    : grooveWaveAt(elapsed, beatSec, CHAIN_LAG_SHOULDER_BEATS);
  const dropHead = bounceDir === BOUNCE_DIRS.UP
    ? 1 - grooveWaveAt(elapsed, beatSec, CHAIN_LAG_HEAD_BEATS)
    : grooveWaveAt(elapsed, beatSec, CHAIN_LAG_HEAD_BEATS);

  const hipDrop = BOUNCE_HIP_DROP * amp * dropHip;
  const kneeOut = BOUNCE_KNEE_OUT_MAX * amp * dropHip;
  const swaySin = Math.sin((Math.PI / Math.max(1e-6, beatSec)) * elapsed);
  const hipSwayX = BOUNCE_HIP_SWAY_X * amp * swaySin;

  const leftHip = [
    BASE_POSE[23][0] + hipSwayX,
    BASE_POSE[23][1] + hipDrop,
  ];
  const rightHip = [
    BASE_POSE[24][0] + hipSwayX,
    BASE_POSE[24][1] + hipDrop,
  ];
  writePlantedLegsFromHips(lm, leftHip, rightHip, kneeOut);

  // 肩／上胸隨鏈延遲下沉；左右隨重心極輕同向
  const shDrop = BOUNCE_SHOULDER_DROP * amp * dropShoulder;
  lm[11][1] += shDrop;
  lm[12][1] += shDrop;
  lm[11][0] += hipSwayX * 0.35;
  lm[12][0] += hipSwayX * 0.35;

  const hDrop = BOUNCE_HEAD_DROP * amp * dropHead;
  for (let i = 0; i <= 10; i++) {
    lm[i][1] += hDrop;
    lm[i][0] += hipSwayX * 0.25;
  }
}

function grooveEnablesSwing(mode) {
  return normalizeGrooveMode(mode) === GROOVE_MODES.SWING;
}

function grooveEnablesBounce(mode) {
  return normalizeGrooveMode(mode) === GROOVE_MODES.BOUNCE;
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
  return { knee, ankle: [ankleFixed[0], ankleFixed[1]] };
}

/** Swing／Bounce 共用：寫入髖＋釘地膝踝 */
function writePlantedLegsFromHips(lm, leftHip, rightHip, kneeOutMax) {
  const leftAnkle = [BASE_POSE[27][0], BASE_POSE[27][1]];
  const rightAnkle = [BASE_POSE[28][0], BASE_POSE[28][1]];
  const leftLeg = solveLegFromPlantedFoot(
    leftHip, leftAnkle, BASE_POSE[25], L_THIGH_L, L_SHIN_L, "L", kneeOutMax,
  );
  const rightLeg = solveLegFromPlantedFoot(
    rightHip, rightAnkle, BASE_POSE[26], L_THIGH_R, L_SHIN_R, "R", kneeOutMax,
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

const LEFT_FINGER_IDXS = [17, 19, 21];
const RIGHT_FINGER_IDXS = [18, 20, 22];
const FINGER_OFFSETS_L = LEFT_FINGER_IDXS.map(i => [
  BASE_POSE[i][0] - BASE_POSE[15][0],
  BASE_POSE[i][1] - BASE_POSE[15][1],
]);
const FINGER_OFFSETS_R = RIGHT_FINGER_IDXS.map(i => [
  BASE_POSE[i][0] - BASE_POSE[16][0],
  BASE_POSE[i][1] - BASE_POSE[16][1],
]);
const BASE_FOREARM_ANGLE = Math.PI / 2;

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
    // 前半就要舉高（後半常被換招 blend 吃掉）；仍比最初版緩一點
    left_upper:    [90, 48, 12, -18, -20, 8, 42, 90],
    left_forearm:  [120, 150, 175, 195, 195, 175, 145, 120],
    right_upper:   [90, 48, 12, -18, -20, 8, 42, 90],
    right_forearm: [120, 150, 175, 195, 195, 175, 145, 120],
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

/** C2：pair 過渡拍數；同 pattern（lock）回傳 0；並保證最短真實秒數 */
function blendWindowBeatsForPair(fromKey, toKey, beatSec = 0.5) {
  if (!fromKey || !toKey || fromKey === toKey) return 0;
  const large =
    patternTransitionSize(fromKey) === "large" ||
    patternTransitionSize(toKey) === "large";
  let beats = large ? BLEND_WINDOW_BEATS_LARGE : BLEND_WINDOW_BEATS_SMALL;
  const minSec = large ? MIN_BLEND_SEC_LARGE : MIN_BLEND_SEC_SMALL;
  const bs = Math.max(1e-6, beatSec || 0.5);
  beats = Math.max(beats, minSec / bs);
  return beats;
}

/** 三次 Ease-In-Out：啟動慢 → 中段快 → 抵達減速 */
function easeInOutCubic(t) {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 已關閉 rest bridge（REST_BRIDGE_PEAK=0）；保留函式以免呼叫端改動過大 */
function needsRestBridge(_fromKey, _toKey) {
  return REST_BRIDGE_PEAK > 1e-6 && (
    patternTransitionSize(_fromKey) === "large" ||
    patternTransitionSize(_toKey) === "large"
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
 * A → B 直接 intent 混合（Direct pose-to-pose）。
 * viaRest 僅在 REST_BRIDGE_PEAK>0 時生效；預設關閉。
 */
function bridgeArmIntent(from, to, w, viaRest) {
  const wClamped = clamp(w, 0, 1);
  const direct = lerpArmIntent(from, to, easeInOutCubic(wClamped));
  if (!viaRest || REST_BRIDGE_PEAK <= 1e-6) return direct;
  const s = Math.sin(Math.PI * wClamped);
  const restW = REST_BRIDGE_PEAK * s * s * s * s;
  return lerpArmIntent(direct, REST_ARM_INTENT, restW);
}

/** 限制意圖目標每幀變化，壓住過渡尾段／過閾值時的瞬間加速 */
function rateLimitArmIntent(prev, next, dt, maxDegPerSec) {
  if (!prev || !(dt > 0) || !(maxDegPerSec > 0)) return clampArmIntent(next);
  const maxStep = maxDegPerSec * dt;
  const lim = (a, b) => a + clamp(b - a, -maxStep, maxStep);
  return clampArmIntent({
    elevation: lim(prev.elevation, next.elevation),
    sweep: lim(prev.sweep, next.sweep),
    elbowFlex: lim(prev.elbowFlex, next.elbowFlex),
    humeralRot: lim(prev.humeralRot, next.humeralRot),
    forearmTwist: lim(prev.forearmTwist ?? 0, next.forearmTwist ?? 0),
  });
}

function rateLimitPoint2d(prev, next, dt, maxSpeed) {
  if (!prev || !(dt > 0) || !(maxSpeed > 0)) return [next[0], next[1]];
  const dx = next[0] - prev[0];
  const dy = next[1] - prev[1];
  const dist = Math.hypot(dx, dy);
  // 正常速度上限 + 單幀暴衝上限（防瞬移，但不擋舉手到位）
  const maxStep = Math.min(maxSpeed * dt, ARM_POINT_MAX_STEP_JUMP);
  if (dist <= maxStep || dist < 1e-9) return [next[0], next[1]];
  const s = maxStep / dist;
  return [prev[0] + dx * s, prev[1] + dy * s];
}

/**
 * 全時連續角速度上限（無 blending 開關斷層）。
 * large／舉手落差大時略降，仍保持平滑。
 */
function intentRateLimitDegPerSec({
  toLarge,
  enteringLarge,
  intentL,
  intentR,
  stateL,
  stateR,
}) {
  let max = INTENT_MAX_DEG_PER_SEC;
  if (toLarge || enteringLarge) {
    max = Math.min(max, INTENT_MAX_DEG_PER_SEC_LARGE);
  }
  const elevTarget = Math.max(intentL?.elevation ?? 0, intentR?.elevation ?? 0);
  const elevNow = Math.max(stateL?.elevation ?? 0, stateR?.elevation ?? 0);
  if (elevTarget > elevNow + 35 && elevTarget > 70) {
    max = Math.min(max, INTENT_MAX_DEG_PER_SEC_LARGE);
  }
  return max;
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
    grooveMode = GROOVE_MODES.BOUNCE,
    /** @type {BounceDir} */
    bounceDir = BOUNCE_DIRS.DOWN,
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
    this.grooveMode = normalizeGrooveMode(grooveMode);
    this.bounceDir = normalizeBounceDir(bounceDir);

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
    this._limitedIntentL = null;
    this._limitedIntentR = null;
    this._prevElbowL = null;
    this._prevElbowR = null;
    this._prevWristL = null;
    this._prevWristR = null;
    this._prevT = null;
    // 每幀重用，避免 BASE_POSE.map 造成 GC 微卡頓（呼叫端勿跨幀留存回傳值）
    this._lmBuffer = Array.from({ length: 33 }, () => [0, 0, 0, 1]);
    this._tmpShoulderL = [0, 0, 0];
    this._tmpShoulderR = [0, 0, 0];
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

    let blendBeats = blendWindowBeatsForPair(fromKey, toKey, this.beatSec);
    // 避免短 pattern 整段都被過渡吃掉（仍保留最短秒數對應的拍數）
    const maxByPat = pat.beats * 0.42; // 保留過半拍給動作本體（尤其 surrender 舉手）
    blendBeats = Math.min(blendBeats, Math.max(0, maxByPat));

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
    let blendBeats = blendWindowBeatsForPair(fromKey, toKey, this.beatSec);
    blendBeats = Math.min(blendBeats, Math.max(0, pat.beats * 0.42));
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
    this._limitedIntentL = null;
    this._limitedIntentR = null;
    this._prevElbowL = null;
    this._prevElbowR = null;
    this._prevWristL = null;
    this._prevWristR = null;
    try {
      getArmFkThree(L_UPPER_L, L_LOWER_L, L_UPPER_R, L_LOWER_R).resetContinuity();
    } catch (_) {
      /* FK 尚未建立時略過 */
    }
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
    const patName = entry.pattern;

    let dt = this._prevT == null ? 1 / 60 : clamp(t - this._prevT, 1 / 240, 0.05);
    if (this._prevT != null && (t < this._prevT - 1e-4 || t - this._prevT > 0.2)) {
      this._resetArmDynamics();
      dt = 1 / 60;
    }
    this._prevT = t;

    const localBeat = beatFloat - entry.beatStart;
    const enteringLarge =
      patternTransitionSize(patName) === "large" && localBeat < 1.5;
    const maxDeg = intentRateLimitDegPerSec({
      toLarge:
        patternTransitionSize(resolved.toKey) === "large" ||
        patternTransitionSize(patName) === "large",
      enteringLarge,
      intentL: resolved.intentL,
      intentR: resolved.intentR,
      stateL: this._armState.L,
      stateR: this._armState.R,
    });
    const intentL = rateLimitArmIntent(
      this._limitedIntentL, resolved.intentL, dt, maxDeg,
    );
    const intentR = rateLimitArmIntent(
      this._limitedIntentR, resolved.intentR, dt, maxDeg,
    );
    this._limitedIntentL = intentL;
    this._limitedIntentR = intentR;

    const halfLife = springHalfLifeForArms(
      springHalfLifeForPattern(patName, this.beatSec),
      !!resolved.blending,
      this._armState.L,
      this._armState.R,
      intentL,
      intentR,
    );

    const lm = this._lmBuffer;
    for (let i = 0; i < 33; i++) {
      const base = BASE_POSE[i];
      lm[i][0] = base[0];
      lm[i][1] = base[1];
      lm[i][2] = base[2];
      lm[i][3] = base[3];
    }

    // 律動先於手臂 FK，讓肩／髖位移帶動手臂根點
    if (grooveEnablesSwing(this.grooveMode)) {
      applySwing(lm, elapsed, this.beatSec, amp);
    }
    if (grooveEnablesBounce(this.grooveMode)) {
      applyBounce(lm, elapsed, this.beatSec, amp, this.bounceDir);
    }

    const smoothL = springArmIntent(this._armState.L, intentL, halfLife, dt);
    const smoothR = springArmIntent(this._armState.R, intentR, halfLife, dt);

    applyShoulderDrive(lm, smoothL, smoothR, amp);

    const leftShoulder = this._tmpShoulderL;
    leftShoulder[0] = lm[11][0];
    leftShoulder[1] = lm[11][1];
    leftShoulder[2] = lm[11][2];
    const rightShoulder = this._tmpShoulderR;
    rightShoulder[0] = lm[12][0];
    rightShoulder[1] = lm[12][1];
    rightShoulder[2] = lm[12][2];

    const armFk = getArmFkThree(L_UPPER_L, L_LOWER_L, L_UPPER_R, L_LOWER_R);
    const leftArm = armFk.solve(leftShoulder, smoothL, 1);
    const rightArm = armFk.solve(rightShoulder, smoothR, -1);

    const leftGeo = enforceArmGeometry(
      leftShoulder,
      leftArm.elbow,
      leftArm.wrist,
      L_UPPER_L,
      L_LOWER_L,
    );
    const rightGeo = enforceArmGeometry(
      rightShoulder,
      rightArm.elbow,
      rightArm.wrist,
      L_UPPER_R,
      L_LOWER_R,
    );

    // 螢幕座標：擋單幀暴衝
    const pointSpeed = ARM_POINT_MAX_SPEED_NORMAL;
    const elbowL = rateLimitPoint2d(this._prevElbowL, leftGeo.elbow, dt, pointSpeed);
    const wristL = rateLimitPoint2d(this._prevWristL, leftGeo.wrist, dt, pointSpeed);
    const elbowR = rateLimitPoint2d(this._prevElbowR, rightGeo.elbow, dt, pointSpeed);
    const wristR = rateLimitPoint2d(this._prevWristR, rightGeo.wrist, dt, pointSpeed);
    this._prevElbowL = elbowL;
    this._prevWristL = wristL;
    this._prevElbowR = elbowR;
    this._prevWristR = wristR;

    leftArm.elbow = elbowL;
    leftArm.wrist = wristL;
    leftArm.forearmAngle = Math.atan2(wristL[1] - elbowL[1], wristL[0] - elbowL[0]);
    rightArm.elbow = elbowR;
    rightArm.wrist = wristR;
    rightArm.forearmAngle = Math.atan2(wristR[1] - elbowR[1], wristR[0] - elbowR[0]);

    lm[13][0] = leftArm.elbow[0];  lm[13][1] = leftArm.elbow[1];
    lm[14][0] = rightArm.elbow[0]; lm[14][1] = rightArm.elbow[1];
    lm[15][0] = leftArm.wrist[0];  lm[15][1] = leftArm.wrist[1];
    lm[16][0] = rightArm.wrist[0]; lm[16][1] = rightArm.wrist[1];

    // 手指：隨前臂平面角 + forearmTwist
    const lTwist = (leftArm.forearmTwist || 0) * DEG * 0.55;
    const lRot = leftArm.forearmAngle - BASE_FOREARM_ANGLE + lTwist;
    const lCos = Math.cos(lRot), lSin = Math.sin(lRot);
    for (let i = 0; i < 3; i++) {
      const fi = LEFT_FINGER_IDXS[i];
      const ox = FINGER_OFFSETS_L[i][0], oy = FINGER_OFFSETS_L[i][1];
      lm[fi][0] = lm[15][0] + ox * lCos - oy * lSin;
      lm[fi][1] = lm[15][1] + ox * lSin + oy * lCos;
    }
    const rTwist = (rightArm.forearmTwist || 0) * DEG * 0.55;
    const rRot = rightArm.forearmAngle - BASE_FOREARM_ANGLE - rTwist;
    const rCos = Math.cos(rRot), rSin = Math.sin(rRot);
    for (let i = 0; i < 3; i++) {
      const fi = RIGHT_FINGER_IDXS[i];
      const ox = FINGER_OFFSETS_R[i][0], oy = FINGER_OFFSETS_R[i][1];
      lm[fi][0] = lm[16][0] + ox * rCos - oy * rSin;
      lm[fi][1] = lm[16][1] + ox * rSin + oy * rCos;
    }

    applySimpleZ(lm, 13, 15, LEFT_FINGER_IDXS, leftShoulder, leftArm.wrist, L_UPPER_L, L_LOWER_L, leftArm, 1);
    applySimpleZ(lm, 14, 16, RIGHT_FINGER_IDXS, rightShoulder, rightArm.wrist, L_UPPER_R, L_LOWER_R, rightArm, -1);

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

function grooveModeLabel(grooveMode, bounceDir) {
  const mode = normalizeGrooveMode(grooveMode);
  if (mode === GROOVE_MODES.BOUNCE) {
    const dir = normalizeBounceDir(bounceDir);
    return dir === BOUNCE_DIRS.UP ? " ·bounce↑" : " ·bounce";
  }
  return " ·swing";
}

// ─── 便利方法：建立一個 synthetic trace 物件 ──────────────────
export function createSyntheticTrace({
  bpm = 120,
  name = null,
  seed = null,
  grooveMode = GROOVE_MODES.BOUNCE,
  bounceDir = BOUNCE_DIRS.DOWN,
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

  const mode = normalizeGrooveMode(grooveMode);
  const dir = normalizeBounceDir(bounceDir);
  const skeleton = new ProceduralSkeleton({
    bpm,
    seed,
    ...preset,
    grooveMode: mode,
    bounceDir: dir,
    patternMode,
  });
  const modeTag = patternModeLabel(patternMode);
  const grooveTag = grooveModeLabel(mode, dir);
  return {
    id: `synth_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name: name || `舞者 #${idx + 1}${modeTag}${grooveTag} (${bpm} BPM)`,
    synthetic: true,
    enabled: true,
    bpm,
    patternMode,
    grooveMode: mode,
    bounceDir: dir,
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
