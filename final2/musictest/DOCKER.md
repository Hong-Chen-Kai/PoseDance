# Docker 啟動指南（碩論主線已定）

**定案：** 後台用 **Docker + Python Essentia**；長照現場只開瀏覽器（讀 JSON／打 API），不必裝 Docker。

```text
你的電腦（開發）或日後伺服器
  └─ Docker 跑 musictest（Essentia + FastAPI）
        └─ http://127.0.0.1:8000
長照據點
  └─ 只要瀏覽器（posedance）；不跑分析容器
```

---

## 0. 先裝 Docker Desktop（Windows）

1. 下載安裝 [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
2. 安裝後**重開機**（若有提示）
3. 開啟 Docker Desktop，等到左下角顯示 **Engine running**
4. 開 PowerShell 測試：

```powershell
docker --version
docker compose version
```

> 註：Docker Desktop 在 Windows 常會啟用 WSL2 當引擎。  
> 這是給 Docker 用的，**你不必自己進 Ubuntu 手裝 Essentia**。

---

## 1. 建置並啟動（第一次較久）

```powershell
cd "C:\Users\kai11\Desktop\暨南\dance\final2\musictest"
docker compose up --build
```

第一次會下載 Python 基底映像、用 pip 裝 Essentia，可能要一陣子，屬正常。  
看到類似 `Uvicorn running on http://0.0.0.0:8000` 即成功。

另開瀏覽器：

| 網址 | 預期 |
|------|------|
| http://127.0.0.1:8000/health | `"essentia": true` |
| http://127.0.0.1:8000/ | 中文測試頁 |
| http://127.0.0.1:8000/docs | Swagger |

背景執行（可選）：

```powershell
docker compose up --build -d
```

看日誌：

```powershell
docker compose logs -f
```

停止：

```powershell
docker compose down
```

（在前景模式也可 `Ctrl+C` 再 `docker compose down`）

---

## 2. 測分析（Essentia 應可用）

測試頁選音檔 →「上傳並分析」，或：

```powershell
curl -X POST http://127.0.0.1:8000/analyze/upload -F "file=@D:/music/sample.wav"
```

成功會在專案的 `cache/` 出現 JSON（已掛載到容器外）。

---

## 3. 為什麼一定要用 Docker

| 方式 | Essentia |
|------|----------|
| Windows 本機 pip／conda | ❌ 通常沒有官方 wheel |
| **Docker compose** | ✅ 容器內是 Linux，`pip install essentia` |

開發分析請用 Docker；正式算歌以容器為準。

---

## 4. 常見問題

**Q: `docker` 不是內部或外部命令**  
A: Docker Desktop 沒開或沒裝好；先開 Desktop 等到 Engine running。

**Q: port 8000 被占用**  
A: 關掉本機已開的 `uvicorn`，或改 `docker-compose.yml` 的 `"8001:8000"`。

**Q: 建置失敗／essentia 裝不起來**  
A: 把完整 `docker compose up --build` 錯誤貼出來再查（網路、磁碟空間、Docker 記憶體上限）。

**Q: 長照要裝 Docker 嗎？**  
A: **不要。** Docker 是後台／你的伺服器；據點只開網頁。

---

## 5. 論文／架構怎麼寫（一句）

> 節奏特徵於後端服務以 Essentia 離線萃取（Docker 部署以利重現），前端 posedance 僅依時間軸讀取預先產生之節奏 JSON，降低長照據點端建置成本。
