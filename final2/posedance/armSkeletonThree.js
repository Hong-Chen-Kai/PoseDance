/**
 * armSkeletonThree.js
 *
 * 隱形 Three.js Bone FK：5 角意圖 → 上臂 3D 方向 + 平面肘角 → Bone 階層 → MediaPipe XY。
 * 不建立可見 Renderer（除錯可另接 SkeletonHelper）。
 */

import * as THREE from "three";

const DEG = Math.PI / 180;
const REST_ABDUCTION_DEG = 8;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function v3norm(v) {
  const n = Math.hypot(v.x, v.y, v.z) || 1e-8;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/** 上臂方向：elevation 舉高、sweep 當 yaw（往胸前） */
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

/** 平面肘角兩解：依意圖選解 */
function pickForearmAngleFromIntent(upperAngle, elbowFlex, humeralRot, side, elevation, sweep) {
  const carrying = (28 + humeralRot * 0.42) * DEG * side;
  const flexRad = elbowFlex * DEG;
  const candA = upperAngle + carrying + side * flexRad;
  const candB = upperAngle + carrying - side * flexRad;

  let picked;
  if (elevation > 72 && elbowFlex > 68) {
    picked = Math.sin(candA) < Math.sin(candB) ? candA : candB;
  } else if (sweep > 12 && elbowFlex > 50) {
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

function createArmChain(side, L1, L2) {
  const root = new THREE.Object3D();
  root.name = side > 0 ? "armL" : "armR";

  const upper = new THREE.Bone();
  upper.name = side > 0 ? "upperL" : "upperR";

  const lower = new THREE.Bone();
  lower.name = side > 0 ? "lowerL" : "lowerR";
  lower.position.set(0, L1, 0);

  const wristTip = new THREE.Bone();
  wristTip.name = side > 0 ? "wristL" : "wristR";
  wristTip.position.set(0, L2, 0);

  upper.add(lower);
  lower.add(wristTip);
  root.add(upper);

  return { root, upper, lower, wristTip, side, L1, L2 };
}

const _Y = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class ArmFkThree {
  constructor(L1L, L2L, L1R, L2R) {
    this.scene = new THREE.Scene();
    this.left = createArmChain(1, L1L, L2L);
    this.right = createArmChain(-1, L1R, L2R);
    this.scene.add(this.left.root, this.right.root);
  }

  /**
   * @param {[number, number, number?]} shoulderXY
   * @param {{ elevation:number, sweep:number, humeralRot:number, elbowFlex:number, forearmTwist?:number }} intent
   * @param {1|-1} side
   */
  solve(shoulderXY, intent, side) {
    const arm = side > 0 ? this.left : this.right;
    const elev = intent.elevation || 0;
    const sweep = intent.sweep || 0;
    const hum = intent.humeralRot || 0;
    const flex = intent.elbowFlex || 0;
    const twist = (intent.forearmTwist || 0) * DEG;

    const upperDir = solveUpperArmDir(elev, sweep, hum, side);
    const upperAngle = Math.atan2(upperDir.y, upperDir.x);
    const forearmAngle = pickForearmAngleFromIntent(upperAngle, flex, hum, side, elev, sweep);

    // 前臂平面方向 + 少量深度（sweep／twist）
    const fz = -Math.sin(sweep * DEG) * 0.25 - Math.sin(twist) * 0.08;
    const forearmDir = v3norm({
      x: Math.cos(forearmAngle),
      y: Math.sin(forearmAngle),
      z: fz,
    });

    arm.root.position.set(shoulderXY[0], shoulderXY[1], shoulderXY[2] || 0);

    // 綁定：local +Y → 對齊目標方向
    _dir.set(upperDir.x, upperDir.y, upperDir.z);
    arm.upper.quaternion.setFromUnitVectors(_Y, _dir);

    // 下臂：世界方向 → 相對上臂的 local quaternion
    arm.root.updateMatrixWorld(true);
    arm.upper.getWorldQuaternion(_qParent);
    _dir.set(forearmDir.x, forearmDir.y, forearmDir.z);
    _qWorld.setFromUnitVectors(_Y, _dir);
    arm.lower.quaternion.copy(_qParent).invert().multiply(_qWorld);

    // 前臂旋（繞肢軸）
    if (Math.abs(twist) > 1e-4) {
      arm.lower.rotateY(twist * 0.35);
    }

    arm.root.updateMatrixWorld(true);

    const elbowW = arm.lower.getWorldPosition(_v).clone();
    const wristW = arm.wristTip.getWorldPosition(_v).clone();

    let wx = wristW.x;
    let wy = wristW.y;
    // 拍手：腕再略往中線收（與平面 FK 同量）
    if (sweep > 15 && flex > 50) {
      const pull = 0.028 * clamp(sweep / 50, 0, 1) * clamp((flex - 50) / 50, 0, 1);
      wx += -side * pull;
    }

    return {
      elbow: [elbowW.x, elbowW.y],
      wrist: [wx, wy],
      forearmAngle,
      upperDir,
      elevation: elev,
      sweep,
      elbowFlex: flex,
      humeralRot: hum,
      forearmTwist: intent.forearmTwist || 0,
    };
  }
}

let _fk = null;

export function getArmFkThree(L1L, L2L, L1R, L2R) {
  if (!_fk) {
    _fk = new ArmFkThree(L1L, L2L, L1R, L2R);
  } else {
    // 長度若變（理論上固定）仍重用階層
    _fk.left.L1 = L1L;
    _fk.left.L2 = L2L;
    _fk.left.lower.position.y = L1L;
    _fk.left.wristTip.position.y = L2L;
    _fk.right.L1 = L1R;
    _fk.right.L2 = L2R;
    _fk.right.lower.position.y = L1R;
    _fk.right.wristTip.position.y = L2R;
  }
  return _fk;
}

export const ARM_FK_THREE_BUILD = "three-arm-fk-v3";
