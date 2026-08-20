# musictest

posedance **節奏預分析**後台（碩論主線）。

```text
Docker（Linux）→ Python Essentia → bpm / beats[] JSON
前端 posedance／測試頁 → 讀 JSON 或打 API
長照據點 → 只開瀏覽器，不必裝 Docker
```

---

## 怎麼跑

詳見 **[DOCKER.md](./DOCKER.md)**。

```powershell
# 1. 安裝並開啟 Docker Desktop（Engine running）
# 2. 在本目錄：
docker compose up --build

# 3. 瀏覽器
# http://127.0.0.1:8000/health   →  "essentia": true
# http://127.0.0.1:8000/         →  測試頁
# http://127.0.0.1:8000/docs     →  API 說明
```

停止：`Ctrl+C` 或 `docker compose down`。

---

## 資料夾（精簡後）

| 路徑 | 用途 |
|------|------|
| `Dockerfile` / `docker-compose.yml` | 容器建置與啟動 |
| `DOCKER.md` | 安裝 Docker、啟動、常見問題 |
| `app.py` | FastAPI（/health、分析、測試首頁） |
| `analyze.py` | Essentia 算 bpm／beats |
| `analyze_cli.py` | 容器內指令列測試（進階） |
| `youtube_audio.py` | yt-dlp 抽音 |
| `cache_store.py` / `schemas.py` | 快取與 JSON 格式 |
| `requirements.txt` | pip 依賴（含 Essentia；在 Docker Linux 內安裝） |
| `web/` | 前後端串接測試頁 |
| `examples/` | JSON 範例 |
| `cache/` `tmp/` `uploads/` | 執行時資料（可清空，留 `.gitkeep`） |

---

## API 摘要

- `GET /health`
- `POST /analyze/upload`
- `POST /analyze/local`
- `POST /analyze/youtube`
- `GET /rhythm/{key}`
