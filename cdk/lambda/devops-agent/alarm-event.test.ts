import { UnreadableAlarmPayload, incidentOf, parseAlarmEvents, parseSqsRecord, sanitize, toIncidentEvent } from './alarm-event';
import {
  ALARM_ARN,
  ALARM_NAME,
  alarmActionEvent,
  alarmStateChangeEvent,
  compositeAlarmNotification,
  metricAlarmNotification,
  snsBatchEvent,
  snsEvent,
  sqsRecord,
} from './cloudwatch-alarms.fixtures';

describe('parseAlarmEvents', () => {
  it('reads an SNS metric alarm notification', () => {
    const [alarm] = parseAlarmEvents(snsEvent());

    expect(alarm).toEqual({
      alarmName: ALARM_NAME,
      alarmArn: ALARM_ARN,
      state: 'ALARM',
      reason: expect.stringContaining('Threshold Crossed'),
      description: 'Checkout service 5xx rate above 5 per minute',
      namespace: 'AWS/ApplicationELB',
      region: 'ap-southeast-1',
      accountId: '123456789012',
      stateChangeTime: '2026-09-25T04:12:07.086+0000',
    });
  });

  it('reads a direct alarm-action invoke, deriving the Region from the alarm ARN', () => {
    const [alarm] = parseAlarmEvents(alarmActionEvent());

    expect(alarm).toMatchObject({
      alarmName: ALARM_NAME,
      alarmArn: ALARM_ARN,
      state: 'ALARM',
      namespace: 'AWS/ApplicationELB',
      region: 'ap-southeast-1',
    });
  });

  it('reads an EventBridge alarm state change', () => {
    const [alarm] = parseAlarmEvents(alarmStateChangeEvent('OK'));

    expect(alarm).toMatchObject({
      alarmName: ALARM_NAME,
      alarmArn: ALARM_ARN,
      state: 'OK',
      namespace: 'AWS/ApplicationELB',
      region: 'ap-southeast-1',
      accountId: '123456789012',
    });
  });

  it('handles a composite alarm, which carries no metric namespace', () => {
    const [alarm] = parseAlarmEvents(snsEvent(compositeAlarmNotification()));

    expect(alarm?.alarmName).toBe('checkout-unhealthy');
    expect(alarm?.namespace).toBeUndefined();
    expect(alarm?.state).toBe('ALARM');
  });

  it('returns every alarm in an SNS batch', () => {
    const event = snsBatchEvent([
      metricAlarmNotification(),
      metricAlarmNotification({ AlarmName: 'checkout-latency', AlarmArn: `${ALARM_ARN}-latency` }),
    ]);

    expect(parseAlarmEvents(event).map((alarm) => alarm.alarmName)).toEqual([ALARM_NAME, 'checkout-latency']);
  });

  it('skips unparseable records instead of failing the whole batch', () => {
    const event = snsEvent() as { Records: unknown[] };
    const good = event.Records[0] as Record<string, unknown>;
    const bad = { ...good, Sns: { ...(good['Sns'] as object), Message: 'not json' } };

    expect(parseAlarmEvents({ Records: [bad, good] })).toHaveLength(1);
  });

  it('ignores valid JSON that is not an alarm notification', () => {
    // The topic is reachable by CloudWatch in every publisher account, so a stray but
    // parseable message must not become a firing alarm by way of default values.
    expect(parseAlarmEvents(snsEvent({ hello: 'world' }))).toEqual([]);
    expect(parseAlarmEvents(snsEvent(metricAlarmNotification({ NewStateValue: undefined })))).toEqual([]);
    expect(parseAlarmEvents(snsEvent(metricAlarmNotification({ AlarmName: undefined })))).toEqual([]);
  });

  it('ignores an alarm-action payload with no state', () => {
    expect(parseAlarmEvents({ source: 'aws.cloudwatch', alarmData: { alarmName: 'x' } })).toEqual([]);
  });

  it('does not mistake a non-record payload for a queue batch', () => {
    expect(parseAlarmEvents({ Records: 'not an array' })).toEqual([]);
    expect(parseAlarmEvents({ Records: ['not an object'] })).toEqual([]);
  });

  it('returns nothing for an event shape it does not recognize', () => {
    expect(parseAlarmEvents({ unexpected: true })).toEqual([]);
    expect(parseAlarmEvents(undefined)).toEqual([]);
    expect(parseAlarmEvents({ Records: [] })).toEqual([]);
  });
});

describe('parseSqsRecord', () => {
  it('reads a raw-delivery message and keeps the message id', () => {
    const alarm = parseSqsRecord(sqsRecord(metricAlarmNotification(), { messageId: 'm-42' }));

    expect(alarm).toMatchObject({ alarmName: ALARM_NAME, state: 'ALARM', sourceMessageId: 'm-42' });
  });

  it('unwraps the SNS envelope when a source topic does not use raw delivery', () => {
    // Guessing wrong here fails silently, so both subscription modes are supported.
    const alarm = parseSqsRecord(
      sqsRecord(metricAlarmNotification(), { messageId: 'm-7', rawMessageDelivery: false }),
    );

    expect(alarm).toMatchObject({ alarmName: ALARM_NAME, state: 'ALARM', sourceMessageId: 'm-7' });
  });

  it('names which part of the body it could not read', () => {
    // Each message points at a different failure, because they mean different things to
    // whoever is looking at the dead-letter queue.
    expect(() => parseSqsRecord({ ...sqsRecord(), body: '"a string, not an object"' })).toThrow(
      /not a JSON object/,
    );
    expect(() =>
      parseSqsRecord({ ...sqsRecord(), body: JSON.stringify({ Type: 'Notification', Message: 'not json' }) }),
    ).toThrow(/SNS envelope Message is not JSON/);
    expect(() =>
      parseSqsRecord({
        ...sqsRecord(),
        body: JSON.stringify({ Type: 'Notification', Message: '"a string"' }),
      }),
    ).toThrow(/SNS envelope Message is not a JSON object/);
  });

  it('throws on an unreadable body, so the message is reported and eventually dead-lettered', () => {
    // Returning nothing would let SQS delete a mis-wired publisher's traffic with no trace.
    expect(() => parseSqsRecord({ ...sqsRecord(), body: 'not json' })).toThrow(UnreadableAlarmPayload);
    expect(() => parseSqsRecord(sqsRecord({ hello: 'world' }))).toThrow(
      /not a CloudWatch alarm notification/,
    );
    expect(() => parseSqsRecord({ messageId: 'm-1' })).toThrow(/no string body/);
  });
});

describe('incidentOf', () => {
  it('falls back to the alarm name so identity never goes missing', () => {
    expect(incidentOf({ alarmName: 'x', state: 'ALARM' })).toBe('cloudwatch-alarm:x');
    expect(incidentOf({ alarmName: 'x', state: 'ALARM', alarmArn: ALARM_ARN })).toBe(ALARM_ARN);
  });
});

describe('toIncidentEvent', () => {
  const alarm = parseAlarmEvents(snsEvent())[0]!;

  it('uses the alarm ARN as incidentId so repeat firings dedup server side', () => {
    expect(toIncidentEvent(alarm).incidentId).toBe(ALARM_ARN);
  });

  it('falls back to the alarm name when no ARN is present', () => {
    const noArn = parseAlarmEvents(snsEvent(metricAlarmNotification({ AlarmArn: undefined })))[0]!;

    expect(toIncidentEvent(noArn).incidentId).toBe(`cloudwatch-alarm:${ALARM_NAME}`);
  });

  it('folds context into description and leaves data unset, because the webhook drops data', () => {
    const incident = toIncidentEvent(alarm);

    expect(incident.data).toBeUndefined();
    expect(incident.description).toContain('Checkout service 5xx rate');
    expect(incident.description).toContain('State reason: Threshold Crossed');
    expect(incident.description).toContain(`Alarm ARN: ${ALARM_ARN}`);
    expect(incident.description).toContain('Account: 123456789012');
  });

  it('maps each alarm state explicitly, and INSUFFICIENT_DATA to neither', () => {
    // Mapping a metric gap to 'created' billed an investigation for every quiet period.
    expect(toIncidentEvent(alarm).action).toBe('created');
    expect(toIncidentEvent({ ...alarm, state: 'OK' }).action).toBe('resolved');
    expect(toIncidentEvent({ ...alarm, state: 'INSUFFICIENT_DATA' }).action).toBe('updated');
  });

  it('passes the metric namespace through as the service', () => {
    expect(toIncidentEvent(alarm).service).toBe('AWS/ApplicationELB');
  });

  it('defaults to HIGH priority and honours an override', () => {
    expect(toIncidentEvent(alarm).priority).toBe('HIGH');
    expect(toIncidentEvent(alarm, 'CRITICAL').priority).toBe('CRITICAL');
  });

  it('strips control characters from agent-visible text', () => {
    const incident = toIncidentEvent({ ...alarm, reason: 'bad\u0007reason' });

    expect(incident.description).toContain('badreason');
  });

  it('clamps the title so it stays inside the API limit', () => {
    const longName = 'a'.repeat(500);
    const incident = toIncidentEvent({ ...alarm, alarmName: longName });

    expect(incident.title.length).toBeLessThanOrEqual(256);
  });
});

describe('sanitize', () => {
  it('returns undefined for empty input rather than an empty string', () => {
    expect(sanitize(undefined, 10)).toBeUndefined();
    expect(sanitize('', 10)).toBeUndefined();
  });

  it('keeps newlines and tabs, which carry meaning in a description', () => {
    expect(sanitize('one\ntwo\tthree', 100)).toBe('one\ntwo\tthree');
  });
});
