"""
命令列快速測試（不必先開 API）。

用法（建議在 Docker 容器內）：
  docker compose run --rm musictest python analyze_cli.py path /app/uploads/歌.wav

  # YouTube（需 yt-dlp；映像已含 ffmpeg）
  docker compose run --rm musictest python analyze_cli.py youtube Gb8AZbpnzy4
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from analyze import analyze_audio_file, result_to_dict
from cache_store import load_cache, save_cache
from youtube_audio import download_audio, extract_video_id


def main() -> int:
    parser = argparse.ArgumentParser(description="Essentia 節奏分析 CLI（musictest）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_path = sub.add_parser("path", help="分析本機音檔")
    p_path.add_argument("audio", type=str, help="音檔路徑")
    p_path.add_argument("--video-id", type=str, default=None)
    p_path.add_argument("--offset", type=float, default=0.0)
    p_path.add_argument("--force", action="store_true")
    p_path.add_argument(
        "--method",
        choices=("multifeature", "degara"),
        default="multifeature",
    )

    p_yt = sub.add_parser("youtube", help="下載 YouTube 音訊後分析")
    p_yt.add_argument("url_or_id", type=str)
    p_yt.add_argument("--offset", type=float, default=0.0)
    p_yt.add_argument("--force", action="store_true")
    p_yt.add_argument(
        "--method",
        choices=("multifeature", "degara"),
        default="multifeature",
    )

    args = parser.parse_args()

    if args.cmd == "path":
        audio = Path(args.audio)
        cache_key = args.video_id or f"local_{audio.stem}"
        if not args.force:
            cached = load_cache(cache_key)
            if cached:
                print(json.dumps(cached, ensure_ascii=False, indent=2))
                print(f"\n[cache hit] key={cache_key}", file=sys.stderr)
                return 0
        result = analyze_audio_file(
            audio,
            video_id=args.video_id,
            offset_sec=args.offset,
            source="local",
            method=args.method,
        )
    else:
        video_id = extract_video_id(args.url_or_id)
        if not video_id:
            print("無法解析 videoId", file=sys.stderr)
            return 2
        cache_key = video_id
        if not args.force:
            cached = load_cache(cache_key)
            if cached:
                print(json.dumps(cached, ensure_ascii=False, indent=2))
                print(f"\n[cache hit] key={cache_key}", file=sys.stderr)
                return 0
        vid, audio_path = download_audio(args.url_or_id)
        result = analyze_audio_file(
            audio_path,
            video_id=vid,
            offset_sec=args.offset,
            source="youtube",
            method=args.method,
        )

    data = result_to_dict(result)
    save_cache(cache_key, data)
    print(json.dumps(data, ensure_ascii=False, indent=2))
    print(
        f"\n[ok] bpm={data['bpm']:.2f} beats={len(data['beats'])} "
        f"confidence={data['confidence']:.3f} cache_key={cache_key}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
