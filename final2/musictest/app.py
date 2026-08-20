"""
musictest FastAPI：Essentia 節奏預分析服務。

啟動：docker compose up --build（見 DOCKER.md）
測試頁：http://127.0.0.1:8000/
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from analyze import analyze_audio_file, result_to_dict
from cache_store import load_cache, save_cache
from schemas import AnalyzeLocalRequest, AnalyzeYoutubeRequest, RhythmResult
from youtube_audio import download_audio, extract_video_id

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
UPLOAD_DIR = ROOT / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="posedance musictest",
    description="後端預分析：Essentia → bpm / beats[] JSON（供 YouTube 時間軸對拍）",
    version="0.1.0",
)

# 開發期允許 posedance 前端跨 origin 呼叫
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", include_in_schema=False)
def ui_home() -> FileResponse:
    """第一次前後端測試頁（JS fetch → Python API）。"""
    index = WEB_DIR / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=404, detail="找不到 web/index.html")
    return FileResponse(index)


# 靜態資源（之後若加 css/js 檔可用 /static/...）
if WEB_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/health")
def health() -> dict[str, Any]:
    essentia_ok = False
    essentia_version = None
    try:
        import essentia  # type: ignore

        essentia_ok = True
        essentia_version = getattr(essentia, "__version__", "unknown")
    except ImportError:
        pass
    return {
        "ok": True,
        "service": "musictest",
        "essentia": essentia_ok,
        "essentiaVersion": essentia_version,
        "engine": "essentia",
        "deployHint": "docker compose up --build（見 DOCKER.md）",
        "pythonHint": "container: Python 3.10 + pip essentia",
    }


def _serve_or_compute(
    cache_key: str,
    *,
    force: bool,
    compute,
) -> dict[str, Any]:
    if not force:
        cached = load_cache(cache_key)
        if cached is not None:
            return cached
    try:
        result: RhythmResult = compute()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ImportError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 — 回傳分析錯誤細節供除錯
        raise HTTPException(status_code=500, detail=str(e)) from e
    data = result_to_dict(result)
    save_cache(cache_key, data)
    data["cached"] = False
    return data


@app.post("/analyze/local")
def analyze_local(body: AnalyzeLocalRequest) -> dict[str, Any]:
    path = Path(body.path)
    cache_key = body.video_id or f"local_{path.stem}"

    def compute() -> RhythmResult:
        return analyze_audio_file(
            path,
            video_id=body.video_id,
            offset_sec=body.offset_sec,
            source="local",
        )

    return _serve_or_compute(cache_key, force=body.force, compute=compute)


@app.post("/analyze/youtube")
def analyze_youtube(body: AnalyzeYoutubeRequest) -> dict[str, Any]:
    video_id = extract_video_id(body.url_or_id)
    if not video_id:
        raise HTTPException(status_code=400, detail="無法解析 YouTube videoId")
    cache_key = video_id

    def compute() -> RhythmResult:
        vid, audio_path = download_audio(body.url_or_id)
        return analyze_audio_file(
            audio_path,
            video_id=vid,
            offset_sec=body.offset_sec,
            source="youtube",
        )

    return _serve_or_compute(cache_key, force=body.force, compute=compute)


@app.post("/analyze/upload")
async def analyze_upload(
    file: UploadFile = File(...),
    video_id: str | None = Form(default=None),
    offset_sec: float = Form(default=0.0),
    force: bool = Form(default=False),
) -> dict[str, Any]:
    suffix = Path(file.filename or "audio.bin").suffix or ".wav"
    cache_key = video_id or f"upload_{Path(file.filename or 'audio').stem}"

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=UPLOAD_DIR)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        def compute() -> RhythmResult:
            return analyze_audio_file(
                tmp_path,
                video_id=video_id,
                offset_sec=offset_sec,
                source="local",
            )

        return _serve_or_compute(cache_key, force=force, compute=compute)
    finally:
        # 上傳暫存可刪；分析結果已在 cache/
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


@app.get("/rhythm/{key}")
def get_rhythm(key: str) -> dict[str, Any]:
    data = load_cache(key)
    if data is None:
        raise HTTPException(status_code=404, detail=f"快取不存在：{key}")
    return data
