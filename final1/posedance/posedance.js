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
  currentPoseFlags: {
    leftHandUp: false,
    rightHandUp: false,
  },

  // 判定相關
  successCount: 0,
  lastJudgeResult: "none", // none | success | fail
};

// 動作提示對照表（請依實際檔名調整 src）
// 這裡假設照片放在 final1/photo 底下，因此使用 ../photo 路徑
const poseHintMap = {
  leftHandUp: {
    src: "../photo/lefthand.JPG",
    label: "左手舉起",
  },
  rightHandUp: {
    src: "../photo/righthand.JPG",
    label: "右手舉起",
  },
  bothHandsUp: {
    src: "../photo/bothhand.JPG",
    label: "雙手一起舉起",
  },
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function initDomRefs() {
  els.currentTimeText = $("currentTimeText");
  els.poseIdText = $("poseIdText");
  els.detectedPoseText = $("detectedPoseText");
  els.successCountText = $("successCountText");
  els.phaseTag = $("phaseTag");
  els.judgeTag = $("judgeTag");
  els.judgeResultTag = $("judgeResultTag");
  els.videoUrlInput = $("videoUrlInput");
  els.loadVideoButton = $("loadVideoButton");

  els.nextPoseHintImage = $("nextPoseHintImage");
  els.nextPoseHintLabel = $("nextPoseHintLabel");

  els.poseInfoText = $("poseInfoText");
  els.startCameraButton = $("startCameraButton");
  els.inputVideo = $("input_video");
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

// --- Pose 偵測

function createPoseDetectors() {
  const leftConfig = {
    visibilityThreshold: 0.5,
    yMarginRatio: 0.1,
    elbowShoulderYRatio: 0.4,
    wristElbowYRatio: 0.5,
    forwardXRatio: 0.4,
  };

  const rightConfig = {
    visibilityThreshold: 0.5,
    yMarginRatio: 0.1,
    elbowShoulderYRatio: 0.4,
    wristElbowYRatio: 0.5,
    forwardXRatio: 0.4,
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
    const yMargin = shoulderWidth * leftConfig.yMarginRatio;

    const handAboveShoulder = leftWrist.y < leftShoulder.y - yMargin;

    const elbowShoulderYDiff = Math.abs(leftElbow.y - leftShoulder.y);
    const elbowNearShoulder =
      elbowShoulderYDiff < shoulderWidth * leftConfig.elbowShoulderYRatio;

    const wristElbowYDiff = Math.abs(leftWrist.y - leftElbow.y);
    const wristNearElbow =
      wristElbowYDiff < shoulderWidth * leftConfig.wristElbowYRatio;

    const wristShoulderXDiff = Math.abs(leftWrist.x - leftShoulder.x);
    const armForward =
      wristShoulderXDiff < shoulderWidth * leftConfig.forwardXRatio;

    return (
      handAboveShoulder && elbowNearShoulder && wristNearElbow && armForward
    );
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
    const yMargin = shoulderWidth * rightConfig.yMarginRatio;

    const handAboveShoulder = rightWrist.y < rightShoulder.y - yMargin;

    const elbowShoulderYDiff = Math.abs(rightElbow.y - rightShoulder.y);
    const elbowNearShoulder =
      elbowShoulderYDiff < shoulderWidth * rightConfig.elbowShoulderYRatio;

    const wristElbowYDiff = Math.abs(rightWrist.y - rightElbow.y);
    const wristNearElbow =
      wristElbowYDiff < shoulderWidth * rightConfig.wristElbowYRatio;

    const wristShoulderXDiff = Math.abs(rightWrist.x - rightShoulder.x);
    const armForward =
      wristShoulderXDiff < shoulderWidth * rightConfig.forwardXRatio;

    return (
      handAboveShoulder && elbowNearShoulder && wristNearElbow && armForward
    );
  };

  return { detectLeftHandUp, detectRightHandUp };
}

async function initPose() {
  if (!els.inputVideo || !els.startCameraButton) return;

  els.startCameraButton.addEventListener("click", async () => {
    try {
      els.startCameraButton.disabled = true;
      els.startCameraButton.textContent = "啟動中...";
      console.log("正在初始化 Pose 模型與攝影機...");

      const poseInstance = await PoseModel.init();
      if (!poseInstance) {
        throw new Error("MediaPipe PoseLandmarker 初始化失敗");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
      });

      els.inputVideo.srcObject = stream;
      await els.inputVideo.play();

      const { detectLeftHandUp, detectRightHandUp } = createPoseDetectors();

      PoseModel.setCallback((result) => {
        if (!result || !result.landmarks) {
          state.currentPoseFlags.leftHandUp = false;
          state.currentPoseFlags.rightHandUp = false;
          if (els.poseInfoText) {
            els.poseInfoText.textContent = "等待姿態檢測...";
          }
          PoseModel.setOverlayState({
            leftHandUp: false,
            rightHandUp: false,
          });
          return;
        }

        const detectedLeft = detectLeftHandUp(result.landmarks);
        const detectedRight = detectRightHandUp(result.landmarks);

        state.currentPoseFlags.leftHandUp = detectedLeft;
        state.currentPoseFlags.rightHandUp = detectedRight;

        if (els.poseInfoText) {
          els.poseInfoText.textContent = `偵測：左手=${
            detectedLeft ? "UP" : "-"
          }，右手=${detectedRight ? "UP" : "-"}`;
        }

        PoseModel.setOverlayState({
          leftHandUp: detectedLeft,
          rightHandUp: detectedRight,
        });

        if (els.detectedPoseText) {
          let label = "（無）";
          if (detectedLeft && detectedRight) {
            label = "bothHandsUp";
          } else if (detectedLeft) {
            label = "leftHandUp";
          } else if (detectedRight) {
            label = "rightHandUp";
          }
          els.detectedPoseText.textContent = label;
        }
      });

      let pendingFrame = null;
      let isProcessing = false;
      let lastTimestamp = 0;

      const processFrames = async () => {
        if (isProcessing || !pendingFrame) return;
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
        if (els.inputVideo.readyState === els.inputVideo.HAVE_ENOUGH_DATA) {
          pendingFrame = els.inputVideo;
          if (!isProcessing) {
            processFrames();
          }
        }
        requestAnimationFrame(loop);
      };

      loop();

      state.poseReady = true;
      els.startCameraButton.textContent = "攝影機已啟動";
      console.log("系統就緒，請站在攝影機前，雙手入鏡。");
    } catch (err) {
      console.error(err);
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

  if (els.currentTimeText) {
    els.currentTimeText.textContent = `${currentTime.toFixed(2)} s`;
  }
  if (els.poseIdText) {
    els.poseIdText.textContent = action ? action.poseId : "（無）";
  }
  if (els.successCountText) {
    els.successCountText.textContent = String(state.successCount);
  }

  if (els.phaseTag) {
    if (phase === "ready") {
      els.phaseTag.textContent = "準備中";
      els.phaseTag.className = "tag phase-ready";
    } else {
      els.phaseTag.textContent = "跳舞中";
      els.phaseTag.className = "tag phase-dance";
    }
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

  // 動作提示：尋找下一個判定拍，於前 4 拍時顯示提示圖片與文字
  if (els.nextPoseHintImage && els.nextPoseHintLabel && beatIndex >= 0) {
    const nextAction = state.actions.find(
      (a) => typeof a.beatIndex === "number" && a.beatIndex > beatIndex,
    );

    if (nextAction) {
      const diff = nextAction.beatIndex - beatIndex;
      const hintInfo = poseHintMap[nextAction.poseId];

      if (diff >= 1 && diff <= 4 && hintInfo) {
        // 動作前 4 拍：持續顯示下一個動作的提示
        els.nextPoseHintImage.src = hintInfo.src;
        els.nextPoseHintImage.style.display = "block";
        els.nextPoseHintLabel.textContent = `下一個動作：${hintInfo.label}`;
      } else if (diff > 4) {
        // 還沒接近下一個動作：隱藏提示
        els.nextPoseHintImage.style.display = "none";
        els.nextPoseHintLabel.textContent = "尚未有下一個動作提示";
      }
      // diff 不會小於 1，因為 nextAction.beatIndex > beatIndex
    } else {
      // 沒有後續動作
      els.nextPoseHintImage.style.display = "none";
      els.nextPoseHintLabel.textContent = "後面沒有更多動作";
    }
  }

  // 判定成功/失敗（只在有 action 且 phase 為 dance 時）
  if (els.judgeResultTag) {
    if (action && phase === "dance") {
      let detectedPose = "none";
      if (
        state.currentPoseFlags.leftHandUp &&
        state.currentPoseFlags.rightHandUp
      ) {
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
      } else {
        state.lastJudgeResult = "fail";
        els.judgeResultTag.textContent = "失敗";
        els.judgeResultTag.className = "tag judge-fail";
      }
    } else if (!action) {
      state.lastJudgeResult = "none";
      els.judgeResultTag.textContent = "尚未判定";
      els.judgeResultTag.className = "tag";
    }
  }
}

async function main() {
  initDomRefs();

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
      if (state.player && typeof state.player.loadVideoById === "function") {
        console.log("[YouTube] 呼叫 loadVideoById:", id);
        state.player.loadVideoById(id);
      } else {
        console.warn(
          "[YouTube] player 尚未就緒，無法呼叫 loadVideoById，目前狀態:",
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
