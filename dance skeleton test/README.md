# PoseDance｜dance skeleton test

十舞風自然持續分支展示。選擇舞風 → 選擇本機音樂或「使用測試音」 → 播放。可暫停、繼續、重播、停止、Seek，以及人體／骨架切換。舞者沿正式合法Graph持續編舞，直到音樂結束或使用者停止。歌曲僅於瀏覽器內讀取，不上傳。

線上入口：https://hong-chen-kai.github.io/PoseDance/dance%20skeleton%20test/

請使用支援WebGL、Web Crypto、DecompressionStream的新版Chrome／Edge。需連線下載Three.js模組與動作區塊；初次載入可能需要等待。來源區塊按需載入，RAM Cache最多四塊；以content hash命名的動作檔可由瀏覽器磁碟快取重用。

## 本機啟動

從儲存庫根目錄執行：

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

開啟 http://127.0.0.1:8080/dance%20skeleton%20test/ 。請勿直接雙擊HTML使用file協定。

## 範圍

此版沿用十舞風已正式登錄的Graph、Seed及已接受接縫；不是全舞風BPM跟拍完成版。來源、授權及已知限制見[ATTRIBUTION.md](ATTRIBUTION.md)。原本研究工作區、私有音樂與模型檔不包含在本資料夾。

## 無損資料格式

`.xbgz`只減少傳輸大小，不改動畫數值：保留原64-byte AISTSG01/v5 header，各vertices/joints/root陣列按影格做uint32 XOR差分，body重排為四個位元組平面後gzip。瀏覽器先解gzip、還原位元組排列與XOR，再使用原SHA-256及逐幀hash驗證、原Worker解碼。每個區塊均在發布前反解核對原bytes，無重取樣、無Forward、無新增動作幀。
