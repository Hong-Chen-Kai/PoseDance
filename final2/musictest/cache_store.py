"""依 key 快取 rhythm JSON，避免同歌重複分析。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"


def _safe_key(key: str) -> str:
    s = re.sub(r"[^\w.\-]+", "_", key.strip())
    return s[:180] if s else "unknown"


def cache_path(key: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{_safe_key(key)}.json"


def load_cache(key: str) -> Optional[dict[str, Any]]:
    path = cache_path(key)
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data["cached"] = True
            return data
    except (OSError, json.JSONDecodeError):
        return None
    return None


def save_cache(key: str, data: dict[str, Any]) -> Path:
    path = cache_path(key)
    payload = dict(data)
    payload["cached"] = False
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path
