import { CreateBacklogTaskCommand, DevOpsAgentClient } from '@aws-sdk/client-devops-agent';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  ALARM_ARN,
  ALARM_NAME,
  alarmActionEvent,
  metricAlarmNotification,
  snsBatchEvent,
  snsEvent,
  sqsEvent,
  sqsRecord,
} from '../devops-agent/cloudwatch-alarms.fixtures';
import { taskResponse } from '../devops-agent/api-responses.fixtures';
import { resetWebhookCredentialsCache } from '../devops-agent/secret-cache';
import { logger } from '../devops-agent/audit-log';
import { handler, resetDeliveryState } from './alarm-to-devops-agent';

const secretsMock = mockClient(SecretsManagerClient);
const devOpsAgentMock = mockClient(DevOpsAgentClient);

const AGENT_SPACE_ID = 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111';
const SECRET_ARN = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:devops-agent-webhook-AbCdEf';
const WEBHOOK_URL = 'https://event-ai.ap-southeast-1.api.aws/webhook/generic/abc123';

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

const fetchCalls: CapturedCall[] = [];
const realFetch = globalThis.fetch;
/**
 * process.env is shared by every file in a jest worker, and these cases both set and
 * delete variables. Snapshotting restores it so behaviour never depends on file order —
 * `restoreMocks` does not cover direct assignment.
 */
const realEnv = { ...process.env };
let webhookStatus = 200;

beforeEach(() => {
  secretsMock.reset();
  devOpsAgentMock.reset();
  resetWebhookCredentialsCache();
  resetDeliveryState();
  fetchCalls.length = 0;
  webhookStatus = 200;

  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ webhookUrl: WEBHOOK_URL, webhookSecret: 'shhh' }),
  });
  devOpsAgentMock.on(CreateBacklogTaskCommand).resolves({ task: taskResponse() });

  // The handler calls postIncident without an injected fetch, so the global is the seam
  // here. postIncident resolves it at call time, which makes this assignment effective.
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ url: String(input), init: init ?? {} });
    return new Response('webhook received', { status: webhookStatus });
  };

  process.env['DELIVERY_MODE'] = 'webhook';
  process.env['WEBHOOK_SECRET_ARN'] = SECRET_ARN;
  process.env['AGENT_SPACE_ID'] = AGENT_SPACE_ID;
});

afterEach(() => {
  process.env = { ...realEnv };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('webhook mode', () => {
  it('signs and posts one incident per alarm', async () => {
    const result = await handler(snsEvent());

    expect(result).toEqual({ delivered: 1, skipped: 0, batchItemFailures: [] });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(WEBHOOK_URL);

    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers['x-amzn-event-signature']).toBeDefined();
    expect(JSON.parse(fetchCalls[0]!.init.body as string)).toMatchObject({
      eventType: 'incident',
      incidentId: ALARM_ARN,
      action: 'created',
      title: `CloudWatch Alarm: ${ALARM_NAME}`,
    });
  });

  it('delivers every alarm in a batch', async () => {
    const event = snsBatchEvent([
      metricAlarmNotification(),
      metricAlarmNotification({ AlarmName: 'checkout-latency', AlarmArn: `${ALARM_ARN}-latency` }),
    ]);

    await expect(handler(event)).resolves.toEqual({ delivered: 2, skipped: 0, batchItemFailures: [] });
  });

  it('skips a repeat of the same alarm state inside the dedup window', async () => {
    await handler(snsEvent());
    const second = await handler(snsEvent());

    expect(second).toEqual({ delivered: 0, skipped: 1, batchItemFailures: [] });
    expect(fetchCalls).toHaveLength(1);
  });

  it('still delivers when the same alarm changes state', async () => {
    await handler(snsEvent());
    await handler(snsEvent(metricAlarmNotification({ NewStateValue: 'OK' })));

    expect(fetchCalls).toHaveLength(2);
    expect(JSON.parse(fetchCalls[1]!.init.body as string).action).toBe('resolved');
  });

  it('reads the webhook secret once for a batch', async () => {
    await handler(snsBatchEvent([metricAlarmNotification(), metricAlarmNotification({ AlarmName: 'other' })]));

    expect(secretsMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
  });

  it('throws on a rejected signature so the invocation is retried or dead-lettered', async () => {
    webhookStatus = 403;

    await expect(handler(snsEvent())).rejects.toMatchObject({ status: 403 });
  });

  it('retries a failed alarm instead of writing it off as a duplicate', async () => {
    // The dedup mark lands only after a confirmed delivery. Marking before would make the
    // Lambda retry look like a duplicate and drop the alarm without dead-lettering it.
    webhookStatus = 500;
    await expect(handler(snsEvent())).rejects.toBeDefined();

    webhookStatus = 200;
    await expect(handler(snsEvent())).resolves.toEqual({ delivered: 1, skipped: 0, batchItemFailures: [] });
    expect(fetchCalls).toHaveLength(2);
  });

  it('delivers the rest of the batch when one alarm fails', async () => {
    const event = snsBatchEvent([
      metricAlarmNotification({ AlarmName: 'first', AlarmArn: `${ALARM_ARN}-first` }),
      metricAlarmNotification({ AlarmName: 'second', AlarmArn: `${ALARM_ARN}-second` }),
      metricAlarmNotification({ AlarmName: 'third', AlarmArn: `${ALARM_ARN}-third` }),
    ]);
    let call = 0;
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ url: String(input), init: init ?? {} });
      call += 1;
      return new Response('x', { status: call === 2 ? 500 : 200 });
    };

    await expect(handler(event)).rejects.toBeDefined();

    // All three attempted; the middle failure did not starve the third.
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls.map((entry) => JSON.parse(entry.init.body as string).title)).toEqual([
      'CloudWatch Alarm: first',
      'CloudWatch Alarm: second',
      'CloudWatch Alarm: third',
    ]);
  });

  it('never calls the DevOps Agent API in webhook mode', async () => {
    await handler(snsEvent());

    expect(devOpsAgentMock).not.toHaveReceivedAnyCommand();
  });
});

describe('api mode', () => {
  beforeEach(() => {
    process.env['DELIVERY_MODE'] = 'api';
  });

  it('creates an investigation task instead of posting a webhook', async () => {
    const result = await handler(alarmActionEvent());

    expect(result).toEqual({ delivered: 1, skipped: 0, batchItemFailures: [] });
    expect(fetchCalls).toHaveLength(0);
    expect(devOpsAgentMock).toHaveReceivedCommandWith(CreateBacklogTaskCommand, {
      agentSpaceId: AGENT_SPACE_ID,
      taskType: 'INVESTIGATION',
      priority: 'HIGH',
    });
  });

  it('sends an idempotency token that is stable per alarm transition', async () => {
    await handler(alarmActionEvent());
    resetDeliveryState();
    await handler(alarmActionEvent());

    const calls = devOpsAgentMock.commandCalls(CreateBacklogTaskCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input.clientToken).toBe(calls[1]!.args[0].input.clientToken);
    expect(calls[0]!.args[0].input.clientToken).toMatch(/^[\x21-\x7E]{1,64}$/);
  });

  it('does not open an investigation for a recovery', async () => {
    // An OK transition means the incident is over; investigating it would bill agent time
    // for nothing. The webhook path passes `resolved` along and lets the agent decide.
    const result = await handler(alarmActionEvent('OK'));

    expect(result).toEqual({ delivered: 0, skipped: 1, batchItemFailures: [] });
    expect(devOpsAgentMock).not.toHaveReceivedAnyCommand();
  });

  it('gives each transition of one alarm a distinct idempotency token', async () => {
    // The raw token input starts with the alarm ARN, which alone can exceed the API's
    // 64-character limit — truncating it would hand every firing the same token and the
    // service would discard all but the first as retries.
    await handler(snsEvent(metricAlarmNotification({ StateChangeTime: '2026-09-25T04:12:07.086+0000' })));
    resetDeliveryState();
    await handler(snsEvent(metricAlarmNotification({ StateChangeTime: '2026-09-25T09:30:00.000+0000' })));

    const tokens = devOpsAgentMock
      .commandCalls(CreateBacklogTaskCommand)
      .map((entry) => entry.args[0].input.clientToken);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not investigate a metric gap', async () => {
    // INSUFFICIENT_DATA means the metric stopped reporting, not that anything is wrong.
    const result = await handler(alarmActionEvent('INSUFFICIENT_DATA'));

    expect(result).toMatchObject({ delivered: 0, skipped: 1 });
    expect(devOpsAgentMock).not.toHaveReceivedAnyCommand();
  });

  it('delivers a genuine re-firing inside the dedup window', async () => {
    // A flap ALARM -> OK -> ALARM is two real incidents; keying dedup on the transition rather
    // than the state alone is what stops the second one being discarded.
    await handler(snsEvent(metricAlarmNotification({ StateChangeTime: '2026-09-25T04:00:00.000+0000' })));
    await handler(snsEvent(metricAlarmNotification({ StateChangeTime: '2026-09-25T04:00:20.000+0000' })));

    expect(devOpsAgentMock).toHaveReceivedCommandTimes(CreateBacklogTaskCommand, 2);
  });

  it('falls back to the queue message id when the payload has no state change time', async () => {
    // Without a discriminator the token was a constant, so every later firing of that alarm
    // was discarded by the service as a retry of the first.
    const withoutTime = metricAlarmNotification({ StateChangeTime: undefined });
    await handler(sqsEvent([sqsRecord(withoutTime, { messageId: 'm-1' })]));
    resetDeliveryState();
    await handler(sqsEvent([sqsRecord(withoutTime, { messageId: 'm-2' })]));

    const tokens = devOpsAgentMock
      .commandCalls(CreateBacklogTaskCommand)
      .map((entry) => entry.args[0].input.clientToken);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('does not read the webhook secret', async () => {
    await handler(alarmActionEvent());

    expect(secretsMock).not.toHaveReceivedAnyCommand();
  });
});

describe('audit trail', () => {
  let info: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  const recordFor = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls.map(([, entry]) => entry as Record<string, unknown>).find((entry) => entry['event'] === event);

  it('records the alarm, the resulting task and the mode on one line', async () => {
    process.env['DELIVERY_MODE'] = 'api';

    await handler(alarmActionEvent());

    expect(recordFor(info, 'alarm.delivered')).toEqual({
      event: 'alarm.delivered',
      outcome: 'delivered',
      deliveryMode: 'api',
      alarmName: ALARM_NAME,
      incidentId: ALARM_ARN,
      alarmState: 'ALARM',
      sourceMessageId: undefined,
      taskId: 'task-123',
    });
  });

  it('closes every invocation with a summary, so counts are auditable without replay', async () => {
    await handler(snsBatchEvent([metricAlarmNotification(), metricAlarmNotification()]));

    expect(recordFor(info, 'batch.completed')).toMatchObject({
      outcome: 'delivered',
      delivered: 1,
      skipped: 1,
      failed: 0,
    });
  });

  it('records a failure at error level with the error name, and still summarizes', async () => {
    webhookStatus = 403;

    await expect(handler(snsEvent())).rejects.toBeDefined();

    expect(recordFor(error, 'alarm.failed')).toMatchObject({
      outcome: 'failed',
      errorName: 'WebhookDeliveryError',
      incidentId: ALARM_ARN,
    });
    // Level follows outcome consistently, so the summary of a failed invocation is visible
    // to an operator filtering at ERROR — alongside the alarm that caused it.
    expect(recordFor(error, 'batch.completed')).toMatchObject({ outcome: 'failed', failed: 1 });
  });

  it('keeps the queue message id on the record, tying an audit line to a redelivery', async () => {
    await handler(sqsEvent([sqsRecord(metricAlarmNotification(), { messageId: 'm-9' })]));

    expect(recordFor(info, 'alarm.delivered')).toMatchObject({ sourceMessageId: 'm-9' });
  });
});

describe('ingress queue batches', () => {
  it('reports only the failed message back for redelivery', async () => {
    const event = sqsEvent([
      sqsRecord(metricAlarmNotification({ AlarmName: 'first', AlarmArn: `${ALARM_ARN}-1` }), { messageId: 'm-1' }),
      sqsRecord(metricAlarmNotification({ AlarmName: 'second', AlarmArn: `${ALARM_ARN}-2` }), { messageId: 'm-2' }),
      sqsRecord(metricAlarmNotification({ AlarmName: 'third', AlarmArn: `${ALARM_ARN}-3` }), { messageId: 'm-3' }),
    ]);
    let call = 0;
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ url: String(input), init: init ?? {} });
      call += 1;
      return new Response('x', { status: call === 2 ? 500 : 200 });
    };

    // Resolves rather than throws: failing the invocation would redeliver all three, and
    // the dedup window would then swallow the two that succeeded. The response is exactly the
    // shape the event source mapping expects — counts live in the audit summary instead.
    const result = await handler(event);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm-2' }] });
    expect(fetchCalls).toHaveLength(3);
  });

  it('reports nothing when the whole batch succeeds', async () => {
    const result = await handler(
      sqsEvent([
        sqsRecord(metricAlarmNotification({ AlarmName: 'a', AlarmArn: `${ALARM_ARN}-a` }), { messageId: 'm-1' }),
        sqsRecord(metricAlarmNotification({ AlarmName: 'b', AlarmArn: `${ALARM_ARN}-b` }), { messageId: 'm-2' }),
      ]),
    );

    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('reports an unreadable message so it is redelivered and then dead-lettered', async () => {
    const result = await handler(
      sqsEvent([
        sqsRecord(metricAlarmNotification(), { messageId: 'm-good' }),
        { ...sqsRecord(), messageId: 'm-bad', body: 'not json' },
      ]),
    );

    // Previously this message was acknowledged and lost with no audit record at all.
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm-bad' }] });
  });

  it('audits and counts the unreadable message, rather than reporting a clean batch', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    await handler(
      sqsEvent([
        sqsRecord(metricAlarmNotification(), { messageId: 'm-good' }),
        { ...sqsRecord(), messageId: 'm-bad', body: 'not json' },
      ]),
    );

    const records = error.mock.calls.map(([, entry]) => entry as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'event.unrecognized',
          outcome: 'failed',
          sourceMessageId: 'm-bad',
          errorName: 'UnreadableAlarmPayload',
        }),
        // The summary must not claim success while a message is on its way to the DLQ.
        expect.objectContaining({ event: 'batch.completed', outcome: 'failed', failed: 1, delivered: 1 }),
      ]),
    );
  });

  it('still fails the invocation when the event has no per-message handle', async () => {
    // An alarm action or direct invoke cannot be partially acknowledged, so the only route
    // to a retry and then the dead-letter queue is to throw.
    webhookStatus = 500;

    await expect(handler(snsEvent())).rejects.toBeDefined();
  });
});

describe('failure shapes', () => {
  it('wraps a thrown non-Error so the invocation still fails with an Error', async () => {
    // Nothing in the SDK throws a bare value, but a fetch polyfill or a bad shim can.
    globalThis.fetch = (async () => {
      throw 'a bare string, not an Error';
    }) as typeof fetch;

    await expect(handler(snsEvent())).rejects.toBeInstanceOf(Error);
  });

  it('aggregates when several alarms in one batch fail', async () => {
    // Non-queue paths cannot report per message, so every failure has to survive in one
    // thrown error rather than the first one masking the rest.
    webhookStatus = 500;
    const event = snsBatchEvent([
      metricAlarmNotification({ AlarmName: 'first', AlarmArn: `${ALARM_ARN}-1` }),
      metricAlarmNotification({ AlarmName: 'second', AlarmArn: `${ALARM_ARN}-2` }),
    ]);

    await expect(handler(event)).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('2 of 2'),
    });
  });

  it('stamps the audit trail with the Lambda request id when a context is passed', async () => {
    const addContext = jest.spyOn(logger, 'addContext').mockImplementation(() => undefined);
    const context = { awsRequestId: 'req-1', functionName: 'bridge' } as never;

    await handler(alarmActionEvent(), context);

    expect(addContext).toHaveBeenCalledWith(context);
  });
});

describe('configuration', () => {
  it('rejects an unknown delivery mode rather than silently doing nothing', async () => {
    process.env['DELIVERY_MODE'] = 'carrier-pigeon';

    await expect(handler(snsEvent())).rejects.toThrow(/DELIVERY_MODE/);
  });

  it('fails when the webhook secret ARN is missing', async () => {
    delete process.env['WEBHOOK_SECRET_ARN'];

    await expect(handler(snsEvent())).rejects.toThrow(/WEBHOOK_SECRET_ARN/);
  });

  it('fails when the Agent Space id is missing in api mode', async () => {
    process.env['DELIVERY_MODE'] = 'api';
    delete process.env['AGENT_SPACE_ID'];

    await expect(handler(snsEvent())).rejects.toThrow(/AGENT_SPACE_ID/);
  });

  it('defaults to api mode, matching the stack default', async () => {
    delete process.env['DELIVERY_MODE'];

    await handler(snsEvent());

    expect(fetchCalls).toHaveLength(0);
    expect(devOpsAgentMock).toHaveReceivedCommand(CreateBacklogTaskCommand);
  });

  it('returns without delivering for an unrecognized event', async () => {
    await expect(handler({ hello: 'world' })).resolves.toEqual({ delivered: 0, skipped: 0, batchItemFailures: [] });
    expect(fetchCalls).toHaveLength(0);
  });
});
