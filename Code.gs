// ══════════════════════════════════════════════════════════
//  DYS 大洋保全 打卡系統 — Google Apps Script
//  版本：1.4.1  |  2026.09
//
//  支援功能：
//  1. 寫入打卡紀錄（員工手機自動上傳）
//  2. 查詢指定月份的打卡紀錄
//  3. 讀取員工名單
// ══════════════════════════════════════════════════════════

const SHEET_RECORDS   = '打卡紀錄';
const SHEET_EMPLOYEES = '員工資料';
const TEMP_VAULT_PROPERTY = 'TEMP_IDENTITY_VAULT_ID';
const TEMP_VAULT_SECRET_PROPERTY = 'TEMP_IDENTITY_VAULT_SECRET';
const MONTHLY_BACKUP_FOLDER_PROPERTY = 'MONTHLY_BACKUP_FOLDER_ID';

// 完整身分證只接受 POST 本文，不得透過 GET／一般打卡紀錄傳送。
function doPost(e) {
  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (payload.action === 'registerTempIdentity') return jsonResponse(registerTempIdentity(payload));
    if (payload.action === 'backupMonthlySnapshot') return jsonResponse(backupMonthlySnapshot(payload));
    return jsonResponse({ status: 'error', message: '不支援的請求' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: '資料處理失敗' });
  }
}

function getMonthlyBackupFolder() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty(MONTHLY_BACKUP_FOLDER_PROPERTY);
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); }
    catch (err) { throw new Error('備份資料夾無法存取，請聯絡系統管理員'); }
  }
  const folder = DriveApp.createFolder('DYS 出勤備份（限管理員）');
  props.setProperty(MONTHLY_BACKUP_FOLDER_PROPERTY, folder.getId());
  return folder;
}

function backupMonthlySnapshot(payload) {
  const month = String(payload.month || '');
  const snapshot = payload.snapshot || {};
  if (!/^\d{4}-\d{2}$/.test(month) || !Array.isArray(snapshot.records)) return { status: 'error', message: '備份資料不完整' };
  const folder = getMonthlyBackupFolder();
  const filename = 'DYS_出勤備份_' + month + '.json';
  if (folder.getFilesByName(filename).hasNext()) return { status: 'ok', duplicate: true };
  const content = JSON.stringify({ month: month, createdAt: new Date().toISOString(), snapshot: snapshot });
  folder.createFile(filename, content, MimeType.PLAIN_TEXT);
  return { status: 'ok', duplicate: false };
}

function getTempIdentityVaultSheet() {
  const props = PropertiesService.getScriptProperties();
  let vaultId = props.getProperty(TEMP_VAULT_PROPERTY);
  let ss = vaultId ? SpreadsheetApp.openById(vaultId) : null;
  if (!ss) {
    ss = SpreadsheetApp.create('DYS 臨時人員身分保管（限管理員）');
    vaultId = ss.getId();
    props.setProperty(TEMP_VAULT_PROPERTY, vaultId);
  }
  let sheet = ss.getSheetByName('身分保管');
  if (!sheet) {
    sheet = ss.insertSheet('身分保管');
    sheet.appendRow(['臨時人員代碼', '姓名', '完整身分證', '末四碼', '伺服器比對值', '個資告知時間', '首次案場', '最後更新']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function registerTempIdentity(payload) {
  const fullId = String(payload.fullId || '').trim().toUpperCase();
  const tempId = String(payload.tempId || '').trim();
  const name = String(payload.name || '').trim();
  if (!fullId || !tempId || !name) return { status: 'error', message: '資料不完整' };
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(TEMP_VAULT_SECRET_PROPERTY);
  if (!secret) { secret = Utilities.getUuid() + Utilities.getUuid(); props.setProperty(TEMP_VAULT_SECRET_PROPERTY, secret); }
  const fingerprint = Utilities.base64Encode(Utilities.computeHmacSha256Signature(fullId, secret));
  const sheet = getTempIdentityVaultSheet();
  const rows = Math.max(0, sheet.getLastRow() - 1);
  if (rows > 0 && sheet.getRange(2, 5, rows, 1).createTextFinder(fingerprint).matchEntireCell(true).findNext()) return { status: 'ok', duplicate: true };
  if (sheet.getRange(1, 6).getValue() === '同意時間') sheet.getRange(1, 6).setValue('個資告知時間');
  sheet.appendRow([tempId, name, fullId, fullId.slice(-4), fingerprint, String(payload.noticeAt || new Date().toISOString()), String(payload.siteId || ''), new Date()]);
  return { status: 'ok', duplicate: false };
}

// ── 主入口 ──────────────────────────────────────────────────
function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || '';
  const callback = isValidJsonpCallback(params.callback) ? params.callback : '';

  try {
    // 查詢打卡紀錄（管理後台查歷史）
    if (action === 'getRecords') {
      return jsonResponse(getRecords(params.yearMonth), callback);
    }
    // 讀取員工名單（從 Sheets 同步員工）
    if (action === 'getEmployees') {
      return jsonResponse(getEmployees(), callback);
    }
    // 員工忘記編號時，以姓名加第二驗證資料查詢（不回傳電話或生日）
    if (action === 'lookupEmployeeId') {
      return jsonResponse(lookupEmployeeId(params), callback);
    }
    // 寫入打卡紀錄（員工打卡時自動呼叫）
    if (params.empId) {
      return jsonResponse(writePunch(params), callback);
    }
    // 其他：回傳系統狀態（測試用）
    return jsonResponse({ status: 'ok', message: 'DYS 打卡系統 API 運作正常' }, callback);

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() }, callback);
  }
}

// ── 寫入打卡紀錄 ─────────────────────────────────────────────
function writePunch(params) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(SHEET_RECORDS);

  // 第一次使用時自動建立工作表＋標題列
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RECORDS);
    sheet.appendRow(['員工編號', '姓名', '打卡類型', '日期', '時間', 'Timestamp']);
    sheet.setFrozenRows(1);
    // 標題列樣式
    sheet.getRange(1, 1, 1, 6)
      .setBackground('#1a73e8')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    sheet.setColumnWidths(1, 6, 130);
  }

  const timestamp = String(params.timestamp || new Date().toISOString());
  const dataRows = sheet.getLastRow() - 1;
  if (timestamp && dataRows > 0) {
    const duplicate = sheet.getRange(2, 6, dataRows, 1)
      .createTextFinder(timestamp)
      .matchEntireCell(true)
      .findNext();
    if (duplicate) return { status: 'ok', duplicate: true };
  }

  sheet.appendRow([
    params.empId    || '',
    params.name     || '',
    params.type     || '',
    params.date     || '',
    params.time     || '',
    timestamp
  ]);
  return { status: 'ok', duplicate: false };
  } finally {
    lock.releaseLock();
  }
}

// ── 查詢打卡紀錄（依年月篩選） ────────────────────────────────
function getRecords(yearMonth) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RECORDS);

  if (!sheet) return { status: 'ok', records: [] };

  const data    = sheet.getDataRange().getValues();
  const records = [];

  for (let i = 1; i < data.length; i++) {
    const row  = data[i];
    const date = row[3] ? String(row[3]).trim() : '';
    // 有傳 yearMonth（格式 YYYY-MM）就篩選，沒傳就全回
    if (!yearMonth || date.startsWith(yearMonth)) {
      records.push({
        empId    : String(row[0] || '').trim(),
        name     : String(row[1] || '').trim(),
        type     : String(row[2] || '').trim(),
        date     : date,
        time     : String(row[4] || '').trim(),
        timestamp: String(row[5] || '').trim()
      });
    }
  }

  return { status: 'ok', records: records };
}

// ── 讀取員工名單 ─────────────────────────────────────────────
function getEmployees() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_EMPLOYEES);

  if (!sheet) {
    return { status: 'error', message: '找不到「員工資料」工作表，請先建立' };
  }

  const data      = sheet.getDataRange().getValues();
  const employees = [];

  for (let i = 1; i < data.length; i++) {
    const id   = String(data[i][0] || '').trim();
    const name = String(data[i][1] || '').trim();
    if (id && name && name !== '.') {
      employees.push({ id, name });
    }
  }

  return { status: 'ok', employees: employees };
}

// ── 員工編號自助查詢 ─────────────────────────────────────────
function lookupEmployeeId(params) {
  const name = String(params.name || '').trim();
  const verifyType = String(params.verifyType || '').trim();
  const verifyValue = String(params.verifyValue || '').replace(/\D/g, '');
  if (!name || !/^(mobile|birthday)$/.test(verifyType) || !/^\d{4}$/.test(verifyValue)) {
    return { status: 'error', message: '查詢資料不完整' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_EMPLOYEES);
  if (!sheet) return { status: 'error', message: '目前無法查詢，請聯絡主管' };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { status: 'error', message: '目前無法查詢，請聯絡主管' };
  const headers = data[0].map(value => String(value || '').trim());
  const idIndex = findEmployeeColumn(headers, ['員工編號', '工號']);
  const nameIndex = findEmployeeColumn(headers, ['姓名', '員工姓名', '中文姓名', '員工']);
  const verifyIndex = verifyType === 'mobile'
    ? findEmployeeColumn(headers, ['行動電話', '手機', '連絡電話', '聯絡電話'])
    : findEmployeeColumn(headers, ['生日', '出生年月日']);
  if (idIndex < 0 || nameIndex < 0 || verifyIndex < 0) {
    return { status: 'error', message: '目前無法查詢，請聯絡主管' };
  }

  const matches = data.slice(1).filter(row => {
    const rowId = String(row[idIndex] || '').trim();
    const rowName = String(row[nameIndex] || '').trim();
    return rowId && rowName === name && getVerificationLastFour(row[verifyIndex], verifyType) === verifyValue;
  });
  if (matches.length !== 1) return { status: 'error', message: '查無符合資料，請確認後再試一次' };
  return { status: 'ok', empId: String(matches[0][idIndex]).trim() };
}

function findEmployeeColumn(headers, candidates) {
  const exactIndex = headers.findIndex(header => candidates.includes(header));
  return exactIndex >= 0
    ? exactIndex
    : headers.findIndex(header => candidates.some(candidate => header.indexOf(candidate) >= 0));
}

function getVerificationLastFour(value, verifyType) {
  if (value instanceof Date && !isNaN(value.getTime()) && verifyType === 'birthday') {
    return ('0' + (value.getMonth() + 1)).slice(-2) + ('0' + value.getDate()).slice(-2);
  }
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

// ── 工具：回傳 JSON 並設定 CORS ─────────────────────────────
function isValidJsonpCallback(callback) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(String(callback || ''));
}

function jsonResponse(obj, callback) {
  const content = callback
    ? callback + '(' + JSON.stringify(obj) + ');'
    : JSON.stringify(obj);
  return ContentService
    .createTextOutput(content)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
