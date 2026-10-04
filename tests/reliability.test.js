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

test('延後備份提醒不應更新上次備份日期，立即備份只呼叫一次匯出', () => {
  const banner = { removed: false, remove() { this.removed = true; } };
  const storage = createStorage();
  const context = {
    localStorage: storage,
    today: () => '2026-10-02',
    $: id => id === 'backup-banner' ? banner : null,
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'dismissBackupReminder')}; this.dismiss = dismissBackupReminder;`, context);
  context.dismiss();
  assert.equal(storage.getItem('last_backup_date'), null);
  assert.equal(banner.removed, true);
  assert.match(inlineScript, /onclick="exportAuditBackupJSON\(\)"[^>]*>備份本機全部紀錄/);
  assert.match(inlineScript, /onclick="dismissBackupReminder\(\)"[^>]*>稍後再說/);
});

test('後台雲端同步逾時但有本機密碼時仍可進入登入頁並標示未確認', async () => {
  const messages=[];
  let supervisorStatus,authStatus;
  let destination;
  const lockButton={disabled:false,setAttribute(){},removeAttribute(){}};
  const overlay={classList:{remove(){}}};
  const elements={
    'login-cloud-status':{textContent:'',style:{}},
    'lock-screen':{style:{}},'lock-input':{value:'old'},'sup-emp-input':{value:'old'},
    'lock-hint':{textContent:'old'},'role-supervisor':{style:{}},
  };
  const context={
    adminOpening:false,_guideDrawerTimer:null,drawerOpen:false,
    $:id=>id==='tab-admin'?lockButton:id==='guide-overlay'||id==='keyboard-overlay'?overlay:elements[id],
    syncSupervisorsFromFirebase:status=>{supervisorStatus=status;return new Promise(()=>{});},
    syncAuthFromFirebase:status=>{authStatus=status;return new Promise(()=>{});},
    setTimeout:callback=>{queueMicrotask(callback);return 1;},clearTimeout(){},
    getPwdHash:()=> 'cached-hash',ADMIN_UNLOCKED:true,getSupervisors:()=>[],switchRole(){},showAdminMenu(){},
    showToast:(message,type)=>messages.push({message,type}),navigateTo:page=>{destination=page;},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'goAdmin')}; this.run=goAdmin;`,context);
  const settled=await Promise.race([context.run().then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),20))]);
  assert.equal(settled,true,'雲端未回應時登入入口不可無限等待');
  assert.equal(lockButton.disabled,false);
  assert.equal(destination,'admin');
  assert.equal(elements['lock-screen'].style.display,'flex');
  assert.match(elements['login-cloud-status'].textContent,/未確認/);
  assert.ok(messages.some(item=>item.message.includes('逾時')));
  assert.equal(supervisorStatus.active,false);
  assert.equal(authStatus.active,false);
});

test('加入桌面僅由打卡說明引導，頁面不保留底部安裝浮條', () => {
  assert.doesNotMatch(html, /id="pwa-banner"/);
  assert.doesNotMatch(html, /#pwa-banner/);
  assert.doesNotMatch(inlineScript, /beforeinstallprompt|pwaBannerTimer|dismissPWA/);
  assert.match(html, /onclick="replayGuide\(\)"[^>]*>查看打卡說明/);
  assert.match(html, /可選擇加入手機桌面/);
});

test('新裝置雲端登入資料讀取失敗時不可誤開初始設定', async () => {
  const messages=[];
  let setupOpened=false;
  const elements={
    'tab-admin':{disabled:false,textContent:''},
    'guide-overlay':{classList:{remove(){}}},
    'keyboard-overlay':{classList:{remove(){}}},
    'login-cloud-status':{textContent:'',style:{}},
  };
  const context={
    adminOpening:false,_guideDrawerTimer:null,drawerOpen:false,
    $:id=>elements[id],clearTimeout(){},setTimeout:()=>1,
    syncSupervisorsFromFirebase:async status=>{status.verified=false;},
    syncAuthFromFirebase:async status=>{status.verified=false;status.loaded=false;},
    getPwdHash:()=>'',openSetup:()=>{setupOpened=true;},
    showToast:(message,type)=>messages.push({message,type}),
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'goAdmin')}; this.run=goAdmin;`,context);
  await context.run();
  assert.equal(setupOpened,false);
  assert.ok(messages.some(item=>item.type==='error'&&item.message.includes('雲端')));
});

test('後台登入雲端讀取失敗時應標記為未確認', async () => {
  const status={verified:true};
  const context={
    FB_DB:{ref:()=>({once:()=>Promise.reject(new Error('offline'))})},
    localStorage:createStorage({admin_pwd_hash:'local-hash'}),
    console:{warn(){}},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'syncAuthFromFirebase')}; this.run=syncAuthFromFirebase;`,context);
  await context.run(status);
  assert.equal(status.verified,false);
  assert.equal(context.localStorage.getItem('admin_pwd_hash'),'local-hash');
});

test('後台登入雲端讀取成功時應標記為已確認', async () => {
  const status={verified:false};
  const context={
    FB_DB:{ref:()=>({once:()=>Promise.resolve({val:()=>({admin_pwd_hash:'cloud-hash'})})})},
    localStorage:createStorage(),console:{warn(){}},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'syncAuthFromFirebase')}; this.run=syncAuthFromFirebase;`,context);
  await context.run(status);
  assert.equal(status.verified,true);
  assert.equal(context.localStorage.getItem('admin_pwd_hash'),'cloud-hash');
});

test('幹部資料讀取失敗時不可標記為已確認', async () => {
  const status={verified:true};
  const context={FB_DB:{ref:()=>({once:()=>Promise.reject(new Error('offline'))})},console:{warn(){}}};
  vm.runInNewContext(`${extractFunction(inlineScript,'syncSupervisorsFromFirebase')}; this.run=syncSupervisorsFromFirebase;`,context);
  await context.run(status);
  assert.equal(status.verified,false);
});

test('後台同步逾時後晚到的密碼不得覆寫本機資料', async () => {
  let resolveSnapshot;
  const storage=createStorage({admin_pwd_hash:'original'});
  const status={verified:false,active:true};
  const context={
    FB_DB:{ref:()=>({once:()=>new Promise(resolve=>{resolveSnapshot=resolve;})})},
    localStorage:storage,console:{warn(){}},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'syncAuthFromFirebase')}; this.run=syncAuthFromFirebase;`,context);
  const pending=context.run(status);
  status.active=false;
  resolveSnapshot({val:()=>({admin_pwd_hash:'late-hash'})});
  await pending;
  assert.equal(storage.getItem('admin_pwd_hash'),'original');
  assert.equal(status.verified,false);
});

test('後台同步逾時後晚到的幹部名單不得覆寫本機資料', async () => {
  let resolveSnapshot;
  const storage=createStorage({supervisors:'[{"empId":"local"}]'});
  const status={verified:false,active:true};
  const context={
    FB_DB:{ref:()=>({once:()=>new Promise(resolve=>{resolveSnapshot=resolve;})})},
    localStorage:storage,normalizeSupervisors:data=>data,console:{warn(){}},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'syncSupervisorsFromFirebase')}; this.run=syncSupervisorsFromFirebase;`,context);
  const pending=context.run(status);
  status.active=false;
  resolveSnapshot({val:()=>[{empId:'late'}]});
  await pending;
  assert.equal(storage.getItem('supervisors'),'[{"empId":"local"}]');
  assert.equal(status.verified,false);
});

test('雲端幹部名單為空時不可把本機舊名單標成已確認', async () => {
  const storage=createStorage({supervisors:'[{"empId":"local","active":true}]'});
  const status={verified:false,active:true};
  const context={FB_DB:{ref:()=>({once:()=>Promise.resolve({val:()=>[]})})},localStorage:storage,console:{warn(){}}};
  vm.runInNewContext(`${extractFunction(inlineScript,'syncSupervisorsFromFirebase')}; this.run=syncSupervisorsFromFirebase;`,context);
  await context.run(status);
  assert.equal(status.verified,false);
  assert.equal(storage.getItem('supervisors'),'[{"empId":"local","active":true}]');
});

test('從引導進後台會取消延遲彈出的員工編號鍵盤', () => {
  const timers=new Map();
  let next=0,drawerOpens=0;
  const overlay={classList:{remove(){}}};
  const context={
    adminOpening:false,_guideDrawerTimer:null,drawerOpen:false,
    localStorage:createStorage(),
    $:()=>overlay,
    setTimeout:callback=>{const id=++next;timers.set(id,callback);return id;},
    clearTimeout:id=>timers.delete(id),
    openDrawer:()=>{drawerOpens++;},
    syncSupervisorsFromFirebase:()=>new Promise(()=>{}),syncAuthFromFirebase:()=>new Promise(()=>{}),
    showToast(){},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'guideSkip')}; ${extractFunction(inlineScript,'goAdmin')}; this.skip=guideSkip;this.admin=goAdmin;`,context);
  context.skip();
  context.admin();
  for(const callback of timers.values()) callback();
  assert.equal(drawerOpens,0);
});

test('幹部資料雲端同步失敗時保留本機設定並回報失敗', async () => {
  const storage = createStorage();
  const context = {
    localStorage: storage,
    normalizeSupervisors: data => data,
    FB_DB: { ref: () => ({ set: () => Promise.reject(new Error('offline')) }) },
    setTimeout,
    clearTimeout,
    console: { warn() {} },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'saveSupervisors')}; this.save = saveSupervisors;`, context);
  assert.equal(await context.save([{ empId: '1001', active: false }]), false);
  assert.equal(JSON.parse(storage.getItem('supervisors'))[0].active, false);
  context.FB_DB = { ref: () => ({ set: () => Promise.resolve() }) };
  assert.equal(await context.save([{ empId: '1001', active: false }]), true);
});

test('幹部雲端寫入一直等待時回報尚未同步', async () => {
  const context = {
    localStorage: createStorage(),
    normalizeSupervisors: data => data,
    FB_DB: { ref: () => ({ set: () => new Promise(() => {}) }) },
    setTimeout: callback => { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    console: { warn() {} },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'saveSupervisors')}; this.save = saveSupervisors;`, context);
  assert.equal(await context.save([{ empId: '1001' }]), false);
});

test('未核對排班的無打卡紀錄只能標示待確認', () => {
  assert.match(inlineScript, /type:'待確認未打卡'/);
  assert.doesNotMatch(inlineScript, /type:'❌ 缺勤'/);
  assert.match(html, /id="an-absent"[^>]*>[^<]*<\/div><div class="stat-lbl">待確認未打卡/);
});

test('後台分類選單可由鍵盤聚焦與啟動', () => {
  const menu = html.match(/<div id="admin-menu">([\s\S]*?)<\/div><!-- \/#admin-menu -->/)[1];
  assert.doesNotMatch(menu, /<div class="admin-menu-item"/);
  assert.ok((menu.match(/<button type="button" class="admin-menu-item"/g) || []).length >= 10);
});

test('後台首頁有清楚的今日工作引導且快捷入口不與清單重複', () => {
  const menu = html.match(/<div id="admin-menu">([\s\S]*?)<\/div><!-- \/#admin-menu -->/)[1];
  assert.match(menu, /class="admin-menu-intro"/);
  assert.match(menu, /class="admin-quick-grid"[^>]*aria-label="今日常用操作"/);
  for(const target of ['daily-actions','records','site-health']){
    assert.equal((menu.match(new RegExp(`showSub\\('${target}'`, 'g'))||[]).length,1);
  }
  assert.match(menu, /class="admin-menu-section admin-only"/);
});

test('後台異常橫幅連到現有異常子頁且可由鍵盤啟動', () => {
  assert.match(html, /<button[^>]*id="anomaly-banner"[^>]*onclick="showSub\('anomaly'\)"/);
});

test('案場搜尋支援正式代碼、舊代碼與名稱，並遵守幹部案場範圍', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'findSitesForSearch')}; this.run = findSitesForSearch;`, context);
  const sites = [
    { id: 'A058', name: '藏美海揚' },
    { id: 'C127', name: '濾能-南科' },
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(context.run(sites, 'A58', ['A058']).map(site => site.id))), ['A058']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run(sites, '藏美', ['A058']).map(site => site.id))), ['A058']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run(sites, '南科', ['A058']).map(site => site.id))), []);
});

test('案場健康燈號對漏下班顯示紅色、對單筆重複顯示黃色', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildSiteHealth')}; this.run = buildSiteHealth;`, context);
  const result = context.run(
    [{ id: 'A058', name: '藏美海揚' }, { id: 'B002', name: '測試案場' }],
    [{ siteId: 'A058', kind: 'missing_out' }, { siteId: 'B002', kind: 'duplicate' }],
    [{ siteId: 'A058', timestamp: '2026-09-16T08:00:00' }, { siteId: 'B002', timestamp: '2026-09-16T09:00:00' }],
  );
  assert.equal(result.find(row => row.siteId === 'A058').level, 'red');
  assert.equal(result.find(row => row.siteId === 'B002').level, 'yellow');
});

test('人員出勤摘要計算出勤日、漏下班、重複與最近案場', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildEmployeeAttendance')}; this.run = buildEmployeeAttendance;`, context);
  const result = context.run([
    { empId: '1001', name: '王小明', type: '上班', date: '2026-09-14', siteId: 'A058', timestamp: '2026-09-14T08:00:00' },
    { empId: '1001', name: '王小明', type: '上班', date: '2026-09-15', siteId: 'B002', timestamp: '2026-09-15T08:00:00' },
  ], [
    { empId: '1001', kind: 'missing_out' }, { empId: '1001', kind: 'duplicate' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{
    empId: '1001', name: '王小明', attendanceDays: 2, missingOut: 1, duplicate: 1,
    lastDate: '2026-09-15', lastSiteId: 'B002', lastTimestamp: '2026-09-15T08:00:00',
  }]);
});

test('分析日期鍵以台灣本地日期連續產生，不跳過起訖日', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getAnalysisDateKeys')}; this.run = getAnalysisDateKeys;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run(3, '2026-09-16'))), ['2026-09-14', '2026-09-15', '2026-09-16']);
});

test('完整身分證保管只能走 POST，且不會被寫進一般打卡工作表', () => {
  assert.match(codeGs, /function doPost\(e\)/);
  assert.match(codeGs, /action === 'registerTempIdentity'/);
  assert.match(codeGs, /function registerTempIdentity\(payload\)/);
  assert.doesNotMatch(codeGs, /writePunch\(params\)[\s\S]*params\.fullId/);
});

test('補登資料拒絕未填原因、未來日期與完全重複的打卡', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getManualPunchPolicy')}; ${extractFunction(inlineScript, 'validateManualPunchInput')}; this.run = validateManualPunchInput;`, context);
  const duplicate = [{ empId: '1001', type: '上班', date: '2026-09-16', time: '08:00' }];

  assert.equal(context.run({ empId: '1001', type: '上班', date: '2026-08-10', time: '08:00', reason: '' }, duplicate, '2026-09-16').error, '超過 30 天的補卡請填寫原因');
  assert.equal(context.run({ empId: '1001', type: '上班', date: '2026-09-17', time: '08:00', reason: '忘記打卡' }, [], '2026-09-16').error, '不可補登未來日期');
  assert.equal(context.run({ empId: '1001', type: '上班', date: '2026-09-16', time: '08:00', reason: '忘記打卡' }, duplicate, '2026-09-16').error, '已有相同時間的打卡紀錄');
});

test('補卡在 30 天內與跨月前 7 天可直接補登，較久才要求填原因', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getManualPunchPolicy')}; this.run = getManualPunchPolicy;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run('2026-08-30', '2026-09-06'))), { allowed: true, requiresReason: false, overdue: false });
  assert.deepEqual(JSON.parse(JSON.stringify(context.run('2026-08-01', '2026-09-20'))), { allowed: true, requiresReason: true, overdue: true });
  assert.equal(context.run('2026-07-01', '2026-09-20').allowed, false);
});

test('今日待處理中心只列出漏下班與需要確認的案場', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildDailyActionItems')}; this.run = buildDailyActionItems;`, context);
  const result = context.run([
    { kind: 'missing_out', severity: 'red', empId: '1001', name: '王小明', date: '2026-09-16', siteId: 'A058', desc: '有上班無下班紀錄' },
    { kind: 'duplicate', severity: 'yellow', empId: '1002', name: '陳小美', date: '2026-09-16', siteId: 'B002', desc: '上班打卡 2 次' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map(item => item.kind))), ['missing_out', 'duplicate']);
  assert.equal(result[0].action, '補下班');
});

test('補下班必須有同日較早的上班紀錄', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getManualPunchPolicy')}; ${extractFunction(inlineScript, 'validateManualPunchInput')}; this.run = validateManualPunchInput;`, context);

  assert.equal(context.run({ empId: '1001', type: '下班', date: '2026-09-16', time: '17:00', reason: '漏打下班' }, [], '2026-09-16').error, '補下班前請先確認同日上班紀錄');
  assert.equal(context.run({ empId: '1001', type: '下班', date: '2026-09-16', time: '07:00', reason: '漏打下班' }, [{ empId: '1001', type: '上班', date: '2026-09-16', time: '08:00' }], '2026-09-16').error, '下班時間不可早於上班時間');
  assert.equal(context.run({ empId: '1001', type: '下班', date: '2026-09-16', time: '17:00', reason: '漏打下班' }, [{ empId: '1001', type: '上班', date: '2026-09-16', time: '08:00' }], '2026-09-16').valid, true);
});

test('補登紀錄保留原因、建立時間與操作者，不覆寫原始欄位', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildManualPunchRecord')}; this.run = buildManualPunchRecord;`, context);
  const record = context.run(
    { empId: '1001', name: '王小明', type: '下班', date: '2026-09-16', time: '17:00', reason: '漏打下班', siteId: 'A058' },
    { createdAt: '2026-09-16T18:00:00+08:00', createdBy: 'S001' },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {
    empId: '1001', name: '王小明', type: '下班', date: '2026-09-16', time: '17:00',
    timestamp: '2026-09-16T17:00:00', siteId: 'A058', synced: false, fbSynced: false,
    manual: true, note: '漏打下班', correctionReason: '漏打下班', createdAt: '2026-09-16T18:00:00+08:00', createdBy: 'S001',
  });
});

test('快速修改既有打卡須保留原始時間與完整修正依據', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildCorrectedPunchRecord')}; this.run = buildCorrectedPunchRecord;`, context);
  const record = context.run(
    { empId: '1001', name: '王小明', type: '上班', date: '2026-09-16', time: '06:18', timestamp: '2026-09-16T06:18:00', siteId: 'A058' },
    { time: '06:10', reason: '打卡機時間誤差' },
    { correctedAt: '2026-09-16T07:00:00+08:00', correctedBy: 'S001' },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {
    empId: '1001', name: '王小明', type: '上班', date: '2026-09-16', time: '06:10', timestamp: '2026-09-16T06:10:00', siteId: 'A058',
    manual: true, correctionReason: '打卡機時間誤差', originalTime: '06:18', originalTimestamp: '2026-09-16T06:18:00',
    correctedAt: '2026-09-16T07:00:00+08:00', correctedBy: 'S001', synced: false, fbSynced: false,
  });
});

test('補登同步到 Firebase 時必須保留稽核欄位', async () => {
  const writes = [];
  const context = {
    FB_DB: { ref: () => ({ set: value => { writes.push(value); return Promise.resolve(); } }) },
    localRecs: [], saveRecs() {}, updateFbStatusBar() {}, console: { warn() {} },
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'uploadToFirebase')}; this.run = uploadToFirebase;`, context);
  context.run({
    empId: '1001', name: '王小明', type: '下班', date: '2026-09-16', time: '17:00', timestamp: '2026-09-16T17:00:00', siteId: 'A058',
      manual: true, correctionReason: '漏打下班', originalTime: '16:45', originalTimestamp: '2026-09-16T16:45:00',
      correctedAt: '2026-09-16T18:00:00+08:00', correctedBy: 'S001', createdAt: '2026-09-16T18:00:00+08:00', createdBy: 'S001',
  });
  await Promise.resolve();
    assert.equal(writes[0].manual, true);
    assert.equal(writes[0].correctionReason, '漏打下班');
    assert.equal(writes[0].originalTime, '16:45');
    assert.equal(writes[0].originalTimestamp, '2026-09-16T16:45:00');
    assert.equal(writes[0].correctedAt, '2026-09-16T18:00:00+08:00');
    assert.equal(writes[0].correctedBy, 'S001');
    assert.equal(writes[0].createdBy, 'S001');
});

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

test('儲存幹部資料時必須保留停用狀態並補齊缺少欄位', async () => {
  const storage = createStorage();
  const writes = [];
  const context = {
    localStorage: storage,
    FB_DB: { ref: () => ({ set: value => { writes.push(value); return Promise.resolve(); } }) },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'normalizeSupervisors')}; ${extractFunction(inlineScript, 'saveSupervisors')}; this.run = saveSupervisors;`, context);
  await context.run([{ empId: '010', name: '停用主管', active: false }]);
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
    getLastColumn: () => 12,
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

test('從員工編號鍵盤開啟查詢時，必須先關閉鍵盤覆蓋層', () => {
  const modal = { classList: { add() {} }, setAttribute() {} };
  const fields = {
    'employee-lookup-modal': modal,
    'lookup-name': { value: '', focus() {} },
    'lookup-value': { value: '' },
    'lookup-result': { textContent: '' },
  };
  let drawerClosed = false;
  const context = {
    $: id => fields[id],
    closeDrawer: () => { drawerClosed = true; },
    updateLookupHint() {},
    setTimeout: callback => callback(),
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'openEmployeeLookup')}; this.run = openEmployeeLookup;`, context);
  context.run();
  assert.equal(drawerClosed, true);
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

test('Firebase 名單更新姓名但保留既有停用及案場設定', () => {
  const storage = createStorage({ employees: JSON.stringify([
    { id: '1001', name: '舊姓名', disabled: true, manualDisabled: true, siteId: 'A001' },
  ]) });
  const context = { localStorage: storage };
  vm.runInNewContext(`${extractFunction(inlineScript, 'mergeFirebaseEmployees')}; this.run = mergeFirebaseEmployees;`, context);
  const result = context.run([{ id: '1001', name: '新姓名' }, { id: '1002', name: '新員工' }]);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(JSON.parse(storage.getItem('employees')), [
    { id: '1001', name: '新姓名', disabled: true, manualDisabled: true, siteId: 'A001' },
    { id: '1002', name: '新員工' },
  ]);
});

test('CSV 只匯出幹部可見且符合目前案場篩選的紀錄', () => {
  let downloaded = '';
  const fields = { 'f-emp': {value:''}, 'f-site': {value:'A001'} };
  const context = {
    $: id => fields[id],
    localRecs: [
      {empId:'1',name:'甲',type:'上班',date:'2026-10-03',time:'08:00',siteId:'A001'},
      {empId:'2',name:'乙',type:'上班',date:'2026-10-03',time:'08:00',siteId:'A002'},
    ],
    filterRecsBySup: rows => rows.filter(row => row.siteId==='A001'),
    getDateRange: () => ({s:null,e:null}),
    resolveSiteSearchId: value => value==='A001' ? value : '',
    dlFile: csv => { downloaded=csv; },
    showToast() {}, today: () => '2026-10-03', markBackupDone() {},
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'csvCell')}; ${extractFunction(inlineScript, 'exportCSV')}; this.run = exportCSV;`,context);
  context.run();
  assert.match(downloaded,/甲/);
  assert.doesNotMatch(downloaded,/乙/);
  downloaded=''; fields['f-site'].value='unknown'; context.run();
  assert.equal(downloaded,'');
});

test('未同步紀錄存在時不可清除本機打卡資料', () => {
  let saves=0, confirms=0;
  const context={
    localRecs:[{synced:false,fbSynced:true}],
    confirm:()=>{confirms++;return true;},
    saveRecs:()=>{saves++;}, loadRecords(){}, showToast(){},
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'clearLocal')}; this.run = clearLocal;`,context);
  context.run();
  assert.equal(context.localRecs.length,1);
  assert.equal(saves,0);
  assert.equal(confirms,0);
});

test('篩選與本機全部摘要 CSV 均不標記詳細備份日期', () => {
  const downloads=[];
  let marked=0;
  const fields={'f-emp':{value:''},'f-site':{value:'A001'}};
  const context={
    $:id=>fields[id],
    localRecs:[
      {empId:'1',name:'甲',type:'上班',date:'2026-10-03',time:'08:00',siteId:'A001'},
      {empId:'2',name:'乙',type:'上班',date:'2026-10-02',time:'08:00',siteId:'A002'},
    ],
    filterRecsBySup:rows=>rows,
    getDateRange:()=>({s:'2026-10-03',e:'2026-10-03'}),
    resolveSiteSearchId:value=>value,
    dlFile:(csv,name)=>downloads.push({csv,name}),
    showToast(){},today:()=> '2026-10-03',markBackupDone:()=>{marked++;},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'csvCell')}; ${extractFunction(inlineScript,'exportCSV')}; ${extractFunction(inlineScript,'exportFullBackupCSV')}; this.filtered=exportCSV; this.full=exportFullBackupCSV;`,context);
  context.filtered();
  assert.equal(marked,0);
  assert.match(downloads[0].csv,/甲/);
  assert.doesNotMatch(downloads[0].csv,/乙/);
  context.full();
  assert.equal(marked,0);
  assert.match(downloads[1].csv,/甲/);
  assert.match(downloads[1].csv,/乙/);
  assert.match(downloads[1].name,/本機全部摘要/);
});

test('CSV 欄位包含逗號、引號或換行時應正確轉義', () => {
  const context={};
  vm.runInNewContext(`${extractFunction(inlineScript,'csvCell')}; this.run=csvCell;`,context);
  assert.equal(context.run('甲,乙'), '"甲,乙"');
  assert.equal(context.run('甲"乙'), '"甲""乙"');
  assert.equal(context.run('甲\n乙'), '"甲\n乙"');
});

test('詳細備份保留紀錄全部欄位，簡潔 CSV 不標記備份日期', () => {
  const files=[];
  let marked=0;
  const context={
    localRecs:[{empId:'1',siteId:'A001',timestamp:'2026-10-03T00:00:00Z',originalTime:'08:00',correctionReason:'補正'}],
    dlFile:(body,name)=>files.push({body,name}),
    markBackupDone:()=>{marked++;},showToast(){},today:()=> '2026-10-03',
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'exportAuditBackupJSON')}; this.run=exportAuditBackupJSON;`,context);
  context.run();
  assert.equal(marked,1);
  assert.match(files[0].name,/\.json$/);
  assert.deepEqual(JSON.parse(files[0].body).records,context.localRecs);
  assert.doesNotMatch(extractFunction(inlineScript,'exportFullBackupCSV'),/markBackupDone\(/);
});

test('清除前摘要顯示筆數、日期範圍和上次備份日', () => {
  let message='';
  const context={
    localRecs:[{date:'2026-10-02',synced:true,fbSynced:true},{date:'2026-10-01',synced:true,fbSynced:true}],
    localStorage:createStorage({last_backup_date:'2026-10-02'}),
    confirm:text=>{message=text;return false;},
    saveRecs(){},loadRecords(){},showToast(){},
  };
  vm.runInNewContext(`${extractFunction(inlineScript,'clearLocal')}; this.run=clearLocal;`,context);
  context.run();
  assert.match(message,/2 筆/);
  assert.match(message,/2026-10-01/);
  assert.match(message,/2026-10-02/);
  assert.match(message,/上次備份：2026-10-02/);
});

test('代班成功提示須在本機紀錄寫入後才出現', () => {
  assert.match(extractFunction(inlineScript, 'doSubPunch'), /await _saveSubPunchRec\(/);
  assert.match(extractFunction(inlineScript, 'doSubPunchNew'), /await _saveSubPunchRec\(/);
});

test('後台紀錄應標示目前是本機已同步資料', () => {
  assert.match(extractFunction(inlineScript, 'loadRecords'), /本機現有紀錄（較早資料請查詢 Sheets）/);
});

test('Apps Script 寫入完成後必須釋放文件鎖', () => {
  const rows = [];
  let released = false;
  const sheet = {
    getLastRow: () => rows.length + 1,
    getLastColumn: () => 12,
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

test('後台分析中幹部只能看見分配案場，管理員可看全部', () => {
  const records = [{ timestamp: 'a', siteId: 'A058' }, { timestamp: 'b', siteId: 'B002' }, { timestamp: 'legacy', siteId: null }];
  const context = { CURRENT_ROLE: 'supervisor', CURRENT_SUPERVISOR: { sites: ['A058'] } };
  vm.runInNewContext(`${extractFunction(inlineScript, 'getAnalysisSiteScope')}; ${extractFunction(inlineScript, 'filterAnalysisRecords')}; this.run = filterAnalysisRecords;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run(records))), [records[0]]);
  context.CURRENT_ROLE = 'admin';
  assert.equal(context.run(records).length, 3);
});

test('後台分析合併本機與雲端紀錄時同 timestamp 只保留一筆', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'mergeRecordsByTimestamp')}; this.run = mergeRecordsByTimestamp;`, context);
  const merged = context.run([{ timestamp: 'same', source: 'local' }], [{ timestamp: 'same', source: 'cloud' }, { timestamp: 'new' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [{ timestamp: 'same', source: 'local' }, { timestamp: 'new' }]);
});

test('臨時人員歷程只彙整出勤案場與日期，不回傳身分證欄位', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildTempStaffHistory')}; this.run = buildTempStaffHistory;`, context);
  const result = context.run([{ id: 'TMP_1', name: '代班甲', idHash: 'private' }], [
    { empId: 'TMP_1', siteId: 'A058', date: '2026-09-10', type: '上班' },
    { empId: 'TMP_1', siteId: 'B002', date: '2026-09-12', type: '下班' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ id: 'TMP_1', name: '代班甲', attendanceDays: 2, sites: ['A058', 'B002'], lastDate: '2026-09-12' }]);
  assert.equal('idHash' in result[0], false);
});

test('月結檢查統計漏下班、重複、逾期補卡與未同步紀錄', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildMonthCloseSummary')}; this.run = buildMonthCloseSummary;`, context);
  const result = context.run([
    { empId: '1001', date: '2026-09-10', type: '上班', timestamp: 'a', manual: true, createdAt: '2026-10-20', fbSynced: true },
    { empId: '1002', date: '2026-09-11', type: '上班', timestamp: 'b', fbSynced: false },
    { empId: '1002', date: '2026-09-11', type: '上班', timestamp: 'c', fbSynced: true },
  ], '2026-09', '2026-10-20');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { missingOut: 2, duplicate: 1, overdueManual: 1, unsynced: 1 });
});

test('月度備份只含指定月份出勤，且排除完整身分證與驗證資料', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'buildMonthlyBackupPayload')}; this.run = buildMonthlyBackupPayload;`, context);
  const result = context.run('2026-09', {
    records: [{ empId: '1001', date: '2026-09-01' }, { empId: '1002', date: '2026-08-31' }],
    employees: [{ id: '1001', name: '王小明', phone: '0912345678', birthday: '1980-01-01' }],
    sites: [{ id: 'A058', name: '藏美海揚' }], supervisors: [], announcement: '測試',
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.employees[0].phone, undefined);
  assert.equal(result.employees[0].birthday, undefined);
  assert.equal(JSON.stringify(result).includes('0912345678'), false);
  assert.equal(JSON.stringify(result).includes('fullId'), false);
});

test('Apps Script 月度備份只接受 POST 並寫入專屬 Drive 資料夾', () => {
  assert.match(codeGs, /action === 'backupMonthlySnapshot'/);
  assert.match(codeGs, /function backupMonthlySnapshot\(payload\)/);
  assert.match(codeGs, /DriveApp\.createFolder/);
});

test('版本更新紀錄應將目前版本置頂，並提供可閱讀的異動摘要', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getReleaseNotes')}; this.run = getReleaseNotes;`, context);
  const notes = context.run();
  assert.equal(notes[0].version, 'v1.4.18');
  assert.equal(notes[0].date, '2026.10');
  assert.ok(notes[0].changes.some(change => change.includes('浮條')));
  assert.ok(notes.every(note => Array.isArray(note.changes) && note.changes.length > 0));
});

test('管理員登入不可建立固定預設密碼，且要先同步雲端密碼', () => {
  assert.doesNotMatch(inlineScript, /localStorage\.setItem\('admin_pwd_hash','aa8abcd'\)/);
  const goAdmin = extractFunction(inlineScript, 'goAdmin');
  assert.ok(goAdmin.indexOf('syncAuthFromFirebase(authStatus)') < goAdmin.indexOf('if(!getPwdHash())'));
});

test('新 iPhone 沒有本機設定時，員工打卡不可誤跳初始設定', () => {
  const setupModal = { classList: { added: false, add() { this.added = true; } } };
  const navBrand = { textContent: '' };
  const cfgBar = { style: {} };
  const cfgUrl = { textContent: '' };
  const storage = createStorage();
  const context = {
    localStorage: storage,
    SCRIPT_URL: '', IS_DEMO: false, COMPANY: 'DYS 大洋保全', ABSENT_LIMIT: 7, MSG_IN: '', MSG_OUT: '',
    DEFAULT_SCRIPT_URL: 'https://script.google.com/macros/s/live/exec',
    getPwdHash: () => '',
    $: id => ({ 'setup-modal': setupModal, 'nav-brand': navBrand, 'cfg-bar-wrap': cfgBar, 'cfg-bar-url': cfgUrl }[id]),
  };
  vm.runInNewContext(`${extractFunction(inlineScript, 'updateCfgBar')}; ${extractFunction(inlineScript, 'loadConfig')}; this.run = loadConfig;`, context);
  context.run();
  assert.equal(setupModal.classList.added, false);
  assert.equal(context.SCRIPT_URL, 'https://script.google.com/macros/s/live/exec');
  assert.equal(context.IS_DEMO, false);
});

test('後台登入提示應清楚區分管理員密碼與幹部員工編號', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction(inlineScript, 'getLoginRoleGuide')}; this.run = getLoginRoleGuide;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.run('admin'))), {
    title: '管理員登入', hint: '請輸入管理員密碼', button: '登入管理後台',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.run('supervisor'))), {
    title: '幹部登入', hint: '請輸入您的員工編號', button: '以員工編號登入',
  });
});

test('臨時人員身分證僅顯示個資告知，不得要求勾選同意', () => {
  assert.doesNotMatch(html, /id="sub-id-consent"/);
  assert.doesNotMatch(extractFunction(inlineScript, 'subLookupId'), /sub-id-consent/);
  assert.doesNotMatch(codeGs, /payload\.consent !== true/);
  assert.match(codeGs, /個資告知時間/);
});
