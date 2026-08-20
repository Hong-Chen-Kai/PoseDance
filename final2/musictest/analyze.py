"""
使用 Essentia RhythmExtractor2013 產出 bpm + beats[]。

注意：此模組只寫 Python，不需撰寫 C++。
安裝：Linux／Docker 內 pip install essentia（見 Dockerfile）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from schemas import RhythmResult


def _import_essentia():
    try:
        import essentia.standard as es  # type: ignore
        import essentia  # type: ignore

        return es, getattr(essentia, "__version__", "unknown")
    except ImportError as e:
        raise ImportError(
            "找不到 essentia（節奏分析引擎）。\n"
            "碩論主線請用 Docker 啟動（容器內為 Linux，可裝 Essentia）：\n"
            "  cd final2/musictest\n"
            "  docker compose up --build\n"
            "然後開 http://127.0.0.1:8000/health 確認 \"essentia\": true\n"
            "說明見 DOCKER.md。"
        ) from e


def analyze_audio_file(
    path: str | Path,
    *,
    video_id: Optional[str] = None,
    offset_sec: float = 0.0,
    source: str = "local",
    method: str = "multifeature",
) -> RhythmResult:
    """
    對單一音檔做節奏分析。

    method:
      - multifeature：較準、較慢（預設，古典／爵士較建議）
      - degara：較快；confidence 可能為 0
    """
    es, version = _import_essentia()
    audio_path = Path(path).resolve()
    if not audio_path.is_file():
        raise FileNotFoundError(f"音檔不存在：{audio_path}")

    # RhythmExtractor2013 文件要求輸入約 44100 Hz
    audio = es.MonoLoader(filename=str(audio_path), sampleRate=44100)()
    duration = float(len(audio) / 44100.0) if len(audio) else 0.0

    extractor = es.RhythmExtractor2013(method=method)
    bpm, beats, confidence, estimates, bpm_intervals = extractor(audio)

    beat_list = [float(t) for t in beats]
    extras: dict[str, Any] = {
        "essentiaVersion": str(version),
        "estimatesCount": int(len(estimates)) if estimates is not None else 0,
        "bpmIntervalsCount": int(len(bpm_intervals)) if bpm_intervals is not None else 0,
    }

    return RhythmResult(
        videoId=video_id,
        source=source if source in ("local", "youtube") else "local",
        sourcePath=str(audio_path),
        bpm=float(bpm),
        beats=beat_list,
        confidence=float(confidence),
        offsetSec=float(offset_sec),
        durationSec=duration,
        engine="essentia",
        method=method,
        cached=False,
        extras=extras,
    )


def result_to_dict(result: RhythmResult) -> dict[str, Any]:
    return result.model_dump()
