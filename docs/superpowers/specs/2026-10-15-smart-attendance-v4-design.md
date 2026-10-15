# 智慧打卡 4.0 設計規格

## 目標與範圍

在不影響既有 QR 打卡、洋基哨點、Firebase／Google Sheets 背景同步、補卡、報表及歷史資料的前提下，新增可測試的智慧勤務、交接、補卡與提醒能力。所有新增使用者文字一律使用「同仁」。本設計支援未來約 500 位同仁，但第一階段不建立完整排班系統。

本分支只開發、測試與建立 PR；不得合併 main、部署正式 Firebase／Functions、修改正式 Rules、啟用 Blaze、發送真實推播，或修改／刪除既有正式打卡資料。

## 不可違反的邊界

- QR 打卡維持本機先成功、Firebase／Sheets 背景補傳；新功能不得進入其同步等待路徑。
- 原始 QR 打卡不可覆寫或刪除。預測、交接、同仁確認、主管核准與補登必須有不同來源與稽核事件。
- 預測只用於提醒、候選與分析；不可成為正式下班卡、薪資或加班依據。
- 接班同仁不替上一班確認下班；互助提醒不形成責任或懲處。
- 不使用 LINE、簡訊、原生 App 或前端保存任何私鑰／服務端密鑰。

## 相容策略與資料權威

既有 `punches/{date}/{timestamp}`、localStorage `local_records` 和 Sheets「打卡紀錄」保持原樣，供現有後台、月報與補傳流程使用。v4 另建新資料層；它只讀取既有打卡事件來建立投影，不會回寫既有事件。

Firebase v4 是跨裝置作業狀態的權威資料來源；Sheets v4 是可稽核的報表／封存投影。前端只可讀取授權範圍，所有案件狀態轉移、訂閱、排程、推播與權限判斷最後由受控 Functions 驗證。正式 Rules 與 Functions 部署不在本分支執行。

### v4 資料集合

| 路徑／工作表 | 用途與不可變欄位 |
| --- | --- |
| `v4/duties/{dutyId}`／勤務投影 | `empId`、`siteId`、`postName`、`startEventId`、`endEventId`、`startedAt`、`endedAt`、`status`、`sourceRecordIds`、`version`。由原始打卡建構，不修改原始卡。 |
| `v4/handoverCandidates/{candidateId}`／交接候選 | `siteId`、`postName`、`fromDutyId`、`toDutyId`、`window`、`confidence`、`status`、`createdAt`、`expiresAt`。狀態為 `proposed/acknowledged/dismissed/resolved/expired`。 |
| `v4/makeupCases/{caseId}`／智慧補卡案件 | `dutyId`、`empId`、候選時間與來源、交接證據、`status`、`idempotencyKey`、`version`。狀態為 `detected/draft/requested/employee_confirmed/supervisor_review/approved/rejected/cancelled/expired/applied`。 |
| `v4/amendments/{amendmentId}`／追加式補卡稽核 | `caseId`、`targetDutyId`、`effectiveAt`、`reason`、`actorId`、`approvedBy`、`approvedAt`、`source`、`createdAt`。只新增，不覆寫原始卡。 |
| `v4/reminderProfiles/{empId}` 與 `v4/reminderJobs/{jobId}` | 5-3-3 狀態、可比較勤務統計、去重鍵、租約、取消與發送結果。 |
| `v4/pushSubscriptions/{deviceId}` 與 `v4/deliveries/{deliveryId}` | 經授權的裝置訂閱、端點雜湊、授權／撤銷時間、每裝置送達結果；私密訂閱金鑰不可公開讀取。 |
| `v4/auditEvents/{auditId}` | 每個狀態轉移的 actor、時間、原因、請求與版本，僅受控服務可寫入。 |

舊覆寫式補卡保留讀取相容；新的智慧補卡只建立 `amendment`。正式報表在後續受控投影中只採用已 `applied` 的核准 amendment，並以 `caseId + amendmentId` 去重，避免與原始卡重複計算。

## 勤務配對與預測

新增純函式勤務配對器，依 `empId + siteId + postName` 和 Asia/Taipei 時間順序配對；同一打卡事件最多使用一次。配對不再以同一日曆日分組，必須支援跨日、跨月、跨年、同日多班與設定允許的 24 小時勤務。

輸出勤務狀態：`complete`、`missing_in`、`missing_out`、`duplicate`、`ambiguous`。未知班別、衝突或資料不足必須是 `ambiguous`／待確認，不能自動補卡。月份與報表歸屬以勤務上班的台灣本地日期決定。

預測只以最近 60 天完整且可比較勤務訓練，優先匹配同仁、案場、哨點、相近上班時段與星期特性；使用中位數和離散度，不用易受異常影響的平均數。高可信度至少有 5 筆集中樣本；中、低可信度均不安排自動推播。每次完成勤務才更新摘要，避免打卡時掃描全公司歷史。

## 智慧交接與同仁互助

接班同仁的上班卡成功後，以目前案場、哨點及時間窗查詢少量未結束勤務候選。不同案場或不同哨點不可配對；多人重疊、代班不明或時間窗外只能呈現一般提醒或不提醒。

符合條件時，畫面只顯示一次「交接班貼心提醒」與最小必要資訊，不公開其他同仁的工號、完整姓名、精確出勤時間、補卡原因或其他案場資料。按下已閱讀、對象不符、稍後處理只更新候選稽核狀態，不改變上一班勤務或正式下班卡。已下班、已駁回、已過期或已顯示的事件均不可重複出現。

## 智慧補卡

未結束勤務先建立待確認補卡案件而非打卡。候選時間分開保存為歷史預測、接班時間、交接證據、同仁確認與主管核實；它們不可互相偽裝。下一次本人上班成功後，才可看到前次案件的一鍵確認、修改時間或稍後處理，且不阻擋本次打卡。

只有案件本人可確認；主管僅可處理所授權案場；管理員才可看全域統計。核准與套用是分離且可安全重試的狀態，任何重送、並發或既有下班卡出現都不能產生兩筆補登。所有轉移以版本與 deterministic idempotency key 保護。

## 5-3-3 與 PWA Web Push

提醒狀態在雲端保存：新加入者在前 5 個正常完成的勤務每班提醒一次；之後每 3 個實際勤務提醒一次；經主管確認漏下班後，進入 3 個正常勤務的修復期，再回維持期。休假不計數，待確認案件不算漏卡；每個勤務最多一次。

推播只在預測高可信度、預測下班前 10 分鐘、尚未下班、訂閱有效且未取消時產生。job 使用 `ruleVersion|dutyId|stage` 去重鍵、交易租約與 per-device delivery 紀錄；排程重跑、裝置重複登入或暫時失敗不得重複打擾。410／404 端點即撤銷；過期提醒不補送。

前端使用標準 Notification、Push API 和 Service Worker `push`／`notificationclick`。iPhone 僅限 iOS/iPadOS 16.4+、Safari 加入主畫面的 PWA，且必須由同仁點擊授權。前端提供開啟、狀態、測試和停用；不支援或拒絕時顯示說明，不影響打卡。站內提醒只在網站開啟且尚未產生同勤務推播時顯示。

Functions 使用 Node、Admin SDK 與 `web-push`，VAPID 私鑰放 Functions Secret Manager；本分支只提供本機／emulator 模擬 sender。排程、Cloud Scheduler、秘密與正式部署都需另行核准，且可能需要 Firebase Blaze。

## 權限、隱私與效能

訂閱裝置不可只憑員工編號綁定；需以 Firebase Auth 與伺服端一次性綁定挑戰驗證，產生不可猜的 `deviceId`。用戶端不得直接寫入 subscriptions、reminder jobs、deliveries、amendments 或 audit events。新 Rules 必須預設拒絕，僅允許各角色讀取必要範圍；沒有 `siteId` 的舊資料不得作為交接資料展示給幹部。

交接依 site/post/time 建索引；勤務與提醒以增量摘要更新；排程以到期候選與租約處理。目標是在 500 人與網路延遲、重送、離線補傳、併發打卡下維持冪等，且不在 QR 打卡時載入全歷史。

## 測試與驗收

- 單元：跨日／跨月／跨年、24 小時、同日多班、重複與歧義勤務；預測可信度；5-3-3 狀態與提醒去重。
- 整合：同／不同哨點交接、多人重疊、跨裝置一次性提醒、補卡狀態轉移、案場權限、原始卡不變與 amendment 報表投影。
- Push 模擬：授權狀態、失效端點、已下班取消、排程重跑、同仁多裝置、fake sender 送達紀錄；不得接觸正式同仁或端點。
- 回歸：既有 Node 可靠性測試與本機瀏覽器冒煙測試；QR、洋基哨點、Firebase／Sheets 背景同步、臨時人員、月報均保持通過。
- 效能：以合成 500 人資料驗證配對、摘要與候選查詢；結果只描述實測值，不宣稱未驗證的節省比例。

## 分期交付

1. P0：純函式勤務配對、資料來源分層、append-only 基礎與回歸測試。
2. P1：交接候選、同仁互助提醒、隱私與冪等測試。
3. P2：智慧補卡案件、一鍵確認、主管審核、有效出勤投影與權限測試。
4. P3：預測、5-3-3、PWA 推播介面與 Functions emulator 模擬。
5. P4：500 人效能、統計儀表板、完整驗收文件。

每期都維持可測試，且不部署正式環境。若實際 Rules、Functions、Cloud Scheduler、VAPID 秘密或 Blaze 啟用需要變更，必須在部署前另取得管理者核准。
