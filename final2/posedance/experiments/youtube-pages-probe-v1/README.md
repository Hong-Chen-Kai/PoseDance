# YouTube 本機／GitHub Pages 對照頁

僅使用官方 IFrame Player API；沒有 SMPL、動畫、攝影機、音訊擷取或新套件。載入時 origin 使用真實 `location.origin`；HTML referrer policy 保留跨來源網站識別。不修改或冒用其他網站的來源。

待發布檔案只有本目錄的 `index.html` 與本 README。遠端倉庫為 `Hong-Chen-Kai/PoseDance`，已讀取的 master head 為 `8d66454579913e3e8ff2607fd181a6dc93f0d3be`；推送前須重新核對。既有公開頁 `/PoseDance/final2/posedance/posedanceTest.html` 回應200；網站根目錄404不代表Pages未啟用。

預定遠端路徑：`final2/posedance/experiments/youtube-pages-probe-v1/index.html`。

**尚未推送／發布**，預定公開網址為：

https://hong-chen-kai.github.io/PoseDance/final2/posedance/experiments/youtube-pages-probe-v1/

人工對照：在本機與公開頁各測 `M7lc1UVf-VE`、`PBwAxmrE194`。先按載入、再播放；記錄網址、日期、瀏覽器、code、rawState、timeSeconds、是否實際聽到／看到影片。官方示例是環境控制組，不是舞曲配對。

每個環境分別記錄，不預先推定部署會成功或失敗。保留150/101/153原碼。停止時確認iframe移除及聲音停止；頁面不自動載入任何YouTube資源。

既有Node白名單SMPL播放器不能直接當成GitHub Pages靜態網站搬移；此頁僅用於先釐清YouTube環境差異。
