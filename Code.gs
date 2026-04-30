// ══════════════════════════════════════════════════════════
//  DYS 大洋保全 打卡系統 — Google Apps Script
//  版本：1.0.0  |  2026.04
//
//  支援功能：
//  1. 寫入打卡紀錄（員工手機自動上傳）
//  2. 查詢指定月份的打卡紀錄
//  3. 讀取員工名單
// ══════════════════════════════════════════════════════════

const SHEET_RECORDS   = '打卡紀錄';
const SHEET_EMPLOYEES = '員工資料';

// ── 主入口 ──────────────────────────────────────────────────
function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || '';

  try {
    // 查詢打卡紀錄（管理後台查歷史）
    if (action === 'getRecords') {
      return jsonResponse(getRecords(params.yearMonth));
    }
    // 讀取員工名單（從 Sheets 同步員工）
    if (action === 'getEmployees') {
      return jsonResponse(getEmployees());
    }
    // 寫入打卡紀錄（員工打卡時自動呼叫）
    if (params.empId) {
      writePunch(params);
      return jsonResponse({ status: 'ok' });
    }
    // 其他：回傳系統狀態（測試用）
    return jsonResponse({ status: 'ok', message: 'DYS 打卡系統 API 運作正常' });

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

// ── 寫入打卡紀錄 ─────────────────────────────────────────────
function writePunch(params) {
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

  sheet.appendRow([
    params.empId    || '',
    params.name     || '',
    params.type     || '',
    params.date     || '',
    params.time     || '',
    params.timestamp || new Date().toISOString()
  ]);
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

// ── 工具：回傳 JSON 並設定 CORS ─────────────────────────────
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
