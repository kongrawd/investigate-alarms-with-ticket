/**
 * Sample CloudWatch alarm events, one per delivery shape the handler accepts.
 *
 * The field sets mirror the documented schemas rather than a trimmed-down version, so a
 * test that passes here is evidence about production payloads:
 *
 *  - SNS metric / composite alarm notifications:
 *    https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Notify_Users_Alarm_Changes.html
 *  - direct Lambda alarm action:
 *    https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-actions-Lambda.html
 *  - EventBridge CloudWatch Alarm State Change:
 *    https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch-and-eventbridge.html
 *
 * Account and Agent Space ids are AWS's reserved example values, so nothing here points at
 * a real environment. Override them when replaying a fixture at a deployed function.
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';

export const ACCOUNT_ID = '123456789012';
export const REGION = 'ap-southeast-1';
export const ALARM_NAME = 'checkout-5xx-rate';
export const ALARM_ARN = `arn:aws:cloudwatch:${REGION}:${ACCOUNT_ID}:alarm:${ALARM_NAME}`;
export const STATE_CHANGE_TIME = '2026-09-25T04:12:07.086+0000';

const REASON =
  'Threshold Crossed: 1 out of the last 1 datapoints [12.0 (25/09/26 04:11:00)] was greater than the threshold (5.0) (minimum 1 datapoint for OK -> ALARM transition).';

const REASON_DATA = JSON.stringify({
  version: '1.0',
  queryDate: '2026-09-25T04:12:07.082+0000',
  startDate: '2026-09-25T04:11:00.000+0000',
  statistic: 'Sum',
  period: 60,
  recentDatapoints: [12.0],
  threshold: 5.0,
});

/** The JSON document CloudWatch publishes to SNS for a metric alarm. */
export function metricAlarmNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AlarmName: ALARM_NAME,
    AlarmDescription: 'Checkout service 5xx rate above 5 per minute',
    AWSAccountId: ACCOUNT_ID,
    AlarmConfigurationUpdatedTimestamp: '2026-09-20T09:00:00.000+0000',
    NewStateValue: 'ALARM',
    NewStateReason: REASON,
    StateChangeTime: STATE_CHANGE_TIME,
    Region: 'Asia Pacific (Singapore)',
    AlarmArn: ALARM_ARN,
    OldStateValue: 'OK',
    OKActions: [],
    AlarmActions: [`arn:aws:sns:${REGION}:${ACCOUNT_ID}:alarms-to-devops-agent`],
    InsufficientDataActions: [],
    Trigger: {
      MetricName: 'HTTPCode_Target_5XX_Count',
      Namespace: 'AWS/ApplicationELB',
      StatisticType: 'Statistic',
      Statistic: 'SUM',
      Unit: null,
      Dimensions: [{ name: 'LoadBalancer', value: 'app/checkout/1234567890abcdef' }],
      Period: 60,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 5.0,
      TreatMissingData: 'notBreaching',
      EvaluateLowSampleCountPercentile: null,
    },
    ...overrides,
  };
}

/**
 * Composite alarm notification. Deliberately included: the composite schema has no
 * `Trigger`, so anything that assumes a metric namespace is present breaks on it.
 */
export function compositeAlarmNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AlarmName: 'checkout-unhealthy',
    AlarmDescription: 'Any checkout signal degraded',
    AWSAccountId: ACCOUNT_ID,
    NewStateValue: 'ALARM',
    NewStateReason: `arn:aws:cloudwatch:${REGION}:${ACCOUNT_ID}:alarm:${ALARM_NAME} transitioned to ALARM`,
    StateChangeTime: STATE_CHANGE_TIME,
    Region: 'Asia Pacific (Singapore)',
    AlarmArn: `arn:aws:cloudwatch:${REGION}:${ACCOUNT_ID}:alarm:checkout-unhealthy`,
    OldStateValue: 'OK',
    OKActions: [],
    AlarmActions: [`arn:aws:sns:${REGION}:${ACCOUNT_ID}:alarms-to-devops-agent`],
    InsufficientDataActions: [],
    AlarmRule: `ALARM("${ALARM_NAME}") OR ALARM("checkout-latency")`,
    TriggeringChildren: [{ Arn: ALARM_ARN, State: { Value: 'ALARM', Timestamp: STATE_CHANGE_TIME } }],
    ...overrides,
  };
}

/** Wraps an alarm notification in the SNS event envelope Lambda receives. */
export function snsEvent(notification: Record<string, unknown> = metricAlarmNotification()): unknown {
  const topicArn = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:alarms-to-devops-agent`;

  return {
    Records: [
      {
        EventSource: 'aws:sns',
        EventVersion: '1.0',
        EventSubscriptionArn: `${topicArn}:0b6941ba-9b1e-4f8c-9d3e-2a5c7e1f4b90`,
        Sns: {
          Type: 'Notification',
          MessageId: 'd2c3f4a5-6b78-49ca-8def-1234567890ab',
          TopicArn: topicArn,
          Subject: `ALARM: "${notification['AlarmName']}" in Asia Pacific (Singapore)`,
          Message: JSON.stringify(notification),
          Timestamp: '2026-09-25T04:12:08.123Z',
          SignatureVersion: '1',
          Signature: 'EXAMPLEsignature==',
          SigningCertUrl: `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-EXAMPLE.pem`,
          UnsubscribeUrl: `https://sns.${REGION}.amazonaws.com/?Action=Unsubscribe`,
          MessageAttributes: {},
        },
      },
    ],
  };
}

/** Several alarms arriving in one SNS batch, e.g. one root cause tripping two alarms. */
export function snsBatchEvent(notifications: Record<string, unknown>[]): unknown {
  const event = snsEvent() as { Records: unknown[] };
  const template = event.Records[0] as Record<string, unknown>;

  return {
    Records: notifications.map((notification, index) => ({
      ...template,
      Sns: {
        ...(template['Sns'] as Record<string, unknown>),
        MessageId: `d2c3f4a5-6b78-49ca-8def-00000000000${index}`,
        Message: JSON.stringify(notification),
      },
    })),
  };
}

/** Payload delivered when a Lambda function is set directly as an alarm action. */
export function alarmActionEvent(state = 'ALARM'): unknown {
  return {
    source: 'aws.cloudwatch',
    alarmArn: ALARM_ARN,
    accountId: ACCOUNT_ID,
    time: STATE_CHANGE_TIME,
    region: REGION,
    alarmData: {
      alarmName: ALARM_NAME,
      state: {
        value: state,
        reason: REASON,
        reasonData: REASON_DATA,
        timestamp: STATE_CHANGE_TIME,
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold Crossed: back within threshold.',
        timestamp: '2026-09-25T04:06:07.086+0000',
      },
      configuration: {
        description: 'Checkout service 5xx rate above 5 per minute',
        metrics: [
          {
            id: '1234e046-06f0-a3da-9534-EXAMPLEe4c',
            metricStat: {
              metric: {
                namespace: 'AWS/ApplicationELB',
                name: 'HTTPCode_Target_5XX_Count',
                dimensions: { LoadBalancer: 'app/checkout/1234567890abcdef' },
              },
              period: 60,
              stat: 'Sum',
            },
            returnData: true,
          },
        ],
      },
    },
  };
}

/**
 * EventBridge `CloudWatch Alarm State Change`. The same detail-type is also emitted
 * under source `aws.monitoring` with best-effort delivery, which is why the parser keys
 * off `detail.alarmName` rather than the source.
 */
export function alarmStateChangeEvent(state = 'ALARM'): unknown {
  return {
    version: '0',
    id: 'c4c1c1c9-6542-e61b-6ef0-8c4d36933a92',
    'detail-type': 'CloudWatch Alarm State Change',
    source: 'aws.cloudwatch',
    account: ACCOUNT_ID,
    time: '2026-09-25T04:12:07Z',
    region: REGION,
    resources: [ALARM_ARN],
    detail: {
      alarmName: ALARM_NAME,
      configuration: {
        description: 'Checkout service 5xx rate above 5 per minute',
        metrics: [
          {
            id: '30b6c6b2-a864-43a2-4877-c09a1afc3b87',
            metricStat: {
              metric: {
                namespace: 'AWS/ApplicationELB',
                name: 'HTTPCode_Target_5XX_Count',
                dimensions: { LoadBalancer: 'app/checkout/1234567890abcdef' },
              },
              period: 60,
              stat: 'Sum',
            },
            returnData: true,
          },
        ],
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold Crossed: back within threshold.',
        reasonData: REASON_DATA,
        timestamp: '2026-09-25T04:06:07.086+0000',
      },
      state: {
        value: state,
        reason: REASON,
        reasonData: REASON_DATA,
        timestamp: STATE_CHANGE_TIME,
      },
    },
  };
}

/**
 * The payload the DevOps Agent docs use to verify a webhook without asking for real
 * work: the [TEST] markers tell the triage agent to skip rather than investigate.
 */
export function webhookVerificationNotification(): Record<string, unknown> {
  return metricAlarmNotification({
    AlarmName: 'TEST-webhook-verification',
    AlarmDescription: '[TEST] Webhook integration test - not a real incident. No investigation needed.',
    NewStateReason: '[TEST] Manual test to verify webhook connectivity from Lambda. Safe to ignore.',
  });
}

/**
 * A message on the ingress queue. `rawMessageDelivery` mirrors the SNS subscription
 * setting: when true the body is the alarm notification itself, when false it is an SNS
 * envelope carrying the notification as a string. Both reach the queue in practice.
 */
export function sqsRecord(
  notification: Record<string, unknown> = metricAlarmNotification(),
  { messageId = 'msg-1', rawMessageDelivery = true, topicArn = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:team-alarms` } = {},
): SQSRecord {
  const body = rawMessageDelivery
    ? JSON.stringify(notification)
    : JSON.stringify({
        Type: 'Notification',
        MessageId: 'c1d2e3f4-5678-90ab-cdef-EXAMPLE22222',
        TopicArn: topicArn,
        Subject: `ALARM: "${notification['AlarmName']}"`,
        Message: JSON.stringify(notification),
        Timestamp: '2026-09-25T04:12:08.123Z',
      });

  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1790000000000',
      SenderId: 'AIDAIEXAMPLE',
      ApproximateFirstReceiveTimestamp: '1790000000001',
    },
    messageAttributes: {},
    md5OfBody: 'd41d8cd98f00b204e9800998ecf8427e',
    eventSource: 'aws:sqs',
    eventSourceARN: `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:AlarmIngressQueue`,
    awsRegion: REGION,
  };
}

/** A batch off the ingress queue, as an event source mapping delivers it. */
export function sqsEvent(records: SQSRecord[] = [sqsRecord()]): SQSEvent {
  return { Records: records };
}
