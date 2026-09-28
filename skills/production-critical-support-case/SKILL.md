---
name: production-critical-support-case
description: >-
  Raises an AWS Support case for a production-critical workload. Use this skill
  when an investigation has findings and the cause needs AWS to act or confirm —
  a service-side fault, an unexplained throttle or quota rejection, a
  control-plane error, or a root cause hypothesis the investigation could not
  confirm. Also use it when asked to open, draft or escalate a Support case for a
  monitor. Covers classifying the workload from the directives and
  understanding-agent-space memory stores, agent instructions and resource tags,
  choosing a severityCode the account's support plan offers, and writing a case
  that reports the findings and asks for validation.
metadata:
  agent_types: INCIDENT_TRIAGE, INCIDENT_RCA, INCIDENT_MITIGATION
---

# Raise a Support case for a production-critical workload

This Agent Space supports critical workloads. Treat every workload as
production-critical unless an explicit record says otherwise.

Raise the case on weak evidence. Set the severity from confirmed impact only.

## Step 1: Classify the workload

Default: **production-critical**. Collect evidence, then apply the rule below.

Read, in order:

1. `directives` memory store — standing records naming this workload.
2. Global agent instructions, then the instructions for this agent type.
3. `understanding-agent-space` memory store — the deployment environment (account
   and Region pair) and the container holding this resource.
4. Tags on the alarmed resource, then on its account.
5. The monitor and resource names.

Match records by resource ARN, ARN prefix, account id, Region, or the value of the
resource's `Application`, `awsApplication` or `WorkloadId` tag.

**Rule:**

| Evidence | Classification |
| --- | --- |
| An explicit record names the workload non-production or excluded | Not production-critical — stop, raise no case |
| An explicit record names it production-critical | Production-critical (confirmed) |
| `Environment=prod` or `Criticality=critical` tag | Production-critical (confirmed) |
| Only the name suggests production, for example `prod-checkout-api` | Production-critical (inferred) |
| The name suggests non-production, for example `checkout-api-staging` | Production-critical (inferred) |
| No signal found | Production-critical (inferred) |

An explicit record is the only evidence that rules a workload out. A
non-production name does not: names are not governed, so record it in the case and
ask.

See `references/production-signals.md` for tag keys, exact name patterns, and the
substrings that produce false positives.

## Step 2: Confirm the case is warranted

Raise a case when both hold:

1. The investigation produced findings — an impaired resource, an error signature,
   or a timeline.
2. The cause needs AWS to act or confirm.

Do not raise a case when either holds:

1. An explicit record excluded the workload in Step 1.
2. `support:DescribeCases` returns an open case naming the same monitor. Report
   that case id instead.

Read the entry for this monitor in the `monitors` memory store. A recurring known
cause lowers the severity and changes the questions asked. It does not cancel the
case unless the entry says to skip this monitor.

When it is unclear whether AWS or the team owns the cause, raise the case. That is
the question the case settles.

## Step 3: Choose the severity

Call `support:DescribeSeverityLevels` and pick the highest code the account offers
that the confirmed impact justifies:

| Confirmed impact | severityCode |
| --- | --- |
| Business-critical system down | `critical` |
| Production system down, important functions unavailable | `urgent` |
| Production functions impaired or degraded | `high` |
| Non-critical functions abnormal | `normal` |
| Question, no impact | `low` |

An inferred classification caps the severity at `high`. Requesting a code the plan
does not offer fails the call.

## Step 4: Write the case

Call `support:CreateCase` with `issueType: technical`, `language: en`, and a
`serviceCode` and `categoryCode` from `support:DescribeServices`.

`subject`: `<severity> — <monitor name> — <account>/<Region>`

`communicationBody` carries these five sections, in order:

```
Affected resource
  Monitor: prod-checkout-api-5xx (arn:aws:cloudwatch:ap-southeast-1:111122223333:alarm:prod-checkout-api-5xx)
  Resource: arn:aws:elasticloadbalancing:ap-southeast-1:111122223333:loadbalancer/app/prod-checkout/1a2b3c
  Account 111122223333, Region ap-southeast-1.

Production-critical classification
  Confirmed. Tag Criticality=critical on the load balancer; the directives memory
  store records account 111122223333 as production.

Findings
  1. HTTPCode_ELB_5XX_Count rose from 0 to 1,840/min at 2026-09-25T14:02Z and has
     not recovered.
  2. Target group healthy host count stayed at 6 of 6 throughout, so the targets
     are reachable.
  3. RejectedConnectionCount is non-zero from 14:02Z, with no matching rise in
     NewConnectionCount.

Ruled out
  No deployment in the window (last at 2026-09-24T09:11Z). No security group or
  listener rule change in CloudTrail for the past 24 hours. Target CPU below 40%.

Validation requested
  1. Confirm the rejected connections originate service-side; we observed them
     without a request-rate change.
  2. Confirm whether this load balancer is at a connection limit we cannot see.
```

Rules for the body:

- State every classification as `Confirmed` or `Inferred`, naming the evidence or
  its absence: `Inferred. No Environment or Criticality tag; no record in
  directives; name carries no environment marker.`
- Give each finding its metric, value, and timestamp in UTC.
- Write each validation request as a question with the observation behind it.
- Keep the body under 8,000 characters.
- Never paste credentials, keys or tokens. AWS Support redacts them, and they are
  not needed.

## Step 5: When the case cannot be created

`support:CreateCase` needs the `support:CreateCase` permission and a Business,
Enterprise or Unified Operations support plan. Without either it fails with
`SubscriptionRequiredException` or an access error.

Do not stop there. Put the full case in the findings — subject, `severityCode`,
and the five sections — state which of the two requirements is missing, and say
the account team can file it unchanged.
