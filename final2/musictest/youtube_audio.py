"""使用 yt-dlp 將 YouTube 音訊下載到暫存目錄。"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

ROOT = Path(__file__).resolve().parent
TMP_DIR = ROOT / "tmp"


_VIDEO_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")


def extract_video_id(url_or_id: str) -> Optional[str]:
    s = (url_or_id or "").strip()
    if not s:
        return None
    if _VIDEO_ID_RE.match(s):
        return s
    # youtu.be/xxxxxxxxxxx
    m = re.search(r"youtu\.be/([a-zA-Z0-9_-]{11})", s)
    if m:
        return m.group(1)
    m = re.search(r"[?&]v=([a-zA-Z0-9_-]{11})", s)
    if m:
        return m.group(1)
    m = re.search(r"youtube\.com/embed/([a-zA-Z0-9_-]{11})", s)
    if m:
        return m.group(1)
    m = re.search(r"youtube\.com/shorts/([a-zA-Z0-9_-]{11})", s)
    if m:
        return m.group(1)
    return None


def download_audio(url_or_id: str) -> Tuple[str, Path]:
    """
    下載最佳音訊並轉成 wav（若系統有 ffmpeg）。
    回傳 (videoId, wav_or_audio_path)。
    """
    video_id = extract_video_id(url_or_id)
    if not video_id:
        raise ValueError(f"無法解析 YouTube videoId：{url_or_id!r}")

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(TMP_DIR / f"{video_id}.%(ext)s")

    # 優先轉 wav 方便 Essentia MonoLoader；無 ffmpeg 時仍保留原格式
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "-x",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        out_tmpl,
        "--",
        f"https://www.youtube.com/watch?v={video_id}",
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        # 無 ffmpeg 時改下載原始音訊檔
        cmd_fallback = [
            sys.executable,
            "-m",
            "yt_dlp",
            "-f",
            "bestaudio/best",
            "--no-playlist",
            "-o",
            out_tmpl,
            "--",
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            subprocess.run(cmd_fallback, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as e2:
            detail = (e2.stderr or e.stderr or str(e2))[-2000:]
            raise RuntimeError(
                "yt-dlp 下載失敗。請確認已安裝 yt-dlp，"
                "並建議安裝 ffmpeg 以便轉成 wav。\n" + detail
            ) from e2

    candidates = sorted(
        TMP_DIR.glob(f"{video_id}.*"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    # 略過 .part / .ytdl
    audio_path = next(
        (
            p
            for p in candidates
            if p.suffix.lower()
            in {".wav", ".mp3", ".m4a", ".webm", ".opus", ".ogg", ".flac", ".aac"}
        ),
        None,
    )
    if audio_path is None or not audio_path.is_file():
        raise FileNotFoundError(f"下載後找不到音檔：{video_id}")

    return video_id, audio_path
