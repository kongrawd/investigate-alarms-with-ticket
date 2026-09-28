---
name: alarm-bridge-triage
description: >-
  Triage procedure for incidents raised by the CloudWatch alarm bridge. Use this
  skill when an investigation title begins with "CloudWatch Alarm:", when the
  description carries an Alarm ARN, or when asked why an alarm reached DevOps
  Agent but produced no findings. Covers reading the bridge's audit records,
  telling a delivery fault apart from a real workload fault, and checking the
  ingress queue and dead-letter queue before blaming the workload.
metadata:
  agent_types: INCIDENT_TRIAGE
---

# Alarm bridge triage

Incidents titled `CloudWatch Alarm: <name>` arrive from a bridge: a CloudWatch
alarm publishes to an SNS topic, an SQS queue buffers it, and a Lambda function
calls CreateBacklogTask. Establish that the alarm is real before investigating
the workload.

## Establish the alarm is real

1. Read `Alarm ARN`, `Region` and `Account` from the incident description. The
   bridge folds them in because the payload carries nothing else.
2. Read the alarm's history for the transition named in the description. An alarm
   forced with `set-alarm-state` is a test, not an incident.
3. Confirm the state is `ALARM`. The bridge does not open investigations for `OK`
   or `INSUFFICIENT_DATA`, so a recovery arriving here means something else
   published to the topic.

## Separate a delivery fault from a workload fault

The bridge emits one JSON audit record per decision. Filter its log group on
`incidentId` matching the alarm ARN, then read `outcome`:

- `delivered` — the bridge did its job; investigate the workload.
- `skipped` — a duplicate transition or a non-ALARM state. Not an incident.
- `failed` — the bridge could not deliver. Read `errorName` and the nested
  `error.stack`, then check the dead-letter queue depth before anything else.

If no record exists for the alarm, it never reached the bridge. Check the alarm's
action history for `Failed to execute action`, which points at the topic policy or
the KMS key policy rather than the workload.

See `references/audit-fields.md` for every field an audit record carries and what
each one tells you.

## Report

State which of the three cases applies, name the evidence used (audit record,
alarm history, queue depth), and only then describe the workload fault. If the
cause is the delivery path, say so plainly: the alarm is a symptom of the
pipeline, not the service.
