import { INDEXED_LOG_FIELDS, audit, logger } from './audit-log';

/**
 * Powertools writes through console under the hood, so the spies below capture what would
 * reach CloudWatch. What matters is the level each outcome lands on — an operator filtering
 * at WARN must still see everything that needs action — and that the audit fields stay flat,
 * since a nested field cannot be served by the log group's field index policy.
 */
describe('audit', () => {
  const identity = {
    deliveryMode: 'api',
    alarmName: 'checkout-5xx-rate',
    incidentId: 'arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:checkout-5xx-rate',
    alarmState: 'ALARM',
  };

  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it('logs a delivery at info, carrying the trail from alarm to investigation', () => {
    audit('alarm.delivered', { ...identity, outcome: 'delivered', taskId: 'task-123' });

    expect(info).toHaveBeenCalledWith('alarm.delivered', {
      event: 'alarm.delivered',
      ...identity,
      outcome: 'delivered',
      taskId: 'task-123',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a skip at info, since nothing was lost', () => {
    audit('alarm.skipped.duplicate', { ...identity, outcome: 'skipped', reason: 'within the window' });

    expect(info).toHaveBeenCalledTimes(1);
  });

  it('logs a failed delivery at error, keeping the stack trace', () => {
    const cause = new TypeError('fetch failed');

    audit('alarm.failed', { ...identity, outcome: 'failed' }, cause);

    expect(info).not.toHaveBeenCalled();
    const [, record] = error.mock.calls[0]!;
    // Powertools serializes the Error to { name, location, message, stack, cause }; errorName
    // stays flat alongside it because a field index cannot reach into a nested object.
    expect(record).toMatchObject({ outcome: 'failed', errorName: 'TypeError', error: cause });
  });

  it('still logs at error when the thrown value is not an Error', () => {
    audit('alarm.failed', { ...identity, outcome: 'failed' }, 'boom');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![1]).not.toHaveProperty('error');
  });

  it('logs an unreadable payload at warn: unexpected, but nothing was dropped silently', () => {
    audit('event.unrecognized', { outcome: 'ignored', reason: 'no recognizable CloudWatch alarm' });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps every audit field flat, so the index policy can serve it', () => {
    audit('alarm.delivered', { ...identity, outcome: 'delivered', taskId: 'task-123' });

    const [, record] = info.mock.calls[0]!;
    // The nested `error` object is the one exception, and only on failures.
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      expect(typeof value).not.toBe('object');
      expect(key).not.toContain('.');
    }
  });

  it('indexes only fields that some audit record actually emits', () => {
    audit('alarm.delivered', {
      ...identity,
      outcome: 'delivered',
      taskId: 'task-123',
      sourceMessageId: 'm-1',
    });
    const emitted = new Set(Object.keys(info.mock.calls[0]![1] as object));

    // function_request_id is added by Powertools from the Lambda context, not by us.
    for (const field of INDEXED_LOG_FIELDS.filter((name) => name !== 'function_request_id')) {
      expect(emitted).toContain(field);
    }
  });
});

