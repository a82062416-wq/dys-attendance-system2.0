const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const codeGs = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
const inlineScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(Boolean)
  .at(-1);

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `找不到 ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} 函式括號未閉合`);
}

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test('本機沒有幹部名單時，不可把預設名單寫回 Firebase', () => {
  const writes = [];
  const context = {
    localStorage: createStorage(),
    _DEFAULT_SUPERVISORS: [{ empId: '001', active: true }],
    FB_DB: { ref: () => ({ set: value => { writes.push(value); return { catch() {} }; } }) },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'normalizeSupervisors')}; ${extractFunction(inlineScript, 'getSupervisors')}; this.run = getSupervisors;`, context);
  const result = context.run();
  assert.equal(result[0].empId, '001');
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].sites)), []);
  assert.equal(writes.length, 0);
});

test('Firebase 有有效幹部名單時，同步函式應回傳並快取該名單', async () => {
  const remote = [{ empId: '009', active: true }];
  const storage = createStorage();
  const context = {
    localStorage: storage,
    FB_DB: { ref: () => ({ once: async () => ({ val: () => remote }) }) },
    console: { warn() {} },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'normalizeSupervisors')}; ${extractFunction(inlineScript, 'syncSupervisorsFromFirebase')}; this.run = syncSupervisorsFromFirebase;`, context);
  const result = await context.run();
  assert.equal(result[0].empId, '009');
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].sites)), []);
  assert.equal(JSON.parse(storage.getItem('supervisors'))[0].empId, '009');
});

test('舊版幹部資料缺少 sites 時，載入後必須補為空案場清單', () => {
  const storage = createStorage({
    supervisors: JSON.stringify([{ empId: '009', name: '測試主管', title: '課長', viewAll: false, active: true }]),
  });
  const context = {
    localStorage: storage,
    _DEFAULT_SUPERVISORS: [],
    console: { warn() {} },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'normalizeSupervisors')}; ${extractFunction(inlineScript, 'getSupervisors')}; this.run = getSupervisors;`, context);
  const [supervisor] = context.run();
  assert.deepEqual(JSON.parse(JSON.stringify(supervisor.sites)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(supervisor.permissions)), []);
});

test('儲存幹部資料時必須保留停用狀態並補齊缺少欄位', () => {
  const storage = createStorage();
  const writes = [];
  const context = {
    localStorage: storage,
    FB_DB: { ref: () => ({ set: value => { writes.push(value); return { catch() {} }; } }) },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'normalizeSupervisors')}; ${extractFunction(inlineScript, 'saveSupervisors')}; this.run = saveSupervisors;`, context);
  context.run([{ empId: '010', name: '停用主管', active: false }]);
  const [saved] = JSON.parse(storage.getItem('supervisors'));
  assert.equal(saved.active, false);
  assert.deepEqual(saved.sites, []);
  assert.deepEqual(saved.permissions, []);
  assert.equal(writes.length, 1);
});

test('幹部摘要必須分開顯示總人數與啟用人數', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getSupervisorSummary')}; this.run = getSupervisorSummary;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run([
    { empId: '001', active: true },
    { empId: '002', active: false },
    { empId: '003' },
  ]))), { total: 3, active: 2 });
});

test('Apps Script 對同一 timestamp 僅新增一次打卡資料', () => {
  const rows = [];
  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange: () => ({
      createTextFinder: timestamp => ({
        matchEntireCell: () => ({ findNext: () => rows.some(row => row[5] === timestamp) ? { row: 2 } : null }),
      }),
    }),
    appendRow: row => rows.push(row),
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
  };
  vm.runInNewContext(`${codeGs}; this.run = writePunch;`, context);
  const punch = { empId: '10000001', name: '測試員工', type: '上班', date: '2026-09-10', time: '08:00', timestamp: 'unique-1' };
  const first = context.run(punch);
  const second = context.run(punch);
  assert.equal(first.status, 'ok');
  assert.equal(second.duplicate, true);
  assert.equal(rows.length, 1);
});

test('員工編號查詢僅在姓名與手機末四碼都相符時回傳編號', () => {
  const rows = [
    ['員工編號', '姓名', '行動電話', '生日'],
    ['11500001', '測試員工', '0912345678', '1980/05/20'],
  ];
  const context = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => ({ getDataRange: () => ({ getValues: () => rows }) }),
      }),
    },
  };
  vm.runInNewContext(`${codeGs}; this.run = lookupEmployeeId;`, context);
  const match = context.run({ name: '測試員工', verifyType: 'mobile', verifyValue: '5678' });
  const mismatch = context.run({ name: '測試員工', verifyType: 'mobile', verifyValue: '0000' });
  assert.deepEqual(JSON.parse(JSON.stringify(match)), { status: 'ok', empId: '11500001' });
  assert.equal(mismatch.status, 'error');
  assert.equal(mismatch.empId, undefined);
});

test('上次打卡應顯示白話日期，過久紀錄要提醒確認', () => {
  const context = { pad: value => String(value).padStart(2, '0') };
  vm.runInNewContext(`${extractFunction(inlineScript, 'summarizeLastPunch')}; this.run = summarizeLastPunch;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run(
    { type: '上班', date: '2026-09-11', time: '08:03' },
    new Date('2026-09-11T14:00:00'),
  ))), { text: '今天 08:03 上班', stale: false });
  assert.deepEqual(JSON.parse(JSON.stringify(context.run(
    { type: '下班', date: '2026-05-20', time: '18:00' },
    new Date('2026-09-11T14:00:00'),
  ))), { text: '5/20 18:00 下班（請確認）', stale: true });
});

test('伺服器回覆失敗時，打卡紀錄不可標記為已同步', async () => {
  const records = [{ timestamp: 'unique-2', synced: false }];
  const context = {
    SCRIPT_URL: 'https://example.invalid/script',
    localRecs: records,
    fetch: async () => ({ ok: true, json: async () => ({ status: 'error' }) }),
    requestSheetUpload: async () => ({ status: 'error' }),
    saveRecs() {},
    updateSyncStatusBar() {},
    loadRecords() {},
    ADMIN_UNLOCKED: false,
    console: { warn() {} },
    URLSearchParams,
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'uploadRec')}; this.run = uploadRec;`, context);
  const result = await context.run({ empId: '10000001', name: '測試員工', type: '上班', date: '2026-09-10', time: '08:00', timestamp: 'unique-2' });
  assert.equal(result, false);
  assert.equal(records[0].synced, false);
});

test('舊版 A58 QR Code 必須解析到 Excel 的 A058 案場代碼', () => {
  const context = {
    SITE_ID_ALIASES: { A58: 'A058', A07: 'A007', A12: 'A012' },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'resolveSiteId')}; this.run = resolveSiteId;`, context);
  assert.equal(context.run('A58'), 'A058');
});

test('舊版 A58 QR token 與新版 A058 token 都必須有效', () => {
  const context = {
    SITE_ID_ALIASES: { A58: 'A058', A07: 'A007', A12: 'A012' },
    resolveSiteId: siteId => ({ A58: 'A058', A07: 'A007', A12: 'A012' })[siteId] || siteId,
    hashPwd: value => ({ 'A58DYS04270': 'old-token-hash', 'A058DYS04270': 'new-token-hash' })[value],
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'isSiteTokenValid')}; this.run = isSiteTokenValid;`, context);
  assert.equal(context.run('A58', 'OLD-TOKE', '0'), true);
  assert.equal(context.run('A58', 'NEW-TOKE', '0'), true);
  assert.equal(context.run('A58', 'WRONG-TOKEN', '0'), false);
});

test('已更換 QR 的案場必須拒絕舊版本，但未更換案場保留 v0 QR', () => {
  const context = {
    resolveSiteId: siteId => ({ A58: 'A058', A07: 'A007', A12: 'A012' })[siteId] || siteId,
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'isQrVersionCurrent')}; this.run = isQrVersionCurrent;`, context);
  assert.equal(context.run('A58', '0', {}), true);
  assert.equal(context.run('A58', '0', { A058: '1' }), false);
  assert.equal(context.run('A58', '1', { A058: '1' }), true);
  assert.equal(context.run('A07', '0', { A058: '1' }), true);
});

test('台灣凌晨的日期鍵必須是當地日期，不可退回前一天', () => {
  const context = { pad: value => String(value).padStart(2, '0') };
  vm.runInNewContext(`${extractFunction(inlineScript, 'localDateKey')}; this.run = localDateKey;`, context);
  assert.equal(context.run(new Date('2026-09-14T00:30:00+08:00')), '2026-09-14');
});

test('從 Sheets 同步員工時必須保留既有手動停用與案場設定', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'mergeSheetEmployees')}; this.run = mergeSheetEmployees;`, context);
  const merged = context.run(
    [{ id: '10000001', name: '舊姓名', disabled: true, manualDisabled: true, siteId: 'A058', absentLimit: 10 }],
    [{ id: '10000001', name: '新姓名' }, { id: '10000002', name: '新員工' }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [
    { id: '10000001', name: '新姓名', disabled: true, manualDisabled: true, siteId: 'A058', absentLimit: 10 },
    { id: '10000002', name: '新員工', disabled: false, absentLimit: null },
  ]);
});

test('Apps Script 寫入完成後必須釋放文件鎖', () => {
  const rows = [];
  let released = false;
  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ createTextFinder: () => ({ matchEntireCell: () => ({ findNext: () => null }) }) }),
    appendRow: row => rows.push(row),
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService: { getDocumentLock: () => ({ waitLock: () => {}, releaseLock: () => { released = true; } }) },
  };
  vm.runInNewContext(`${codeGs}; this.run = writePunch;`, context);
  const result = context.run({ empId: '10000001', name: '測試員工', type: '上班', date: '2026-09-10', time: '08:00', timestamp: 'locked-1' });
  assert.equal(result.status, 'ok');
  assert.equal(released, true);
  assert.equal(rows.length, 1);
});
