import { Logger } from '@aws-lambda-powertools/logger';

import { env } from './env';

export { INDEXED_LOG_FIELDS } from './log-fields';

/**
 * Structured audit logging for the alarm bridge, on Powertools for AWS Lambda.
 *
 * Powertools always emits JSON, one object per log event, with `level`, `timestamp`,
 * `service` and — once `addContext` has run — `function_request_id` and `cold_start`. Any
 * extra object passed alongside the message is merged at the root of the event, so the audit
 * fields below stay flat and are therefore usable in a CloudWatch Logs field index policy.
 *
 * Deliberately paired with Lambda's default TEXT log format rather than the JSON advanced
 * logging control: with ALC set to JSON, Lambda nests an already-JSON line under `message`,
 * which would break flat field indexes. Level filtering is Powertools' job instead, via
 * POWERTOOLS_LOG_LEVEL — and because it filters before writing, suppressed records cost
 * nothing to ingest.
 *
 * The trail an auditor follows is: alarm ARN (`incidentId`) → `taskId` → the investigation in
 * the Agent Space. CloudTrail separately records the underlying `aidevops:*` call.
 */
export const logger = new Logger({
  serviceName: env('POWERTOOLS_SERVICE_NAME') ?? 'alarm-to-devops-agent',
});

/** What happened to the alarm. A closed set, so queries can group on it. */
export type AuditOutcome = 'delivered' | 'skipped' | 'failed' | 'ignored';

export interface AuditRecord {
  readonly outcome: AuditOutcome;
  readonly deliveryMode?: string | undefined;
  readonly alarmName?: string | undefined;
  /** Alarm ARN: the correlation key shared by every record for one incident. */
  readonly incidentId?: string | undefined;
  readonly alarmState?: string | undefined;
  /** DevOps Agent backlog task, i.e. the investigation this alarm produced. */
  readonly taskId?: string | undefined;
  /** SQS message this alarm arrived in, when it came off the ingress queue. */
  readonly sourceMessageId?: string | undefined;
  readonly webhookStatus?: number | undefined;
  readonly reason?: string | undefined;
  /** Flat copy of the error class, because a field index cannot reach into `error`. */
  readonly errorName?: string | undefined;
  readonly delivered?: number | undefined;
  readonly skipped?: number | undefined;
  readonly failed?: number | undefined;
}

/**
 * Audit event names. Dotted and low-cardinality so they group cleanly, and closed so a
 * query written against them keeps working.
 */
export type AuditEvent =
  | 'alarm.delivered'
  | 'alarm.skipped.duplicate'
  | 'alarm.skipped.state'
  | 'alarm.failed'
  | 'event.unrecognized'
  | 'batch.completed';

/**
 * Levels are chosen so that INFO alone is a complete audit trail, and raising the level to
 * WARN leaves only the things an operator must act on:
 *
 *   debug — parsing detail, off in production
 *   info  — every audit decision, and the per-invocation summary
 *   warn  — nothing lost, but something unexpected arrived
 *   error — an alarm was not delivered
 */
/**
 * The per-invocation summary, which reports a failed outcome by counting the alarms that
 * failed rather than by carrying one error. The individual failures were already audited with
 * their causes.
 */
type SummaryEvent = 'batch.completed';

/**
 * Overloaded so the type system enforces the rule that matters: a single alarm cannot be
 * recorded as failed without the error that caused it.
 */
export function audit(event: SummaryEvent, record: AuditRecord): void;
export function audit(
  event: Exclude<AuditEvent, SummaryEvent>,
  record: AuditRecord & { readonly outcome: 'failed' },
  cause: unknown,
): void;
export function audit(
  event: Exclude<AuditEvent, SummaryEvent>,
  record: AuditRecord & { readonly outcome: Exclude<AuditOutcome, 'failed'> },
): void;
export function audit(event: AuditEvent, record: AuditRecord, cause?: unknown): void {
  const entry = { event, ...record };

  switch (record.outcome) {
    case 'failed': {
      // Passing the Error itself is Powertools' native form: it serializes to
      // `error: { name, location, message, stack, cause }`, so the stack trace survives —
      // the flat errorName above stays for the field index, which cannot reach into a
      // nested object.
      const error = cause instanceof Error ? cause : undefined;
      if (error) logger.error(event, { ...entry, errorName: error.name, error });
      else logger.error(event, entry);
      return;
    }
    case 'ignored':
      logger.warn(event, entry);
      return;
    default:
      logger.info(event, entry);
  }
}

