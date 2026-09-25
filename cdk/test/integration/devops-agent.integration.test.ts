import {
  DeleteAssetCommand,
  DevOpsAgentClient,
  GetAccountUsageCommand,
  GetAssetCommand,
  GetBacklogTaskCommand,
  ListBacklogTasksCommand,
} from '@aws-sdk/client-devops-agent';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
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

/**
 * Topics that fan into the ingress queue, as deployed via additionalAlarmTopicArns:
 *
 *   FANIN_TOPIC_ARNS=arn:...:team-a-alarms,arn:...:team-b-alarms
 *   DLQ_URL=https://sqs...  (optional, asserts nothing was dead-lettered)
 */
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

  it('leaves nothing on the dead-letter queue', async () => {
    if (!process.env['DLQ_URL']) return;

    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: process.env['DLQ_URL'],
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
