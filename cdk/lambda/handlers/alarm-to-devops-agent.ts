import { createHash } from 'node:crypto';
import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import type { Context, SQSRecord } from 'aws-lambda';
import {
  incidentOf,
  parseAlarmEvents,
  parseSqsRecord,
  toIncidentEvent,
  type AlarmSummary,
} from '../devops-agent/alarm-event';
import { isSqsEvent } from '../devops-agent/alarm-payloads';
import { startInvestigation } from '../devops-agent/api-client';
import { audit, logger } from '../devops-agent/audit-log';
import { env, requireEnv } from '../devops-agent/env';
import { getWebhookCredentials } from '../devops-agent/secret-cache';
import { postIncident } from '../devops-agent/webhook-client';

/**
 * Bridges CloudWatch alarms into DevOps Agent. Defaults to `api`, matching the stack.
 *
 *   DELIVERY_MODE=webhook  HMAC-signed POST to the Agent Space's generic webhook.
 *                          This is the only path that can also fire an Event trigger,
 *                          i.e. run a custom agent — the trigger itself is created in
 *                          the Operator Web App, since CreateTrigger only accepts
 *                          schedule conditions.
 *   DELIVERY_MODE=api      SigV4 CreateBacklogTask. No shared secret, and it can carry a
 *                          ticket reference, but it always starts a plain investigation.
 *
 * Env: DELIVERY_MODE, WEBHOOK_SECRET_ARN (webhook mode), AGENT_SPACE_ID (api mode),
 *      DEVOPS_AGENT_REGION (optional, defaults to the function's Region).
 */
type DeliveryMode = 'webhook' | 'api';

const DEDUP_WINDOW_MS = 60_000;

/**
 * Collapses redeliveries of the same alarm transition. Keyed on the transition, not just the
 * state, so a genuine re-firing inside the window is still delivered; it only spans a warm
 * container, so it trims duplicates rather than guaranteeing once-only delivery. Correlating
 * several alarms from one root cause needs shared state (e.g. DynamoDB with a TTL).
 */
const recentlySeen = new Map<string, number>();

/**
 * Handles SQS batches with partial failure reporting, which AWS recommends over hand-rolled
 * collection: a record handler that throws is recorded in `batchItemFailures`, so only the
 * failed messages are redelivered and an unreadable one eventually reaches the dead-letter
 * queue instead of being acknowledged.
 */
const batchProcessor = new BatchProcessor(EventType.SQS);

export interface BridgeResult {
  readonly batchItemFailures: { itemIdentifier: string }[];
  /** Present for the non-queue ingress paths, which have no per-message handle. */
  readonly delivered?: number;
  readonly skipped?: number;
}

export const handler = async (event: unknown, context?: Context): Promise<BridgeResult> => {
  // Stamps every record in this invocation with function_request_id and cold_start, which is
  // what ties an audit trail together and back to the REPORT line.
  if (context) logger.addContext(context);

  const mode = deliveryMode();
  const counts = { delivered: 0, skipped: 0, failed: 0 };

  if (isSqsEvent(event)) {
    const response = await processPartialResponse(
      event,
      (record: SQSRecord) => deliverSqsRecord(record, mode, counts),
      batchProcessor,
      // A wholly failed batch is a normal outcome here — every message is reported and
      // redelivered — so it must not also throw, which would discard the partial response.
      { ...(context ? { context } : {}), throwOnFullBatchFailure: false },
    );

    auditSummary(mode, counts);
    return response;
  }

  const alarms = parseAlarmEvents(event);
  if (alarms.length === 0) {
    audit('event.unrecognized', { outcome: 'ignored', reason: 'no recognizable CloudWatch alarm in event' });
    return { delivered: 0, skipped: 0, batchItemFailures: [] };
  }

  const failures: Error[] = [];
  for (const alarm of alarms) {
    try {
      await deliver(alarm, mode, counts);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  auditSummary(mode, counts);

  // No per-message handle on these paths, so the only route to a retry and then the
  // dead-letter queue is to fail the invocation.
  const [firstFailure, ...otherFailures] = failures;
  if (firstFailure) {
    throw otherFailures.length === 0
      ? firstFailure
      : new AggregateError(failures, `${failures.length} of ${alarms.length} alarms failed to deliver`);
  }

  return { delivered: counts.delivered, skipped: counts.skipped, batchItemFailures: [] };
};

/** Test seam: clears the in-container dedup window between cases. */
export function resetDeliveryState(): void {
  recentlySeen.clear();
}

type Counts = { delivered: number; skipped: number; failed: number };

async function deliverSqsRecord(record: SQSRecord, mode: DeliveryMode, counts: Counts): Promise<void> {
  let alarm: AlarmSummary;
  try {
    // Parsing inside the record handler is what makes an unreadable body a reported failure
    // rather than a silent acknowledgement.
    alarm = parseSqsRecord(record);
  } catch (error) {
    // Audited here rather than left to the batch processor: the message is about to be
    // redelivered and then dead-lettered, so it has to be visible and counted. Without this
    // the summary reported failed=0 while a message was quietly on its way to the DLQ.
    counts.failed += 1;
    audit(
      'event.unrecognized',
      { outcome: 'failed', deliveryMode: mode, sourceMessageId: record.messageId },
      error,
    );
    throw error;
  }

  await deliver(alarm, mode, counts);
}

async function deliver(alarm: AlarmSummary, mode: DeliveryMode, counts: Counts): Promise<void> {
  const identity = {
    deliveryMode: mode,
    alarmName: alarm.alarmName,
    incidentId: incidentOf(alarm),
    alarmState: alarm.state,
    sourceMessageId: alarm.sourceMessageId,
  };

  if (wasRecentlySeen(alarm)) {
    audit('alarm.skipped.duplicate', {
      ...identity,
      outcome: 'skipped',
      reason: `this transition was already delivered within the ${DEDUP_WINDOW_MS}ms window`,
    });
    counts.skipped += 1;
    return;
  }

  const incident = toIncidentEvent(alarm);

  // Only a firing alarm is a new incident. OK is a recovery and INSUFFICIENT_DATA is a metric
  // gap; in api mode either would open an investigation and bill agent time for an incident
  // that is over or never happened. The webhook carries the state through and lets the agent
  // decide.
  if (mode === 'api' && alarm.state !== 'ALARM') {
    audit('alarm.skipped.state', {
      ...identity,
      outcome: 'skipped',
      reason: `state ${alarm.state} maps to '${incident.action}': nothing to investigate`,
    });
    counts.skipped += 1;
    return;
  }

  try {
    if (mode === 'webhook') {
      const { webhookUrl, webhookSecret } = await getWebhookCredentials(requireEnv('WEBHOOK_SECRET_ARN'));
      const status = await postIncident(webhookUrl, webhookSecret, incident);
      audit('alarm.delivered', { ...identity, outcome: 'delivered', webhookStatus: status });
    } else {
      const taskId = await startInvestigation({
        agentSpaceId: requireEnv('AGENT_SPACE_ID'),
        title: incident.title,
        description: incident.description,
        priority: incident.priority,
        clientToken: clientToken(alarm),
      });
      audit('alarm.delivered', { ...identity, outcome: 'delivered', taskId });
    }
    // Marked only after a confirmed delivery. Marking earlier would make a retry of a failed
    // delivery look like a duplicate, dropping the alarm silently.
    markDelivered(alarm);
    counts.delivered += 1;
  } catch (error) {
    counts.failed += 1;
    audit('alarm.failed', { ...identity, outcome: 'failed' }, error);
    throw error;
  }
}

function auditSummary(mode: DeliveryMode, counts: Counts): void {
  audit('batch.completed', {
    outcome: counts.failed > 0 ? 'failed' : 'delivered',
    deliveryMode: mode,
    delivered: counts.delivered,
    skipped: counts.skipped,
    failed: counts.failed,
  });
}

function deliveryMode(): DeliveryMode {
  const mode = env('DELIVERY_MODE') ?? 'api';
  if (mode !== 'webhook' && mode !== 'api') {
    throw new Error(`DELIVERY_MODE must be 'webhook' or 'api', got '${mode}'`);
  }
  return mode;
}

/**
 * Identifies one alarm transition. `stateChangeTime` is part of the key so that a flap
 * (ALARM → OK → ALARM inside the window) delivers the second firing: without it the local
 * window was stricter than the idempotency token it exists to complement, and discarded real
 * incidents.
 */
function transitionKey(alarm: AlarmSummary): string {
  return `${incidentOf(alarm)}:${alarm.state}:${alarm.stateChangeTime ?? alarm.sourceMessageId ?? ''}`;
}

function wasRecentlySeen(alarm: AlarmSummary): boolean {
  const now = Date.now();
  for (const [seenKey, seenAt] of recentlySeen) {
    if (now - seenAt > DEDUP_WINDOW_MS) recentlySeen.delete(seenKey);
  }

  const previous = recentlySeen.get(transitionKey(alarm));
  return previous !== undefined && now - previous < DEDUP_WINDOW_MS;
}

function markDelivered(alarm: AlarmSummary): void {
  recentlySeen.set(transitionKey(alarm), Date.now());
}

/**
 * Stable across redeliveries of one alarm transition, distinct across transitions.
 *
 * Hashed rather than truncated: the raw string starts with the alarm ARN, which on its own
 * often exceeds the API's 64-character limit, so slicing would hand every transition of that
 * alarm the same token and the service would discard all but the first as retries.
 *
 * `stateChangeTime` is the natural discriminator, but a hand-built payload may omit it, which
 * would make the token a constant for that alarm forever. An SQS messageId is the fallback:
 * AWS guarantees a redelivered message keeps the same id, so it is stable per attempt yet
 * unique per transition.
 */
function clientToken(alarm: AlarmSummary): string {
  const discriminator = alarm.stateChangeTime ?? alarm.sourceMessageId ?? alarm.reason ?? '';
  return createHash('sha256').update(`${incidentOf(alarm)}:${alarm.state}:${discriminator}`).digest('hex');
}
