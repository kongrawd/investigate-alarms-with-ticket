import type {
  CloudWatchAlarmCompositeConfiguration,
  CloudWatchAlarmConfiguration,
  CloudWatchAlarmData,
  CloudWatchAlarmEvent,
  CloudWatchAlarmMetric,
  CloudWatchAlarmMetricDataQuery,
  CloudWatchAlarmState,
  EventBridgeEvent,
  SNSEvent,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';

/**
 * Declared shapes for every payload the bridge accepts, plus the guards that narrow an
 * `unknown` event onto them.
 *
 * Kept separate from the parser so that "what the wire looks like" is stated once, in types,
 * rather than being implied by property access on `any`. Every field is optional or
 * `unknown`: these describe untrusted input, and a publisher can always send something
 * incomplete — the guards are what establish the invariants the parser then relies on.
 *
 * Where AWS already publishes a type (`SQSEvent`, `SNSEvent`, `CloudWatchAlarmEvent`,
 * `EventBridgeEvent`) it is reused rather than restated.
 */

/** Any JSON value, for payload bodies that have not been narrowed yet. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue | undefined };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The document CloudWatch publishes to SNS for a metric alarm. Optional throughout because
 * composite and log alarms omit `Trigger`, and because nothing stops another publisher
 * putting a different document on a subscribed topic.
 *
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Notify_Users_Alarm_Changes.html
 */
export interface AlarmNotification {
  readonly AlarmName?: string;
  readonly AlarmDescription?: string | null;
  readonly AWSAccountId?: string;
  readonly NewStateValue?: string;
  readonly NewStateReason?: string;
  readonly OldStateValue?: string;
  readonly StateChangeTime?: string;
  /** A display name such as "Asia Pacific (Singapore)", not a Region code. */
  readonly Region?: string;
  readonly AlarmArn?: string;
  readonly Trigger?: { readonly Namespace?: string; readonly MetricName?: string };
  /** Composite alarms carry these instead of `Trigger`. */
  readonly AlarmRule?: string;
}

/** An SNS notification envelope, as delivered when raw message delivery is off. */
export interface SnsEnvelope {
  readonly Type?: string;
  readonly TopicArn?: string;
  readonly Subject?: string;
  readonly Message?: string;
}

/** An envelope whose `Message` has been confirmed present, so it can be parsed. */
export type SnsEnvelopeWithMessage = JsonObject & SnsEnvelope & { readonly Message: string };

export function isSnsEnvelope(value: JsonObject): value is SnsEnvelopeWithMessage {
  return value['Type'] === 'Notification' && typeof value['Message'] === 'string';
}

/** Detail of an EventBridge `CloudWatch Alarm State Change` event. */
export type AlarmStateChangeDetail = CloudWatchAlarmData;

export type AlarmStateChangeEvent = EventBridgeEvent<'CloudWatch Alarm State Change', AlarmStateChangeDetail>;

/** Narrows an event that carries alarm data under `detail`, as EventBridge delivers it. */
export function isAlarmStateChangeEvent(value: unknown): value is AlarmStateChangeEvent {
  if (!isJsonObject(value)) return false;
  const detail = value['detail'];
  return isJsonObject(detail) && hasAlarmIdentity(detail);
}

/** Narrows a direct alarm-action invoke, which carries the same data under `alarmData`. */
export function isCloudWatchAlarmEvent(value: unknown): value is CloudWatchAlarmEvent {
  if (!isJsonObject(value)) return false;
  const alarmData = value['alarmData'];
  return isJsonObject(alarmData) && hasAlarmIdentity(alarmData);
}

/**
 * Both of the above shapes need a name and a state value to be usable. Checked here so the
 * two guards cannot drift apart, and so a payload missing either is rejected rather than
 * defaulted into a firing alarm.
 */
function hasAlarmIdentity(data: JsonObject): boolean {
  const state = data['state'];
  return typeof data['alarmName'] === 'string' && isJsonObject(state) && typeof state['value'] === 'string';
}

export function isSqsEvent(value: unknown): value is SQSEvent {
  if (!isJsonObject(value) || !Array.isArray(value['Records'])) return false;
  return value['Records'].some((record) => isJsonObject(record) && record['eventSource'] === 'aws:sqs');
}

export function isSnsEvent(value: unknown): value is SNSEvent {
  if (!isJsonObject(value) || !Array.isArray(value['Records'])) return false;
  return value['Records'].some((record) => isJsonObject(record) && isJsonObject(record['Sns']));
}

/** The metric namespace, when the alarm watches a metric rather than other alarms. */
export function namespaceOf(
  configuration: CloudWatchAlarmConfiguration | CloudWatchAlarmCompositeConfiguration | undefined,
): string | undefined {
  if (!configuration || !('metrics' in configuration)) return undefined;
  const metric = configuration.metrics?.find(isMetricQuery);
  return metric?.metricStat?.metric?.namespace;
}

function isMetricQuery(query: CloudWatchAlarmMetricDataQuery): query is CloudWatchAlarmMetric {
  return 'metricStat' in query;
}

/**
 * An SQS record as the parser treats it: the id is required, and the body is `unknown` because
 * nothing guarantees a publisher put a string there. A real `SQSRecord` satisfies this.
 */
export interface UntrustedSqsRecord {
  readonly messageId: string;
  readonly body?: unknown;
}

export type { CloudWatchAlarmData, CloudWatchAlarmEvent, CloudWatchAlarmState, SQSRecord };
