"""節奏分析 API 的請求／回應模型（對齊 beatTest JSON 精神）。"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class AnalyzeLocalRequest(BaseModel):
    """本機已存在的音檔路徑（開發測試用）。"""

    path: str = Field(..., description="本機音檔絕對或相對路徑（wav/mp3/…）")
    video_id: Optional[str] = Field(
        default=None,
        description="可選；寫入 JSON 的 videoId，便於之後對應 YouTube",
    )
    offset_sec: float = Field(default=0.0, description="與 YT 畫面時間軸校正（秒）")
    force: bool = Field(default=False, description="忽略快取強制重算")


class AnalyzeYoutubeRequest(BaseModel):
    """以 YouTube 網址或 videoId 抽音後分析。"""

    url_or_id: str = Field(..., description="YouTube 網址或 11 碼 videoId")
    offset_sec: float = Field(default=0.0)
    force: bool = Field(default=False, description="忽略快取強制重算")


class RhythmResult(BaseModel):
    """與 posedance / beatTest 對接的節奏結果。"""

    videoId: Optional[str] = None
    source: Literal["local", "youtube"] = "local"
    sourcePath: Optional[str] = None
    bpm: float
    beats: list[float] = Field(default_factory=list, description="拍點時間（秒）")
    confidence: float = Field(
        default=0.0,
        description="Essentia RhythmExtractor2013 信心值（degara 時可能為 0）",
    )
    offsetSec: float = 0.0
    durationSec: Optional[float] = None
    engine: str = "essentia"
    method: str = "multifeature"
    cached: bool = False
    extras: dict[str, Any] = Field(default_factory=dict)
