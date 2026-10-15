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
