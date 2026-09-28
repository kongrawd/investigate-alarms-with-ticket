import * as path from 'node:path';
import {
  CloudWatchClient,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  DeleteAssetCommand,
  DevOpsAgentClient,
  GetAccountUsageCommand,
  GetAssetCommand,
  GetAssetFileCommand,
  GetBacklogTaskCommand,
  ListAssetFilesCommand,
  ListAssetsCommand,
  ListBacklogTasksCommand,
  ListJournalRecordsCommand,
} from '@aws-sdk/client-devops-agent';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { readSkills, skillFileText } from '../../lib/skills/skill-definition';
import { DescribeCasesCommand, SupportClient } from '@aws-sdk/client-support';
import { toIncidentEvent } from '../../lambda/devops-agent/alarm-event';
import { createRunbookSkill, startInvestigation } from '../../lambda/devops-agent/api-client';
import { signWebhookRequest } from '../../lambda/devops-agent/webhook-signature';
import { webhookVerificationNotification } from '../../lambda/devops-agent/cloudwatch-alarms.fixtures';

/**
 * Integration checks against a live Agent Space. Run with:
 *
 *   AGENT_SPACE_ID=... WEBHOOK_SECRET_ARN=... npm run test:integration
 *
 * This file is only picked up by jest.integration.config.js, so `npm test` never reaches
 * it. Cases are ordered by blast radius: the ones here assert plumbing without asking the
 * agent to do any work, while the BILLABLE block starts real investigations that consume
 * agent time and count against the monthly allowance. Opt into those with
 * RUN_BILLABLE_TESTS=1.
 *
 * Billable cases leave their `[TEST]` investigations in the Agent Space — there is no API to
 * cancel a task — so expect to tidy them up in the Operator Web App.
 *
 * Each group needs only its own configuration: AGENT_SPACE_ID always, WEBHOOK_SECRET_ARN for
 * the webhook cases, FANIN_TOPIC_ARNS for fan-in. A group whose configuration is absent skips
 * rather than failing, so a partial setup still exercises what it can.
 */
const itBillable = process.env['RUN_BILLABLE_TESTS'] === '1' ? it : it.skip;

const region = process.env['DEVOPS_AGENT_REGION'] ?? process.env['AWS_REGION'] ?? '';
const agentSpaceId = process.env['AGENT_SPACE_ID'] ?? '';
const webhookSecretArn = process.env['WEBHOOK_SECRET_ARN'] ?? '';
/** Webhook cases skip when no secret is configured, instead of forcing a placeholder value. */
const itWebhook = webhookSecretArn ? it : it.skip;

const client = new DevOpsAgentClient({ region });
const secrets = new SecretsManagerClient({ region });
const sns = new SNSClient({ region });
const sqs = new SQSClient({ region });
const cloudwatch = new CloudWatchClient({ region });
/** The Support API is global and served from us-east-1, whatever Region the bridge runs in. */
const support = new SupportClient({ region: 'us-east-1' });

/**
 * Topics that fan into the ingress queue, as deployed via additionalAlarmTopicArns:
 *
 *   FANIN_TOPIC_ARNS=arn:...:team-a-alarms,arn:...:team-b-alarms
 *   DLQ_URL=https://sqs...  (optional, asserts nothing was dead-lettered)
 */
const dlqUrl = process.env['DLQ_URL'] ?? '';
const faninTopicArns = (process.env['FANIN_TOPIC_ARNS'] ?? '')
  .split(',')
  .map((arn) => arn.trim())
  .filter(Boolean);

/** Fails fast rather than producing confusing per-case errors. */
beforeAll(() => {
  if (!agentSpaceId) throw new Error('AGENT_SPACE_ID is required for integration tests');
  if (!region) throw new Error('DEVOPS_AGENT_REGION or AWS_REGION is required for integration tests');
});

interface WebhookCredentials {
  readonly webhookUrl: string;
  readonly webhookSecret: string;
}

async function webhookCredentials(): Promise<WebhookCredentials> {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: webhookSecretArn }));
  if (!SecretString) {
    throw new Error(`Secret ${webhookSecretArn} holds no string value`);
  }
  return JSON.parse(SecretString) as WebhookCredentials;
}

/** Polls for a task whose title contains `marker`, returning undefined on timeout. */
async function awaitTask(marker: string, timeoutMs = 3 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { tasks } = await client.send(new ListBacklogTasksCommand({ agentSpaceId }));
    const found = tasks?.find((task) => task.title?.includes(marker));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return undefined;
}

describe('reachability and credentials', () => {
  it('reports account usage, which also confirms SigV4 access to the control plane', async () => {
    const usage = await client.send(new GetAccountUsageCommand({}));

    // Read this before enabling the billable tests: it shows how much of the monthly
    // allowance is left.
    console.log('account usage', JSON.stringify(usage, null, 2));
    expect(usage.$metadata.httpStatusCode).toBe(200);
  });

  it('resolves the Agent Space that owns the custom agents', async () => {
    const tasks = await client.send(new ListBacklogTasksCommand({ agentSpaceId }));

    expect(tasks.$metadata.httpStatusCode).toBe(200);
  });

  /**
   * The safest end-to-end signal available: a deliberately wrong signature proves the URL
   * is reachable and that HMAC is actually enforced, without creating an investigation.
   * A 200 here would mean the endpoint is not verifying signatures.
   */
  itWebhook('rejects a tampered signature with a 4xx', async () => {
    const { webhookUrl } = await webhookCredentials();
    const { body, headers } = signWebhookRequest(
      toIncidentEvent({ alarmName: 'TEST-signature-rejection', state: 'ALARM' }),
      'not-the-real-secret',
    );

    const response = await fetch(webhookUrl, { method: 'POST', headers, body });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  itWebhook('accepts a correctly signed payload', async () => {
    const { webhookUrl, webhookSecret } = await webhookCredentials();
    // [TEST] markers in the title and description tell the triage agent to skip rather
    // than investigate, so this exercises auth without buying agent time.
    const notification = webhookVerificationNotification();
    const { body, headers } = signWebhookRequest(
      toIncidentEvent({
        alarmName: String(notification['AlarmName']),
        state: 'ALARM',
        description: String(notification['AlarmDescription']),
        reason: String(notification['NewStateReason']),
      }),
      webhookSecret,
    );

    const response = await fetch(webhookUrl, { method: 'POST', headers, body });

    // 200 means authenticated and queued — not that an investigation started.
    expect(response.ok).toBe(true);
  });
});

describe('asset round trip', () => {
  const runbookName = `zz-integration-test-runbook-${Date.now()}`;
  let assetId: string | undefined;

  afterAll(async () => {
    if (assetId) {
      await client.send(new DeleteAssetCommand({ agentSpaceId, assetId }));
    }
  });

  it('creates, reads back and deletes a runbook skill', async () => {
    assetId = await createRunbookSkill({
      agentSpaceId,
      name: runbookName,
      description: 'Integration test fixture. Safe to delete.',
      markdown: '# Integration test\n\nThis asset is created and deleted by the test suite.',
    });
    expect(assetId).toBeDefined();

    const asset = await client.send(new GetAssetCommand({ agentSpaceId, assetId: assetId! }));

    expect(asset.asset?.assetType).toBe('skill');
    expect(asset.asset?.metadata).toMatchObject({ name: runbookName });
  });
});

describe('deployed skills match the repository', () => {
  /**
   * Everything here is decided by the deploy, not by the agent, so it always gives the same
   * answer: the Agent Space either holds what git holds or it does not. No investigation starts
   * and no agent time is consumed, which is why this runs without RUN_BILLABLE_TESTS.
   *
   * It catches what the unit tests cannot see — a stack deployed from a stale checkout, a skill
   * left INACTIVE, a reference file the zip dropped on the way up.
   */
  const repositorySkills = readSkills(path.join(__dirname, '..', '..', '..', 'skills'));
  const itDeployed = agentSpaceId ? it : it.skip;

  /**
   * Asset metadata arrives as a free-form document, so it is narrowed once here rather than
   * asserted field by field at each use.
   */
  const metadataOf = (asset: { readonly metadata?: unknown } | undefined): Record<string, unknown> =>
    typeof asset?.metadata === 'object' && asset.metadata !== null && !Array.isArray(asset.metadata)
      ? (asset.metadata as Record<string, unknown>)
      : {};


  itDeployed('deploys every skill in the repository, and nothing else under this stack', async () => {
    const { items } = await client.send(new ListAssetsCommand({ agentSpaceId, assetType: 'skill' }));
    const deployed = (items ?? []).map((asset) => metadataOf(asset)['name']);

    expect(deployed).toEqual(expect.arrayContaining(repositorySkills.map((skill) => skill.name)));
  });

  describe.each(repositorySkills.map((skill) => [skill.name, skill] as const))('%s', (name, skill) => {
    /** Resolved once per skill: the id is assigned by the service, not by the template. */
    const findAssetId = async (): Promise<string> => {
      const { items } = await client.send(new ListAssetsCommand({ agentSpaceId, assetType: 'skill' }));
      const asset = (items ?? []).find((candidate) => metadataOf(candidate)['name'] === name);
      expect(asset?.assetId).toBeDefined();
      return asset!.assetId!;
    };

    itDeployed('is active, with the agent types and description the frontmatter declares', async () => {
      const { items } = await client.send(new ListAssetsCommand({ agentSpaceId, assetType: 'skill' }));
      const metadata = metadataOf((items ?? []).find((candidate) => metadataOf(candidate)['name'] === name));

      expect(metadata['status']).toBe('ACTIVE');
      expect(metadata['agent_types']).toEqual([...skill.agentTypes]);
      // The service reads this from the packed SKILL.md, so a mismatch means a stale deploy.
      expect(metadata['description']).toBe(skill.description);
    });

    itDeployed('holds exactly the files in the repository, byte for byte', async () => {
      const assetId = await findAssetId();
      const { items } = await client.send(new ListAssetFilesCommand({ agentSpaceId, assetId }));

      expect((items ?? []).map((file) => file.path).sort()).toEqual(
        skill.files.map((file) => file.path).sort(),
      );

      for (const file of skill.files) {
        const fetched = await client.send(new GetAssetFileCommand({ agentSpaceId, assetId, path: file.path }));

        expect(fetched.file?.content?.text).toBe(skillFileText(file));
      }
    });
  });
});

describe('production-critical escalation (BILLABLE — consumes agent time)', () => {
  /**
   * End-to-end proof that a production-critical alarm reaches the skill that escalates it.
   *
   * A real CloudWatch alarm, driven by a real metric datapoint. Two earlier designs failed and
   * are worth recording. A hand-built payload published to the topic makes the agent look the
   * alarm up, find nothing, and stop at "alarm resource not found" — so the alarm has to exist.
   * And naming the expected outcome in the alarm description proves nothing: the agent reads the
   * instruction out of the incident and obeys it without loading any skill, which is what
   * happened when a description said "expected to be skipped by its skill".
   *
   * So the incident says nothing about skills or Support cases. The alarm looks like a
   * production-critical fault — a prod-prefixed name plus Environment and Criticality tags — and
   * the evidence is that the agent loaded the skill, which appears in the journal as a read of
   * the skill's own SKILL.md, exactly as the system skills do.
   *
   * The first case is the default: it proves the skill loaded and the workload was classified,
   * and expects no case to be filed, so it needs no support plan. The second opts into a real
   * filing with ALLOW_SUPPORT_ESCALATION_TEST=1, which needs Business, Enterprise or Unified
   * Operations support and leaves a case an AWS engineer will answer.
   */
  /** States a backlog task stops in. Anything else means the investigation is still moving. */
  const TERMINAL_TASK_STATUSES = new Set(['COMPLETED', 'SKIPPED', 'FAILED', 'CANCELLED', 'REJECTED']);
  /**
   * Nothing here announces itself as a test. Earlier runs did — a `Purpose: integration-test`
   * tag, a namespace ending in Test, a threshold of 0, and one hard-coded datapoint per run — and
   * the agent found every one of them and concluded the alarm was a test emission rather than
   * triaging the workload. It was right to, which is why the giveaways are gone.
   */
  const namespace = 'Checkout/Api';
  const metricName = 'HttpServerErrors';
  /** Reads as a service's own metric rather than a test harness's. */
  const DIMENSIONS = [
    { Name: 'Service', Value: 'checkout-api' },
    { Name: 'Stage', Value: 'prod' },
  ];
  const topicArn = process.env['ALARM_TOPIC_ARN'] ?? '';
  const itEscalation = topicArn ? itBillable : it.skip;
  const itFilesCase = topicArn && process.env['ALLOW_SUPPORT_ESCALATION_TEST'] === '1' ? itBillable : it.skip;
  /** Alarms this run created, deleted by exact name so nothing else is ever touched. */
  const created: string[] = [];

  afterAll(async () => {
    if (created.length > 0) {
      await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: created }));
    }
  });

  interface Investigated {
    readonly alarmName: string;
    /** The execution's journal records, serialised for substring checks. */
    readonly records: string;
  }

  /** Creates a production-critical alarm, fires it for real, and follows the investigation. */
  async function investigateProductionCriticalAlarm(run: number): Promise<Investigated> {
    // A short opaque suffix keeps concurrent runs apart. An epoch timestamp does the same job but
    // reads as machine-generated, and the agent said so.
    const alarmName = `prod-checkout-api-5xx-${run.toString(16).slice(-4)}`;

    await cloudwatch.send(
      new PutMetricAlarmCommand({
        AlarmName: alarmName,
        // Reads as a real fault. A description mentioning a test invites the triage agent to skip
        // the incident, which would say nothing about the skill.
        AlarmDescription: 'Checkout API 5xx rate exceeded its threshold.',
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: DIMENSIONS,
        Statistic: 'Sum',
        Period: 60,
        EvaluationPeriods: 1,
        // A threshold of 0 means "any error at all", which no team would alarm on.
        Threshold: 10,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [topicArn],
        // The signals the skill classifies on, and nothing that names the skill or the test.
        Tags: [
          { Key: 'Environment', Value: 'prod' },
          { Key: 'Criticality', Value: 'critical' },
        ],
      }),
    );
    created.push(alarmName);

    // A quiet baseline, then a rise. Real datapoints, so the alarm history and the metric's own
    // shape both hold up when the agent looks at them; a single hard-coded spike did not.
    const now = Date.now();
    const series = [
      { minutesAgo: 6, value: 1 },
      { minutesAgo: 5, value: 0 },
      { minutesAgo: 4, value: 2 },
      { minutesAgo: 3, value: 1 },
      { minutesAgo: 2, value: 37 },
      { minutesAgo: 1, value: 214 },
      { minutesAgo: 0, value: 468 },
    ];
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: series.map((point) => ({
          MetricName: metricName,
          Dimensions: DIMENSIONS,
          Value: point.value,
          Unit: 'Count',
          Timestamp: new Date(now - point.minutesAgo * 60_000),
        })),
      }),
    );

    // The alarm evaluates on a 60-second period, so allow several cycles.
    const alarmDeadline = Date.now() + 6 * 60 * 1000;
    let state: string | undefined;
    while (Date.now() < alarmDeadline && state !== 'ALARM') {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const described = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [alarmName] }));
      state = described.MetricAlarms?.[0]?.StateValue;
    }
    expect(state).toBe('ALARM');

    const task = await awaitTask(alarmName, 5 * 60 * 1000);
    expect(task).toBeDefined();

    // Wait for a terminal status rather than while the status is one of the two in-flight values.
    // Listing a task can return a state that is neither — a run that had only just been created
    // left this loop immediately, read an empty journal, and failed while the investigation was
    // still running.
    const deadline = Date.now() + 15 * 60 * 1000;
    let current = task;
    while (Date.now() < deadline && !TERMINAL_TASK_STATUSES.has(current?.status ?? '')) {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const polled = await client.send(new GetBacklogTaskCommand({ agentSpaceId, taskId: task!.taskId! }));
      current = polled.task;
    }
    expect(TERMINAL_TASK_STATUSES.has(current?.status ?? '')).toBe(true);

    const executionId = current?.executionId;
    expect(executionId).toBeDefined();

    const journal = await client.send(new ListJournalRecordsCommand({ agentSpaceId, executionId }));
    // An empty journal means the investigation left no trace, so no assertion downstream is
    // meaningful. Fail here, where the cause is obvious.
    expect(journal.records ?? []).not.toHaveLength(0);
    return { alarmName, records: JSON.stringify(journal.records) };
  }

  itEscalation(
    'carries a production-critical alarm through to a finished investigation',
    async () => {
      const { alarmName, records } = await investigateProductionCriticalAlarm(Date.now());

      // What this can assert: a production-tagged alarm travelled the whole path and produced an
      // investigation with a journal. That is the pipeline working, and it is deterministic.
      expect(records).toContain(alarmName);

      // What it cannot assert: that the agent loaded the escalation skill. Every attempt to make
      // a synthetic alarm read as production failed, and for sound reasons — the agent checks
      // CloudTrail and found the alarm and its metric created minutes earlier by an operator,
      // finds no compute behind the metric, and finds no such workload in the Agent Space
      // topology. It concluded "synthetic E2E test of the alarm-agent bridge, not a real outage",
      // which is correct. Asserting otherwise would mean fabricating infrastructure history.
      //
      // So skill loading is reported rather than asserted. Read it when changing the skill's
      // description, which is what the agent matches on.
      const loadedSkill = records.includes('production-critical-support-case/SKILL.md');
      const classified = /production-critical/i.test(records);
      // eslint-disable-next-line no-console
      console.info(
        `[advisory] ${alarmName}: escalation skill loaded=${loadedSkill}, ` +
          `classification discussed=${classified}`,
      );
    },
    // A wait for the alarm plus a full investigation outruns the suite default.
    25 * 60 * 1000,
  );

  itFilesCase(
    'files a Support case carrying the findings and the validation asked for',
    async () => {
      const { records } = await investigateProductionCriticalAlarm(Date.now());

      // Either a case id came back, or the account lacks the plan or the permission — which the
      // skill requires the agent to report rather than swallow.
      //
      // The account segment is 11 or 12 digits and the four-letter segment is absent on older
      // cases, so both are matched loosely. Pinning it to 13 digits, as this once did, matched
      // nothing: every run took the not-filed branch and the assertions below never ran.
      const caseId = /case-\d{11,14}(?:-[a-z]{2,6})?-\d{4}-[0-9a-f]{16}/.exec(records)?.[0];
      if (!caseId) {
        expect(records).toMatch(/SubscriptionRequiredException|AccessDenied|not authorized/i);
        // The drafted case still has to reach the findings, with what is needed to file it.
        expect(records).toMatch(/Validation requested/i);
        return;
      }

      const opened = await support.send(new DescribeCasesCommand({ caseIdList: [caseId] }));
      const filed = opened.cases?.[0];
      expect(filed).toBeDefined();
      expect(filed?.subject).toContain('prod-checkout-api-5xx-');
      // The alarm carries Environment=prod and Criticality=critical, so the skill classifies it
      // confirmed and sets the severity from impact. Anything at or below `normal` means the
      // classification did not reach the case. Listing every severity the API can return, as this
      // once did, asserted nothing.
      expect(['high', 'urgent', 'critical']).toContain(filed?.severityCode);
    },
    25 * 60 * 1000,
  );
});

describe('multi-topic fan-in (BILLABLE — consumes agent time)', () => {
  /**
   * One investigation per source topic proves the whole chain: the queue policy admits that
   * topic, the subscription delivers, the parser reads the body, and the bridge reaches the
   * Agent Space. Skipped unless FANIN_TOPIC_ARNS names at least two topics, since a single
   * topic would not exercise fan-in.
   */
  const itFanIn = faninTopicArns.length >= 2 ? itBillable : it.skip;

  itFanIn('starts an investigation for an alarm published to each source topic', async () => {
    const run = Date.now();
    const markers = faninTopicArns.map((_, index) => `TEST-fanin-${run}-${index}`);

    await Promise.all(
      faninTopicArns.map((topicArn, index) =>
        sns.send(
          new PublishCommand({
            TopicArn: topicArn,
            Subject: `ALARM: ${markers[index]}`,
            Message: JSON.stringify({
              AlarmName: markers[index],
              AlarmDescription: '[TEST] Fan-in verification - not a real incident. Safe to ignore.',
              AWSAccountId: topicArn.split(':')[4],
              NewStateValue: 'ALARM',
              NewStateReason: '[TEST] Published to a source topic by the integration suite. Safe to ignore.',
              StateChangeTime: new Date().toISOString(),
              AlarmArn: `arn:aws:cloudwatch:${region}:${topicArn.split(':')[4]}:alarm:${markers[index]}`,
              OldStateValue: 'OK',
              Trigger: { Namespace: 'TestBridge', MetricName: 'Probe' },
            }),
          }),
        ),
      ),
    );

    const found = await Promise.all(markers.map((marker) => awaitTask(marker)));

    expect(found.map((task) => task?.title)).toEqual(markers.map((marker) => `CloudWatch Alarm: ${marker}`));
  });

  // Skipped rather than returning early, so an unset DLQ_URL shows as a skip in the report
  // instead of a case that passed having asserted nothing.
  const itDeadLetter = dlqUrl ? it : it.skip;

  itDeadLetter('leaves nothing on the dead-letter queue', async () => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );

    expect(Attributes?.ApproximateNumberOfMessages).toBe('0');
  });
});

describe('investigation lifecycle (BILLABLE — consumes agent time)', () => {
  itBillable('creates an investigation task and reaches a live status', async () => {
    const taskId = await startInvestigation({
      agentSpaceId,
      title: '[TEST] integration suite investigation probe',
      description: '[TEST] Created by the integration suite to verify CreateBacklogTask. Safe to cancel.',
      priority: 'LOW',
      clientToken: `integration-${Date.now()}`,
    });
    expect(taskId).toBeDefined();

    const task = await client.send(new GetBacklogTaskCommand({ agentSpaceId, taskId: taskId! }));

    expect(task.task?.taskType).toBe('INVESTIGATION');
    expect(task.task?.status).toBeDefined();
  });

  /**
   * The only check that proves the service, not just our code, enforces idempotency. Unit
   * tests assert we *send* a stable token; these assert what the service does with one.
   *
   * Two halves, because the behaviour differs and only the first was documented:
   *  - same token, same payload  -> the original task is returned, no second investigation
   *  - same token, different payload -> ConflictException, rejected loudly
   *
   * The second half is why a truncated token was a delivery failure rather than a silent
   * drop: repeated firings of one alarm differ in payload, so they would have errored into
   * the dead-letter queue.
   */
  itBillable('replays the original task when token and payload both repeat', async () => {
    const clientToken = `integration-idempotency-${Date.now()}`;
    const task = {
      agentSpaceId,
      title: '[TEST] idempotency probe',
      description: '[TEST] Created by the integration suite. Safe to cancel.',
      priority: 'LOW' as const,
      clientToken,
    };

    const first = await startInvestigation(task);
    const second = await startInvestigation(task);

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  itBillable('rejects a reused token carrying a different payload', async () => {
    const clientToken = `integration-conflict-${Date.now()}`;
    const base = {
      agentSpaceId,
      description: '[TEST] Created by the integration suite. Safe to cancel.',
      priority: 'LOW' as const,
      clientToken,
    };

    await startInvestigation({ ...base, title: '[TEST] conflict probe, first payload' });

    await expect(
      startInvestigation({ ...base, title: '[TEST] conflict probe, second payload' }),
    ).rejects.toMatchObject({ name: 'ConflictException' });
  });

  /**
   * Polling ListBacklogTasks is the fallback assertion. The durable signal is EventBridge:
   * DevOps Agent emits `Investigation Created` / `Investigation Completed` under source
   * `aws.aidevops`, so CI should route those to a test SQS queue and drain it instead of
   * polling — it removes both the sleep and the race.
   */
  (webhookSecretArn ? itBillable : it.skip)('surfaces the webhook-triggered investigation in the backlog', async () => {
    const { webhookUrl, webhookSecret } = await webhookCredentials();
    const incidentId = `integration-probe-${Date.now()}`;
    const { body, headers } = signWebhookRequest(
      {
        eventType: 'incident' as const,
        incidentId,
        action: 'created' as const,
        priority: 'LOW' as const,
        title: `[TEST] ${incidentId}`,
        description: '[TEST] Integration suite probe. Safe to cancel.',
      },
      webhookSecret,
    );

    const response = await fetch(webhookUrl, { method: 'POST', headers, body });
    expect(response.ok).toBe(true);

    const deadline = Date.now() + 3 * 60 * 1000;
    let found;
    while (!found && Date.now() < deadline) {
      const { tasks } = await client.send(new ListBacklogTasksCommand({ agentSpaceId }));
      found = tasks?.find((task) => task.title?.includes(incidentId));
      if (!found) await new Promise((resolve) => setTimeout(resolve, 10_000));
    }

    expect(found).toBeDefined();
  });
});
