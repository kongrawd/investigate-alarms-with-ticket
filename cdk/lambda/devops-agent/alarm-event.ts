import type { CloudWatchAlarmData } from 'aws-lambda';
import {
  isAlarmStateChangeEvent,
  isCloudWatchAlarmEvent,
  isJsonObject,
  isSnsEnvelope,
  isSnsEvent,
  namespaceOf,
  type AlarmNotification,
  type JsonObject,
  type SnsEnvelopeWithMessage,
  type UntrustedSqsRecord,
} from './alarm-payloads';
import type { IncidentAction, IncidentEvent, IncidentPriority } from './webhook-client';

/** The fields we need from an alarm, normalized across the delivery shapes. */
export interface AlarmSummary {
  /**
   * SQS message this alarm arrived in, when the event came from the ingress queue. The
   * handler reports only the failed ids back to Lambda, so a single bad message does not
   * force redelivery of the whole batch.
   */
  readonly sourceMessageId?: string | undefined;
  readonly alarmName: string;
  readonly alarmArn?: string | undefined;
  readonly state: string;
  readonly reason?: string | undefined;
  readonly description?: string | undefined;
  readonly namespace?: string | undefined;
  readonly region?: string | undefined;
  readonly accountId?: string | undefined;
  readonly stateChangeTime?: string | undefined;
}

/**
 * Accepts the three ways a CloudWatch alarm can reach a Lambda function:
 *
 *  - SNS notification (`Records[].Sns.Message` holds the alarm JSON)
 *  - EventBridge `CloudWatch Alarm State Change`
 *  - a direct alarm action invoke (`alarmData`, via the
 *    lambda.alarms.cloudwatch.amazonaws.com principal)
 *
 * Unrecognized records are skipped rather than thrown, so one malformed message in a
 * batch cannot block the rest.
 */
export function parseAlarmEvents(event: unknown): AlarmSummary[] {
  if (isSnsEvent(event)) {
    return event.Records.flatMap((record) => {
      const alarm = readNotification(record.Sns.Message);
      return alarm ? [alarm] : [];
    });
  }

  if (isCloudWatchAlarmEvent(event)) {
    return [fromAlarmData(event.alarmData, { alarmArn: event.alarmArn, accountId: event.accountId })];
  }

  if (isAlarmStateChangeEvent(event)) {
    return [
      fromAlarmData(event.detail, {
        alarmArn: event.resources[0],
        accountId: event.account,
        region: event.region,
      }),
    ];
  }

  return [];
}

/** Parses a notification document, returning undefined for anything unreadable. */
function readNotification(message: string): AlarmSummary | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    return undefined;
  }
  return isJsonObject(payload) ? fromNotification(payload) : undefined;
}

/** Thrown when a queue message cannot be read as an alarm, so the batch processor reports it. */
export class UnreadableAlarmPayload extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnreadableAlarmPayload';
  }
}

/**
 * Reads one message off the ingress queue.
 *
 * The body depends on how the SNS subscription was created, and both forms appear in
 * practice: with raw message delivery enabled the body is the alarm notification itself,
 * and without it the body is an SNS envelope carrying the notification as a JSON string in
 * `Message`. Subscriptions this stack creates use raw delivery, but a topic somebody else
 * already wired to the queue may not, and guessing wrong fails silently.
 *
 * An EventBridge alarm state change forwarded to the queue is also accepted.
 *
 * Throws rather than returning nothing: a message the bridge cannot read must be reported as
 * a batch item failure so it is redelivered and eventually dead-lettered. Silently returning
 * an empty result would let SQS delete it, losing a mis-wired publisher's traffic without a
 * trace.
 */
export function parseSqsRecord(record: UntrustedSqsRecord): AlarmSummary {
  if (typeof record.body !== 'string') {
    throw new UnreadableAlarmPayload('SQS record has no string body');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(record.body);
  } catch {
    throw new UnreadableAlarmPayload('SQS record body is not JSON');
  }
  if (!isJsonObject(payload)) {
    throw new UnreadableAlarmPayload('SQS record body is not a JSON object');
  }

  // SNS envelope: unwrap and re-parse the inner notification.
  const document: JsonObject = isSnsEnvelope(payload) ? unwrapEnvelope(payload) : payload;

  // An EventBridge event forwarded onto the queue is accepted too.
  const alarm = isAlarmStateChangeEvent(document) ? parseAlarmEvents(document)[0] : fromNotification(document);

  if (!alarm) {
    throw new UnreadableAlarmPayload('SQS record body is not a CloudWatch alarm notification');
  }
  return { ...alarm, sourceMessageId: record.messageId };
}

function unwrapEnvelope(envelope: SnsEnvelopeWithMessage): JsonObject {
  let inner: unknown;
  try {
    inner = JSON.parse(envelope.Message);
  } catch {
    throw new UnreadableAlarmPayload('SNS envelope Message is not JSON');
  }
  if (!isJsonObject(inner)) {
    throw new UnreadableAlarmPayload('SNS envelope Message is not a JSON object');
  }
  return inner;
}

/**
 * Returns undefined for anything that is not an alarm notification. The topic is open to
 * CloudWatch in every account listed as a publisher, so defaulting a missing name or state
 * would turn any stray-but-valid JSON — an operator's test message, a mis-wired publisher —
 * into a firing high-priority alarm.
 */
function fromNotification(payload: JsonObject): AlarmSummary | undefined {
  const alarm = payload as AlarmNotification;
  if (typeof alarm.AlarmName !== 'string' || typeof alarm.NewStateValue !== 'string') return undefined;

  return {
    alarmName: alarm.AlarmName,
    alarmArn: alarm.AlarmArn,
    state: alarm.NewStateValue,
    reason: alarm.NewStateReason,
    description: alarm.AlarmDescription ?? undefined,
    namespace: alarm.Trigger?.Namespace,
    // CloudWatch puts a display name ("Asia Pacific (Singapore)") in the SNS payload's
    // Region field. The agent needs the Region code to scope an API call or log query, and
    // the other two ingress shapes already supply one, so normalize from the ARN.
    region: regionFromArn(alarm.AlarmArn),
    accountId: alarm.AWSAccountId,
    stateChangeTime: alarm.StateChangeTime,
  };
}

/** Where the alarm identity lives outside `alarmData`, which differs per ingress shape. */
interface AlarmDataContext {
  readonly alarmArn?: string | undefined;
  readonly accountId?: string | undefined;
  readonly region?: string | undefined;
}

function fromAlarmData(alarmData: CloudWatchAlarmData, context: AlarmDataContext): AlarmSummary {
  return {
    alarmName: alarmData.alarmName,
    alarmArn: context.alarmArn,
    state: alarmData.state.value,
    reason: alarmData.state.reason,
    description: alarmData.configuration?.description,
    namespace: namespaceOf(alarmData.configuration),
    region: context.region ?? regionFromArn(context.alarmArn),
    accountId: context.accountId,
    stateChangeTime: alarmData.state.timestamp,
  };
}

function regionFromArn(arn: string | undefined): string | undefined {
  return arn?.split(':')[3] || undefined;
}

/**
 * Stable identity for an alarm, used as the incident id, the dedup key and the audit
 * correlation key. One helper because three call sites previously each invented their own
 * fallback, so a notification without an ARN correlated differently in each place.
 */
export function incidentOf(alarm: AlarmSummary): string {
  return alarm.alarmArn ?? `cloudwatch-alarm:${alarm.alarmName}`;
}

/** Strips control characters and clamps length before anything reaches the agent. */
export function sanitize(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLength);
}

/**
 * Maps an alarm onto the webhook payload.
 *
 * Everything the agent should see goes into `description`, because the webhook drops
 * `data` before the investigation is created. `incidentId` is the alarm ARN so repeat
 * firings of the same alarm collapse server side instead of opening parallel
 * investigations.
 */
export function toIncidentEvent(
  alarm: AlarmSummary,
  priority: IncidentPriority = 'HIGH',
): IncidentEvent {
  return {
    eventType: 'incident',
    incidentId: incidentOf(alarm),
    action: actionFor(alarm.state),
    priority,
    title: sanitize(`CloudWatch Alarm: ${alarm.alarmName}`, 256) ?? alarm.alarmName,
    description: foldContext(alarm),
    timestamp: alarm.stateChangeTime ?? new Date().toISOString(),
    service: sanitize(alarm.namespace, 128),
  };
}

/**
 * Alarms have three states, and only ALARM is a new incident. INSUFFICIENT_DATA means the
 * metric stopped reporting — a deploy, a scale-in, a quiet period — so it is reported as an
 * update rather than opening an investigation. Mapping it to `created` (the old `state !==
 * 'OK'` behaviour) billed agent time for every metric gap.
 */
function actionFor(state: string): IncidentAction {
  switch (state) {
    case 'ALARM':
      return 'created';
    case 'OK':
      return 'resolved';
    default:
      return 'updated';
  }
}

function foldContext(alarm: AlarmSummary): string | undefined {
  const lines = [
    alarm.description,
    alarm.reason ? `State reason: ${alarm.reason}` : undefined,
    `State: ${alarm.state}`,
    alarm.alarmArn ? `Alarm ARN: ${alarm.alarmArn}` : undefined,
    alarm.region ? `Region: ${alarm.region}` : undefined,
    alarm.accountId ? `Account: ${alarm.accountId}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return sanitize(lines.join('\n'), 4096);
}
