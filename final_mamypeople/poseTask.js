/**
 * MediaPipe Pose 升級版本 (PoseJs)
 * 使用 MediaPipe Tasks Vision WebAssembly 版本
 * 實現身體骨架檢測與繪製
 *
 * 來源：複製自 PoseTest2/models/poseTask.js，讓 posedance 可以獨立運作。
 */

// MediaPipe Pose 關鍵點索引（共 33 個點）
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

// 身體骨架連接點定義
const POSE_CONNECTIONS = [
  // 臉部
  [POSE_LANDMARKS.LEFT_EYE, POSE_LANDMARKS.RIGHT_EYE],
  [POSE_LANDMARKS.LEFT_EYE, POSE_LANDMARKS.NOSE],
  [POSE_LANDMARKS.RIGHT_EYE, POSE_LANDMARKS.NOSE],
  [POSE_LANDMARKS.LEFT_EYE, POSE_LANDMARKS.LEFT_EAR],
  [POSE_LANDMARKS.RIGHT_EYE, POSE_LANDMARKS.RIGHT_EAR],
  [POSE_LANDMARKS.MOUTH_LEFT, POSE_LANDMARKS.MOUTH_RIGHT],

  // 上半身 - 肩膀到手腕
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.RIGHT_SHOULDER],
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_ELBOW],
  [POSE_LANDMARKS.LEFT_ELBOW, POSE_LANDMARKS.LEFT_WRIST],
  [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_ELBOW],
  [POSE_LANDMARKS.RIGHT_ELBOW, POSE_LANDMARKS.RIGHT_WRIST],

  // 手部連接
  [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_INDEX],
  [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_PINKY],
  [POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.LEFT_THUMB],
  [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_INDEX],
  [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_PINKY],
  [POSE_LANDMARKS.RIGHT_WRIST, POSE_LANDMARKS.RIGHT_THUMB],

  // 軀幹
  [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_HIP],
  [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_HIP],
  [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.RIGHT_HIP],

  // 下半身 - 左腿
  [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.LEFT_KNEE],
  [POSE_LANDMARKS.LEFT_KNEE, POSE_LANDMARKS.LEFT_ANKLE],
  [POSE_LANDMARKS.LEFT_ANKLE, POSE_LANDMARKS.LEFT_HEEL],
  [POSE_LANDMARKS.LEFT_ANKLE, POSE_LANDMARKS.LEFT_FOOT_INDEX],
  [POSE_LANDMARKS.LEFT_HEEL, POSE_LANDMARKS.LEFT_FOOT_INDEX],

  // 下半身 - 右腿
  [POSE_LANDMARKS.RIGHT_HIP, POSE_LANDMARKS.RIGHT_KNEE],
  [POSE_LANDMARKS.RIGHT_KNEE, POSE_LANDMARKS.RIGHT_ANKLE],
  [POSE_LANDMARKS.RIGHT_ANKLE, POSE_LANDMARKS.RIGHT_HEEL],
  [POSE_LANDMARKS.RIGHT_ANKLE, POSE_LANDMARKS.RIGHT_FOOT_INDEX],
  [POSE_LANDMARKS.RIGHT_HEEL, POSE_LANDMARKS.RIGHT_FOOT_INDEX],
];

const CONNECTION_KEY_SET = new Set(
  POSE_CONNECTIONS.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)),
);

export const PoseModel = {
  instance: null,
  callback: null,
  vision: null,
  landmarkPreprocessor: null,
  lastTimestampUs: 0,
  modelComplexity: 2, // 模型複雜度：0=Lite, 1=Full, 2=Heavy（預設為 1）
  minPoseDetectionConfidence: 0.5, // 最小檢測信心度（0-1）
  minPosePresenceConfidence: 0.5, // 最小存在信心度（0-1）
  minTrackingConfidence: 0.7, // 最小追蹤信心度（0-1）
  overlayState: {
    leftHandUp: false,
    leftHandUpRightStretch: false,
    leftArmUp90: false,
    leftHandTouchRightShoulder: false,
    rightHandUp: false,
    rightHandUpLeftStretch: false,
    rightArmUp90: false,
    rightHandTouchLeftShoulder: false,
    bothHandsUp: false,
    hideActionLabels: false,
    highlightConnections: [],
    skeletonStyle: {
      baseColor: "rgba(230, 235, 240, 0.55)",
      baseLineWidth: 2,
      highlightColor: "#39FF14",
      highlightLineWidth: 6,
    },
  }, // 覆蓋層狀態

  /**
   * 設置 landmarks 前處理（例如 OneEuroFilter 防抖）
   * @param {(landmarks: any[], meta: { timestampUs: number }) => any[]} preprocessor
   */
  setLandmarkPreprocessor(preprocessor) {
    this.landmarkPreprocessor = preprocessor;
  },

  /**
   * 設置模型複雜度
   * @param {number} complexity - 0=Lite（快速）, 1=Full（平衡）, 2=Heavy（高精度）
   */
  setModelComplexity(complexity) {
    if (complexity >= 0 && complexity <= 2) {
      this.modelComplexity = complexity;
      console.log(
        `模型複雜度已設置為: ${complexity} (${
          complexity === 0 ? "Lite" : complexity === 1 ? "Full" : "Heavy"
        })`,
      );
    } else {
      console.warn("模型複雜度必須為 0、1 或 2");
    }
  },

  /**
   * 設置最小檢測信心度
   * @param {number} confidence - 信心度值（0-1），預設為 0.5
   */
  setMinDetectionConfidence(confidence) {
    if (confidence >= 0 && confidence <= 1) {
      this.minPoseDetectionConfidence = confidence;
      console.log(`最小檢測信心度已設置為: ${confidence}`);
    } else {
      console.warn("最小檢測信心度必須在 0-1 之間");
    }
  },

  /**
   * 設置最小存在信心度
   * @param {number} confidence - 信心度值（0-1），預設為 0.5
   */
  setMinPresenceConfidence(confidence) {
    if (confidence >= 0 && confidence <= 1) {
      this.minPosePresenceConfidence = confidence;
      console.log(`最小存在信心度已設置為: ${confidence}`);
    } else {
      console.warn("最小存在信心度必須在 0-1 之間");
    }
  },

  /**
   * 設置最小追蹤信心度
   * @param {number} confidence - 信心度值（0-1），預設為 0.5
   */
  setMinTrackingConfidence(confidence) {
    if (confidence >= 0 && confidence <= 1) {
      this.minTrackingConfidence = confidence;
      console.log(`最小追蹤信心度已設置為: ${confidence}`);
    } else {
      console.warn("最小追蹤信心度必須在 0-1 之間");
    }
  },

  /**
   * 根據複雜度獲取對應的模型路徑
   */
  getModelPath(complexity) {
    const models = {
      0: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", // Lite
      1: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task", // Full
      2: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task", // Heavy
    };
    return models[complexity] || models[1]; // 預設使用 Full
  },

  /**
   * 初始化 MediaPipe PoseLandmarker（使用 GPU 加速）
   */
  async init() {
    if (this.instance) {
      return this.instance;
    }

    try {
      // 動態導入 MediaPipe Tasks Vision
      const { FilesetResolver, PoseLandmarker } =
        await import("@mediapipe/tasks-vision");

      if (!FilesetResolver || !PoseLandmarker) {
        console.error(
          "MediaPipe Tasks Vision 未載入，請確保已引入 @mediapipe/tasks-vision",
        );
        return null;
      }

      // 載入 Wasm Runtime
      this.vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
      );

      // 根據複雜度選擇對應的模型
      const modelPath = this.getModelPath(this.modelComplexity);
      const complexityNames = ["Lite", "Full", "Heavy"];
      const complexityName = complexityNames[this.modelComplexity] || "Full";

      // 初始化 PoseLandmarker，啟用 GPU 加速
      this.instance = await PoseLandmarker.createFromOptions(this.vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: "GPU", // GPU 加速
        },
        runningMode: "VIDEO",
        numPoses: 1, // 檢測單人（可調整為多人）
        minPoseDetectionConfidence: this.minPoseDetectionConfidence,
        minPosePresenceConfidence: this.minPosePresenceConfidence,
        minTrackingConfidence: this.minTrackingConfidence,
      });

      console.log(
        `✅ MediaPipe PoseLandmarker 初始化完成${this.modelComplexity} - ${complexityName}）`,
      );
      console.log(
        `   檢測信心度: ${this.minPoseDetectionConfidence}, 存在信心度: ${this.minPosePresenceConfidence}, 追蹤信心度: ${this.minTrackingConfidence}`,
      );
      return this.instance;
    } catch (error) {
      console.error("MediaPipe PoseLandmarker 初始化失敗:", error);
      return null;
    }
  },

  /**
   * 繪製連接線
   */
  computeContainTransform(video, canvas) {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const cw = video.clientWidth || canvas.width || vw;
    const ch = video.clientHeight || canvas.height || vh;

    // object-fit: contain 的顯示區域
    const scale = Math.min(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (cw - dw) / 2;
    const oy = (ch - dh) / 2;
    return { ox, oy, dw, dh, cw, ch };
  },

  drawConnectors(ctx, video, canvas, landmarks, connections, options = {}) {
    const { color = "#00FF00", lineWidth = 2 } = options;
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

  normalizeConnectionKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  },

  getValidHighlightConnections(connections) {
    if (!Array.isArray(connections)) return [];
    const dedup = new Set();
    const result = [];

    for (const pair of connections) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      const key = this.normalizeConnectionKey(a, b);
      if (!CONNECTION_KEY_SET.has(key) || dedup.has(key)) continue;
      dedup.add(key);
      result.push([a, b]);
    }
    return result;
  },

  /**
   * 繪製關鍵點
   */
  drawLandmarks(ctx, video, canvas, landmarks, options = {}) {
    const { color = "#FF0000", radius = 4 } = options;
    const t = this.computeContainTransform(video, canvas);

    ctx.fillStyle = color;

    for (const landmark of landmarks) {
      if (landmark.visibility > 0.5) {
        const x = t.ox + landmark.x * t.dw;
        const y = t.oy + landmark.y * t.dh;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  },

  /**
   * 處理檢測結果
   */
  onResults(results) {
    // 安全檢查
    const canvas = document.querySelector("#output_canvas");
    const video = document.querySelector("#input_video");

    if (!canvas || !video) {
      return; // 元素不存在，直接返回
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return; // 無法獲取上下文，直接返回
    }

    // 設置畫布尺寸：以「顯示尺寸」為準，避免 object-fit 造成的縮放/留白導致骨架看起來歪
    const dpr = window.devicePixelRatio || 1;
    const displayW = video.clientWidth || video.videoWidth;
    const displayH = video.clientHeight || video.videoHeight;
    const nextW = Math.max(1, Math.floor(displayW * dpr));
    const nextH = Math.max(1, Math.floor(displayH * dpr));
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }

    // 清除畫布
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);

    // 繪製身體骨架
    if (results.landmarks && results.landmarks.length > 0) {
      let poseLandmarks = results.landmarks[0]; // 第一個人

      // landmarks 前處理（例如 OneEuroFilter 防抖）
      if (this.landmarkPreprocessor) {
        try {
          poseLandmarks = this.landmarkPreprocessor(poseLandmarks, {
            timestampUs: this.lastTimestampUs,
          });
          // 確保後續繪圖 / callback 都吃到同一份處理後結果
          results.landmarks[0] = poseLandmarks;
        } catch (error) {
          console.error("landmarkPreprocessor 執行失敗:", error);
        }
      }

      const style = this.overlayState.skeletonStyle || {};
      const highlightConnections = this.getValidHighlightConnections(
        this.overlayState.highlightConnections,
      );

      // 先畫全身淡灰底層
      this.drawConnectors(ctx, video, canvas, poseLandmarks, POSE_CONNECTIONS, {
        color: style.baseColor || "rgba(230, 235, 240, 0.55)",
        lineWidth: style.baseLineWidth || 2,
      });

      // 再畫目標連線亮綠高亮
      if (highlightConnections.length > 0) {
        this.drawConnectors(
          ctx,
          video,
          canvas,
          poseLandmarks,
          highlightConnections,
          {
            color: style.highlightColor || "#39FF14",
            lineWidth: style.highlightLineWidth || 6,
          },
        );
      }

      // 繪製關鍵點
      this.drawLandmarks(ctx, video, canvas, poseLandmarks, {
        color: "#FF0000",
        radius: 5,
      });

      // 如果有回調函數，傳遞檢測結果
      if (this.callback) {
        this.callback({
          landmarks: poseLandmarks,
          worldLandmarks: results.worldLandmarks?.[0] || null,
        });
      }
    }

    // 繪製覆蓋層文字（左上角顯示動作狀態）
    this.drawOverlayText(ctx);

    ctx.restore();
  },

  /**
   * 檢測視頻幀
   * @param {HTMLVideoElement} video - 視頻元素
   * @param {number} timestamp - 時間戳（微秒）
   */
  async detect(video, timestamp) {
    if (!this.instance) {
      return null;
    }

    // 保存時間戳供 onResults 的 landmarks 前處理使用
    this.lastTimestampUs = timestamp;

    // 確保輸入尺寸已準備好（video 或 canvas）
    const vw =
      typeof video?.videoWidth === "number"
        ? video.videoWidth
        : typeof video?.width === "number"
          ? video.width
          : 0;
    const vh =
      typeof video?.videoHeight === "number"
        ? video.videoHeight
        : typeof video?.height === "number"
          ? video.height
          : 0;
    if (!video || vw === 0 || vh === 0) return null;

    try {
      // 使用 detectForVideo 處理視頻幀
      const results = this.instance.detectForVideo(video, timestamp);
      this.onResults(results);
      return results?.landmarks?.[0] || null;
    } catch (error) {
      console.error("檢測失敗:", error);
      return null;
    }
  },

  /**
   * 設置回調函數
   */
  setCallback(callback) {
    this.callback = callback;
  },

  /**
   * 設置覆蓋層狀態（用於顯示動作狀態）
   * @param {Object} state - 狀態物件，例如 { leftHandUp: true }
   */
  setOverlayState(state) {
    this.overlayState = { ...this.overlayState, ...state };
  },

  /**
   * 繪製左上角文字覆蓋層
   * 注意：因為 canvas 使用了 CSS transform: scaleX(-1) 鏡像翻轉，
   * 所以需要在繪製文字時將 context 翻轉回來，讓文字正常顯示
   */
  drawOverlayText(ctx) {
    ctx.save();

    // 因為 canvas 被 CSS 水平翻轉，所以需要將 context 翻轉回來
    // 先移動到右邊，然後水平翻轉
    ctx.translate(ctx.canvas.width, 0);
    ctx.scale(-1, 1);

    const padding = 15;
    const fontSize = 32;
    const debugFontSize = 16;
    const lineHeight = fontSize + 8;

    // 調試信息固定在左上角（不受 LeftHand Up 影響）
    const debugYOffset = padding;

    const hideActionLabels = true;

    // 右上角動作名稱可由外部狀態關閉（例如判定成功時）
    if (!hideActionLabels && this.overlayState.leftHandUp) {
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#006400"; // 深綠色文字（DarkGreen）
      const text = "LeftHand Up";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 顯示在右邊（因為 context 已翻轉，所以用 canvas.width - padding - textWidth）
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, padding);
    }

    // 繪製 LeftHand Up Right Stretch 狀態（顯示在右邊，藍色文字，無背景）
    if (!hideActionLabels && this.overlayState.leftHandUpRightStretch) {
      ctx.font = `bold ${fontSize}px Microsoft JhengHei, Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#0066CC"; // 藍色文字
      const text = "左手向右伸展";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 顯示在右邊，位置在 LeftHand Up 下方（如果同時顯示）
      const yOffset = this.overlayState.leftHandUp
        ? padding + lineHeight
        : padding;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 繪製 LeftArmUp90 狀態（顯示在右邊，紫色文字，無背景）
    if (!hideActionLabels && this.overlayState.leftArmUp90) {
      ctx.font = `bold ${fontSize}px Microsoft JhengHei, Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#9932CC"; // 紫色文字（DarkOrchid）
      const text = "左手上舉90度";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 計算 y 偏移：根據前面已顯示的動作數量決定位置
      let yOffset = padding;
      if (this.overlayState.leftHandUp) yOffset += lineHeight;
      if (this.overlayState.leftHandUpRightStretch) yOffset += lineHeight;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 繪製 LeftHandTouchRightShoulder 狀態（顯示在右邊，橙色文字，無背景）
    if (!hideActionLabels && this.overlayState.leftHandTouchRightShoulder) {
      ctx.font = `bold ${fontSize}px Microsoft JhengHei, Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#FF8C00"; // 橙色文字（DarkOrange）
      const text = "左手碰右肩";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 計算 y 偏移：根據前面已顯示的動作數量決定位置
      let yOffset = padding;
      if (this.overlayState.leftHandUp) yOffset += lineHeight;
      if (this.overlayState.leftHandUpRightStretch) yOffset += lineHeight;
      if (this.overlayState.leftArmUp90) yOffset += lineHeight;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 繪製 RightHand Up 狀態（顯示在右邊，深綠色文字，無背景）
    if (!hideActionLabels && this.overlayState.rightHandUp) {
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#228B22"; // 森林綠文字（ForestGreen）
      const text = "RightHand Up";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 計算 y 偏移：根據前面已顯示的動作數量決定位置
      let yOffset = padding;
      if (this.overlayState.leftHandUp) yOffset += lineHeight;
      if (this.overlayState.leftHandUpRightStretch) yOffset += lineHeight;
      if (this.overlayState.leftArmUp90) yOffset += lineHeight;
      if (this.overlayState.leftHandTouchRightShoulder) yOffset += lineHeight;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 繪製 RightHand Up Left Stretch 狀態（顯示在右邊，天藍色文字，無背景）
    if (!hideActionLabels && this.overlayState.rightHandUpLeftStretch) {
      ctx.font = `bold ${fontSize}px Microsoft JhengHei, Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#4169E1"; // 皇家藍文字（RoyalBlue）
      const text = "右手向左伸展";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 計算 y 偏移：根據前面已顯示的動作數量決定位置
      let yOffset = padding;
      if (this.overlayState.leftHandUp) yOffset += lineHeight;
      if (this.overlayState.leftHandUpRightStretch) yOffset += lineHeight;
      if (this.overlayState.leftArmUp90) yOffset += lineHeight;
      if (this.overlayState.leftHandTouchRightShoulder) yOffset += lineHeight;
      if (this.overlayState.rightHandUp) yOffset += lineHeight;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 繪製 RightArmUp90 狀態（顯示在右邊，洋紅色文字，無背景）
    if (!hideActionLabels && this.overlayState.rightArmUp90) {
      ctx.font = `bold ${fontSize}px Microsoft JhengHei, Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#BA55D3"; // 中蘭紫文字（MediumOrchid）
      const text = "右手上舉90度";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 計算 y 偏移：根據前面已顯示的動作數量決定位置
      let yOffset = padding;
      if (this.overlayState.leftHandUp) yOffset += lineHeight;
      if (this.overlayState.leftHandUpRightStretch) yOffset += lineHeight;
      if (this.overlayState.leftArmUp90) yOffset += lineHeight;
      if (this.overlayState.leftHandTouchRightShoulder) yOffset += lineHeight;
      if (this.overlayState.rightHandUp) yOffset += lineHeight;
      if (this.overlayState.rightHandUpLeftStretch) yOffset += lineHeight;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 繪製 RightHandTouchLeftShoulder 狀態（顯示在右邊，珊瑚色文字，無背景）
    if (!hideActionLabels && this.overlayState.rightHandTouchLeftShoulder) {
      ctx.font = `bold ${fontSize}px Microsoft JhengHei, Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#FF6347"; // 番茄色文字（Tomato）
      const text = "右手碰左肩";
      // 計算文字寬度，以便定位到右邊
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      // 計算 y 偏移：根據前面已顯示的動作數量決定位置
      let yOffset = padding;
      if (this.overlayState.leftHandUp) yOffset += lineHeight;
      if (this.overlayState.leftHandUpRightStretch) yOffset += lineHeight;
      if (this.overlayState.leftArmUp90) yOffset += lineHeight;
      if (this.overlayState.leftHandTouchRightShoulder) yOffset += lineHeight;
      if (this.overlayState.rightHandUp) yOffset += lineHeight;
      if (this.overlayState.rightHandUpLeftStretch) yOffset += lineHeight;
      if (this.overlayState.rightArmUp90) yOffset += lineHeight;
      const rightX = ctx.canvas.width - padding - textWidth;
      ctx.fillText(text, rightX, yOffset);
    }

    // 調試信息（顯示檢測狀態）- 只顯示兩行：手腕XY 和 肩膀XY（固定在左上角）
    if (this.overlayState.debugInfo) {
      ctx.font = `${debugFontSize}px Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#FFFF00"; // 黃色文字

      const wristX = this.overlayState.debugInfo.wristX?.toFixed(3) || "N/A";
      const wristY = this.overlayState.debugInfo.wristY?.toFixed(3) || "N/A";
      const wristIndex = this.overlayState.debugInfo.wristIndex ?? "N/A";
      const shoulderX =
        this.overlayState.debugInfo.shoulderX?.toFixed(3) || "N/A";
      const shoulderY =
        this.overlayState.debugInfo.shoulderY?.toFixed(3) || "N/A";

      const debugLines = [
        `手腕[${wristIndex}] XY: (${wristX}, ${wristY})`,
        `肩膀[11] XY: (${shoulderX}, ${shoulderY})`,
      ];

      // 繪製調試背景
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = "#000000";
      const debugHeight = debugLines.length * (debugFontSize + 4) + 10;
      const debugWidth = 280; // 稍微加寬以容納更多文字
      ctx.fillRect(padding - 5, debugYOffset - 5, debugWidth, debugHeight);

      // 繪製調試文字
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#FFFF00";
      debugLines.forEach((line, index) => {
        ctx.fillText(line, padding, debugYOffset + index * (debugFontSize + 4));
      });
    }

    ctx.restore();
  },
};
