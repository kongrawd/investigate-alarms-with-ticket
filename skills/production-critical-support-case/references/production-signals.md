# Production-critical signals

The default classification is production-critical. These signals confirm it, and
only the first can rule it out.

## Explicit records

| Where | What to look for |
| --- | --- |
| `directives` memory store | Standing records such as "Account 111122223333 is production" or "svc-sandbox-* is not production" |
| Global agent instructions | Standing policy naming production accounts, Regions or applications |
| Agent-type instructions | The same, scoped to Incident triage, Incident RCA or Incident mitigation |
| `understanding-agent-space` memory store | The deployment environment (account and Region pair) and the container holding the resource |

Match by resource ARN, ARN prefix, account id, Region, or the value of the
resource's `Application`, `awsApplication` or `WorkloadId` tag.

An explicit record is authoritative in both directions. Nothing else rules a
workload out.

## Resource tags

Read the alarmed resource first, then its account. Resource tags win on conflict:
an account-wide `Environment=prod` says nothing about one sandbox resource inside
it.

| Tag key | Production-critical values |
| --- | --- |
| `Environment`, `environment`, `Stage`, `SDLCStage`, `sdlc` | `prod`, `production`, `prd`, `live` |
| `Criticality`, `WorkloadTier`, `BusinessCriticality`, `Tier` | `critical`, `tier-0`, `tier0`, `tier-1`, `tier1`, `gold`, `p1` |

Tag keys are case-sensitive and often namespaced. Match the segment after the last
`:`, so `example-inc:dev-ops:environment` counts as `environment`.

`Environment=prod` with `Criticality=low` is production but not
production-critical. Raise the case, use `high` at most, and state the conflict.

## Names

Supporting evidence only. A name never rules a workload out.

**Check these first — they contain `prod` and are not production:**

```
nonprod   non-prod   nonproduction   preprod   pre-prod   prod-test   prodsim
```

Also exclude names where `prod` belongs to another word:

```
product-catalog   production-support-tools   reproducer   productivity
```

Require `prod` at a boundary — the start, the end, or between `-`, `_`, `.` or `/`.

**Non-production markers.** Any of these outranks a production marker:
`prod-api-staging` is the staging copy.

```
dev   test   qa   uat   stage   staging   beta   alpha   sandbox   sbx
demo   poc   pilot   scratch   tmp   temp   experiment
```

**Production markers:**

```
prod   production   prd   live
```

Single-character environment codes such as `svc-p-01` against `svc-d-01` count
only where an explicit record confirms the convention. `p` alone is too weak.

## Worked classifications

| Monitor name | Tags | Classification |
| --- | --- | --- |
| `prod-checkout-api-5xx` | `Criticality=critical` | Production-critical (confirmed) |
| `checkout-api-5xx` | none | Production-critical (inferred), no signal found |
| `nonprod-checkout-5xx` | none | Production-critical (inferred), name suggests non-production |
| `product-catalog-dev-5xx` | `Environment=dev` | Production-critical (inferred), `prod` is part of `product` |
| `sbx-checkout-5xx` | none | Production-critical (inferred) unless `directives` excludes `sbx-*` |
| `prod-checkout-api-5xx` | `Environment=prod`, `Criticality=low` | Production-critical (confirmed), severity capped at `high` |
