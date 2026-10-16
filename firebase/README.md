# v4 Firebase 安全範本（未部署）

本目錄僅供安全設計審查；**不可直接部署至正式環境**。目前沒有 Firebase 專案綁定、`firebase.json` 或部署流程，也未修改正式 Rules、資料、`index.html` 或 `Code.gs`。新增前已檢查 repository，沒有既有 Firebase Rules 可沿用；repository 沒有檔案不代表正式 Firebase 沒有規則。

`v4-database.rules.json` 是 Realtime Database 的拒絕存取基底，只列出 `/v4/makeupCases`、`/v4/handover`、`/v4/audit`。所有 client（包含已登入及帶管理者 claims 者）的讀取、建立、修改、刪除都拒絕；尚未實作可供前端使用的授權規則。這三個路徑只是本範本的審查範圍，不代表所有 v4 資料路徑已完成設計；現有設計文件提及的 `handoverCandidates`、`auditEvents` 等命名，需在實作接線前統一。

## 權限與服務端責任

- 必須先導入 Firebase Auth，並由受信任的服務端設定 custom claims，把登入 uid 對應到同仁身分、角色與可管理案場。員工編號、前端密碼或 client 傳入的 `siteId` 都不能單獨證明權限。
- 讀寫一律經受控 Functions API，由 Functions 服務帳號搭配 Admin SDK 操作。Functions 必須驗證 Auth token、claims、最新有效的角色與案場授權，並用伺服端資料確認案件及交接紀錄的 `siteId`。缺少身分、案場或跨案場不符都拒絕；不得把缺少 `siteId` 的舊資料當成可展示給幹部的交接資料。
- 同仁僅能透過 Functions 申請／確認自己的案件；核准、駁回與套用需由 Functions 驗證有權幹部、狀態轉移、版本及冪等條件。Client 不得直接寫入核准狀態，也不能指定可信任的核准人或時間。
- Audit 只允許 Functions 產生，actor、伺服端時間、原因、請求與版本由服務端取得或驗證。Client 不得新增、竄改或刪除 audit；服務端應實作追加紀錄及相應的存取控制。
- **Admin SDK 會繞過 Realtime Database Rules**。此範本不能約束服務帳號；上述檢查須在 Functions 實作、測試並採最小 IAM 權限。不要把服務帳號金鑰或其他憑證放入前端或 repository。

## 本機語法驗證

在 repository 根目錄使用既有 Node 執行（不連線 Firebase、不需憑證）：

```bash
node -e "JSON.parse(require('node:fs').readFileSync('firebase/v4-database.rules.json', 'utf8')); console.log('v4 rules JSON syntax OK');"
```

此命令只驗證 JSON 語法，**不代表已通過 Firebase Rules 編譯、授權測試或部署**。日後需在獨立本機 Emulator 專案驗證：匿名／一般同仁／幹部均無法直讀寫這三個路徑、client 無法核准及寫 audit；Functions 的身分冒用、跨案場、缺少 `siteId`、非法轉移及重複請求也都需要測試。

## 正式整合前的限制

本範本根層 `.read`／`.write` 都為 `false`，若當完整 ruleset 取代正式 Rules，會拒絕其他原有 client 存取；**不得整份覆蓋正式 Rules**。Realtime Database 的祖先允許規則會向下繼承：若將三個子路徑合入既有 rules，而其根層或 `/v4` 存在允許條件，子路徑的 `false` 也無法撤銷該授權。因此也不能只複製片段就宣稱已隔離。

正式整合需先取得正式 Rules 供審查、完成 Firebase Auth/custom claims 與 Functions，確認全部祖先規則及實際資料路徑，使用 Emulator 測試既有功能和 v4 權限，再依另行授權的部署流程處理。本分支不執行部署、正式資料讀寫、Blaze 啟用或秘密設定。
