const assert = require('node:assert/strict');
const test = require('node:test');
const { createInMemoryStore, createAttendanceService } = require('../src/v4-attendance-service');

const NOW = '2026-10-16T00:00:00.000Z';
const owner = { actorId: 'uid-1', empId: 'E1' };
const colleague = { actorId: 'uid-2', empId: 'E2' };
const supervisor = { actorId: 'uid-supervisor', empId: 'S1' };

function setup() {
  const seed = {
    principals: [
      { ...owner, role: 'employee' },
      { ...colleague, role: 'employee' },
      { ...supervisor, role: 'supervisor', siteIds: ['site-1'] },
      { actorId: 'uid-other-supervisor', empId: 'S2', role: 'supervisor', siteIds: ['site-2'] },
    ],
    duties: [
      { dutyId: 'duty-1', empId: 'E1', siteId: 'site-1', postName: 'gate', status: 'missing_out', startedAt: '2026-10-15T08:00:00.000Z', endedAt: null, sourceRecordIds: ['original-in-1'] },
      { dutyId: 'duty-2', empId: 'E2', siteId: 'site-1', postName: 'gate', status: 'missing_out', startedAt: NOW, endedAt: null, sourceRecordIds: ['original-in-2'] },
      { dutyId: 'legacy', empId: 'E1', postName: 'gate', status: 'missing_out', startedAt: NOW, endedAt: null },
    ],
  };
  const original = structuredClone(seed);
  const store = createInMemoryStore(seed);
  const firstDevice = createAttendanceService({ store, clock: () => NOW });
  const secondDevice = createAttendanceService({ store, clock: () => NOW });
  return { firstDevice, secondDevice, seed, original };
}

function create(service, overrides = {}) {
  return service.createMakeupCase(owner, { dutyId: 'duty-1', idempotencyKey: 'create-1', ...overrides });
}

function fails(code, run) {
  assert.throws(run, error => error.code === code);
}

test('two devices share one immutable case with original duty provenance', () => {
  const { firstDevice, secondDevice, seed, original } = setup();
  const result = create(firstDevice);
  assert.equal(result.status, 'detected');
  assert.equal(result.version, 1);
  assert.equal(result.empId, 'E1');
  assert.deepEqual(result.sourceRecordIds, ['original-in-1']);
  result.sourceRecordIds.push('tampered');
  result.status = 'applied';
  assert.equal(secondDevice.readMakeupCase(owner, result.caseId).status, 'detected');
  assert.deepEqual(secondDevice.readMakeupCase(owner, result.caseId).sourceRecordIds, ['original-in-1']);
  assert.deepEqual(seed, original);
});

test('identity is resolved from trusted principals and cannot be changed by role or empId claims', () => {
  const { firstDevice } = setup();
  for (const actor of [null, {}, { empId: 'E1' }, { actorId: 'unknown', empId: 'E1' }, { actorId: owner.actorId, empId: 'E2' }]) {
    fails('UNAUTHENTICATED', () => firstDevice.createMakeupCase(actor, { dutyId: 'duty-1', idempotencyKey: 'x' }));
  }
  fails('FORBIDDEN', () => firstDevice.createMakeupCase({ ...colleague, role: 'supervisor', siteIds: ['site-1'] }, { dutyId: 'duty-1', idempotencyKey: 'x' }));
  fails('INVALID_ARGUMENT', () => create(firstDevice, { empId: 'E2' }));
});

test('create retries and different devices cannot create duplicate cases for one duty', () => {
  const { firstDevice, secondDevice } = setup();
  const original = create(firstDevice);
  assert.deepEqual(create(secondDevice), original);
  assert.deepEqual(create(secondDevice, { idempotencyKey: 'another-device' }), original);
  assert.equal(firstDevice.listMakeupCases(owner).length, 1);
  assert.equal(firstDevice.readCaseHistory(owner, original.caseId).events.length, 1);
  fails('IDEMPOTENCY_CONFLICT', () => create(firstDevice, { dutyId: 'legacy' }));
});

test('only the case owner can write and confirmed time preserves append-only history', () => {
  const { firstDevice, secondDevice } = setup();
  const initial = create(firstDevice);
  const request = { caseId: initial.caseId, expectedVersion: 1, action: 'confirm', effectiveAt: '2026-10-15T20:00:00.000Z', reason: '忘記下班打卡', idempotencyKey: 'confirm-1' };
  fails('FORBIDDEN', () => firstDevice.transitionMakeupCase(colleague, request));
  fails('FORBIDDEN', () => firstDevice.transitionMakeupCase(supervisor, request));
  const confirmed = secondDevice.transitionMakeupCase(owner, request);
  assert.equal(confirmed.status, 'employee_confirmed');
  assert.equal(confirmed.version, 2);
  assert.deepEqual(firstDevice.transitionMakeupCase(owner, request), confirmed);
  fails('VERSION_CONFLICT', () => firstDevice.transitionMakeupCase(owner, { ...request, idempotencyKey: 'stale-device' }));
  fails('IDEMPOTENCY_CONFLICT', () => firstDevice.transitionMakeupCase(owner, { ...request, reason: 'different' }));
  const history = firstDevice.readCaseHistory(owner, initial.caseId);
  assert.deepEqual(history.revisions.map(item => item.status), ['detected', 'employee_confirmed']);
  assert.equal(history.revisions[0].effectiveAt, undefined);
  assert.equal(history.events[1].actorId, owner.actorId);
  assert.equal(history.events.length, 2);
  history.revisions[0].status = 'tampered';
  assert.equal(firstDevice.readCaseHistory(owner, initial.caseId).revisions[0].status, 'detected');
});

test('supervisors read pending cases only inside trusted site scope', () => {
  const { firstDevice } = setup();
  const current = create(firstDevice);
  const legacy = create(firstDevice, { dutyId: 'legacy', idempotencyKey: 'legacy-key' });
  assert.equal(firstDevice.readMakeupCase(supervisor, current.caseId).caseId, current.caseId);
  assert.deepEqual(firstDevice.listMakeupCases(supervisor).map(item => item.caseId), [current.caseId]);
  fails('FORBIDDEN', () => firstDevice.readMakeupCase(supervisor, legacy.caseId));
  fails('FORBIDDEN', () => firstDevice.readMakeupCase(colleague, current.caseId));
  fails('FORBIDDEN', () => firstDevice.readCaseHistory(colleague, current.caseId));
  const otherSupervisor = { actorId: 'uid-other-supervisor', empId: 'S2', siteIds: ['site-1'], role: 'supervisor' };
  fails('FORBIDDEN', () => firstDevice.readMakeupCase(otherSupervisor, current.caseId));
  assert.deepEqual(firstDevice.listMakeupCases(colleague), []);
  firstDevice.transitionMakeupCase(owner, { caseId: current.caseId, expectedVersion: 1, action: 'cancel', idempotencyKey: 'cancel-1' });
  fails('FORBIDDEN', () => firstDevice.readMakeupCase(supervisor, current.caseId));
  assert.deepEqual(firstDevice.listMakeupCases(supervisor), []);
});

test('invalid requests and approval/apply cannot write a revision or audit', () => {
  const { firstDevice } = setup();
  fails('INVALID_ARGUMENT', () => create(firstDevice, { idempotencyKey: '' }));
  const current = create(firstDevice);
  const base = { caseId: current.caseId, expectedVersion: 1, action: 'confirm', effectiveAt: '2026-10-15T20:00:00.000Z', reason: '本人確認', idempotencyKey: 'invalid' };
  for (const change of [{ action: 'approve' }, { action: 'apply' }, { effectiveAt: 'invalid' }, { effectiveAt: '2026-10-14T00:00:00.000Z' }, { effectiveAt: '2026-10-17T00:00:00.000Z' }, { expectedVersion: '1' }, { reason: '' }, { empId: 'E2' }]) {
    fails('INVALID_ARGUMENT', () => firstDevice.transitionMakeupCase(owner, { ...base, ...change }));
  }
  assert.equal(firstDevice.readMakeupCase(owner, current.caseId).version, 1);
  assert.equal(firstDevice.readCaseHistory(owner, current.caseId).events.length, 1);
});

test('one device winning a cancellation prevents a second device confirming stale data', () => {
  const { firstDevice, secondDevice } = setup();
  const current = create(firstDevice);
  const cancelled = firstDevice.transitionMakeupCase(owner, { caseId: current.caseId, expectedVersion: 1, action: 'cancel', idempotencyKey: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  fails('VERSION_CONFLICT', () => secondDevice.transitionMakeupCase(owner, { caseId: current.caseId, expectedVersion: 1, action: 'confirm', effectiveAt: NOW, reason: '本人確認', idempotencyKey: 'confirm' }));
  fails('INVALID_TRANSITION', () => secondDevice.transitionMakeupCase(owner, { caseId: current.caseId, expectedVersion: 2, action: 'cancel', idempotencyKey: 'cancel-again' }));
});
