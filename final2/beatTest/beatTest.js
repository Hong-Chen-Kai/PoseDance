const state = {
  beats: [],
  countInBeats: 0,
  actions: [],
  bpm: null,
  mode: "easy",
  videoId: null,
  player: null,
  ready: false,
  lastLoadedVideoId: null,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function initDomRefs() {
  els.currentTimeText = $("currentTimeText");
  els.beatIndexText = $("beatIndexText");
  els.beatNumberText = $("beatNumberText");
  els.barIndexText = $("barIndexText");
  els.beatsCountText = $("beatsCountText");
  els.bpmText = $("bpmText");
  els.actionsCountText = $("actionsCountText");
  els.countInBeatsText = $("countInBeatsText");
  els.poseIdText = $("poseIdText");
  els.debugText = $("debugText");
  els.phaseTag = $("phaseTag");
  els.judgeTag = $("judgeTag");
  els.videoUrlInput = $("videoUrlInput");
  els.loadVideoButton = $("loadVideoButton");
  els.modeSelect = $("modeSelect");
}

const APPLE_JSON_PATH_CANDIDATES = {
  easy: ["./apple.json"],
  hard: ["./applev2.json", "./apple.v2.json"],
};

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  // 如果看起來像 11 位的純 ID，就直接用
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    // youtu.be/xxxxxxxxxxx
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace("/", "");
      return id || null;
    }
    // www.youtube.com/watch?v=xxxxxxxxxxx
    const v = url.searchParams.get("v");
    if (v) return v;
  } catch {
    // 不是合法 URL，就當成一般字串處理，不特別報錯
  }
  return null;
}

async function loadAppleJson() {
  const mode = state.mode === "hard" ? "hard" : "easy";
  const candidates = APPLE_JSON_PATH_CANDIDATES[mode] || APPLE_JSON_PATH_CANDIDATES.easy;
  let data = null;
  let loadedPath = null;
  let lastStatus = "unknown";
  for (const path of candidates) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) {
      lastStatus = String(res.status);
      continue;
    }
    data = await res.json();
    loadedPath = path;
    break;
  }
  if (!data || !loadedPath) {
    throw new Error(`載入 hard/easy JSON 失敗，mode=${mode}，lastStatus=${lastStatus}`);
  }
  state.beats = Array.isArray(data.beats) ? data.beats : [];
  state.countInBeats =
    typeof data.countInBeats === "number" ? data.countInBeats : 16;
  state.actions = Array.isArray(data.actions) ? data.actions : [];
  state.bpm = typeof data.bpm === "number" ? data.bpm : null;
  state.videoId =
    typeof data.videoId === "string" && data.videoId
      ? data.videoId
      : "dQw4w9WgXcQ"; // placeholder

  if (els.beatsCountText) {
    els.beatsCountText.textContent = String(state.beats.length);
  }
  if (els.bpmText) {
    els.bpmText.textContent =
      state.bpm !== null ? String(state.bpm) : "—";
  }
  if (els.actionsCountText) {
    els.actionsCountText.textContent = String(state.actions.length);
  }
  if (els.countInBeatsText) {
    els.countInBeatsText.textContent = String(state.countInBeats);
  }
  if (els.debugText) {
    els.debugText.textContent =
      `${loadedPath} 載入成功\n` +
      `mode: ${mode}\n` +
      `videoId: ${state.videoId}\n` +
      `bpm: ${state.bpm ?? "—"}\n` +
      `beats.length: ${state.beats.length}\n` +
      `actions.length: ${state.actions.length}`;
  }
  if (els.videoUrlInput && state.videoId) {
    els.videoUrlInput.value = state.videoId;
  }
}

function loadVideoByIdIfReady() {
  if (
    !state.ready ||
    !state.player ||
    !state.videoId ||
    typeof state.player.loadVideoById !== "function"
  ) {
    return;
  }
  if (state.lastLoadedVideoId === state.videoId) return;
  state.player.loadVideoById(state.videoId);
  state.lastLoadedVideoId = state.videoId;
}

// YouTube IFrame API 會在 global 呼叫這個函式
window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  state.player = new YT.Player("player", {
    height: "180",
    width: "320",
    videoId: state.videoId || "dQw4w9WgXcQ",
    playerVars: {
      playsinline: 1,
      enablejsapi: 1,
      origin: typeof window !== "undefined" ? window.location.origin : undefined,
    },
    events: {
      onReady: () => {
        state.ready = true;
        loadVideoByIdIfReady();
        if (els.debugText) {
          els.debugText.textContent += `\nYouTube Player ready，videoId=${state.videoId}`;
        }
      },
    },
  });
};

function findBeatIndex(currentTime, beats) {
  if (!beats || beats.length === 0) return -1;
  // 線性掃描即可，beats 數量不算巨大；之後如需優化可改為二分搜尋
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
  const inDancePhase = phase === "dance";

  if (els.currentTimeText) {
    els.currentTimeText.textContent = `${currentTime.toFixed(2)} s`;
  }
  if (els.beatIndexText) {
    els.beatIndexText.textContent = String(beatIndex);
  }
  if (els.beatNumberText) {
    els.beatNumberText.textContent = String(beatNumber);
  }
  if (els.barIndexText) {
    els.barIndexText.textContent = beatNumber
      ? String(barIndex + 1)
      : "0";
  }
  if (els.poseIdText) {
    els.poseIdText.textContent =
      action && inDancePhase ? action.poseId : "（無）";
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
}

async function main() {
  initDomRefs();
  if (els.modeSelect) {
    state.mode = els.modeSelect.value === "hard" ? "hard" : "easy";
  }
  if (els.loadVideoButton) {
    els.loadVideoButton.addEventListener("click", () => {
      const raw = els.videoUrlInput ? els.videoUrlInput.value : "";
      const id = extractVideoId(raw);
      if (!id) {
        if (els.debugText) {
          els.debugText.textContent += `\n無法從輸入取得 videoId。`;
        }
        return;
      }
      state.videoId = id;
      state.lastLoadedVideoId = null;
      loadVideoByIdIfReady();
      if (els.debugText) {
        els.debugText.textContent += `\n已載入影片 videoId=${id}`;
      }
    });
  }

  if (els.modeSelect) {
    els.modeSelect.addEventListener("change", async () => {
      state.mode = els.modeSelect.value === "hard" ? "hard" : "easy";
      try {
        await loadAppleJson();
        state.lastLoadedVideoId = null;
        loadVideoByIdIfReady();
      } catch (err) {
        if (els.debugText) {
          els.debugText.textContent = String(err);
        }
      }
    });
  }
  try {
    await loadAppleJson();
    // API 可能比 apple.json 先就緒：補載正確 videoId
    loadVideoByIdIfReady();
  } catch (err) {
    if (els.debugText) {
      els.debugText.textContent = String(err);
    }
  }
  updateUiLoop();
}

main();

