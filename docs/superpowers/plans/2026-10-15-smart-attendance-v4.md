# 智慧打卡 4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改變既有 QR 打卡熱路徑與正式雲端資料的前提下，交付可測試的智慧勤務、交接、補卡、5-3-3 與 PWA 推播模擬。

**Architecture:** 以瀏覽器與 Node 共用的純函式 `smart-attendance-v4.js` 建立勤務、交接、補卡與提醒決策；`index.html` 僅在既有打卡成功後非阻塞呼叫。v4 Firebase／Functions 只提供本機模擬程式與部署範本，正式資料、Rules、Secrets 與排程都不部署。

**Tech Stack:** Vanilla JavaScript、Node built-in test、Playwright、Firebase Functions Node runtime（僅原始碼／模擬）、標準 PWA Push API。

**Spec:** `docs/superpowers/specs/2026-10-15-smart-attendance-v4-design.md`

## Global Constraints

- 既有 QR、洋基哨點、Firebase／Sheets 背景同步、臨時人員與報表不得等待或依賴 v4。
- 新增 UI 一律以「同仁」稱呼；不可從姓名推測性別。
- 原始打卡不可刪除或覆寫；預測永遠不可作為正式出勤。
- 不使用 LINE、簡訊或原生 App；不得提交 VAPID 私鑰或任何密鑰。
- 不部署、不改正式 Firebase Rules／資料、不啟用 Blaze、不發送真實推播。
- 所有日期時間依 Asia/Taipei 處理；沒有 siteId 的舊紀錄不得作為幹部交接資訊。

## Review Focus

- 兩筆同 timestamp 但不同同仁的紀錄不可因舊 timestamp 合併邏輯遺失；Task 1 加入事件 ID 與配對測試。
- 同日雙班與跨日班不得交叉配對；Task 1 以事件唯一使用權測試。
- 接班提醒不得洩漏另一位同仁的工號、完整姓名或精確時間；Task 2 驗證最小化 view model。
- 補卡確認、核准、套用重送或併發時不得產生兩筆有效 amendment；Task 3 驗證版本與冪等鍵。
- 已下班、失效訂閱、排程重跑及多裝置不得送出重複推播；Task 5 驗證 job/delivery 狀態機。

---

### Task 1: 建立勤務配對與可解釋預測核心

**Files:**
- Create: `smart-attendance-v4.js`
- Create: `tests/smart_attendance_v4.test.js`
- Modify: `index.html`（載入共用核心，不改現有打卡流程）

**Interfaces:**
- Produces `SmartAttendanceV4.buildDutyPairs(records, options)`, `buildDutySummary(duties)`, `predictDutyEnd(duties, duty, options)`。
- `Duty` 具 `dutyId`, `sourceRecordIds`, `status`, `startedAt`, `endedAt`, `siteId`, `postName` 與不可變原始事件參照。

- [ ] **Step 1: 寫入勤務配對失敗測試**

在 `tests/smart_attendance_v4.test.js` 建立跨日、跨月、24 小時、同日雙班、重複與歧義事件測試；斷言每筆原始事件只被使用一次，且沒有完整配對時不產生正式下班時間。

- [ ] **Step 2: 執行新測試確認失敗**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js`

Expected: FAIL，因核心尚未存在。

- [ ] **Step 3: 實作純函式核心**

在 `smart-attendance-v4.js` 實作 UMD 形式的 `buildDutyPairs(records, {timeZone,maxDutyHours})`、`buildDutySummary(duties)`、`predictDutyEnd(history, duty, options)`。用中位數與離散度形成 high／medium／low 可信度，high 至少五筆可比較完整勤務；不寫入任何 localStorage 或網路。

- [ ] **Step 4: 驗證核心與既有回歸**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js tests/reliability.test.js`

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add smart-attendance-v4.js index.html tests/smart_attendance_v4.test.js
git commit -m "feat: 新增智慧勤務配對與預測核心"
```

### Task 2: 交接候選與非阻塞同仁互助提醒

**Files:**
- Modify: `smart-attendance-v4.js`
- Modify: `index.html`
- Modify: `tests/smart_attendance_v4.test.js`
- Modify: `tests/ui_smoke.py`

**Interfaces:**
- Consumes `Duty[]` from Task 1。
- Produces `buildHandoverCandidates(duties, incomingDuty, options)`, `createHandoverView(candidate, viewer)`, `shouldShowHandoverReminder(candidate, seenKeys)`。

- [ ] **Step 1: 寫入交接與隱私失敗測試**

測試同案場同哨點合理時間窗的候選、不同案場／哨點排除、多人重疊不指定單人、已下班／已看過不顯示，以及員工 view model 不含工號、完整姓名、精確時間與補卡理由。

- [ ] **Step 2: 執行測試確認失敗**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js`

Expected: FAIL，因交接函式尚未存在。

- [ ] **Step 3: 實作候選與提醒**

實作 site/post/time-window 索引查詢與 deterministic `candidateId`；在 `doPunch('上班')` 成功畫面後以非阻塞方式呼叫提醒。新增手機友善 modal，固定文字為「交接班貼心提醒」「您即將接替上一班同仁的勤務。交接完成時，請順便提醒上一班同仁記得完成下班打卡。」；按鈕只記錄本機預覽狀態。

- [ ] **Step 4: 執行單元、UI 與既有回歸**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js tests/reliability.test.js`

Run: `DYS_TEST_URL=http://127.0.0.1:8877/index.html python tests/ui_smoke.py`

Expected: 全部 PASS，且 UI 測試確認上班紀錄先寫入、提醒才顯示。

- [ ] **Step 5: Commit**

```bash
git add smart-attendance-v4.js index.html tests/smart_attendance_v4.test.js tests/ui_smoke.py
git commit -m "feat: 新增智慧交接與同仁互助提醒"
```

### Task 3: 追加式智慧補卡案件與有效出勤投影

**Files:**
- Modify: `smart-attendance-v4.js`
- Modify: `index.html`
- Modify: `Code.gs`
- Modify: `tests/smart_attendance_v4.test.js`
- Modify: `tests/reliability.test.js`

**Interfaces:**
- Produces `createMakeupCase(duty, evidence, now)`, `transitionMakeupCase(case, action, actor, payload)`, `buildEffectiveAttendance(records, amendments)`。
- `Amendment` 必須有 `amendmentId`, `caseId`, `idempotencyKey`, `source`, `createdAt`；不能更改 `records`。

- [ ] **Step 1: 寫入案件狀態機與 append-only 失敗測試**

覆蓋 detected→confirmed／review→approved→applied、非法轉移、本人以外確認、跨案場主管、重送、apply 失敗重試、原始打卡不變與核准 amendment 報表不重複計算。

- [ ] **Step 2: 執行測試確認失敗**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js tests/reliability.test.js`

Expected: FAIL，因狀態機與 v4 容器尚未實作。

- [ ] **Step 3: 實作本機 v4 案件層與 UI**

在核心新增 immutable case／amendment 函式；在成功上班後只對本人顯示待確認案件，提供確認候選、修改實際時間、稍後處理。既有手動補卡保留不變；新增「智慧交接與補卡」後台入口，只顯示角色可見案場的模擬資料與批次核准候選。

- [ ] **Step 4: 新增 Apps Script v4 範本但不接入正式寫入**

在 `Code.gs` 新增明確標示未部署的 v4 append-only helper／資料表標頭常數與測試可執行的去重函式；不得改動既有 `writePunch` 行為或原表資料。

- [ ] **Step 5: 驗證所有補卡與回歸測試**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js tests/reliability.test.js`

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add smart-attendance-v4.js index.html Code.gs tests/smart_attendance_v4.test.js tests/reliability.test.js
git commit -m "feat: 新增追加式智慧補卡案件"
```

### Task 4: 60 天摘要、5-3-3 狀態與 500 人模擬

**Files:**
- Modify: `smart-attendance-v4.js`
- Modify: `tests/smart_attendance_v4.test.js`
- Create: `tests/smart_attendance_v4_performance.js`

**Interfaces:**
- Produces `buildEmployeeHabitSummary(duties, now)`, `advanceReminderProfile(profile, dutyOutcome)`, `shouldScheduleReminder(profile, prediction, duty)`。

- [ ] **Step 1: 寫入 5-3-3 與效能失敗測試**

驗證前五個正常勤務每班提醒、維持期每第三個實際勤務、確認漏卡後三班修復、休假／待確認不計數、低可信度／已下班不排程，以及 500 位合成同仁資料不會在 QR 路徑取全歷史。

- [ ] **Step 2: 執行測試確認失敗**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js`

Expected: FAIL，因提醒狀態函式尚未存在。

- [ ] **Step 3: 實作摘要與規則**

實作只從完整勤務更新的 60 天摘要、狀態機及 deterministic job key `ruleVersion|dutyId|stage`；不得建立實際推播或接觸 Firebase。

- [ ] **Step 4: 執行效能與回歸**

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js tests/reliability.test.js`

Run: `TZ=Asia/Taipei node tests/smart_attendance_v4_performance.js`

Expected: 測試 PASS，腳本輸出資料筆數與實測耗時。

- [ ] **Step 5: Commit**

```bash
git add smart-attendance-v4.js tests/smart_attendance_v4.test.js tests/smart_attendance_v4_performance.js
git commit -m "feat: 新增5-3-3提醒與效能摘要"
```

### Task 5: PWA 通知介面與 Functions 模擬

**Files:**
- Modify: `index.html`
- Modify: `sw.js`
- Create: `functions/package.json`
- Create: `functions/src/reminder-engine.js`
- Create: `functions/src/index.js`
- Create: `functions/test/reminder-engine.test.js`
- Modify: `tests/ui_smoke.py`

**Interfaces:**
- Browser produces `getPushCapability()`, `enablePushReminders()`, `disablePushReminders()`, `sendPushTest()`；使用者手勢才可請求授權。
- Functions produces `evaluateReminderJobs(snapshot, now)`, `claimReminderJob(store, job)`, `deliverReminder(pushClient, job, subscription)`；預設 fake sender。

- [ ] **Step 1: 寫入失敗測試與 Functions 模擬依賴**

建立 Functions 內建 Node test，覆蓋 high-confidence 十分鐘 job、已下班取消、重跑去重、多裝置與 410／404 撤銷；UI 冒煙測試覆蓋不支援、拒絕、已開啟、停用和不自動跳授權。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test functions/test/reminder-engine.test.js`

Expected: FAIL，因 Functions engine 尚未存在。

- [ ] **Step 3: 實作前端 PWA 推播介面**

在 manifest／現有 Service Worker 架構保留 cache 行為下加入 `push` 和 `notificationclick` handler；新增開啟、狀態、測試、停用 UI。測試按鈕在本分支只走本機頁面通知／fake subscription，絕不發送 Web Push。前端僅可使用 VAPID public-key placeholder，無私鑰。

- [ ] **Step 4: 實作 Functions 模擬專案**

建立不含憑證的 Functions 原始碼與 README，使用 in-memory store／fake sender 測 job、lease、delivery、無效端點與取消。保留未部署標記；不得執行 Firebase deploy、Scheduler 或 secret 命令。

- [ ] **Step 5: 驗證 PWA、Functions 與回歸**

Run: `node --test functions/test/reminder-engine.test.js`

Run: `TZ=Asia/Taipei node --test tests/smart_attendance_v4.test.js tests/reliability.test.js`

Run: `DYS_TEST_URL=http://127.0.0.1:8877/index.html python tests/ui_smoke.py`

Expected: 全部 PASS；輸出明確標示僅模擬，未送正式通知。

- [ ] **Step 6: Commit**

```bash
git add index.html sw.js functions tests/ui_smoke.py
git commit -m "feat: 新增PWA推播模擬與提醒引擎"
```

### Task 6: 後台統計、全量驗證與 GitHub Draft PR

**Files:**
- Modify: `index.html`
- Modify: `CHANGELOG.md`
- Modify: `tests/smart_attendance_v4.test.js`
- Create: `docs/smart-attendance-v4-deployment-checklist.md`

**Interfaces:**
- Consumes summaries, cases, jobs and deliveries from Tasks 1–5。
- Produces scope-aware management counts: estimated／confirmed／approved／closed, handover candidates, reminder outcomes, prediction error.

- [ ] **Step 1: 寫入範圍與統計失敗測試**

測試幹部只能看到授權案場、管理員可看全域，及統計不將預測成功率與補卡完成率混合。

- [ ] **Step 2: 實作簡潔後台入口與上線檢核文件**

將「智慧交接與補卡」整合既有今日待處理／異常區，不重做後台；建立部署前核准清單，列出 Rules、Functions、Blaze、VAPID、iPhone 實機測試與資料遷移授權。

- [ ] **Step 3: 執行所有驗證**

Run: `TZ=Asia/Taipei node --test tests/reliability.test.js tests/smart_attendance_v4.test.js functions/test/reminder-engine.test.js`

Run: `TZ=Asia/Taipei node tests/smart_attendance_v4_performance.js`

Run: 啟動本機 HTTP server 後 `DYS_TEST_URL=http://127.0.0.1:<port>/index.html python tests/ui_smoke.py`

Expected: 命令成功，且報告逐項區分實際通過、模擬通過與因外部授權未執行項目。

- [ ] **Step 4: Commit、Push 與 Draft PR**

```bash
git add index.html CHANGELOG.md tests docs
git commit -m "feat: 完成智慧打卡4.0驗收準備"
git push -u origin feature/smart-attendance-v4
gh pr create --draft --base main --head feature/smart-attendance-v4 --title "feat: 智慧打卡4.0第一階段" --body-file <generated-summary>
```

PR 必須列出已完成、模擬限制、測試證據、相容性、500 人實測值與正式部署前核准事項；不可聲稱已部署或已對 iPhone 實機推播。

## Plan Self-Review

- 覆蓋：Task 1 P0 勤務與預測；Task 2 P1 交接；Task 3 P2 append-only 補卡；Task 4 5-3-3 與效能；Task 5 Web Push 模擬；Task 6 後台、文件與 PR。
- 相容性：每個接入點都在原 QR 成功後非阻塞執行，現有 writes 不被改寫。
- 安全：正式 Rules、Secrets、Functions deploy、Blaze 與真實通知均明確排除。
- 邊界：iPhone 真實 Web Push、Rules 部署與 Sheets v4 實表建立是後續管理者核准項，不納入「已通過」結果。
