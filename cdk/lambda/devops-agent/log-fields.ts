/**
 * Field names indexed on the bridge's log group.
 *
 * Deliberately dependency-free: the CDK stack reads this to build the field index policy,
 * and importing the logger module there would construct a Powertools `Logger` inside every
 * `cdk synth`, and drag the Lambda runtime's dependencies into the infrastructure closure.
 *
 * Kept next to the audit record definition it mirrors — an index on a field nobody logs is
 * silent waste, and a logged field nobody indexed is a slow query.
 */
/**
 * Fields Powertools adds from the Lambda context, which the audit record itself never sets.
 */
type PowertoolsField = 'function_request_id' | 'level' | 'service';

/** Audit fields safe to index: flat, low-to-medium cardinality, and actually emitted. */
export type IndexableLogField =
  | 'event'
  | 'outcome'
  | 'incidentId'
  | 'taskId'
  | 'alarmName'
  | 'alarmState'
  | 'deliveryMode'
  | 'sourceMessageId'
  | 'errorName'
  | PowertoolsField;

export const INDEXED_LOG_FIELDS: readonly IndexableLogField[] = [
  'event',
  'outcome',
  'incidentId',
  'taskId',
  'alarmName',
  'sourceMessageId',
  'function_request_id',
  // A field index policy accepts at most 20 fields; keep this to the ones queries filter on.
] as const satisfies readonly IndexableLogField[];
