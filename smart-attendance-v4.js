(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.SmartAttendanceV4 = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;

  function partsAt(epoch, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(epoch));
    const result = {};
    for (const part of parts) if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }

  function dateKey(epoch, timeZone) {
    const parts = partsAt(epoch, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  function parseEventTime(record, timeZone) {
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp.trim() : '';
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(timestamp)) {
      const calendarDate = new Date(`${timestamp.slice(0, 10)}T00:00:00Z`);
      if (!Number.isFinite(calendarDate.getTime()) ||
          calendarDate.toISOString().slice(0, 10) !== timestamp.slice(0, 10)) return null;
      const epoch = Date.parse(timestamp);
      return Number.isFinite(epoch) ? epoch : null;
    }
    const local = record.date && record.time ? `${record.date}T${record.time}` : timestamp;
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(local);
    if (!match) return null;
    const target = match.slice(1).map(value => Number(value || 0));
    const [year, month, day, hour, minute, second] = target;
    const wallTime = Date.UTC(year, month - 1, day, hour, minute, second);
    if (!Number.isFinite(wallTime)) return null;
    let epoch = wallTime;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = partsAt(epoch, timeZone);
      const actualWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      epoch += wallTime - actualWallTime;
    }
    const actual = partsAt(epoch, timeZone);
    return [actual.year, actual.month, actual.day, actual.hour, actual.minute, actual.second]
      .every((value, index) => value === target[index]) ? epoch : null;
  }

  function median(values) {
    const ordered = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function buildDutyPairs(records, options = {}) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    const timeZone = options.timeZone || 'Asia/Taipei';
    const maxDutyHours = options.maxDutyHours === undefined ? 24 : options.maxDutyHours;
    if (!Number.isFinite(maxDutyHours) || maxDutyHours <= 0 || maxDutyHours > 24) {
      throw new RangeError('maxDutyHours must be between 0 and 24');
    }
    const maxDuration = maxDutyHours * 60 * MINUTE;
    const usedIds = new Set();
    const events = records.map((record, index) => {
      if (!record || typeof record !== 'object') throw new TypeError('each record must be an object');
      const rawId = record.eventId ?? record.recordId ?? record.id ?? `index:${index}`;
      let id = String(rawId);
      let suffix = index;
      while (usedIds.has(id)) id = `${rawId}#${suffix++}`;
      usedIds.add(id);
      const epoch = parseEventTime(record, timeZone);
      const empId = String(record.empId ?? '').trim();
      const siteId = String(record.siteId ?? '').trim();
      const postName = String(record.postName ?? '').trim();
      return { id, index, epoch, empId, siteId, postName, type: record.type,
        isSubstitute: record.isSubstitute !== undefined && record.isSubstitute !== false,
        key: JSON.stringify([empId, siteId, postName]) };
    }).sort((a, b) => (a.epoch ?? Infinity) - (b.epoch ?? Infinity) || a.index - b.index);
    const simultaneousTypes = new Map();
    const invalidTimeGroups = new Set();
    for (const event of events) {
      // Without a timestamp, this group's event order cannot be established safely.
      if (event.epoch === null) invalidTimeGroups.add(event.key);
      const key = `${event.key}|${event.epoch}`;
      if (!simultaneousTypes.has(key)) simultaneousTypes.set(key, new Set());
      simultaneousTypes.get(key).add(event.type);
    }
    const groups = new Map();
    const result = [];

    function makeDuty(status, first, second = null) {
      const sourceRecordIds = second ? [first.id, second.id] : [first.id];
      const startedAt = first.type === '上班' && first.epoch !== null ? new Date(first.epoch).toISOString() : null;
      const endedAt = status === 'complete' ? new Date(second.epoch).toISOString() : null;
      return {
        dutyId: `duty:${encodeURIComponent(first.key)}:${encodeURIComponent(first.id)}`,
        status, empId: first.empId || null, siteId: first.siteId || null,
        ...(first.isSubstitute ? { isSubstitute: true } : {}),
        postName: first.postName || null, sourceRecordIds,
        startedAt, endedAt,
        eventAt: first.epoch !== null ? new Date(first.epoch).toISOString() : null,
        localStartDate: startedAt ? dateKey(first.epoch, timeZone) : null,
        durationMinutes: status === 'complete' ? (second.epoch - first.epoch) / MINUTE : null,
      };
    }

    for (const current of events) {
      if (invalidTimeGroups.has(current.key)) {
        result.push(makeDuty('ambiguous', current));
        continue;
      }
      if (!current.empId || !current.siteId || !current.postName || current.epoch === null ||
          (current.type !== '上班' && current.type !== '下班')) {
        if (current.empId && current.siteId && current.postName && current.epoch !== null) {
          const state = groups.get(current.key) || { open: null, last: null, conflicted: false, uncertain: false };
          if (state.open) result.push(makeDuty('ambiguous', state.open));
          state.open = null;
          state.last = null;
          state.conflicted = false;
          state.uncertain = true;
          groups.set(current.key, state);
        }
        result.push(makeDuty('ambiguous', current));
        continue;
      }
      let state = groups.get(current.key);
      if (!state) {
        state = { open: null, last: null, conflicted: false, uncertain: false };
        groups.set(current.key, state);
      }
      const atSameMoment = simultaneousTypes.get(`${current.key}|${current.epoch}`);
      if (atSameMoment.size > 1) {
        if (state.open) result.push(makeDuty('ambiguous', state.open));
        result.push(makeDuty('ambiguous', current));
        state.open = null;
        state.conflicted = false;
        state.uncertain = true;
        state.last = current;
        continue;
      }
      if (current.type === '上班') {
        if (state.open) {
          if (current.epoch - state.open.epoch <= 2 * MINUTE) {
            result.push(makeDuty('duplicate', current));
            continue;
          }
          const expired = current.epoch - state.open.epoch > maxDuration;
          result.push(makeDuty(expired && !state.conflicted ? 'missing_out' : 'ambiguous', state.open));
          state.conflicted = !expired;
        }
        state.open = current;
        state.uncertain = false;
        state.last = current;
      } else if (state.open) {
        const duration = current.epoch - state.open.epoch;
        if (state.conflicted) {
          result.push(makeDuty('ambiguous', state.open));
          result.push(makeDuty('ambiguous', current));
        } else if (duration > 0 && duration <= maxDuration) {
          result.push(makeDuty('complete', state.open, current));
        } else {
          result.push(makeDuty(duration <= 0 ? 'ambiguous' : 'missing_out', state.open));
          result.push(makeDuty(duration <= 0 ? 'ambiguous' : 'missing_in', current));
        }
        state.open = null;
        state.conflicted = false;
        state.last = current;
      } else {
        const repeated = state.last && state.last.type === '下班' &&
          current.epoch - state.last.epoch <= 2 * MINUTE;
        result.push(makeDuty(state.uncertain ? 'ambiguous' : repeated ? 'duplicate' : 'missing_in', current));
        state.uncertain = false;
        state.last = current;
      }
    }
    for (const state of groups.values()) if (state.open) {
      result.push(makeDuty(state.conflicted ? 'ambiguous' : 'missing_out', state.open));
    }
    return result.sort((a, b) => Date.parse(a.eventAt || '9999-12-31') -
      Date.parse(b.eventAt || '9999-12-31') || a.dutyId.localeCompare(b.dutyId));
  }

  function buildDutySummary(duties) {
    const complete = duties.filter(duty => duty.status === 'complete' &&
      duty.startedAt && duty.endedAt && Number.isFinite(duty.durationMinutes));
    return {
      completeCount: complete.length,
      incompleteCount: duties.length - complete.length,
      medianMinutes: complete.length ? median(complete.map(duty => duty.durationMinutes)) : null,
    };
  }

  function predictDutyEnd(history, duty, options = {}) {
    const timeZone = options.timeZone || 'Asia/Taipei';
    const start = Date.parse(duty.startedAt);
    if (!Number.isFinite(start)) throw new TypeError('duty must have a valid startedAt');
    const target = partsAt(start, timeZone);
    const targetMinutes = target.hour * 60 + target.minute;
    const targetIsWeekend = [0, 6].includes(new Date(Date.UTC(target.year, target.month - 1, target.day)).getUTCDay());
    const durations = history.filter(item => {
      if (item.status !== 'complete' || !item.startedAt || !item.endedAt ||
          item.empId !== duty.empId || item.siteId !== duty.siteId || item.postName !== duty.postName) return false;
      const itemStart = Date.parse(item.startedAt);
      const itemEnd = Date.parse(item.endedAt);
      if (!Number.isFinite(itemStart) || !Number.isFinite(itemEnd) || itemStart >= start ||
          itemEnd > start || start - itemStart > 60 * DAY || itemEnd <= itemStart ||
          itemEnd - itemStart > 24 * 60 * MINUTE) return false;
      const local = partsAt(itemStart, timeZone);
      const minutes = local.hour * 60 + local.minute;
      const weekend = [0, 6].includes(new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay());
      return Math.min(Math.abs(minutes - targetMinutes), 1440 - Math.abs(minutes - targetMinutes)) <= 120 &&
        weekend === targetIsWeekend;
    }).map(item => (Date.parse(item.endedAt) - Date.parse(item.startedAt)) / MINUTE);
    if (!durations.length) return {
      predictedEndAt: null, confidence: 'low', sampleSize: 0,
      medianMinutes: null, dispersionMinutes: null, advisoryOnly: true,
      explanation: 'No comparable completed duties in the last 60 days',
    };
    const center = median(durations);
    const dispersion = median(durations.map(value => Math.abs(value - center)));
    const maxDeviation = Math.max(...durations.map(value => Math.abs(value - center)));
    const confidence = durations.length >= 5 && dispersion <= 30 && maxDeviation <= 60 ? 'high' :
      durations.length >= 3 && dispersion <= 60 ? 'medium' : 'low';
    return {
      predictedEndAt: new Date(start + center * MINUTE).toISOString(), confidence,
      sampleSize: durations.length, medianMinutes: center, dispersionMinutes: dispersion,
      maxDeviationMinutes: maxDeviation,
      advisoryOnly: true,
      explanation: `${durations.length} comparable completed duties; median ${center} minutes; median absolute deviation ${dispersion} minutes; maximum deviation ${maxDeviation} minutes`,
    };
  }

  /**
   * Advisory only. Call after the incoming clock-in has been saved successfully.
   * Pass a complete recent duty snapshot; an incomplete snapshot cannot prove
   * that another overlapping duty is absent. No records or storage are changed.
   * Returns null when uncertain; seenKeys is caller-owned display state.
   */
  function buildHandoverReminder(duties, incomingRecord, options = {}) {
    if (!Array.isArray(duties) || !incomingRecord || !options ||
        options.clockInSucceeded !== true || incomingRecord.type !== '上班') return null;
    const minGapHours = options.minGapHours === undefined ? 4 : options.minGapHours;
    const maxGapHours = options.maxGapHours === undefined ? 16 : options.maxGapHours;
    if (!Number.isFinite(minGapHours) || !Number.isFinite(maxGapHours) ||
        minGapHours <= 0 || maxGapHours < minGapHours || maxGapHours >= 24) return null;
    const timeZone = options.timeZone || 'Asia/Taipei';
    const identity = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    const substituteUncertain = value => value.isSubstitute !== undefined && value.isSubstitute !== false;
    const empId = identity(incomingRecord.empId);
    const siteId = identity(incomingRecord.siteId);
    const postName = identity(incomingRecord.postName);
    if (!empId || !siteId || !postName || substituteUncertain(incomingRecord) || /^TMP_/i.test(empId)) return null;
    let incomingAt;
    try { incomingAt = parseEventTime(incomingRecord, timeZone); }
    catch (_) { return null; }
    if (incomingAt === null) return null;
    const candidates = [];
    for (const duty of duties) {
      if (!duty || typeof duty !== 'object') return null;
      const dutySite = identity(duty.siteId);
      const dutyPost = identity(duty.postName);
      if ((dutySite && dutySite !== siteId) || (dutyPost && dutyPost !== postName)) continue;
      const dutyEmp = identity(duty.empId);
      if (!dutySite || !dutyPost || !dutyEmp || !identity(duty.dutyId) ||
          !Array.isArray(duty.sourceRecordIds) || !duty.sourceRecordIds.length ||
          duty.sourceRecordIds.some(id => !identity(id))) return null;
      let start;
      let end;
      try {
        start = duty.startedAt ? parseEventTime({ timestamp: duty.startedAt }, timeZone) : null;
        end = duty.endedAt ? parseEventTime({ timestamp: duty.endedAt }, timeZone) : null;
      } catch (_) { return null; }
      if (start === null) return null;
      if (duty.status === 'complete' && end !== null && end > start && end <= incomingAt) continue;
      // The newly saved incoming duty may already be in the snapshot.
      if (dutyEmp === empId && start === incomingAt && duty.status === 'missing_out' &&
          duty.endedAt === null && !substituteUncertain(duty)) continue;
      // Complete-but-overlapping, duplicate and ambiguous duties all prevent
      // choosing a previous colleague, even if another candidate looks valid.
      if (duty.status !== 'missing_out' || duty.endedAt !== null ||
          substituteUncertain(duty) || /^TMP_/i.test(dutyEmp) || dutyEmp === empId ||
          duty.sourceRecordIds.length !== 1 || start >= incomingAt) return null;
      candidates.push(start);
    }
    if (candidates.length !== 1) return null;
    const gap = incomingAt - candidates[0];
    if (gap < minGapHours * 60 * MINUTE || gap > maxGapHours * 60 * MINUTE) return null;

    // A compact display-deduplication digest, not an authorization token.
    // Hash only the recipient's own clock-in and scope, never another duty's
    // employee ID, event ID, name or attendance times.
    const input = JSON.stringify([siteId, postName, empId, incomingAt]);
    let first = 2166136261;
    let second = 3339675911;
    for (let index = 0; index < input.length; index += 1) {
      first = Math.imul(first ^ input.charCodeAt(index), 16777619);
      second = Math.imul(second ^ input.charCodeAt(index), 2246822519);
    }
    const key = `handover:v1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
    const seenKeys = options.seenKeys;
    if ((Array.isArray(seenKeys) && seenKeys.includes(key)) ||
        (seenKeys && typeof seenKeys.has === 'function' && seenKeys.has(key))) return null;
    return {
      key, title: '交接班貼心提醒',
      message: '交接勤務時，請順便提醒上一班同仁記得完成下班打卡。\n感謝同仁互相協助！',
    };
  }

  function findPreviousMissingOut(records, incoming, options = {}) {
    if (!Array.isArray(records) || !incoming || incoming.type !== '上班' ||
        options.clockInSucceeded !== true || !incoming.empId || incoming.isSubstitute) return null;
    const timeZone = options.timeZone || 'Asia/Taipei';
    const currentAt = parseEventTime(incoming, timeZone);
    if (currentAt === null) return null;
    const own = records.filter(record => record && String(record.empId) === String(incoming.empId));
    const current = own.filter(record => parseEventTime(record, timeZone) === currentAt);
    if (current.length !== 1 || current[0].type !== '上班') return null;
    const prior = own.filter(record => parseEventTime(record, timeZone) !== currentAt &&
      (parseEventTime(record, timeZone) === null || parseEventTime(record, timeZone) < currentAt));
    if (!prior.length || prior.some(record => parseEventTime(record, timeZone) === null)) return null;
    const ordered = prior.slice().sort((a, b) => parseEventTime(b, timeZone) - parseEventTime(a, timeZone));
    const previous = ordered[0];
    const previousAt = parseEventTime(previous, timeZone);
    if (previous.type !== '上班' || previous.isSubstitute || !previous.siteId || !previous.postName ||
        prior.filter(record => parseEventTime(record, timeZone) === previousAt).length !== 1) return null;
    const projected = prior.map((record, index) => ({...record, eventId: `makeup:${index}`}));
    const previousIndex = prior.indexOf(previous);
    const duties = buildDutyPairs(projected, {timeZone});
    const duty = duties.find(item => item.sourceRecordIds.includes(`makeup:${previousIndex}`));
    if (!duty || duty.status !== 'missing_out' || duty.sourceRecordIds.length !== 1) return null;
    const originalClockIn = {
      timestamp: new Date(previousAt).toISOString(), siteId: String(previous.siteId),
      postName: String(previous.postName),
      eventId: String(previous.eventId ?? previous.recordId ?? previous.id ?? previous.timestamp ?? ''),
    };
    const candidate = {empId: String(incoming.empId), originalClockIn};
    if ((options.cases || []).some(item => item && item.empId === candidate.empId &&
        item.originalClockIn && item.originalClockIn.timestamp === originalClockIn.timestamp)) return null;
    return candidate;
  }

  // Append immutable case revisions: original evidence and earlier confirmations
  // remain present in the local ledger. This never creates an attendance event.
  function appendMakeupCase(cases, candidate, action, options = {}) {
    if (!Array.isArray(cases) || !candidate || !candidate.originalClockIn ||
        !options.empId || String(options.empId) !== candidate.empId) throw new Error('identity mismatch');
    if (!Number.isFinite(Date.parse(options.now))) throw new Error('invalid time');
    if (action === 'draft') {
      if (!options.id || cases.some(item => item.empId === candidate.empId && item.originalClockIn &&
          item.originalClockIn.timestamp === candidate.originalClockIn.timestamp)) throw new Error('case exists or invalid id');
      return [...cases, {id: options.id, empId: candidate.empId,
        originalClockIn: {...candidate.originalClockIn}, status: 'draft', createdAt: options.now, confirmations: []}];
    }
    const latest = cases.filter(item => item.id === candidate.id).at(-1);
    if (!latest || latest.empId !== candidate.empId) throw new Error('identity mismatch');
    if (latest.status === 'requested') throw new Error('already requested');
    if (!['deferred', 'requested'].includes(action)) throw new Error('invalid action');
    const confirmation = {action, confirmedAt: options.now};
    if (action === 'requested') {
      const endedAt = parseEventTime({date: options.endedDate, time: options.endedTime}, options.timeZone || 'Asia/Taipei');
      if (endedAt === null || endedAt < Date.parse(latest.originalClockIn.timestamp)) throw new Error('invalid end time');
      confirmation.proposedEndedAt = new Date(endedAt).toISOString();
    }
    return [...cases, {...latest, originalClockIn: {...latest.originalClockIn}, status: action,
      confirmations: [...latest.confirmations, confirmation]}];
  }

  return { buildDutyPairs, buildDutySummary, predictDutyEnd, buildHandoverReminder, findPreviousMissingOut, appendMakeupCase };
});
