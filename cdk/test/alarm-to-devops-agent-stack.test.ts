import { App, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LogGroupClass } from 'aws-cdk-lib/aws-logs';
import { INDEXED_LOG_FIELDS } from '../lambda/devops-agent/audit-log';
import { AlarmToDevOpsAgentStack, type DeliveryMode } from '../lib/alarm-to-devops-agent-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const AGENT_SPACE_ID = 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111';
const AGENT_SPACE_REGION = 'ap-southeast-1';
const SECRET_ARN = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:devops-agent-webhook-AbCdEf';

function apiStack(): Stack {
  return new AlarmToDevOpsAgentStack(new App(), 'ApiStack', {
    env,
    agentSpaceId: AGENT_SPACE_ID,
    agentSpaceRegion: AGENT_SPACE_REGION,
  });
}

function webhookStack(): Stack {
  return new AlarmToDevOpsAgentStack(new App(), 'WebhookStack', {
    env,
    agentSpaceId: AGENT_SPACE_ID,
    agentSpaceRegion: AGENT_SPACE_REGION,
    deliveryMode: 'webhook',
    webhookSecretArn: SECRET_ARN,
  });
}

describe('configuration validation', () => {
  it('refuses to synthesize without an existing Agent Space id', () => {
    expect(() => new AlarmToDevOpsAgentStack(new App(), 'S', { env, agentSpaceId: '' })).toThrow(
      /agentSpaceId is required/,
    );
  });

  it('refuses an unrecognized delivery mode at synth rather than at runtime', () => {
    expect(
      () =>
        new AlarmToDevOpsAgentStack(new App(), 'S', {
          env,
          agentSpaceId: AGENT_SPACE_ID,
          // Bypasses the type system on purpose: the value arrives from `cdk -c`, where the
          // compiler cannot help, so the stack must reject it at synth.
          deliveryMode: 'Webhook' as unknown as DeliveryMode,
        }),
    ).toThrow(/deliveryMode must be 'api' or 'webhook'/);
  });

  it('refuses a blank Region rather than deploying a broken ARN', () => {
    expect(
      () => new AlarmToDevOpsAgentStack(new App(), 'S', { env, agentSpaceId: AGENT_SPACE_ID, agentSpaceRegion: ' ' }),
    ).toThrow(/agentSpaceRegion must be a Region name/);
  });

  it('refuses webhook mode without a secret, which cannot be created by IaC', () => {
    expect(
      () =>
        new AlarmToDevOpsAgentStack(new App(), 'S', {
          env,
          agentSpaceId: AGENT_SPACE_ID,
          deliveryMode: 'webhook',
        }),
    ).toThrow(/webhookSecretArn is required for webhook mode/);
  });
});

describe('api mode', () => {
  const template = Template.fromStack(apiStack());

  it('passes the Agent Space id and Region to the function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DELIVERY_MODE: 'api',
          AGENT_SPACE_ID: AGENT_SPACE_ID,
          DEVOPS_AGENT_REGION: AGENT_SPACE_REGION,
        }),
      },
    });
  });

  it('grants CreateBacklogTask on that Agent Space only, in its own Region', () => {
    // The partition stays a token because cdk.json targets both aws and aws-cn, so the
    // ARN renders as an Fn::Join and the tail is asserted as text.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'aidevops:CreateBacklogTask',
            Effect: 'Allow',
            Resource: { 'Fn::Join': Match.anyValue() },
          }),
        ]),
      }),
    });
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).toContain(
      `:aidevops:${AGENT_SPACE_REGION}:${env.account}:agentspace/${AGENT_SPACE_ID}`,
    );
  });

  it('does not grant secret access it has no use for', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = JSON.stringify(policies);

    expect(actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it('does not set a webhook secret variable', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const variables = Object.values(functions)[0]!['Properties'].Environment.Variables;

    expect(variables).not.toHaveProperty('WEBHOOK_SECRET_ARN');
  });
});

describe('webhook mode', () => {
  const template = Template.fromStack(webhookStack());

  it('reads the webhook credentials from the supplied secret', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ DELIVERY_MODE: 'webhook', WEBHOOK_SECRET_ARN: SECRET_ARN }) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'secretsmanager:GetSecretValue', Resource: SECRET_ARN }),
        ]),
      }),
    });
  });

  it('grants no DevOps Agent API access, since the webhook authenticates with HMAC', () => {
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('aidevops:');
  });
});

describe('alarm ingress', () => {
  const template = Template.fromStack(apiStack());

  it('encrypts the topic with a rotating customer-managed key', () => {
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
  });

  it('lets CloudWatch use the topic key in a plain same-account deployment', () => {
    // A key's default policy covers only the account root and a service principal cannot
    // be granted via IAM, so without this statement every same-account alarm fails to
    // publish — and CloudWatch surfaces that failure nowhere.
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowAlarmPublishEncrypt',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: ['kms:GenerateDataKey*', 'kms:Decrypt'],
            Condition: { StringEquals: { 'aws:SourceAccount': [env.account] } },
          }),
        ]),
      }),
    });
  });

  it('retains the audit trail for three months', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
  });

  it('indexes the fields the audit records emit', () => {
    // An index on a field nobody logs is silent waste, so the list comes from the logger
    // module rather than being restated here.
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupClass: 'STANDARD',
      FieldIndexPolicies: [{ Fields: [...INDEXED_LOG_FIELDS] }],
    });
  });

  it('lets Powertools own log levels, and keeps Lambda out of the log format', () => {
    // ALC JSON would nest each already-JSON line under `message` and break the flat indexes.
    const functions = template.findResources('AWS::Lambda::Function');
    const properties = Object.values(functions)[0]!['Properties'];

    expect(properties.Environment.Variables.POWERTOOLS_LOG_LEVEL).toBe('INFO');
    expect(properties.Environment.Variables.POWERTOOLS_SERVICE_NAME).toBe('alarm-to-devops-agent');
    expect(properties.LoggingConfig?.LogFormat).toBeUndefined();
  });

  it('enables source maps, without which the emitted map is dead weight', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ NODE_OPTIONS: '--enable-source-maps' }) },
    });
  });

  it('allows CloudWatch to publish, which the attached topic policy otherwise revokes', () => {
    // enforceSSL makes CDK attach an explicit TopicPolicy, and attaching one replaces
    // SNS's implicit default statement. Without an explicit Allow the topic denies every
    // publisher, and CloudWatch reports only "Failed to execute action".
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowAlarmPublish',
            Effect: 'Allow',
            Action: 'sns:Publish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': [env.account] } },
          }),
        ]),
      }),
    });
  });

  it('denies non-TLS access to the topic', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  it('fans the topic into the ingress queue rather than straight to the function', () => {
    // SNS cannot subscribe to SNS, so the queue is what lets several topics converge.
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'sqs',
      RawMessageDelivery: true,
    });
    template.resourceCountIs('AWS::SNS::Subscription', 1);
  });

  it('consumes the queue with partial batch failure reporting', () => {
    // Without ReportBatchItemFailures a single bad alarm forces the whole batch to be
    // redelivered, and the dedup window then suppresses the ones that already succeeded.
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('redrives the ingress queue to the dead-letter queue after repeated failures', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
      // Six times the function timeout PLUS the batching window, which is the documented
      // rule: 6 * (30 + 5). At 6 * 30 the mapping can redeliver messages still in flight.
      VisibilityTimeout: 210,
    });
  });

  it('lets the subscribed topic enqueue, granted once by the subscription itself', () => {
    // SqsSubscription.bind() adds this; a hand-written duplicate only consumed policy budget,
    // since a second resource-policy Allow can never restrict anything.
    const statements = Object.values(template.findResources('AWS::SQS::QueuePolicy')).flatMap(
      (policy) => policy['Properties'].PolicyDocument.Statement as Record<string, any>[],
    );
    const snsGrants = statements.filter(
      (statement) => statement['Principal']?.Service === 'sns.amazonaws.com' && statement['Action'] === 'sqs:SendMessage',
    );

    expect(snsGrants).toHaveLength(1);
    expect(snsGrants[0]!['Condition']).toHaveProperty('ArnEquals');
  });

  it('dead-letters failed invocations and caps concurrency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      DeadLetterConfig: Match.anyValue(),
      ReservedConcurrentExecutions: 10,
    });
    // SQS-managed encryption, not the CMK: CDK grants the SNS subscription DLQ only
    // sqs:SendMessage, so a CMK-encrypted DLQ would silently reject SNS's writes.
    template.hasResourceProperties('AWS::SQS::Queue', {
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
    });
  });

  it('grants the execution role no wildcard actions or resources', () => {
    // queue.grantSendMessages() would add GetQueueAttributes/GetQueueUrl, and on a
    // CMK-encrypted queue kms:Encrypt and kms:ReEncrypt* as well. Written out by hand, the
    // policy needs no cdk-nag acknowledgement.
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy['Properties'].PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
    );
    const actions = statements.flatMap((statement) => [statement.Action].flat());

    expect(actions.filter((action) => action.endsWith('*'))).toEqual([]);
    expect(statements.map((statement) => statement.Resource)).not.toContain('*');
    expect(actions).toEqual(expect.arrayContaining(['sqs:SendMessage', 'logs:PutLogEvents']));
    // SQS-managed encryption means the role needs no KMS permission whatsoever.
    expect(actions.filter((action) => action.startsWith('kms:'))).toEqual([]);
  });

  it('keeps log access scoped to its own log group instead of a managed policy', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    const roles = template.findResources('AWS::IAM::Role');

    expect(JSON.stringify(roles)).not.toContain('AWSLambdaBasicExecutionRole');
  });

  it('does not open the topic to other accounts unless asked', () => {
    const policy = JSON.stringify(template.findResources('AWS::SNS::TopicPolicy'));

    expect(policy).toContain(env.account);
    expect(policy).not.toContain('111122223333');
  });
});

describe('cross-account alarms', () => {
  const template = Template.fromStack(
    new AlarmToDevOpsAgentStack(new App(), 'CrossAccountStack', {
      env,
      agentSpaceId: AGENT_SPACE_ID,
      alarmPublisherAccountIds: ['111122223333', '444455556666'],
    }),
  );

  it('adds the named accounts to the publish grant, alongside its own', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowAlarmPublish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': [env.account, '111122223333', '444455556666'] },
            },
          }),
        ]),
      }),
    });
  });

  it('adds the publishing accounts to the key grant, which an AWS managed key could not do', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowAlarmPublishEncrypt',
            Condition: {
              StringEquals: { 'aws:SourceAccount': [env.account, '111122223333', '444455556666'] },
            },
          }),
        ]),
      }),
    });
  });
});

describe('additional alarm topics', () => {
  const existingTopics = [
    'arn:aws:sns:us-east-1:123456789012:team-a-alarms',
    'arn:aws:sns:us-east-1:111122223333:team-b-alarms',
  ];
  const template = Template.fromStack(
    new AlarmToDevOpsAgentStack(new App(), 'FanInStack', {
      env,
      agentSpaceId: AGENT_SPACE_ID,
      additionalAlarmTopicArns: existingTopics,
    }),
  );

  it('subscribes each existing topic to the ingress queue', () => {
    // One per existing topic plus the stack's own topic. This is the fan-in: SNS cannot
    // subscribe to SNS, but every topic can subscribe to the one queue.
    template.resourceCountIs('AWS::SNS::Subscription', 3);

    for (const topicArn of existingTopics) {
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'sqs',
        TopicArn: topicArn,
        RawMessageDelivery: true,
      });
    }
  });

  it('lets exactly those topics enqueue, and nothing else', () => {
    const policy = JSON.stringify(template.findResources('AWS::SQS::QueuePolicy'));

    for (const topicArn of existingTopics) expect(policy).toContain(topicArn);
    expect(policy).toContain('aws:SourceArn');
  });

  it('keeps a single consumer regardless of how many topics feed it', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });
});

describe('infrequent access log class', () => {
  it('refuses to pair field indexes with the Infrequent Access class', () => {
    // CDK only guards the DELIVERY class, so this pairing would otherwise deploy indexes
    // that the log class cannot honour.
    expect(
      () =>
        new AlarmToDevOpsAgentStack(new App(), 'IaConflictStack', {
          env,
          agentSpaceId: AGENT_SPACE_ID,
          logGroupClass: LogGroupClass.INFREQUENT_ACCESS,
          indexAuditFields: true,
        }),
    ).toThrow(/field index policies are only supported on the Standard log class/);
  });

  it('rejects the conflict even when indexAuditFields is left at its default', () => {
    // The guard reads the resolved value; reading props directly let the default (true) slip
    // through and silently dropped the index policy.
    expect(
      () =>
        new AlarmToDevOpsAgentStack(new App(), 'IaDefaultStack', {
          env,
          agentSpaceId: AGENT_SPACE_ID,
          logGroupClass: LogGroupClass.INFREQUENT_ACCESS,
        }),
    ).toThrow(/field index policies are only supported on the Standard log class/);
  });

  it('halves ingestion cost when indexing is given up', () => {
    const iaTemplate = Template.fromStack(
      new AlarmToDevOpsAgentStack(new App(), 'IaStack', {
        env,
        agentSpaceId: AGENT_SPACE_ID,
        logGroupClass: LogGroupClass.INFREQUENT_ACCESS,
        indexAuditFields: false,
      }),
    );

    iaTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupClass: 'INFREQUENT_ACCESS',
      RetentionInDays: 90,
      FieldIndexPolicies: Match.absent(),
    });
  });
});

describe('cdk-nag AWS Solutions', () => {
  // cdk-nag 3 runs as a validation plugin rather than an Aspect, so the test drives it
  // directly with validateScope and reads the report. Findings acknowledged in the stack
  // are already filtered out.
  it.each([
    ['api', apiStack],
    ['webhook', webhookStack],
  ])('reports no unacknowledged findings in %s mode', (_mode, build) => {
    const stack = build();

    const report = new AwsSolutionsChecks(stack, { verbose: true }).validateScope(stack);

    expect(report.violations.map((violation) => violation.ruleName)).toEqual([]);
    expect(report.success).toBe(true);
  });
});
