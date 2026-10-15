const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../smart-attendance-v4.js');
const options = { timeZone: 'Asia/Taipei', maxDutyHours: 24 };

function event(id, type, date, time, extra = {}) {
  return { eventId: id, empId: 'E1', siteId: 'S1', postName: 'P1', type, date, time, ...extra };
}

function pair(records, overrides = {}) {
  return core.buildDutyPairs(records, { ...options, ...overrides });
}

test('瀏覽器與 Node 共用相同純函式介面', () => {
  const source = fs.readFileSync(path.join(__dirname, '../smart-attendance-v4.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof context.SmartAttendanceV4.buildDutyPairs, 'function');
  assert.equal(typeof core.predictDutyEnd, 'function');
});

test('跨日、跨月、跨年與正好 24 小時勤務依上班台灣日期歸屬', () => {
  const records = [
    event('out-year', '下班', '2027-01-01', '07:00'),
    event('in-year', '上班', '2026-12-31', '19:00'),
    event('in-month', '上班', '2027-01-31', '08:00'),
    event('out-month', '下班', '2027-02-01', '08:00'),
  ];
  const duties = pair(records);
  assert.deepEqual(duties.map(duty => duty.status), ['complete', 'complete']);
  assert.deepEqual(duties.map(duty => duty.localStartDate), ['2026-12-31', '2027-01-31']);
  assert.deepEqual(duties.map(duty => duty.durationMinutes), [720, 1440]);
  assert.deepEqual(duties.map(duty => duty.sourceRecordIds), [['in-year', 'out-year'], ['in-month', 'out-month']]);
  assert.deepEqual(records, [
    event('out-year', '下班', '2027-01-01', '07:00'),
    event('in-year', '上班', '2026-12-31', '19:00'),
    event('in-month', '上班', '2027-01-31', '08:00'),
    event('out-month', '下班', '2027-02-01', '08:00'),
  ]);
});

test('同日多班逐一配對，員工、案場及哨點互不混用', () => {
  const records = [
    event('a', '上班', '2026-10-15', '06:00'),
    event('b', '下班', '2026-10-15', '12:00'),
    event('c', '上班', '2026-10-15', '13:00'),
    event('d', '下班', '2026-10-15', '20:00'),
    event('wrong-site', '下班', '2026-10-15', '21:00', { siteId: 'S2' }),
    event('wrong-post', '上班', '2026-10-15', '07:00', { postName: 'P2' }),
    event('wrong-person', '下班', '2026-10-15', '18:00', { empId: 'E2' }),
  ];
  const duties = pair(records);
  assert.deepEqual(duties.filter(duty => duty.status === 'complete').map(duty => duty.sourceRecordIds), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(duties.filter(duty => duty.status !== 'complete').map(duty => duty.status).sort(), ['missing_in', 'missing_in', 'missing_out']);
  assert.equal(new Set(duties.flatMap(duty => duty.sourceRecordIds)).size, records.length);
});

test('重複事件與不明班別不會成為完整勤務或虛構下班卡', () => {
  const duties = pair([
    event('in', '上班', '2026-10-15', '08:00'),
    event('repeat', '上班', '2026-10-15', '08:01'),
    event('out', '下班', '2026-10-15', '17:00'),
    event('unknown', '換班', '2026-10-15', '18:00'),
  ]);
  assert.deepEqual(duties.map(duty => duty.status), ['complete', 'duplicate', 'ambiguous']);
  assert.deepEqual(duties.map(duty => duty.sourceRecordIds), [['in', 'out'], ['repeat'], ['unknown']]);
  assert.equal(duties[1].endedAt, null);
  assert.equal(duties[2].endedAt, null);
});

test('超過最大時數及缺少身分欄位時不猜測配對', () => {
  const duties = pair([
    event('too-old', '上班', '2026-10-15', '07:00'),
    event('late-out', '下班', '2026-10-16', '07:01'),
    event('no-site', '上班', '2026-10-16', '08:00', { siteId: null }),
  ]);
  assert.deepEqual(duties.map(duty => duty.status), ['missing_out', 'missing_in', 'ambiguous']);
  assert.ok(duties.every(duty => duty.endedAt === null));
});

test('相隔較久的兩張上班卡競爭同一下班卡時全數待確認', () => {
  const duties = pair([
    event('first-in', '上班', '2026-10-15', '08:00'),
    event('second-in', '上班', '2026-10-15', '16:00'),
    event('out', '下班', '2026-10-15', '20:00'),
  ]);
  assert.deepEqual(duties.map(duty => duty.status), ['ambiguous', 'ambiguous', 'ambiguous']);
  assert.equal(new Set(duties.flatMap(duty => duty.sourceRecordIds)).size, 3);
  assert.ok(duties.every(duty => duty.endedAt === null));
});

test('同一瞬間的上下班事件不因輸入順序而成為完整勤務', () => {
  for (const records of [
    [event('in', '上班', '2026-10-15', '08:00'), event('out', '下班', '2026-10-15', '08:00')],
    [event('out', '下班', '2026-10-15', '08:00'), event('in', '上班', '2026-10-15', '08:00')],
  ]) {
    const duties = pair(records);
    assert.deepEqual(duties.map(duty => duty.status), ['ambiguous', 'ambiguous']);
  }
});

test('兩卡之間有未知班別事件時不跨過衝突自動配對', () => {
  const duties = pair([
    event('in', '上班', '2026-10-15', '08:00'),
    event('unknown', '換班', '2026-10-15', '12:00'),
    event('out', '下班', '2026-10-15', '17:00'),
  ]);
  assert.deepEqual(duties.map(duty => duty.status), ['ambiguous', 'ambiguous', 'ambiguous']);
  assert.equal(new Set(duties.flatMap(duty => duty.sourceRecordIds)).size, 3);
});

test('未知班別與上下班同一瞬間時，各種輸入順序都必須待確認', () => {
  for (const unknownTime of ['08:00', '17:00']) {
    const records = [
      event('in', '上班', '2026-10-15', '08:00'),
      event('out', '下班', '2026-10-15', '17:00'),
      event('unknown', '換班', '2026-10-15', unknownTime),
    ];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const duties = pair(order.map(index => records[index]));
      assert.ok(duties.every(duty => duty.status === 'ambiguous'), `${unknownTime}: ${order}`);
      assert.equal(duties.flatMap(duty => duty.sourceRecordIds).length, 3);
    }
  }
});

test('ISO 不可能日期不可經 Date.parse 正規化成完整勤務', () => {
  for (const timestamp of ['2026-02-30T08:00:00+08:00', '2026-02-30T00:00:00Z']) {
    const duties = pair([
      event('invalid', '上班', null, null, { timestamp }),
      event('out', '下班', '2026-03-02', '17:00'),
    ]);
    assert.equal(duties.find(duty => duty.sourceRecordIds.includes('invalid')).eventAt, null);
    assert.ok(duties.every(duty => duty.status !== 'complete'));
  }
});

test('同組無效時間無法定位時不得跨過資料配對，其他組仍可配對', () => {
  const duties = pair([
    event('in', '上班', '2026-10-15', '08:00'),
    event('invalid', '換班', '2026-10-15', 'invalid'),
    event('out', '下班', '2026-10-15', '17:00'),
    event('other-in', '上班', '2026-10-15', '08:00', { empId: 'E2' }),
    event('other-out', '下班', '2026-10-15', '17:00', { empId: 'E2' }),
  ]);
  assert.ok(duties.filter(duty => duty.empId === 'E1').every(duty => duty.status === 'ambiguous'));
  assert.deepEqual(duties.filter(duty => duty.status === 'complete').map(duty => duty.sourceRecordIds),
    [['other-in', 'other-out']]);
});

test('原始 ID 與自動去重字尾重疊時，每張來源卡仍有唯一 ID', () => {
  const duties = pair([
    event('a', '上班', '2026-10-15', '08:00'),
    event('a#2', '下班', '2026-10-15', '17:00'),
    event('a', '上班', '2026-10-16', '08:00'),
  ]);
  const sourceIds = duties.flatMap(duty => duty.sourceRecordIds);
  assert.equal(sourceIds.length, 3);
  assert.equal(new Set(sourceIds).size, 3);
  assert.equal(new Set(duties.map(duty => duty.dutyId)).size, duties.length);
});

test('預測不能使用目標上班後才結束的勤務', () => {
  const history = pair([
    event('past-in', '上班', '2026-10-08', '08:00'),
    event('past-out', '下班', '2026-10-08', '17:00'),
    event('future-in', '上班', '2026-10-15', '07:00'),
    event('future-out', '下班', '2026-10-15', '18:00'),
  ]);
  const duty = pair([event('current', '上班', '2026-10-15', '08:00')])[0];
  const prediction = core.predictDutyEnd(history, duty, options);
  assert.equal(prediction.sampleSize, 1);
  assert.equal(prediction.medianMinutes, 540);
  assert.equal(prediction.predictedEndAt, '2026-10-15T09:00:00.000Z');
});

test('預測僅使用最近 60 天同條件的完整勤務，以中位數及離散度解釋高可信度', () => {
  const starts = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'];
  const ends = ['17:00', '17:05', '16:55', '17:00', '17:00'];
  const history = pair(starts.flatMap((date, index) => [
    event(`in-${index}`, '上班', date, '08:00'),
    event(`out-${index}`, '下班', date, ends[index]),
  ]));
  history.push(...pair([event('incomplete', '上班', '2026-10-08', '08:00')]));
  const duty = pair([event('current', '上班', '2026-10-15', '08:00')])[0];
  const prediction = core.predictDutyEnd(history, duty, options);
  assert.equal(prediction.confidence, 'high');
  assert.equal(prediction.sampleSize, 5);
  assert.equal(prediction.medianMinutes, 540);
  assert.equal(prediction.dispersionMinutes, 0);
  assert.equal(prediction.predictedEndAt, '2026-10-15T09:00:00.000Z');
  assert.equal(prediction.advisoryOnly, true);
});

test('少於五筆、不同哨點、過舊資料或分散樣本不可得高可信度', () => {
  const duty = pair([event('current', '上班', '2026-10-15', '08:00')])[0];
  const samples = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'];
  const history = pair(samples.flatMap((date, index) => [
    event(`in-${index}`, '上班', date, '08:00'),
    event(`out-${index}`, '下班', date, '17:00'),
  ]));
  history.push(...pair([
    event('old-in', '上班', '2026-07-01', '08:00'), event('old-out', '下班', '2026-07-01', '17:00'),
    event('other-in', '上班', '2026-10-03', '08:00', { postName: 'P2' }), event('other-out', '下班', '2026-10-03', '17:00', { postName: 'P2' }),
  ]));
  const prediction = core.predictDutyEnd(history, duty, options);
  assert.equal(prediction.sampleSize, 4);
  assert.notEqual(prediction.confidence, 'high');
  const spread = history.concat(pair([
    event('wide-in', '上班', '2026-10-08', '08:00'), event('wide-out', '下班', '2026-10-08', '20:00'),
  ]));
  assert.notEqual(core.predictDutyEnd(spread, duty, options).confidence, 'high');
});

test('勤務摘要只統計有真實上班與下班事件的完整勤務', () => {
  const duties = pair([
    event('in', '上班', '2026-10-15', '08:00'),
    event('out', '下班', '2026-10-15', '17:00'),
    event('open', '上班', '2026-10-16', '08:00'),
  ]);
  assert.deepEqual(core.buildDutySummary(duties), {
    completeCount: 1,
    incompleteCount: 1,
    medianMinutes: 540,
  });
});

const handoverOptions = { timeZone: 'Asia/Taipei', clockInSucceeded: true };

function incoming(extra = {}) {
  return event('incoming', '上班', '2026-10-15', '20:00', { empId: 'E2', ...extra });
}

function previous(extra = {}) {
  return pair([event('previous', '上班', '2026-10-15', '08:00', extra)])[0];
}

test('交接提醒是瀏覽器與 Node 共用的純函式', () => {
  const source = fs.readFileSync(path.join(__dirname, '../smart-attendance-v4.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(typeof core.buildHandoverReminder, 'function');
  assert.equal(typeof context.SmartAttendanceV4.buildHandoverReminder, 'function');
  const records = [event('previous', '上班', '2026-10-15', '08:00'), incoming()];
  const duties = pair(records);
  const snapshot = JSON.stringify({ records, duties, handoverOptions });
  const reminder = core.buildHandoverReminder(duties, records[1], handoverOptions);
  const browserReminder = context.SmartAttendanceV4.buildHandoverReminder(duties, records[1], handoverOptions);
  assert.deepEqual(JSON.parse(JSON.stringify(browserReminder)), reminder);
  assert.equal(JSON.stringify({ records, duties, handoverOptions }), snapshot);
});

test('同案場同哨點唯一未下班勤務可提醒，輸出只含不透明鍵與固定文字', () => {
  const duty = previous({ empId: 'PRIVATE_EMPLOYEE', name: '秘密完整姓名', ip: '192.0.2.1' });
  const reminder = core.buildHandoverReminder([duty], incoming(), handoverOptions);
  assert.ok(reminder);
  assert.deepEqual(Object.keys(reminder).sort(), ['key', 'message', 'title']);
  assert.equal(reminder.title, '交接班貼心提醒');
  assert.equal(reminder.message, '交接勤務時，請順便提醒上一班同仁記得完成下班打卡。\n感謝同仁互相協助！');
  assert.match(reminder.key, /^handover:v1:[a-f0-9]+$/);
  for (const privateValue of ['PRIVATE_EMPLOYEE', '秘密完整姓名', '192.0.2.1', duty.dutyId,
    duty.startedAt, '08:00', '2026-10-15', 'previous', 'S1', 'P1']) {
    assert.ok(!JSON.stringify(reminder).includes(privateValue), privateValue);
  }
});

test('交接提醒只允許明確上班成功之後的呼叫', () => {
  for (const settings of [{}, { clockInSucceeded: false }, { clockInSucceeded: 'true' }]) {
    assert.equal(core.buildHandoverReminder([previous()], incoming(), settings), null);
  }
  assert.equal(core.buildHandoverReminder([previous()], incoming({ type: '下班' }), handoverOptions), null);
});

test('不同案場或哨點不構成交接，也不干擾唯一的同組候選', () => {
  const wrongSite = previous({ siteId: 'S2' });
  const wrongPost = previous({ postName: 'P2' });
  assert.equal(core.buildHandoverReminder([wrongSite, wrongPost], incoming(), handoverOptions), null);
  assert.ok(core.buildHandoverReminder([wrongSite, wrongPost, previous()], incoming(), handoverOptions));
});

test('上一班已有下班卡一律不提醒，包括尚未到接班時間的完整勤務', () => {
  for (const outTime of ['19:59', '20:00', '20:01']) {
    const duties = pair([
      event('previous', '上班', '2026-10-15', '08:00'),
      event('out', '下班', '2026-10-15', outTime),
    ]);
    assert.equal(core.buildHandoverReminder(duties, incoming(), handoverOptions), null);
  }
});

test('資料不足、無法辨認案場哨點身分或時間時不猜測交接對象', () => {
  for (const value of [null, {}, [], [null], [previous({ siteId: null })],
    [previous({ postName: '' })], [previous({ empId: '' })],
    [{ ...previous(), startedAt: null }], [{ ...previous(), sourceRecordIds: [] }],
    [{ ...previous(), sourceRecordIds: [null] }], [{ ...previous(), dutyId: {} }],
    [{ ...previous(), status: 'ambiguous' }], [{ ...previous(), status: 'missing_in' }],
    [{ ...previous(), status: 'duplicate' }], [{ ...previous(), endedAt: 'invalid' }]]) {
    assert.equal(core.buildHandoverReminder(value, incoming(), handoverOptions), null);
  }
  for (const extra of [{ siteId: null }, { postName: '' }, { empId: '' },
    { time: 'invalid' }, { date: '2026-02-30' }]) {
    assert.equal(core.buildHandoverReminder([previous()], incoming(extra), handoverOptions), null);
  }
});

test('多人同時值勤或多個上一班候選時略過，不挑最近或任一同仁', () => {
  const first = previous();
  const other = previous({ empId: 'E3' });
  const recentlyStarted = pair([event('recent', '上班', '2026-10-15', '19:30', { empId: 'E3' })])[0];
  const overlappingComplete = pair([
    event('third', '上班', '2026-10-15', '09:00', { empId: 'E3' }),
    event('third-out', '下班', '2026-10-15', '21:00', { empId: 'E3' }),
  ])[0];
  for (const duties of [[first, other], [first, first], [first, recentlyStarted],
    [first, overlappingComplete], [first, { ...other, status: 'ambiguous' }]]) {
    assert.equal(core.buildHandoverReminder(duties, incoming(), handoverOptions), null);
  }
  assert.equal(core.buildHandoverReminder([previous({ empId: 'E2' })], incoming(), handoverOptions), null);
});

test('代班不明與臨時身分不建立交接提醒，勤務配對不遺失代班旗標', () => {
  for (const extra of [{ isSubstitute: true }, { isSubstitute: 'unknown' }, { empId: 'TMP_ABCDEF12' }]) {
    assert.equal(core.buildHandoverReminder([previous(extra)], incoming(), handoverOptions), null);
    assert.equal(core.buildHandoverReminder([previous()], incoming(extra), handoverOptions), null);
  }
  assert.equal(core.buildHandoverReminder([{ ...previous(), isSubstitute: true }], incoming(), handoverOptions), null);
});

test('交接預設僅接受相隔 4 至 16 小時，跨日可用且 24 小時略過', () => {
  for (const [time, allowed] of [['11:59', false], ['12:00', true], ['20:00', true]]) {
    const reminder = core.buildHandoverReminder([previous()], incoming({ time }), handoverOptions);
    assert.equal(Boolean(reminder), allowed, time);
  }
  for (const [date, time, allowed] of [
    ['2026-10-16', '00:00', true], ['2026-10-16', '00:01', false],
    ['2026-10-16', '08:00', false], ['2026-10-15', '08:00', false],
    ['2026-10-15', '07:59', false],
  ]) {
    assert.equal(Boolean(core.buildHandoverReminder([previous()], incoming({ date, time }), handoverOptions)), allowed);
  }
  assert.equal(core.buildHandoverReminder([previous()], incoming(), { ...handoverOptions, maxGapHours: 10 }), null);
  assert.equal(core.buildHandoverReminder([previous()], incoming(), { ...handoverOptions, minGapHours: 13 }), null);
  for (const extra of [{ minGapHours: -1 }, { minGapHours: 0 }, { maxGapHours: 24 },
    { maxGapHours: Infinity }, { minGapHours: 15, maxGapHours: 10 }, { timeZone: 'invalid' }]) {
    assert.equal(core.buildHandoverReminder([previous()], incoming(), { ...handoverOptions, ...extra }), null);
  }
});

test('同一交接的去重鍵不受輸入順序影響，可由已顯示鍵略過', () => {
  const duties = [previous(), previous({ siteId: 'S2' })];
  const reminder = core.buildHandoverReminder(duties, incoming(), handoverOptions);
  assert.ok(reminder);
  assert.deepEqual(core.buildHandoverReminder(duties.slice().reverse(), incoming({ eventId: 'retry' }), handoverOptions), reminder);
  assert.equal(core.buildHandoverReminder(duties, incoming(), { ...handoverOptions, seenKeys: [reminder.key] }), null);
  assert.equal(core.buildHandoverReminder(duties, incoming(), { ...handoverOptions, seenKeys: new Set([reminder.key]) }), null);
  const next = core.buildHandoverReminder([previous()], incoming({ time: '21:00' }), handoverOptions);
  assert.notEqual(next.key, reminder.key);
});
