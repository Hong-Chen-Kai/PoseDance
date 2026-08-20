# posedance musictest — 後台節奏分析（Python Essentia）
# 建置／執行請用 docker compose（見 DOCKER.md）
#
# Essentia 官方在 Linux 用 pip wheel，conda-forge 並無 essentia 套件。

FROM python:3.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# yt-dlp／音檔轉碼需要 ffmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p cache tmp uploads

EXPOSE 8000

# 0.0.0.0：讓主機／其他容器連得進來（不只容器內部）
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
