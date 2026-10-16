# 跨裝置同步準備清單（未部署）

## 已完成的開發準備

- 本機核心只在成功打卡後執行；QR 寫入、Firebase 與 Google Sheets 原流程不等待智慧功能。
- `functions/src/v4-attendance-service.js` 以可信任 principal 模擬跨裝置補卡、版本衝突、追加式稽核與交接提醒去重。
- 補卡只保留追加 revision；原始打卡來源 ID 不可改寫。
- 交接回覆只含固定提醒文字與不透明 candidate ID；多人、到期、案場或哨點不一致一律略過。
- `firebase/v4-database.rules.json` 為預設拒絕的範本，尚未部署。

## 正式接入前必須另行核准

1. Firebase Auth 的可信任同仁身分綁定方式；不得只憑員工編號。
2. Cloud Functions／受控後端與正式 Rules 的完整 Emulator 回歸；不得整份覆蓋既有 Rules。
3. v4 資料路徑、保留期限、幹部月底查詢範圍及稽核權限。
4. 是否需要 Blaze、Cloud Scheduler 或其他付費服務；未核准前不得啟用。
5. 實機雙手機測試：交接、換手機補卡、撤銷授權、離線補傳與月底核對。

## 上線後的最小資料流

`已驗證同仁 → 受控後端 → v4 補卡／交接候選 → 最小權限查詢 → 既有幹部月底核對`

前端不可直接讀寫 v4 出勤案件；正式原始打卡、Firebase 現有路徑與 Google Sheets 不由此流程覆寫。
