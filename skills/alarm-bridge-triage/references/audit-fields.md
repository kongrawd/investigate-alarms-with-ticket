# Audit record fields

One JSON record per decision, in the bridge function's log group. The indexed
fields are cheap to filter on; the rest are read once a record is found.

| Field | Meaning |
| --- | --- |
| `event` | `alarm.delivered`, `alarm.skipped.duplicate`, `alarm.skipped.state`, `alarm.failed`, `event.unrecognized`, `batch.completed` |
| `outcome` | `delivered`, `skipped`, `failed`, `ignored` |
| `incidentId` | Alarm ARN — the correlation key across every record for one incident |
| `taskId` | The investigation this alarm produced |
| `alarmState` | `ALARM`, `OK` or `INSUFFICIENT_DATA` as received |
| `sourceMessageId` | SQS message id, when the alarm arrived via the ingress queue |
| `errorName` | Error class on a failure; the full stack is nested under `error` |
| `function_request_id` | Ties every record from one invocation together |

> Updated during an update-path verification.
