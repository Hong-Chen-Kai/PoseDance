# PoseDance Web V1 —1126

公開入口：https://hong-chen-kai.github.io/PoseDance/dance%20skeleton%20test/

選擇舞風與60至130之間的整數或小數BPM，貼上允許嵌入的YouTube單支影片網址，按載入影片及開始跳舞。演出設定可選起始秒數與3/5分鐘；人體/24關節骨架、浮動播放器寬高獨立縮放、時間軸及視角控制均保留。

本目錄是純靜態網站，不需Node或本機API；使用支援WebGL、WebCrypto、DecompressionStream的現代Chrome/Edge。Chunk按需無損還原，由原SHA及Worker逐幀驗證；Queue≤8、Cache≤4。

本機預覽可由儲存庫根目錄執行 `python -m http.server 8382 --bind 127.0.0.1`，開啟含本目錄的網址。不要以file協定開啟。Three.js及YouTube需網際網路連線；不提供使用者姿態評分或比較。

來源、授權與限制見[ATTRIBUTION.md](ATTRIBUTION.md)；版本及無損傳輸摘要見RELEASE_1126.json。來源commit847c5b1fafddbf9a39f5ff727029e320324b26c7，本目錄只做靜態部署適配，不代表整套PoseDance最終完成。
