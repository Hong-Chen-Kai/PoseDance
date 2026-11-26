# 資料來源、授權與修改說明

本測試頁僅提供已產出的SMPL-Body三維動畫、骨架及PoseDance編舞資料。沒有SMPL-Model參數（shape blendshapes、模型NPZ/PKL或Forward工具）、AIST原始影片與官方音樂。

## AIST++動作標註

Copyright Google LLC。動作標註為CC BY 4.0，官方來源：https://google.github.io/aistplusplus_dataset/factsfigures.html 。授權：https://creativecommons.org/licenses/by/4.0/ 。引用：Ruilong Li, Shan Yang, David A. Ross, Angjoo Kanazawa, “AI Choreographer: Music Conditioned 3D Dance Generation with AIST++”, ICCV 2021。

本展示的修改包括：片段裁切、座標配準、轉場混合、局部動作修正及Graph編排。各舞風原始序列ID、半開範圍與原正式Graph/Registry/人工紀錄SHA見各`*-qualification.json`與`*-graph.json`。動畫播放保持來源60 FPS；未在本次發布新增Forward或接縫。

原始動作影片資料庫：AIST Dance Video Database，https://aistdancedb.ongaaccel.jp/ 。Shuhei Tsuchida, Satoru Fukayama, Masahiro Hamasaki, Masataka Goto, “AIST Dance DB”, ISMIR 2019。原始影片與歌曲不隨此展示重新散布，其條款與AIST++標註授權不同。

## SMPL-Body

SMPL-Body character animation courtesy of the Max Planck Institute for Intelligent Systems。此頁為輸出mesh頂點與骨架，不提供SMPL-Model。SMPL-Body官方授權：https://smpl.is.tue.mpg.de/license.html ，CC BY 4.0：https://creativecommons.org/licenses/by/4.0/ 。引用：Matthew Loper, Naureen Mahmood, Javier Romero, Gerard Pons-Moll, Michael J. Black, “SMPL: A Skinned Multi-Person Linear Model”, ACM Transactions on Graphics, 2015。

## 播放程式與其他元件

PoseDance展示程式沿用專案的Rolling Graph、Reader、Worker、Cache、音樂時鐘與Three.js顯示層；公開版增加相對路徑、靜態來源池讀取與無損封裝。Three.js 0.170.0由esm.sh載入，Three.js採MIT授權：https://github.com/mrdoob/three.js/blob/r170/LICENSE 。不代表Google、AIST或Max Planck背書本系統。此處資料授權不替代使用者自選歌曲的權利。

## 1126公開版與已知限制

本版沿用十舞風各自正式BPM資格及時間Adapter，60至130 BPM可輸入任意整數或小數；Popping使用Graph4.0.0的S/U/C3/C4/C6。新增的是靜態相對路徑、既有無損封裝及YouTube主時鐘整合；未重新生成動畫、變更姿態、降低精度或改動原60FPS。

來源、Graph/Registry與條件資格引用見STYLE_REGISTRY.json；原始SHA與公開移除本機路徑後的SHA分開記錄。保留CONTACT_UNVERIFIED與BEAT_PHASE_ALIGNMENT_UNVERIFIED。一般歌曲自然度不代表全面驗收；YouTube API內容時間同步不等於實體影音延遲量測。House多來源收尾僅限100至117 BPM，其他範圍保留合格CutLoop與安全EOF。Popping保留S樞紐重複性、C2未接受及排除；Breaking現有選段不涵蓋所有地板或手撐技術。其他各舞風既有視覺限制仍有效。

YouTube影片使用官方IFrame API串流，不下載或重新散布其影音；影片權利屬各權利人，播放器仍受可嵌入性、廣告及地區限制。API來源：https://developers.google.com/youtube/iframe_api_reference 。本研究展示不表示Google、AIST或Max Planck背書，也不授予SMPL-Model再散布或商用權利。原始SMPL模型、shape blendshapes、regressors、weights、PKL、NPZ、原始影片與歌曲均不隨本頁提供。
