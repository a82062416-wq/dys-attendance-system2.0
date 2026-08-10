# AGENTS.md — DYS 打卡系統（大洋保全員工打卡系統）

> 本檔案是 Claude Code 與 Codex 共用的核心規則檔。兩個 AI 工具都應在動手前讀取本檔。
> 同一份內容同步放在三個位置（見下方「雙資料夾工作流程」），修改規則時三份都要一起改。
> 最後更新：2026-08-10

---

## 1. 溝通與語言

- 一律使用繁體中文溝通，回覆保持清楚、直接、實用。
- 代碼、日誌、變數名、commit type 使用英文。
- 先解決使用者問題，再追求流程完整度。
- 解釋技術內容時：先用白話簡單解釋，再補充深入細節。
- 使用者：Han，Email：a82062416@gmail.com，角色：DYS大洋保全系統管理員兼開發管理者。

## 2. 安全規則（不可跳過）

- 不硬編碼密鑰、API token；不將 `.env` 或任何憑證檔案提交進 git。
- 不在日誌或交接文件中明碼寫入金鑰/密碼（若非寫不可，寫完要提醒使用者盡快撤銷重發）。
- 修改公開 API、資料結構、資料庫 schema、刪除檔案前，必須先取得使用者確認。
- 未經明確確認，不要執行危險指令，特別注意：`rm`、`sudo`、`chmod`、`chown`、`mv`、刪除檔案、修改系統資料夾。
- 修改大量檔案前，先摘要說明計畫；覆蓋重要檔案前，先檢查現有內容；危險修改前，優先建立備份。

## 3. Git 規則

- 危險修改前先跑 `git status` 確認現況。
- **未經允許不要自動 `git commit`，未經允許不要自動 `git push`。**
- 修改後，摘要列出變更了哪些檔案。
- `.claude/` 資料夾（Claude Code 的本機設定，含 `launch.json`、`settings.local.json`、`worktrees/`）**不應該被 git 追蹤**，已在 `.gitignore` 中排除，若看到 `.claude/` 出現在 `git status` 的待加入清單，先確認 `.gitignore` 是否漏了東西，不要直接 `git add .claude`。

## 4. 工作流程

- 實作前，優先沿用成熟方案/現有程式碼慣例，不要閉門造車重寫。
- 指令報錯或測試失敗時，必須明確報告，不掩蓋、不假裝成功。
- 宣稱「完成」前，必須先實際驗證（跑得動、語法檢查過、或至少肉眼比對邏輯）。
- 修 bug 時，優先理解重現步驟，再動手修，不要憑猜測亂改。
- 預設低摩擦執行，不要把簡單任務做成頻繁確認的流程；但涉及第 2、3 節的安全/Git 規則時仍要停下來確認。
- Coding 任務流程：先看專案結構 → 理解現有檔案再修改 → 優先小範圍精準修改 → 說明修改內容 → 提供測試方式。
- 非必要時不做大規模重構，優先漸進式修改。

## 5. 代碼標準

- 這個專案是單一 HTML 檔案的 Vanilla JS PWA，沒有框架、沒有後端，資料庫是 `localStorage`。維持這個技術選型，不要無故引入框架或建置工具。
- 不做不必要的抽象；不寫不必要的向後相容邏輯。
- Commit message：type 用英文，描述用中文。

---

## 專案特定資訊

### 雙資料夾工作流程（★ 最容易搞混、最容易造成技術債的地方）

| 用途 | 路徑 |
|------|------|
| **編輯資料夾**（平常改 `index.html` 的地方，非 git repo） | `C:\Users\User\Desktop\黑名單網頁架設資料\DYS-打卡系統\公司打卡系統2.0\` |
| **Git repo 資料夾**（真正 push 到 GitHub 的地方） | `C:\Users\User\Desktop\黑名單網頁架設資料\DYS-打卡系統\打卡系統0427-1.0\` |
| **GitHub Repo** | https://github.com/a82062416-wq/dys-attendance-system2.0 |
| **正式網址** | https://a82062416-wq.github.io/dys-attendance-system2.0/ |

**這兩個資料夾曾經對不齊過。** 每次要 push 前，一定要先把 `公司打卡系統2.0\index.html`（與 `sw.js` 等有改過的檔案）複製覆蓋到 `打卡系統0427-1.0\` 對應檔案，再於 `打卡系統0427-1.0` 內執行 git 指令。動手前先 `git diff --stat HEAD` 確認差異，不要盲目複製覆蓋。

```
copy /Y "C:\Users\User\Desktop\黑名單網頁架設資料\DYS-打卡系統\公司打卡系統2.0\index.html" "C:\Users\User\Desktop\黑名單網頁架設資料\DYS-打卡系統\打卡系統0427-1.0\index.html"
cd "C:\Users\User\Desktop\黑名單網頁架設資料\DYS-打卡系統\打卡系統0427-1.0"
git diff --stat HEAD
git add index.html
git commit -m "update"
git push origin main
```

> Sandbox（Cowork/Codex 雲端環境）**可以**直接從 Linux sandbox push GitHub，方法是在 clone URL 內嵌 Personal Access Token：
> ```bash
> TOKEN="你的GitHub PAT"
> REPO="https://${TOKEN}@github.com/a82062416-wq/dys-attendance-system2.0.git"
> rm -rf /tmp/dys-push && git clone "$REPO" /tmp/dys-push
> cp /path/to/index.html /tmp/dys-push/index.html   # 複製有改過的檔案
> cd /tmp/dys-push
> git config user.email "a82062416@gmail.com" && git config user.name "han"
> git add . && git commit -m "type: 說明" && git push origin main
> ```
> 使用者也可在 Windows 上執行 `push.bat`，兩種方式都可行。

### 技術規格速查

- 檔案大小約 209,000 字元 / 232KB（正常範圍，若差異過大要留意是否被截斷）
- 總 JS 函式數約 154 個
- 部署平台：GitHub Pages
- `localStorage` 鍵名：`employees`、`local_records`、`sites`、`supervisors`、`site_announcement`、`site_announcement_level`、`site_announcement_expiry`、`admin_pwd_hash`

### 已知的坑（動手前必看）

1. **Safari `const` 重複宣告會讓整個 script 崩潰**（Chrome 允許，Safari 不允許）。新增函式後務必檢查：
   ```
   grep -o "function [a-zA-Z_]*" index.html | sort | uniq -d
   ```
2. **`公司打卡系統2.0/index.html` 曾在寫入時被截斷**（缺少 `</html>`）。若懷疑檔案不完整，先從 GitHub clone 完整版回來做基底，不要直接在殘缺檔案上繼續改。
3. 使用者的員工主要用 iPhone 打卡，**Safari 相容性優先於其他瀏覽器**。

### 最新任務狀態去哪找

本檔案只放「不常變的核心規則與專案背景」。**每次任務的最新進度、待辦、卡關點，一律以 Obsidian vault 的交接檔為準，不要相信任何 AI 自己的記憶：**

- Vault 路徑：`C:\Users\User\Desktop\CLAUDE\AI儲存庫\`
- 交接資料夾：`C:\Users\User\Desktop\CLAUDE\AI儲存庫\移交任務\`（依日期排序，讀最新一份）
- 交接格式規範：`移交任務\_交接說明.md`、範本：`移交任務\_範本.md`
- 專案速查卡：`C:\Users\User\Desktop\CLAUDE\AI儲存庫\DYS打卡系統-基本資訊.md`

### 本機路徑對照（Cowork/Codex sandbox 掛載）

不同 session 掛載路徑可能不同，若在雲端 sandbox 環境中操作，先確認實際掛載路徑，不要假設固定不變；Windows 端路徑一律以本檔案開頭列出的完整路徑為準。
