import { PoseModel, POSE_LANDMARKS } from "./poseTask.js";

const DEMO_SOURCE_ASPECT = 16 / 9;
/** 以模組 URL 解析，避免部署子路徑或與 HTML 不同層級時 fetch 404 */
const DEMO_TRACE_PATHS = {
  easy: new URL("./demo/pose_trace_easy.json", import.meta.url).href,
  hard: new URL("./demo/pose_trace_hard.json", import.meta.url).href,
};

const DEMO_POSE_CONNECTIONS = [
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

const state = {
  player: null,
  ready: false,
  ytInitStarted: false,
  videoId: null,
  lastLoadedVideoId: null,

  demo: { easy: null, hard: null, loaded: null },

  ui: {
    mode: "mode1",
    hintMode: "easy",
    demoScale: { l1: 1, l2: 1, r1: 1, r2: 1 },
  },

  recorder: {
    armed: false,
    active: false,
    delaySec: 5,
    armStartPlayerTimeSec: null,
    startedAtIso: null,
    lastRecordedT: Number.NEGATIVE_INFINITY,
    samples: [],
  },

  music: {
    open: false,
    categories: [],
    selectedCategory: null,
    q: "",
    page: 1,
    limit: 20,
    sort: "uploaded_at",
    order: "desc",
    items: [],
    total: 0,
    pages: 1,
    loading: false,
    error: null,
  },

  // Pose
  poseReady: false,
  cameraRunning: false,
  poseLoopActive: false,
  cameraStream: null,
  latestUserLandmarks: null,

  // Similarity (Phase 1: time window only)
  similarity: {
    visibilityThreshold: 0.5,
    k: 1.2,
    windowSec: 0.25,
    sigmaTimeSec: 0.12,
    tauDist: 0.12,
    minValidPoints: 15,
    historySec: 4,
    energyE0: 0.08,
    energyE1: 0.35,
    energyMinWeight: 0.1,
  },

  // Rolling overall buffers (Phase 1)
  overall: {
    easy: [],
    hard: [],
    loaded: [],
  },

  orange: {
    active: false,
    enterGoodSec: 0,
    exitBadSec: 0,
    window: [],
    lastT: null,
    enterThreshold: 80,
    enterRequireSec: 3,
    enterInstantMajorityRatio: 0.6,
    exitThreshold: 75,
    exitRequireSec: 1.5,
    exitInstantMajorityRatio: 0.6,
  },
};

const els = {};
function $(id) {
  return document.getElementById(id);
}

const RECORD_SAMPLE_MIN_DT = 1 / 30; // 30fps 上限

function initDomRefs() {
  els.similarityEasyText = $("similarityEasyText");
  els.similarityHardText = $("similarityHardText");
  els.similarityLoadedText = $("similarityLoadedText");
  els.overallEasyText = $("overallEasyText");
  els.overallHardText = $("overallHardText");
  els.overallLoadedText = $("overallLoadedText");
  els.modeText = $("modeText");
  els.videoUrlInput = $("videoUrlInput");
  els.modeSelect = $("modeSelect");
  els.hintModeSelect = $("hintModeSelect");
  els.demoScaleL1 = $("demoScaleL1");
  els.demoScaleL2 = $("demoScaleL2");
  els.demoScaleR1 = $("demoScaleR1");
  els.demoScaleR2 = $("demoScaleR2");
  els.demoScaleBottom = $("demoScaleBottom");
  els.loadVideoButton = $("loadVideoButton");
  els.pickSongButton = $("pickSongButton");
  els.loadSkeletonButton = $("loadSkeletonButton");
  els.skeletonFileInput = $("skeletonFileInput");
  els.startCameraButton = $("startCameraButton");
  els.recordButton = $("recordButton");
  els.poseInfoText = $("poseInfoText");

  els.inputVideo = $("input_video");
  els.outputCanvas = $("output_canvas");
  els.overlayCanvas = $("overlay_canvas");

  els.songModalBackdrop = $("songModalBackdrop");
  els.songModalCloseButton = $("songModalCloseButton");
  els.songCategories = $("songCategories");
  els.songList = $("songList");
  els.songSearchInput = $("songSearchInput");
  els.songSearchButton = $("songSearchButton");
  els.songPrevPageButton = $("songPrevPageButton");
  els.songNextPageButton = $("songNextPageButton");
  els.songPageText = $("songPageText");

  els.ytWrapper = $("ytPlayerWrapper");
  els.ytDragHandle = $("ytDragHandle");
  els.ytResizeHandle = $("ytResizeHandle");
  els.ytResizeHandleTL = $("ytResizeHandleTL");
  els.ytResizeHandleTR = $("ytResizeHandleTR");
  els.ytResizeHandleBL = $("ytResizeHandleBL");

  if (els.poseInfoText) els.poseInfoText.style.display = "none";
}

function setUi({
  easy = "—",
  hard = "—",
  loaded = "—",
  overallEasy = "—",
  overallHard = "—",
  overallLoaded = "—",
} = {}) {
  if (els.similarityEasyText) els.similarityEasyText.textContent = easy;
  if (els.similarityHardText) els.similarityHardText.textContent = hard;
  if (els.similarityLoadedText) els.similarityLoadedText.textContent = loaded;
  if (els.overallEasyText) els.overallEasyText.textContent = overallEasy;
  if (els.overallHardText) els.overallHardText.textContent = overallHard;
  if (els.overallLoadedText) els.overallLoadedText.textContent = overallLoaded;
}

function setModeUiText() {
  if (!els.modeText) return;
  els.modeText.textContent = state.ui.mode === "mode2" ? "Mode 2（未實作）" : "Mode 1";
}

function clearOverlayCanvas() {
  if (!els.overlayCanvas) return;
  const ctx = els.overlayCanvas.getContext("2d");
  if (!ctx) return;

  const w = Math.max(1, Math.floor(els.overlayCanvas.clientWidth));
  const h = Math.max(1, Math.floor(els.overlayCanvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.floor(w * dpr));
  const targetH = Math.max(1, Math.floor(h * dpr));
  if (els.overlayCanvas.width !== targetW || els.overlayCanvas.height !== targetH) {
    els.overlayCanvas.width = targetW;
    els.overlayCanvas.height = targetH;
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
}

function stopCameraIfRunning() {
  state.poseLoopActive = false;
  state.cameraRunning = false;
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  if (els.inputVideo) els.inputVideo.srcObject = null;
  if (els.startCameraButton) els.startCameraButton.textContent = "啟動攝影機";
  state.latestUserLandmarks = null;
  drawUserOverlay();
  clearOverlayCanvas();
}

function setControlsDisabled(disabled) {
  const dis = Boolean(disabled);
  if (els.videoUrlInput) els.videoUrlInput.disabled = dis;
  if (els.loadVideoButton) els.loadVideoButton.disabled = dis;
  if (els.pickSongButton) els.pickSongButton.disabled = dis;
  if (els.loadSkeletonButton) els.loadSkeletonButton.disabled = dis;
  if (els.hintModeSelect) els.hintModeSelect.disabled = dis;
  if (els.startCameraButton) els.startCameraButton.disabled = dis;
  if (els.recordButton) els.recordButton.disabled = dis || !state.cameraRunning || !state.ready;
}

function bindDemoScaleSlider(el, key) {
  if (!el) return;
  const clamp = (x) => Math.max(1.5, Math.min(3.5, x));
  const read = () => {
    const raw = Number(el.value);
    const v = Number.isFinite(raw) ? clamp(raw) : 1;
    state.ui.demoScale[key] = v;
  };
  el.addEventListener("input", read);
  el.addEventListener("change", read);
  // init from DOM
  read();
}

function scaleRectAboutCenter(rect, s) {
  const ss = typeof s === "number" && Number.isFinite(s) ? s : 1;
  const cx = rect.ox + rect.dw / 2;
  const cy = rect.oy + rect.dh / 2;
  const dw = rect.dw * ss;
  const dh = rect.dh * ss;
  return { ox: cx - dw / 2, oy: cy - dh / 2, dw, dh };
}

function applyMode(mode) {
  state.ui.mode = mode === "mode2" ? "mode2" : "mode1";
  setModeUiText();
  const isMode2 = state.ui.mode === "mode2";
  setControlsDisabled(isMode2);
  if (els.demoScaleBottom) els.demoScaleBottom.style.display = isMode2 ? "none" : "";
  if (isMode2) {
    if (state.music.open) closeSongModal();
    if (state.cameraRunning) stopCameraIfRunning();
    state.recorder.armed = false;
    state.recorder.active = false;
    state.recorder.armStartPlayerTimeSec = null;
    state.recorder.startedAtIso = null;
    state.recorder.lastRecordedT = Number.NEGATIVE_INFINITY;
    state.recorder.samples = [];
    setUi({ easy: "—", hard: "—", loaded: "—", overallEasy: "—", overallHard: "—", overallLoaded: "—" });
  }
}

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be")
      return url.pathname.replace("/", "") || null;
    const v = url.searchParams.get("v");
    if (v) return v;
  } catch {
    // ignore
  }
  return null;
}

function loadVideoByIdIfReady({ autoplay = true } = {}) {
  if (
    !state.ready ||
    !state.player ||
    !state.videoId ||
    (typeof state.player.loadVideoById !== "function" &&
      typeof state.player.cueVideoById !== "function")
  ) {
    return false;
  }
  if (state.lastLoadedVideoId === state.videoId) return true;
  if (!autoplay && typeof state.player.cueVideoById === "function") {
    state.player.cueVideoById(state.videoId);
  } else {
    state.player.loadVideoById(state.videoId);
  }
  state.lastLoadedVideoId = state.videoId;
  return true;
}

const API_BASE = "https://imuse.ncnu.edu.tw/Midi-library";

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function parseYoutubeUrlFromText(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/(?:www\.)?(?:youtu\.be\/[^\s]+|youtube\.com\/[^\s]+)/i);
  return m ? m[0] : null;
}

function extractVideoIdFromAny(raw) {
  const id = extractVideoId(raw);
  if (id) return id;
  const url = parseYoutubeUrlFromText(raw);
  return url ? extractVideoId(url) : null;
}

function openSongModal() {
  state.music.open = true;
  if (els.songModalBackdrop) {
    els.songModalBackdrop.classList.add("is-open");
    els.songModalBackdrop.setAttribute("aria-hidden", "false");
  }
}

function closeSongModal() {
  state.music.open = false;
  if (els.songModalBackdrop) {
    els.songModalBackdrop.classList.remove("is-open");
    els.songModalBackdrop.setAttribute("aria-hidden", "true");
  }
}

function renderSongCategories() {
  if (!els.songCategories) return;
  const cats = Array.isArray(state.music.categories) ? state.music.categories : [];
  const selected = state.music.selectedCategory;
  const parts = [];
  parts.push(
    `<button class="modal__cat ${selected ? "" : "is-active"}" data-cat="">全部</button>`,
  );
  for (const c of cats) {
    const safe = String(c);
    const active = selected === safe;
    parts.push(
      `<button class="modal__cat ${active ? "is-active" : ""}" data-cat="${encodeURIComponent(safe)}">${safe}</button>`,
    );
  }
  els.songCategories.innerHTML = parts.join("");
  els.songCategories.querySelectorAll(".modal__cat").forEach((btn) => {
    btn.addEventListener("click", () => {
      const catEnc = btn.getAttribute("data-cat") || "";
      state.music.selectedCategory = catEnc ? decodeURIComponent(catEnc) : null;
      renderSongCategories();
      renderSongList();
    });
  });
}

function renderSongList() {
  if (!els.songList) return;
  const m = state.music;
  if (m.loading) {
    els.songList.innerHTML = `<div class="modal__item"><div><div class="modal__item-title">載入中...</div></div></div>`;
    return;
  }
  if (m.error) {
    els.songList.innerHTML = `<div class="modal__item"><div><div class="modal__item-title">載入失敗</div><div class="modal__item-meta">${String(m.error)}</div></div></div>`;
    return;
  }

  const selectedCat = m.selectedCategory;
  const list = (Array.isArray(m.items) ? m.items : []).filter((it) => {
    if (!selectedCat) return true;
    const cats = Array.isArray(it?.categories) ? it.categories : [];
    return cats.includes(selectedCat) || it?.categories_text === selectedCat;
  });

  if (!list.length) {
    els.songList.innerHTML = `<div class="modal__item"><div><div class="modal__item-title">沒有資料</div><div class="modal__item-meta">請換分類或搜尋</div></div></div>`;
  } else {
    els.songList.innerHTML = list
      .map((it) => {
        const title = it?.title ? String(it.title) : "（無標題）";
        const composer = it?.composer ? String(it.composer) : "";
        const catText = it?.categories_text ? String(it.categories_text) : "";
        const tags = it?.tags ? String(it.tags) : "";
        const desc = it?.description ? String(it.description) : "";
        const id = it?.id ? String(it.id) : "";
        const meta = [composer, catText, tags].filter(Boolean).join(" · ");
        return `
          <div class="modal__item">
            <div>
              <div class="modal__item-title">${title}</div>
              <div class="modal__item-meta">${meta}</div>
              <div class="modal__item-meta">${desc}</div>
            </div>
            <button class="modal__pick" data-mid="${encodeURIComponent(id)}">選取</button>
          </div>
        `;
      })
      .join("");

    els.songList.querySelectorAll(".modal__pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        const midEnc = btn.getAttribute("data-mid") || "";
        const mid = midEnc ? decodeURIComponent(midEnc) : "";
        const it = (Array.isArray(m.items) ? m.items : []).find((x) => String(x?.id || "") === mid);
        if (!it) return;
        const url = parseYoutubeUrlFromText(it.description) || "";
        const vid = extractVideoIdFromAny(url);
        if (!vid) return;
        if (els.videoUrlInput) els.videoUrlInput.value = vid;
        state.videoId = vid;
        state.lastLoadedVideoId = null;
        loadVideoByIdIfReady({ autoplay: false });
        closeSongModal();
      });
    });
  }

  if (els.songPageText) {
    els.songPageText.textContent = `第 ${m.page}/${m.pages} 頁（共 ${m.total}）`;
  }
  if (els.songPrevPageButton) els.songPrevPageButton.disabled = m.page <= 1;
  if (els.songNextPageButton) els.songNextPageButton.disabled = m.page >= m.pages;
}

async function loadCategories() {
  const m = state.music;
  try {
    m.error = null;
    const data = await fetchJson(`${API_BASE}/api/categories`);
    m.categories = Array.isArray(data) ? data : [];
    renderSongCategories();
  } catch (err) {
    m.categories = [];
    m.error = err?.message || String(err);
  }
}

async function loadMidisPage() {
  const m = state.music;
  m.loading = true;
  m.error = null;
  renderSongList();
  const q = m.q ? `q=${encodeURIComponent(m.q)}` : "";
  const url = `${API_BASE}/api/midis?${[
    q,
    `page=${encodeURIComponent(m.page)}`,
    `limit=${encodeURIComponent(m.limit)}`,
    `sort=${encodeURIComponent(m.sort)}`,
    `order=${encodeURIComponent(m.order)}`,
  ]
    .filter(Boolean)
    .join("&")}`;
  try {
    const data = await fetchJson(url);
    m.items = Array.isArray(data?.items) ? data.items : [];
    m.total = typeof data?.total === "number" ? data.total : 0;
    m.page = typeof data?.page === "number" ? data.page : m.page;
    m.pages = typeof data?.pages === "number" ? data.pages : 1;
  } catch (err) {
    m.items = [];
    m.total = 0;
    m.pages = 1;
    m.error = err?.message || String(err);
  } finally {
    m.loading = false;
    renderSongList();
  }
}

function initYouTubePlayerIfPossible() {
  if (state.ytInitStarted) return;
  if (state.player) return;
  const YTGlobal = typeof window !== "undefined" ? window.YT : null;
  if (!YTGlobal || typeof YTGlobal.Player !== "function") return;

  state.ytInitStarted = true;
  state.player = new YT.Player("player", {
    height: "180",
    width: "320",
    videoId: state.videoId || "dQw4w9WgXcQ",
    playerVars: {
      playsinline: 1,
      enablejsapi: 1,
      origin:
        typeof window !== "undefined" ? window.location.origin : undefined,
    },
    events: {
      onReady: () => {
        state.ready = true;
        // 避免一進頁面就自動播放：預設只 cue（或維持當前）
        loadVideoByIdIfReady({ autoplay: false });
      },
      onError: (event) => {
        console.error("[YouTube] errorCode =", event.data);
      },
    },
  });
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  initYouTubePlayerIfPossible();
};

function setupYtFloatingWindow() {
  if (!els.ytWrapper) return;

  const wrapper = els.ytWrapper;
  const dragHandle = els.ytDragHandle || wrapper;
  const resizeHandleBR = els.ytResizeHandle;
  const resizeHandleTL = els.ytResizeHandleTL;
  const resizeHandleTR = els.ytResizeHandleTR;
  const resizeHandleBL = els.ytResizeHandleBL;

  const minW = 200;
  const minH = 140;
  const maxW = Math.min(window.innerWidth - 16, 720);
  const maxH = Math.min(window.innerHeight - 16, 540);

  const readRect = () => wrapper.getBoundingClientRect();

  const initRect = readRect();
  wrapper.style.left = `${Math.max(16, initRect.left)}px`;
  wrapper.style.top = `${Math.max(16, initRect.top)}px`;
  wrapper.style.right = "auto";
  wrapper.style.bottom = "auto";

  if (dragHandle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let rafPending = false;
    let nextLeft = 0;
    let nextTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - startX;
      const dy = clientY - startY;
      nextLeft = Math.min(
        Math.max(0, startLeft + dx),
        window.innerWidth - readRect().width,
      );
      nextTop = Math.min(
        Math.max(0, startTop + dy),
        window.innerHeight - readRect().height,
      );
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          wrapper.style.left = `${nextLeft}px`;
          wrapper.style.top = `${nextTop}px`;
        });
      }
    };

    const stop = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", stop);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", stop);
      dragHandle.style.cursor = "grab";
    };

    const start = (e) => {
      dragging = true;
      dragHandle.style.cursor = "grabbing";
      const rect = readRect();
      startLeft = rect.left;
      startTop = rect.top;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", stop);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", stop);
    };

    dragHandle.addEventListener("mousedown", start);
    dragHandle.addEventListener("touchstart", (e) => {
      e.preventDefault();
      start(e);
    });
  }

  const attachCornerResize = (handle, corner) => {
    if (!handle) return;
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let startLeft = 0;
    let startTop = 0;
    let rafPending = false;
    let lastClientX = 0;
    let lastClientY = 0;

    const applyResize = () => {
      rafPending = false;
      if (!resizing) return;
      const dx = lastClientX - startX;
      const dy = lastClientY - startY;

      // Compute unclamped box from the dragged corner
      let left = startLeft;
      let top = startTop;
      let width = startW;
      let height = startH;

      if (corner === "br") {
        width = startW + dx;
        height = startH + dy;
      } else if (corner === "tr") {
        width = startW + dx;
        height = startH - dy;
        top = startTop + dy;
      } else if (corner === "bl") {
        width = startW - dx;
        height = startH + dy;
        left = startLeft + dx;
      } else {
        // tl
        width = startW - dx;
        height = startH - dy;
        left = startLeft + dx;
        top = startTop + dy;
      }

      // Clamp size
      width = Math.min(Math.max(minW, width), maxW);
      height = Math.min(Math.max(minH, height), maxH);

      // Clamp position to viewport
      left = Math.min(Math.max(0, left), window.innerWidth - width);
      top = Math.min(Math.max(0, top), window.innerHeight - height);

      wrapper.style.width = `${width}px`;
      wrapper.style.height = `${height}px`;
      wrapper.style.left = `${left}px`;
      wrapper.style.top = `${top}px`;
    };

    const onMove = (e) => {
      if (!resizing) return;
      lastClientX = e.touches ? e.touches[0].clientX : e.clientX;
      lastClientY = e.touches ? e.touches[0].clientY : e.clientY;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(applyResize);
      }
    };

    const stop = () => {
      resizing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", stop);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", stop);
    };

    const start = (e) => {
      resizing = true;
      const rect = readRect();
      startW = rect.width;
      startH = rect.height;
      startLeft = rect.left;
      startTop = rect.top;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      lastClientX = startX;
      lastClientY = startY;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", stop);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", stop);
    };

    handle.addEventListener("mousedown", start);
    handle.addEventListener("touchstart", (e) => {
      e.preventDefault();
      start(e);
    });
  };

  attachCornerResize(resizeHandleBR, "br");
  attachCornerResize(resizeHandleTL, "tl");
  attachCornerResize(resizeHandleTR, "tr");
  attachCornerResize(resizeHandleBL, "bl");
}

async function loadDemoTrace(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const hint =
      res.status === 404 ? "（請確認已 commit / push demo JSON 至儲存庫）" : "";
    throw new Error(`HTTP ${res.status} 載入失敗：${url} ${hint}`.trim());
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.samples))
    throw new Error(`格式無效（需含 samples[]）：${url}`);
  return data;
}

function toLmArray(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return [];
  return landmarks.map((lm) => {
    if (!lm) return [null, null, null, null];
    const x = typeof lm.x === "number" ? lm.x : null;
    const y = typeof lm.y === "number" ? lm.y : null;
    const z = typeof lm.z === "number" ? lm.z : null;
    const v = typeof lm.visibility === "number" ? lm.visibility : null;
    return [x, y, z, v];
  });
}

function formatTsForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function createDownload(filename, obj) {
  const text = JSON.stringify(obj);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setRecordUi(tScore) {
  if (!els.recordButton) return;
  if (state.ui.mode === "mode2") {
    els.recordButton.disabled = true;
    els.recordButton.textContent = "開始錄製";
    els.recordButton.classList.remove("btn-record--active");
    return;
  }
  const rec = state.recorder;
  els.recordButton.disabled = !state.cameraRunning || !state.ready;

  if (!rec.armed) {
    els.recordButton.textContent = "開始錄製";
    els.recordButton.classList.remove("btn-record--active");
    return;
  }

  if (!rec.active) {
    if (typeof tScore !== "number" || !Number.isFinite(tScore) || typeof rec.armStartPlayerTimeSec !== "number") {
      els.recordButton.textContent = "準備錄製（等待影片）";
    } else {
      const elapsed = Math.max(0, tScore - rec.armStartPlayerTimeSec);
      const remain = Math.max(0, rec.delaySec - elapsed);
      els.recordButton.textContent = `準備錄製（${Math.ceil(remain)}s）`;
    }
    els.recordButton.classList.add("btn-record--active");
    return;
  }

  els.recordButton.textContent = "停止並下載";
  els.recordButton.classList.add("btn-record--active");
}

async function loadTraceFromFile(file) {
  if (!file) return null;
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.samples)) {
    throw new Error("JSON 格式無效（缺少 samples[]）");
  }
  return data;
}

function computeContainRect(width, height, sourceAspect) {
  const canvasAspect = width / Math.max(1, height);
  if (canvasAspect > sourceAspect) {
    const drawH = height;
    const drawW = drawH * sourceAspect;
    return { ox: (width - drawW) / 2, oy: 0, dw: drawW, dh: drawH };
  }
  const drawW = width;
  const drawH = drawW / sourceAspect;
  return { ox: 0, oy: (height - drawH) / 2, dw: drawW, dh: drawH };
}

function getDemoTimeBracket(samples, t) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  if (samples.length === 1)
    return { left: samples[0], right: samples[0], alpha: 0 };
  const firstT = samples[0]?.t ?? 0;
  const lastT = samples[samples.length - 1]?.t ?? 0;
  if (t <= firstT) return { left: samples[0], right: samples[0], alpha: 0 };
  if (t >= lastT) {
    const last = samples[samples.length - 1];
    return { left: last, right: last, alpha: 0 };
  }
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((samples[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  const right = samples[lo];
  const left = samples[lo - 1];
  const tl = left?.t ?? 0;
  const tr = right?.t ?? tl;
  const alpha = tr === tl ? 0 : (t - tl) / (tr - tl);
  return { left, right, alpha };
}

function interpolateLandmarks(lmA, lmB, alpha) {
  if (!lmA || !Array.isArray(lmA)) return lmB;
  if (!lmB || !Array.isArray(lmB)) return lmA;
  const out = [];
  for (let i = 0; i < 33; i += 1) {
    const a = lmA[i];
    const b = lmB[i];
    if (!a && !b) {
      out.push(null);
      continue;
    }
    if (!a) {
      out.push(b);
      continue;
    }
    if (!b) {
      out.push(a);
      continue;
    }
    const [ax, ay, az, av] = a;
    const [bx, by, bz, bv] = b;
    out.push([
      ax + (bx - ax) * alpha,
      ay + (by - ay) * alpha,
      typeof az === "number" && typeof bz === "number"
        ? az + (bz - az) * alpha
        : (az ?? bz),
      typeof av === "number" && typeof bv === "number"
        ? av + (bv - av) * alpha
        : (av ?? bv),
    ]);
  }
  return out;
}

function getDemoLandmarksAtTime(samples, t) {
  const br = getDemoTimeBracket(samples, t);
  if (!br) return null;
  const { left, right, alpha } = br;
  if (!left || !Array.isArray(left.lm)) return null;
  if (left === right || alpha <= 0) return left.lm;
  if (!right || !Array.isArray(right.lm)) return left.lm;
  return interpolateLandmarks(left.lm, right.lm, alpha);
}

function drawDemoSkeletonAtTime(trace, canvas, currentTime) {
  if (!trace || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = Math.max(1, Math.floor(canvas.clientWidth));
  const h = Math.max(1, Math.floor(canvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.floor(w * dpr));
  const targetH = Math.max(1, Math.floor(h * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const tEnd = trace?.samples?.length
    ? trace.samples[trace.samples.length - 1]?.t
    : Infinity;
  if (typeof tEnd === "number" && currentTime > tEnd) {
    ctx.restore();
    return;
  }

  const lm = getDemoLandmarksAtTime(trace.samples, currentTime);
  if (!lm) {
    ctx.restore();
    return;
  }

  const rect = computeContainRect(w, h, DEMO_SOURCE_ASPECT);
  ctx.strokeStyle = "rgba(34, 197, 94, 0.95)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const [a, b] of DEMO_POSE_CONNECTIONS) {
    const pa = lm[a];
    const pb = lm[b];
    if (!pa || !pb) continue;
    const [ax, ay, , av] = pa;
    const [bx, by, , bv] = pb;
    if (
      typeof ax !== "number" ||
      typeof ay !== "number" ||
      typeof bx !== "number" ||
      typeof by !== "number"
    )
      continue;
    if (
      (typeof av === "number" && av <= 0.5) ||
      (typeof bv === "number" && bv <= 0.5)
    )
      continue;
    ctx.beginPath();
    ctx.moveTo(rect.ox + ax * rect.dw, rect.oy + ay * rect.dh);
    ctx.lineTo(rect.ox + bx * rect.dw, rect.oy + by * rect.dh);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
  for (const point of lm) {
    if (!point) continue;
    const [x, y, , v] = point;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (typeof v === "number" && v <= 0.5) continue;
    ctx.beginPath();
    ctx.arc(rect.ox + x * rect.dw, rect.oy + y * rect.dh, 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.restore();
}

function getLmXYV(lm) {
  if (!lm) return null;
  const x = typeof lm.x === "number" ? lm.x : null;
  const y = typeof lm.y === "number" ? lm.y : null;
  const v = typeof lm.visibility === "number" ? lm.visibility : null;
  if (x === null || y === null) return null;
  return { x, y, v };
}

function getArrXYV(arr) {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const [x, y, , v] = arr;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y, v: typeof v === "number" ? v : null };
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function center2(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const PARTS = Object.freeze({
  leftArm: "leftArm",
  rightArm: "rightArm",
  leftLeg: "leftLeg",
  rightLeg: "rightLeg",
  torso: "torso",
});

const PART_POINT_SETS = Object.freeze({
  [PARTS.leftArm]: [
    POSE_LANDMARKS.LEFT_SHOULDER,
    POSE_LANDMARKS.LEFT_ELBOW,
    POSE_LANDMARKS.LEFT_WRIST,
    POSE_LANDMARKS.LEFT_THUMB,
    POSE_LANDMARKS.LEFT_INDEX,
    POSE_LANDMARKS.LEFT_PINKY,
  ],
  [PARTS.rightArm]: [
    POSE_LANDMARKS.RIGHT_SHOULDER,
    POSE_LANDMARKS.RIGHT_ELBOW,
    POSE_LANDMARKS.RIGHT_WRIST,
    POSE_LANDMARKS.RIGHT_THUMB,
    POSE_LANDMARKS.RIGHT_INDEX,
    POSE_LANDMARKS.RIGHT_PINKY,
  ],
  [PARTS.leftLeg]: [
    POSE_LANDMARKS.LEFT_HIP,
    POSE_LANDMARKS.LEFT_KNEE,
    POSE_LANDMARKS.LEFT_ANKLE,
    POSE_LANDMARKS.LEFT_HEEL,
    POSE_LANDMARKS.LEFT_FOOT_INDEX,
  ],
  [PARTS.rightLeg]: [
    POSE_LANDMARKS.RIGHT_HIP,
    POSE_LANDMARKS.RIGHT_KNEE,
    POSE_LANDMARKS.RIGHT_ANKLE,
    POSE_LANDMARKS.RIGHT_HEEL,
    POSE_LANDMARKS.RIGHT_FOOT_INDEX,
  ],
  [PARTS.torso]: [
    POSE_LANDMARKS.LEFT_SHOULDER,
    POSE_LANDMARKS.RIGHT_SHOULDER,
    POSE_LANDMARKS.LEFT_HIP,
    POSE_LANDMARKS.RIGHT_HIP,
  ],
});

function partOfConnection(a, b) {
  const inSet = (set) => set.includes(a) && set.includes(b);
  if (inSet(PART_POINT_SETS[PARTS.leftArm])) return PARTS.leftArm;
  if (inSet(PART_POINT_SETS[PARTS.rightArm])) return PARTS.rightArm;
  if (inSet(PART_POINT_SETS[PARTS.leftLeg])) return PARTS.leftLeg;
  if (inSet(PART_POINT_SETS[PARTS.rightLeg])) return PARTS.rightLeg;
  return PARTS.torso;
}

function normalizePose2D(getPoint, visTh) {
  const lHip = getPoint(POSE_LANDMARKS.LEFT_HIP);
  const rHip = getPoint(POSE_LANDMARKS.RIGHT_HIP);
  const lSh = getPoint(POSE_LANDMARKS.LEFT_SHOULDER);
  const rSh = getPoint(POSE_LANDMARKS.RIGHT_SHOULDER);
  if (!lHip || !rHip || !lSh || !rSh) return null;
  if (
    (typeof lHip.v === "number" && lHip.v < visTh) ||
    (typeof rHip.v === "number" && rHip.v < visTh) ||
    (typeof lSh.v === "number" && lSh.v < visTh) ||
    (typeof rSh.v === "number" && rSh.v < visTh)
  ) {
    return null;
  }
  const hipC = center2(lHip, rHip);
  const shC = center2(lSh, rSh);
  const scale = dist2(shC, hipC);
  if (!Number.isFinite(scale) || scale < 1e-6) return null;

  const pts = [];
  for (let i = 0; i < 33; i += 1) {
    const p = getPoint(i);
    if (!p) {
      pts.push(null);
      continue;
    }
    const vOk = typeof p.v !== "number" || p.v >= visTh;
    if (!vOk) {
      pts.push(null);
      continue;
    }
    pts.push({
      x: (p.x - hipC.x) / scale,
      y: (p.y - hipC.y) / scale,
      v: p.v,
    });
  }
  return { pts };
}

function computeDemoEnergyForTrace(trace) {
  const cfg = state.similarity;
  const visTh = cfg.visibilityThreshold;
  const samples = trace?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return;

  let prevNorm = null;
  let prevT = null;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s || !Array.isArray(s.lm) || s.lm.length !== 33) continue;
    const t = typeof s.t === "number" && Number.isFinite(s.t) ? s.t : null;
    const norm = normalizePose2D((k) => getArrXYV(s.lm?.[k]), visTh);
    if (!norm || t === null) {
      s.E_ref = 0;
      prevNorm = null;
      prevT = null;
      continue;
    }

    let E = 0;
    if (prevNorm && typeof prevT === "number") {
      const dt = Math.max(1e-3, t - prevT);
      const dists = [];
      for (let j = 0; j < 33; j += 1) {
        const a = prevNorm.pts[j];
        const b = norm.pts[j];
        if (!a || !b) continue;
        const d = dist2(a, b);
        if (!Number.isFinite(d)) continue;
        dists.push(d / dt);
      }
      if (dists.length) {
        dists.sort((x, y) => x - y);
        E = dists[Math.floor(dists.length / 2)];
      }
    }

    s.E_ref = Number.isFinite(E) ? E : 0;
    prevNorm = norm;
    prevT = t;
  }
}

function computeDemoPartEnergyForTrace(trace) {
  const cfg = state.similarity;
  const visTh = cfg.visibilityThreshold;
  const samples = trace?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return;

  let prevNorm = null;
  let prevT = null;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s || !Array.isArray(s.lm) || s.lm.length !== 33) continue;
    const t = typeof s.t === "number" && Number.isFinite(s.t) ? s.t : null;
    const norm = normalizePose2D((k) => getArrXYV(s.lm?.[k]), visTh);
    if (!norm || t === null) {
      s.E_part = {
        [PARTS.leftArm]: 0,
        [PARTS.rightArm]: 0,
        [PARTS.leftLeg]: 0,
        [PARTS.rightLeg]: 0,
        [PARTS.torso]: 0,
      };
      prevNorm = null;
      prevT = null;
      continue;
    }

    const out = {
      [PARTS.leftArm]: 0,
      [PARTS.rightArm]: 0,
      [PARTS.leftLeg]: 0,
      [PARTS.rightLeg]: 0,
      [PARTS.torso]: 0,
    };

    if (prevNorm && typeof prevT === "number") {
      const dt = Math.max(1e-3, t - prevT);
      for (const [part, idxs] of Object.entries(PART_POINT_SETS)) {
        const dists = [];
        for (const j of idxs) {
          const a = prevNorm.pts[j];
          const b = norm.pts[j];
          if (!a || !b) continue;
          const d = dist2(a, b);
          if (!Number.isFinite(d)) continue;
          dists.push(d / dt);
        }
        if (dists.length) {
          dists.sort((x, y) => x - y);
          out[part] = dists[Math.floor(dists.length / 2)];
        }
      }
    }

    s.E_part = out;
    prevNorm = norm;
    prevT = t;
  }
}

function computeMeanDist(userLandmarks, demoLmArray) {
  const cfg = state.similarity;
  const visTh = cfg.visibilityThreshold;
  const userNorm = normalizePose2D((i) => getLmXYV(userLandmarks?.[i]), visTh);
  const demoNorm = normalizePose2D((i) => getArrXYV(demoLmArray?.[i]), visTh);
  if (!userNorm || !demoNorm) return { ok: false, reason: "weak_core" };

  let sum = 0;
  let n = 0;
  for (let i = 0; i < 33; i += 1) {
    const a = userNorm.pts[i];
    const b = demoNorm.pts[i];
    if (!a || !b) continue;
    const d = dist2(a, b);
    if (!Number.isFinite(d)) continue;
    sum += d;
    n += 1;
  }
  if (n < cfg.minValidPoints)
    return { ok: false, reason: "too_few_points", validPoints: n };
  return { ok: true, meanDist: sum / n, validPoints: n };
}

function lowerBoundByT(samples, t) {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function getCandidateRange(samples, t, windowSec) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const startT = t - windowSec;
  const endT = t + windowSec;
  const i0 = Math.max(0, lowerBoundByT(samples, startT));
  const i1 = Math.min(samples.length, lowerBoundByT(samples, endT + 1e-9));
  if (i1 <= i0) return null;
  return { i0, i1 };
}

function gaussian(dt, sigma) {
  if (!Number.isFinite(dt) || !Number.isFinite(sigma) || sigma <= 0) return 1;
  const x = dt / sigma;
  return Math.exp(-0.5 * x * x);
}

function computeWindowScoreD(userLandmarks, trace, t) {
  const cfg = state.similarity;
  if (!trace?.samples) return { ok: false, reason: "no_trace" };
  const samples = trace.samples;
  const range = getCandidateRange(samples, t, cfg.windowSec);
  if (!range) return { ok: false, reason: "no_candidates" };

  let sumW = 0;
  let sumD = 0;
  let sumWE = 0;
  let bestD = Infinity;
  let bestN = 0;

  for (let i = range.i0; i < range.i1; i += 1) {
    const s = samples[i];
    if (!s || !Array.isArray(s.lm) || s.lm.length !== 33) continue;
    const r = computeMeanDist(userLandmarks, s.lm);
    if (!r.ok) continue;
    const dt = Math.abs((typeof s.t === "number" ? s.t : t) - t);
    const wTime = gaussian(dt, cfg.sigmaTimeSec);
    const wPose = Math.exp(-r.meanDist / Math.max(1e-6, cfg.tauDist));
    const w = wTime * wPose;
    sumW += w;
    sumD += w * r.meanDist;
    sumWE +=
      w *
      (typeof s.E_ref === "number" && Number.isFinite(s.E_ref) ? s.E_ref : 0);
    if (r.meanDist < bestD) {
      bestD = r.meanDist;
      bestN = r.validPoints;
    }
  }

  if (!(sumW > 0)) return { ok: false, reason: "no_valid_candidates" };
  const meanDist = sumD / sumW;
  const ErefWin = sumWE / sumW;
  const score = Math.max(0, Math.min(100, 100 * Math.exp(-cfg.k * meanDist)));
  return { ok: true, score, meanDist, validPoints: bestN, ErefWin };
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function computeEnergyGateWeight(E) {
  const cfg = state.similarity;
  const E0 = cfg.energyE0;
  const E1 = Math.max(E0 + 1e-6, cfg.energyE1);
  const minW = cfg.energyMinWeight;
  const u = clamp01((E - E0) / (E1 - E0));
  return minW + (1 - minW) * u;
}

function pushOverall(buffer, nowT, score, w) {
  const cfg = state.similarity;
  const historySec = cfg.historySec;
  if (!Number.isFinite(nowT) || !Number.isFinite(score)) return null;
  const ww = Number.isFinite(w) ? w : 1;
  buffer.push({ t: nowT, score, w: ww });

  const cutoff = nowT - historySec;
  while (buffer.length && buffer[0].t < cutoff) buffer.shift();

  let sumW = 0;
  let sum = 0;
  for (const it of buffer) {
    if (!it) continue;
    const iw = Number.isFinite(it.w) ? it.w : 1;
    const is = Number.isFinite(it.score) ? it.score : null;
    if (is === null) continue;
    sumW += iw;
    sum += iw * is;
  }
  if (!(sumW > 0)) return null;
  return sum / sumW;
}

function computeActiveParts(trace, t) {
  const cfg = state.similarity;
  const samples = trace?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return new Set();
  const range = getCandidateRange(samples, t, cfg.windowSec);
  if (!range) return new Set();

  const sum = {
    [PARTS.leftArm]: 0,
    [PARTS.rightArm]: 0,
    [PARTS.leftLeg]: 0,
    [PARTS.rightLeg]: 0,
    [PARTS.torso]: 0,
  };
  let sumW = 0;

  for (let i = range.i0; i < range.i1; i += 1) {
    const s = samples[i];
    if (!s || !s.E_part) continue;
    const dt = Math.abs((typeof s.t === "number" ? s.t : t) - t);
    const w = gaussian(dt, cfg.sigmaTimeSec);
    sumW += w;
    sum[PARTS.leftArm] += w * (s.E_part[PARTS.leftArm] || 0);
    sum[PARTS.rightArm] += w * (s.E_part[PARTS.rightArm] || 0);
    sum[PARTS.leftLeg] += w * (s.E_part[PARTS.leftLeg] || 0);
    sum[PARTS.rightLeg] += w * (s.E_part[PARTS.rightLeg] || 0);
    sum[PARTS.torso] += w * (s.E_part[PARTS.torso] || 0);
  }

  if (!(sumW > 0)) return new Set();
  const avg = {
    [PARTS.leftArm]: sum[PARTS.leftArm] / sumW,
    [PARTS.rightArm]: sum[PARTS.rightArm] / sumW,
    [PARTS.leftLeg]: sum[PARTS.leftLeg] / sumW,
    [PARTS.rightLeg]: sum[PARTS.rightLeg] / sumW,
    [PARTS.torso]: sum[PARTS.torso] / sumW,
  };

  const vals = Object.values(avg);
  const maxE = Math.max(...vals, 0);
  const absTh = 0.12;
  const relTh = 0.6;

  const active = new Set();
  for (const [part, v] of Object.entries(avg)) {
    if (v >= absTh && v >= maxE * relTh) active.add(part);
  }
  return active;
}

function drawPoseConnections(
  ctx,
  points,
  getXYV,
  rect,
  colorByConnection,
  lineWidth = 3,
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  for (const [a, b] of DEMO_POSE_CONNECTIONS) {
    const pa = getXYV(points?.[a]);
    const pb = getXYV(points?.[b]);
    if (!pa || !pb) continue;
    if ((typeof pa.v === "number" && pa.v < 0.5) || (typeof pb.v === "number" && pb.v < 0.5)) continue;
    const c = typeof colorByConnection === "function" ? colorByConnection(a, b) : "rgba(255,255,255,0.95)";
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.moveTo(rect.ox + pa.x * rect.dw, rect.oy + pa.y * rect.dh);
    ctx.lineTo(rect.ox + pb.x * rect.dw, rect.oy + pb.y * rect.dh);
    ctx.stroke();
  }
}

function drawPosePoints(ctx, points, getXYV, rect, color, radius = 3.5) {
  ctx.fillStyle = color;
  for (let i = 0; i < 33; i += 1) {
    const p = getXYV(points?.[i]);
    if (!p) continue;
    if (typeof p.v === "number" && p.v < 0.5) continue;
    ctx.beginPath();
    ctx.arc(
      rect.ox + p.x * rect.dw,
      rect.oy + p.y * rect.dh,
      radius,
      0,
      2 * Math.PI,
    );
    ctx.fill();
  }
}

function getDemoTraceByMode(mode) {
  if (mode === "hard") return state.demo.hard;
  if (mode === "user") return state.demo.loaded;
  return state.demo.easy;
}

function updateOrangeState(nowT, instantScore, overallScore) {
  const st = state.orange;
  if (!Number.isFinite(nowT)) return st.active;
  const dt = typeof st.lastT === "number" ? Math.max(0, nowT - st.lastT) : 0;
  st.lastT = nowT;

  const enterThr = st.enterThreshold;
  const exitThr = st.exitThreshold;

  const enterOkOverall =
    typeof overallScore === "number" && overallScore >= enterThr;
  const enterOkInstant =
    typeof instantScore === "number" && instantScore >= enterThr;

  const exitOkOverall = typeof overallScore === "number" && overallScore >= exitThr;
  const exitOkInstant = typeof instantScore === "number" && instantScore >= exitThr;

  st.window.push({ t: nowT, enterOk: enterOkInstant, exitOk: exitOkInstant });
  const winSec = st.active ? Math.max(st.exitRequireSec, 0.5) : Math.max(st.enterRequireSec, 0.5);
  const cutoff = nowT - winSec;
  while (st.window.length && st.window[0].t < cutoff) st.window.shift();

  let enterRatio = 0;
  let exitRatio = 0;
  if (st.window.length) {
    let enterN = 0;
    let exitN = 0;
    for (const it of st.window) {
      if (it.enterOk) enterN += 1;
      if (it.exitOk) exitN += 1;
    }
    enterRatio = enterN / st.window.length;
    exitRatio = exitN / st.window.length;
  }

  if (!st.active) {
    const ok = enterOkOverall && enterRatio >= st.enterInstantMajorityRatio;
    if (ok) st.enterGoodSec += dt;
    else st.enterGoodSec = 0;
    if (st.enterGoodSec >= st.enterRequireSec) {
      st.active = true;
      st.exitBadSec = 0;
      st.window = [];
    }
    return st.active;
  }

  // active: stay blue unless clearly deviating for a while
  const okStay = exitOkOverall && exitRatio >= st.exitInstantMajorityRatio;
  if (!okStay) st.exitBadSec += dt;
  else st.exitBadSec = 0;

  if (st.exitBadSec >= st.exitRequireSec) {
    st.active = false;
    st.enterGoodSec = 0;
    st.window = [];
  }

  return st.active;
}

function drawUserOverlay() {
  if (!els.outputCanvas || !els.inputVideo) return;
  const ctx = els.outputCanvas.getContext("2d");
  if (!ctx) return;

  const w = Math.max(1, Math.floor(els.outputCanvas.clientWidth));
  const h = Math.max(1, Math.floor(els.outputCanvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.floor(w * dpr));
  const targetH = Math.max(1, Math.floor(h * dpr));
  if (
    els.outputCanvas.width !== targetW ||
    els.outputCanvas.height !== targetH
  ) {
    els.outputCanvas.width = targetW;
    els.outputCanvas.height = targetH;
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
}

async function initPose() {
  if (!els.startCameraButton) return;

  els.startCameraButton.addEventListener("click", async () => {
    if (state.cameraRunning) {
      state.poseLoopActive = false;
      state.cameraRunning = false;
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach((t) => t.stop());
        state.cameraStream = null;
      }
      if (els.inputVideo) els.inputVideo.srcObject = null;
      els.startCameraButton.textContent = "啟動攝影機";
      state.latestUserLandmarks = null;
      drawUserOverlay();
      clearOverlayCanvas();
      return;
    }

    try {
      els.startCameraButton.disabled = true;
      const poseInstance = await PoseModel.init();
      if (!poseInstance) throw new Error("MediaPipe PoseLandmarker 初始化失敗");

      PoseModel.setCallback((result) => {
        if (
          !result ||
          !Array.isArray(result.landmarks) ||
          result.landmarks.length !== 33
        ) {
          state.latestUserLandmarks = null;
          return;
        }
        state.latestUserLandmarks = result.landmarks;
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      state.cameraStream = stream;
      els.inputVideo.srcObject = stream;
      await els.inputVideo.play();

      // Pose loop
      let lastTimestamp = 0;
      let isProcessing = false;
      let pendingFrame = null;

      const processFrames = async () => {
        if (isProcessing || !pendingFrame) return;
        isProcessing = true;
        const frame = pendingFrame;
        pendingFrame = null;
        try {
          const currentTimestampMs = performance.now();
          let timestampUs = Math.floor(currentTimestampMs * 1000);
          if (timestampUs <= lastTimestamp) timestampUs = lastTimestamp + 1;
          lastTimestamp = timestampUs;
          await PoseModel.detect(frame, timestampUs);
        } catch (err) {
          console.error("Pose detect failed:", err);
        } finally {
          isProcessing = false;
          if (pendingFrame && !isProcessing)
            requestAnimationFrame(processFrames);
        }
      };

      const loop = () => {
        if (!state.poseLoopActive) return;
        if (els.inputVideo.readyState === els.inputVideo.HAVE_ENOUGH_DATA) {
          pendingFrame = els.inputVideo;
          if (!isProcessing) processFrames();
        }
        requestAnimationFrame(loop);
      };

      state.poseLoopActive = true;
      loop();
      state.cameraRunning = true;
      els.startCameraButton.textContent = "關閉攝影機";
      els.startCameraButton.disabled = false;
    } catch (err) {
      console.error(err);
      els.startCameraButton.disabled = false;
      els.startCameraButton.textContent = "啟動攝影機";
    }
  });
}

function getPlayerTimeSafe() {
  if (!state.player || typeof state.player.getCurrentTime !== "function")
    return null;
  try {
    const t = state.player.getCurrentTime();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function updateUiLoop() {
  requestAnimationFrame(updateUiLoop);

  const tRaw = getPlayerTimeSafe();
  const tDemo = typeof tRaw === "number" && Number.isFinite(tRaw) ? tRaw : 0;

  const ytOk = Boolean(state.ready && state.player);
  const tScore =
    ytOk && typeof tRaw === "number" && Number.isFinite(tRaw) ? tRaw : null;

  if (state.ui.mode === "mode2") {
    setRecordUi(tScore);
    setUi({ easy: "—", hard: "—", loaded: "—", overallEasy: "—", overallHard: "—", overallLoaded: "—" });
    clearOverlayCanvas();
    return;
  }

  // --- Recorder state machine (record user pose vs YouTube time)
  const rec = state.recorder;
  if (rec.armed && typeof tScore === "number" && Number.isFinite(tScore)) {
    if (typeof rec.armStartPlayerTimeSec !== "number") {
      rec.armStartPlayerTimeSec = tScore;
    }
    if (!rec.active) {
      const elapsed = tScore - rec.armStartPlayerTimeSec;
      if (elapsed >= rec.delaySec) {
        rec.active = true;
        rec.startedAtIso = new Date().toISOString();
        rec.lastRecordedT = Number.NEGATIVE_INFINITY;
      }
    }
    if (rec.active && state.latestUserLandmarks) {
      if (tScore - rec.lastRecordedT >= RECORD_SAMPLE_MIN_DT) {
        rec.samples.push({ t: tScore, lm: toLmArray(state.latestUserLandmarks) });
        rec.lastRecordedT = tScore;
      }
    }
  }

  setRecordUi(tScore);

  if (!state.latestUserLandmarks) {
    setUi({ easy: "—", hard: "—", overallEasy: "—", overallHard: "—" });
    clearOverlayCanvas();
    return;
  }

  if (tScore === null) {
    setUi({ easy: "—", hard: "—", overallEasy: "—", overallHard: "—" });
    clearOverlayCanvas();
    return;
  }

  const rEasy = computeWindowScoreD(
    state.latestUserLandmarks,
    state.demo.easy,
    tScore,
  );
  const rHard = computeWindowScoreD(
    state.latestUserLandmarks,
    state.demo.hard,
    tScore,
  );
  const rLoaded = computeWindowScoreD(
    state.latestUserLandmarks,
    state.demo.loaded,
    tScore,
  );

  const okEasy = rEasy.ok ? rEasy.score.toFixed(0) : "—";
  const okHard = rHard.ok ? rHard.score.toFixed(0) : "—";
  const okLoaded = rLoaded.ok ? rLoaded.score.toFixed(0) : "—";

  let overallEasy = "—";
  let overallEasyNum = null;
  if (rEasy.ok) {
    const wg = computeEnergyGateWeight(rEasy.ErefWin);
    const ov = pushOverall(state.overall.easy, tScore, rEasy.score, wg);
    if (typeof ov === "number") {
      overallEasyNum = ov;
      overallEasy = ov.toFixed(0);
    }
  }

  let overallHard = "—";
  let overallHardNum = null;
  if (rHard.ok) {
    const wg = computeEnergyGateWeight(rHard.ErefWin);
    const ov = pushOverall(state.overall.hard, tScore, rHard.score, wg);
    if (typeof ov === "number") {
      overallHardNum = ov;
      overallHard = ov.toFixed(0);
    }
  }

  let overallLoaded = "—";
  let overallLoadedNum = null;
  if (rLoaded.ok) {
    const wg = computeEnergyGateWeight(rLoaded.ErefWin);
    const ov = pushOverall(state.overall.loaded, tScore, rLoaded.score, wg);
    if (typeof ov === "number") {
      overallLoadedNum = ov;
      overallLoaded = ov.toFixed(0);
    }
  }

  setUi({
    easy: okEasy,
    hard: okHard,
    loaded: okLoaded,
    overallEasy,
    overallHard,
    overallLoaded,
  });

  // ---- Interactive overlay coloring (test only)
  const isRecordingMode = Boolean(state.recorder?.armed);

  const hintMode =
    state.ui.hintMode === "hard" || state.ui.hintMode === "user"
      ? state.ui.hintMode
      : "easy";
  const trace = isRecordingMode ? null : getDemoTraceByMode(hintMode);
  const demoLm = trace?.samples ? getDemoLandmarksAtTime(trace.samples, tScore) : null;
  const activeParts = trace ? computeActiveParts(trace, tScore) : new Set();
  const selectedInstant =
    hintMode === "hard"
      ? rHard.ok
        ? rHard.score
        : null
      : hintMode === "user"
        ? rLoaded.ok
          ? rLoaded.score
          : null
        : rEasy.ok
          ? rEasy.score
          : null;
  const selectedOverall =
    hintMode === "hard"
      ? overallHardNum
      : hintMode === "user"
        ? overallLoadedNum
        : overallEasyNum;
  const isOrange = updateOrangeState(tScore, selectedInstant, selectedOverall);

  if (els.overlayCanvas) {
    const ctx = els.overlayCanvas.getContext("2d");
    if (ctx) {
      const w = Math.max(1, Math.floor(els.overlayCanvas.clientWidth));
      const h = Math.max(1, Math.floor(els.overlayCanvas.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.floor(w * dpr));
      const targetH = Math.max(1, Math.floor(h * dpr));
      if (els.overlayCanvas.width !== targetW || els.overlayCanvas.height !== targetH) {
        els.overlayCanvas.width = targetW;
        els.overlayCanvas.height = targetH;
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Draw in the same contain-rect as the camera video (object-fit: contain)
      const videoAspect =
        els.inputVideo && els.inputVideo.videoWidth && els.inputVideo.videoHeight
          ? els.inputVideo.videoWidth / Math.max(1, els.inputVideo.videoHeight)
          : w / Math.max(1, h);
      const stageRect = computeContainRect(w, h, videoAspect);

      // User skeleton (white / red hints / blue when good)
      const blueColor = "rgba(59,130,246,0.95)";
      const whiteColor = "rgba(255,255,255,0.92)";
      const redColor = "rgba(239,68,68,0.95)";
      const baseColor = isOrange ? blueColor : whiteColor;
      const colorByConn = (a, b) => {
        if (isOrange) return blueColor;
        const part = partOfConnection(a, b);
        if (isRecordingMode) return whiteColor;
        return activeParts.has(part) ? redColor : whiteColor;
      };
      drawPoseConnections(ctx, state.latestUserLandmarks, getLmXYV, stageRect, colorByConn, 3);
      drawPosePoints(ctx, state.latestUserLandmarks, getLmXYV, stageRect, baseColor, 3.5);

      // Demo overlay (green / blue) on top so it's always visible
      if (demoLm && !isRecordingMode) {
        const demoColor = isOrange ? blueColor : "rgba(34,197,94,0.95)";
        const PAD = 6;
        const GAP = 8;
        const sideAreaRatio = 0.36; // 左右側欄占比（示範骨架放大）
        const leftAreaW = Math.max(140, Math.floor(w * sideAreaRatio));
        const rightAreaW = Math.max(140, Math.floor(w * sideAreaRatio));
        const centerMinW = 300;
        const availableCenterW = w - leftAreaW - rightAreaW - PAD * 2 - GAP * 2;
        const useSide =
          availableCenterW >= centerMinW &&
          leftAreaW + rightAreaW + centerMinW + PAD * 2 + GAP * 2 <= w;

        if (useSide) {
          const leftX = PAD;
          const rightX = w - PAD - rightAreaW;
          const areaY = PAD;
          const areaH = h - PAD * 2;

          const cellW = Math.floor((leftAreaW - GAP) / 2);
          const cellH = areaH;

          const mkCell = (x0) => {
            const r = computeContainRect(cellW, cellH, DEMO_SOURCE_ASPECT);
            return { ox: x0 + r.ox, oy: areaY + r.oy, dw: r.dw, dh: r.dh };
          };

          const rects = [
            mkCell(leftX),
            mkCell(leftX + cellW + GAP),
            mkCell(rightX),
            mkCell(rightX + cellW + GAP),
          ];

          // 注意：overlay_canvas 以 CSS 做了水平鏡像（scaleX(-1)），視覺左右會對調。
          // 這裡把滑桿的 L1/L2/R1/R2 重新對應到「畫面上由左到右」的四格。
          const scales = [
            state.ui?.demoScale?.r2 ?? 1, // 視覺最右 ↔ 畫布最左
            state.ui?.demoScale?.r1 ?? 1,
            state.ui?.demoScale?.l2 ?? 1,
            state.ui?.demoScale?.l1 ?? 1, // 視覺最左 ↔ 畫布最右
          ];

          for (let i = 0; i < rects.length; i += 1) {
            const r0 = rects[i];
            const s = scales[i];
            const r = scaleRectAboutCenter(r0, s);
            drawPoseConnections(ctx, demoLm, getArrXYV, r, () => demoColor, 5);
            drawPosePoints(ctx, demoLm, getArrXYV, r, demoColor, 4.5);
          }
        } else {
          // fallback: 畫在原本位置（避免視窗太窄時看不到）
          drawPoseConnections(ctx, demoLm, getArrXYV, stageRect, () => demoColor, 5);
          drawPosePoints(ctx, demoLm, getArrXYV, stageRect, demoColor, 4.5);
        }
      }

      ctx.restore();
    }
  }
}

async function main() {
  initDomRefs();
  // debug handle for DevTools
  window.__posedanceTestState = state;
  setModeUiText();
  bindDemoScaleSlider(els.demoScaleL1, "l1");
  bindDemoScaleSlider(els.demoScaleL2, "l2");
  bindDemoScaleSlider(els.demoScaleR1, "r1");
  bindDemoScaleSlider(els.demoScaleR2, "r2");
  setupYtFloatingWindow();
  initYouTubePlayerIfPossible();

  try {
    const [easy, hard] = await Promise.all([
      loadDemoTrace(DEMO_TRACE_PATHS.easy),
      loadDemoTrace(DEMO_TRACE_PATHS.hard),
    ]);
    state.demo.easy = easy;
    state.demo.hard = hard;

    computeDemoEnergyForTrace(state.demo.easy);
    computeDemoEnergyForTrace(state.demo.hard);
    computeDemoPartEnergyForTrace(state.demo.easy);
    computeDemoPartEnergyForTrace(state.demo.hard);

    if (!state.videoId && typeof easy.videoId === "string" && easy.videoId) {
      state.videoId = easy.videoId;
      if (els.videoUrlInput) els.videoUrlInput.value = easy.videoId;
    }
    // 初始載入 demo 附帶的 videoId：只 cue 不自動播放
    loadVideoByIdIfReady({ autoplay: false });
  } catch (err) {
    console.error("[DemoTrace] load failed:", err);
  }

  if (els.hintModeSelect) {
    els.hintModeSelect.addEventListener("change", () => {
      const raw = els.hintModeSelect.value;
      const v =
        raw === "hard" ? "hard" : raw === "user" ? "user" : "easy";
      state.ui.hintMode = v;
      state.orange.active = false;
      state.orange.enterGoodSec = 0;
      state.orange.exitBadSec = 0;
      state.orange.window = [];
      state.orange.lastT = null;
    });
  }

  if (els.modeSelect) {
    els.modeSelect.addEventListener("change", () => {
      const raw = els.modeSelect.value;
      applyMode(raw === "mode2" ? "mode2" : "mode1");
    });
    applyMode(els.modeSelect.value);
  } else {
    applyMode("mode1");
  }

  if (els.loadVideoButton) {
    els.loadVideoButton.addEventListener("click", () => {
      if (state.ui.mode === "mode2") return;
      const raw = els.videoUrlInput ? els.videoUrlInput.value : "";
      const id = extractVideoId(raw);
      if (!id) return;
      state.videoId = id;
      state.lastLoadedVideoId = null;
      loadVideoByIdIfReady({ autoplay: true });
    });
  }

  if (els.loadSkeletonButton && els.skeletonFileInput) {
    els.loadSkeletonButton.addEventListener("click", () => {
      if (state.ui.mode === "mode2") return;
      els.skeletonFileInput.value = "";
      els.skeletonFileInput.click();
    });
    els.skeletonFileInput.addEventListener("change", async () => {
      if (state.ui.mode === "mode2") return;
      const file = els.skeletonFileInput.files && els.skeletonFileInput.files[0];
      if (!file) return;
      try {
        const data = await loadTraceFromFile(file);
        state.demo.loaded = data;
        computeDemoEnergyForTrace(state.demo.loaded);
        computeDemoPartEnergyForTrace(state.demo.loaded);
        state.overall.loaded = [];
        setUi({ loaded: "—", overallLoaded: "—" });
      } catch (err) {
        console.error("[LoadedTrace] load failed:", err);
      }
    });
  }

  if (els.recordButton) {
    els.recordButton.addEventListener("click", () => {
      if (state.ui.mode === "mode2") return;
      const rec = state.recorder;
      if (!rec.armed) {
        rec.armed = true;
        rec.active = false;
        rec.armStartPlayerTimeSec = null;
        rec.startedAtIso = null;
        rec.lastRecordedT = Number.NEGATIVE_INFINITY;
        rec.samples = [];
        setRecordUi(getPlayerTimeSafe());
        return;
      }

      // stop & download
      rec.armed = false;
      rec.active = false;
      const videoId = state.videoId || "unknown";
      const payload = {
        videoId,
        recordedAt: rec.startedAtIso || new Date().toISOString(),
        sampleCount: rec.samples.length,
        samples: rec.samples,
      };
      const filename = `pose_trace_user_${videoId}_${formatTsForFilename()}.json`;
      createDownload(filename, payload);

      rec.armStartPlayerTimeSec = null;
      rec.startedAtIso = null;
      rec.lastRecordedT = Number.NEGATIVE_INFINITY;
      rec.samples = [];
      setRecordUi(getPlayerTimeSafe());
    });
  }

  if (els.pickSongButton) {
    els.pickSongButton.addEventListener("click", async () => {
      if (state.ui.mode === "mode2") return;
      openSongModal();
      if (!state.music.categories.length) await loadCategories();
      state.music.page = 1;
      state.music.q = els.songSearchInput ? els.songSearchInput.value.trim() : "";
      await loadMidisPage();
    });
  }

  if (els.songModalCloseButton) {
    els.songModalCloseButton.addEventListener("click", () => closeSongModal());
  }
  if (els.songModalBackdrop) {
    els.songModalBackdrop.addEventListener("click", (e) => {
      if (e.target === els.songModalBackdrop) closeSongModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.music.open) closeSongModal();
  });

  if (els.songSearchButton) {
    els.songSearchButton.addEventListener("click", async () => {
      if (state.ui.mode === "mode2") return;
      state.music.page = 1;
      state.music.q = els.songSearchInput ? els.songSearchInput.value.trim() : "";
      await loadMidisPage();
    });
  }
  if (els.songSearchInput) {
    els.songSearchInput.addEventListener("keydown", async (e) => {
      if (state.ui.mode === "mode2") return;
      if (e.key !== "Enter") return;
      state.music.page = 1;
      state.music.q = els.songSearchInput ? els.songSearchInput.value.trim() : "";
      await loadMidisPage();
    });
  }
  if (els.songPrevPageButton) {
    els.songPrevPageButton.addEventListener("click", async () => {
      if (state.ui.mode === "mode2") return;
      state.music.page = Math.max(1, state.music.page - 1);
      await loadMidisPage();
    });
  }
  if (els.songNextPageButton) {
    els.songNextPageButton.addEventListener("click", async () => {
      if (state.ui.mode === "mode2") return;
      state.music.page = Math.min(state.music.pages, state.music.page + 1);
      await loadMidisPage();
    });
  }

  await initPose();
  updateUiLoop();
}

main();
