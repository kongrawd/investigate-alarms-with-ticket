# AWS Support CreateCase fields

The Support API is global and served from `us-east-1`. Calls from another Region
still reach it; the case is not Region-scoped.

## Requirements

| Requirement | Detail |
| --- | --- |
| Support plan | Business, Enterprise On-Ramp, Enterprise, Business Support+, or Unified Operations. Otherwise `SubscriptionRequiredException` |
| Permission | `support:CreateCase`, plus `support:DescribeServices`, `support:DescribeSeverityLevels` and `support:DescribeCases` |
| Not supported | Quota increases. Use Service Quotas `RequestServiceQuotaIncrease`, or the console |

## Fields

| Field | Value to send |
| --- | --- |
| `subject` | `<severity> — <monitor name> — <account>/<Region>` |
| `communicationBody` | The five sections. 1–8,000 characters |
| `severityCode` | From the table below, limited to what `DescribeSeverityLevels` returns |
| `serviceCode` | From `DescribeServices`, for the service that owns the impaired resource |
| `categoryCode` | From `DescribeServices`, for the chosen `serviceCode`. Each service defines its own |
| `issueType` | `technical` |
| `language` | `en` |
| `ccEmailAddresses` | Up to 10, only addresses an explicit record supplies |
| `dryRun` | `true` validates without creating. Returns `DryRunOperationException` on success |

The response returns `caseId`, formatted `case-12345678910-exen-2025-c4c1d2bf33c5cf47`.
It is not the `displayId` shown in Support Center — call `DescribeCases` for that.

## Severity codes

| severityCode | Support Center name | First response |
| --- | --- | --- |
| `critical` | Business-critical system down | 15–30 minutes, by plan |
| `urgent` | Production system down | 1 hour |
| `high` | Production system impaired | 4 hours |
| `normal` | System impaired | 12 hours |
| `low` | General guidance | 24 hours |

Availability depends on the plan, so call `DescribeSeverityLevels` rather than
assuming a code exists.

## Redaction

AWS Support replaces these with `[REDACTED_BY_AWS]` before storing the case:

- AWS secret access keys
- Private keys
- Credit card numbers, except the last four digits

None of them are needed in a case. Do not include them.

## After creating

- `support:AddCommunicationToCase` adds a follow-up to an existing case.
- `support:DescribeCases` with the case id returns the current status and the
  `displayId`.
- Attachments go through `AddAttachmentsToSet` (5 MB or less per file) or
  `GetAttachmentUploadLinks` with `CompleteAttachmentUpload` for larger files.
