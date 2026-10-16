'use strict';

// Local simulation only. No HTTP transport, Firebase SDK, credentials or deployment.
const { createHash } = require('node:crypto');
const states = new WeakMap();
const pendingStatuses = new Set(['detected', 'employee_confirmed']);
const copy = value => structuredClone(value);

function reject(code) {
  throw Object.assign(new Error(code), { code });
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function input(request, required, optional = []) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !required.includes(key) && !optional.includes(key)) ||
      required.some(key => !Object.hasOwn(request, key))) reject('INVALID_ARGUMENT');
  if (!nonempty(request.idempotencyKey)) reject('INVALID_ARGUMENT');
}

function opaqueId(namespace, value) {
  return namespace + '-' + createHash('sha256').update(value).digest('hex');
}

function createInMemoryStore(seed = {}) {
  // Seed data and actor mappings are trusted server fixtures, never client input.
  const snapshot = copy(seed);
  const store = Object.freeze({});
  states.set(store, {
    principals: new Map((snapshot.principals || []).map(item => [item.actorId, item])),
    duties: new Map((snapshot.duties || []).map(item => [item.dutyId, item])),
    candidates: snapshot.handoverCandidates || [],
    cases: new Map(),
    dutyCases: new Map(),
    requests: new Map(),
    seenHints: new Set(),
  });
  return store;
}

function createAttendanceService({ store, clock = () => new Date().toISOString() }) {
  const state = states.get(store);
  if (!state || typeof clock !== 'function') reject('INVALID_ARGUMENT');

  function principal(actor) {
    const verified = actor && state.principals.get(actor.actorId);
    if (!verified || !nonempty(verified.empId) || actor.empId !== verified.empId) reject('UNAUTHENTICATED');
    return verified;
  }

  function now() {
    const value = clock();
    if (!timestamp(value)) reject('INVALID_CLOCK');
    return value;
  }

  function latest(entry) {
    return entry.revisions.at(-1);
  }

  function canRead(actor, record) {
    return record.empId === actor.empId || (actor.role === 'supervisor' &&
      nonempty(record.siteId) && Array.isArray(actor.siteIds) && actor.siteIds.includes(record.siteId) &&
      pendingStatuses.has(record.status));
  }

  function entryFor(actor, caseId, write = false) {
    const entry = state.cases.get(caseId);
    if (!entry || (write ? latest(entry).empId !== actor.empId : !canRead(actor, latest(entry)))) reject('FORBIDDEN');
    return entry;
  }

  function idempotent(actor, operation, request, run) {
    const key = JSON.stringify([actor.actorId, operation, request.idempotencyKey]);
    const fingerprint = JSON.stringify(Object.keys(request).sort().map(name => [name, request[name]]));
    const prior = state.requests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) reject('IDEMPOTENCY_CONFLICT');
      return copy(prior.result);
    }
    // Synchronous operations are atomic in this single-process in-memory simulator.
    const result = run();
    state.requests.set(key, { fingerprint, result: copy(result) });
    return copy(result);
  }

  function append(entry, revision, actor, action, idempotencyKey) {
    entry.revisions.push(copy(revision));
    entry.events.push({
      eventId: opaqueId('audit', JSON.stringify([revision.caseId, revision.version])),
      caseId: revision.caseId,
      actorId: actor.actorId,
      action,
      version: revision.version,
      at: revision.updatedAt,
      idempotencyKey,
    });
    return revision;
  }

  return Object.freeze({
    createMakeupCase(actorClaim, request) {
      const actor = principal(actorClaim);
      input(request, ['dutyId', 'idempotencyKey']);
      if (!nonempty(request.dutyId)) reject('INVALID_ARGUMENT');
      const duty = state.duties.get(request.dutyId);
      if (!duty || duty.empId !== actor.empId) reject('FORBIDDEN');
      return idempotent(actor, 'create', request, () => {
        const existing = state.dutyCases.get(duty.dutyId);
        if (existing) return latest(state.cases.get(existing));
        if (duty.status !== 'missing_out' || duty.endedAt || !timestamp(duty.startedAt)) reject('INVALID_DUTY');
        const at = now();
        const record = {
          caseId: opaqueId('case', duty.dutyId),
          dutyId: duty.dutyId,
          empId: duty.empId,
          siteId: duty.siteId || null,
          sourceRecordIds: copy(duty.sourceRecordIds || []),
          status: 'detected',
          version: 1,
          source: 'local_simulator',
          createdAt: at,
          updatedAt: at,
        };
        const entry = { revisions: [], events: [] };
        append(entry, record, actor, 'create', request.idempotencyKey);
        state.cases.set(record.caseId, entry);
        state.dutyCases.set(duty.dutyId, record.caseId);
        return record;
      });
    },

    readMakeupCase(actorClaim, caseId) {
      const actor = principal(actorClaim);
      return copy(latest(entryFor(actor, caseId)));
    },

    listMakeupCases(actorClaim) {
      const actor = principal(actorClaim);
      return [...state.cases.values()].map(latest).filter(record => canRead(actor, record)).map(copy);
    },

    readCaseHistory(actorClaim, caseId) {
      const actor = principal(actorClaim);
      return copy(entryFor(actor, caseId));
    },

    transitionMakeupCase(actorClaim, request) {
      const actor = principal(actorClaim);
      input(request, ['caseId', 'expectedVersion', 'action', 'idempotencyKey'], ['effectiveAt', 'reason']);
      if (!nonempty(request.caseId) || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 1 ||
          !['confirm', 'cancel'].includes(request.action)) reject('INVALID_ARGUMENT');
      const entry = entryFor(actor, request.caseId, true);
      const duty = state.duties.get(latest(entry).dutyId);
      const at = now();
      if (request.action === 'confirm' && (!timestamp(request.effectiveAt) || !nonempty(request.reason) ||
          Date.parse(request.effectiveAt) <= Date.parse(duty.startedAt) || Date.parse(request.effectiveAt) > Date.parse(at))) reject('INVALID_ARGUMENT');
      if (request.action === 'cancel' && (request.effectiveAt !== undefined || request.reason !== undefined)) reject('INVALID_ARGUMENT');
      return idempotent(actor, 'transition', request, () => {
        const current = latest(entry);
        if (current.version !== request.expectedVersion) reject('VERSION_CONFLICT');
        if (current.status !== 'detected') reject('INVALID_TRANSITION');
        return append(entry, {
          ...current,
          status: request.action === 'confirm' ? 'employee_confirmed' : 'cancelled',
          version: current.version + 1,
          updatedAt: at,
          ...(request.action === 'confirm' ? { effectiveAt: request.effectiveAt, reason: request.reason } : {}),
        }, actor, request.action, request.idempotencyKey);
      });
    },
  });
}

module.exports = { createInMemoryStore, createAttendanceService };
