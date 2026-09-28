import * as path from 'node:path';
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Validations,
  type StackProps,
} from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { INDEXED_LOG_FIELDS } from '../lambda/devops-agent/log-fields';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export type DeliveryMode = 'webhook' | 'api';

export interface AlarmToDevOpsAgentStackProps extends StackProps {
  /**
   * Id of an existing Agent Space. This stack never creates one — it attaches to whatever
   * space you already run.
   */
  readonly agentSpaceId: string;

  /**
   * Region of that Agent Space. Defaults to the stack's Region. An Agent Space monitors
   * accounts in any Region, so alarms do not have to live where the space does.
   */
  readonly agentSpaceRegion?: string | undefined;

  /** `api` uses SigV4 CreateBacklogTask; `webhook` posts an HMAC-signed incident. */
  readonly deliveryMode?: DeliveryMode | undefined;

  /**
   * ARN of an existing Secrets Manager secret holding `{"webhookUrl","webhookSecret"}`.
   * Required for `webhook` mode. The secret is created out of band because DevOps Agent
   * reveals the webhook secret exactly once — see the README.
   */
  readonly webhookSecretArn?: string | undefined;

  /**
   * Accounts whose CloudWatch alarms may publish to the ingress topic. Leave empty for
   * same-account alarms only.
   */
  readonly alarmPublisherAccountIds?: string[] | undefined;

  /**
   * ARNs of SNS topics you already own that should also feed the bridge. Each is subscribed
   * to the ingress queue, which is how several topics fan in: SNS cannot subscribe to SNS,
   * but it can subscribe to SQS. Existing subscribers on those topics are unaffected.
   *
   * For a topic in another account, that topic's policy must allow this account to call
   * sns:Subscribe.
   */
  readonly additionalAlarmTopicArns?: string[] | undefined;

  /**
   * Log class for the bridge's log group. STANDARD supports field index policies; the
   * INFREQUENT_ACCESS class halves ingestion cost but supports neither field indexes nor
   * metric filters, so the two cannot be combined — this stack rejects that pairing rather
   * than deploying indexes that would be ignored.
   *
   * The class is immutable once the log group exists, so changing it replaces the group and
   * discards the logs in it.
   *
   * @default LogGroupClass.STANDARD
   */
  readonly logGroupClass?: logs.LogGroupClass | undefined;

  /**
   * Index the audit fields for cheaper, faster Logs Insights queries. Ignored — and
   * rejected — when logGroupClass is INFREQUENT_ACCESS.
   *
   * @default true
   */
  readonly indexAuditFields?: boolean | undefined;

  /**
   * Minimum level the function emits. INFO keeps a complete audit trail; WARN leaves only
   * what an operator must act on. Filtered records are never written, so they cost nothing.
   *
   * @default 'INFO'
   */
  readonly logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SILENT' | undefined;
}

/**
 * Ingress for CloudWatch alarms: alarms (this account or others) publish to an SNS topic,
 * which feeds an SQS ingress queue that a bridge function drains and hands to AWS DevOps
 * Agent.
 *
 * Each hop earns its place. SNS is the only thing a CloudWatch alarm can target besides a
 * function, and it accepts cross-account publishing, so one pipeline serves many accounts.
 * The queue is what lets several topics fan in — SNS cannot subscribe to SNS — and it turns
 * a failure into a per-message retry that ends at the dead-letter queue, instead of a whole
 * invocation being redelivered.
 */
export class AlarmToDevOpsAgentStack extends Stack {
  readonly alarmTopic: sns.Topic;
  readonly alarmIngressQueue: sqs.Queue;
  readonly bridgeFunction: NodejsFunction;
  readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AlarmToDevOpsAgentStackProps) {
    super(scope, id, props);

    const deliveryMode: DeliveryMode = props.deliveryMode ?? 'api';
    const agentSpaceRegion = props.agentSpaceRegion ?? this.region;
    const publisherAccounts = props.alarmPublisherAccountIds ?? [];
    const additionalTopicArns = props.additionalAlarmTopicArns ?? [];

    if (!props.agentSpaceId?.trim()) {
      throw new Error('agentSpaceId is required: this stack attaches to an existing Agent Space');
    }
    if (props.agentSpaceRegion !== undefined && !props.agentSpaceRegion.trim()) {
      // A blank string would survive `?? this.region` and produce an ARN with an empty Region
      // segment plus an SDK client with no Region: a clean deploy that fails every invocation.
      throw new Error('agentSpaceRegion must be a Region name, or omitted to use the stack Region');
    }
    if (deliveryMode !== 'api' && deliveryMode !== 'webhook') {
      // Without this, a typo such as `Webhook` silently deploys as api mode and then
      // throws inside the handler on every invocation.
      throw new Error(`deliveryMode must be 'api' or 'webhook', got '${String(deliveryMode)}'`);
    }
    /** Narrows the optional prop to a string once, instead of asserting at each use. */
    const requireWebhookSecretArn = (): string => {
      const arn = props.webhookSecretArn?.trim();
      if (!arn) {
        throw new Error(
          'webhookSecretArn is required for webhook mode. Create the webhook and store its ' +
            'URL and secret first — see "Creating the webhook" in the README.',
        );
      }
      return arn;
    };
    const webhookSecretArn = deliveryMode === 'webhook' ? requireWebhookSecretArn() : undefined;

    // Customer-managed key rather than alias/aws/sns: AWS managed keys cannot be shared
    // across accounts, and cross-account alarms must be able to publish to the topic.
    const key = new kms.Key(this, 'PipelineKey', {
      description: 'Encrypts the DevOps Agent alarm ingress topic',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'CloudWatch alarms routed to AWS DevOps Agent',
      masterKey: key,
      enforceSSL: true,
    });

    // CloudWatch publishes on the alarm's behalf, so SNS needs the data key as the
    // service principal. A key's default policy covers only the account root, and a
    // service principal cannot be granted through IAM — without this statement even a
    // same-account alarm fails to publish, and CloudWatch reports the failure nowhere.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAlarmPublishEncrypt',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'], // In a key policy, '*' means this key only.
        conditions: { StringEquals: { 'aws:SourceAccount': [this.account, ...publisherAccounts] } },
      }),
    );

    // Required even for same-account alarms. `enforceSSL` makes CDK attach an explicit
    // AWS::SNS::TopicPolicy, and attaching any topic policy replaces SNS's implicit default
    // statement — leaving only the deny-non-TLS rule and no Allow at all, so every
    // publisher including CloudWatch is denied. A service principal can only be granted
    // here, never through IAM.
    this.alarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAlarmPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alarmTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': [this.account, ...publisherAccounts] } },
      }),
    );

    // Redrive target for the ingress queue, and the dead-letter queue for the asynchronous
    // ingress paths (a direct invoke or an alarm action). It is NOT reachable from the queue's
    // event source mapping: Lambda's DeadLetterConfig covers asynchronous invocations only,
    // and on-failure destinations are not supported for SQS sources — for the queue path,
    // redrive after maxReceiveCount is the only mechanism.
    //
    // SQS-managed encryption rather than the CMK, so nothing needs a KMS grant to write here.
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    // SQS requires the visibility timeout to be at least six times the function timeout plus
    // the batching window; derived from both so raising either cannot silently break it and
    // start redelivering messages that are still in flight.
    const functionTimeout = Duration.seconds(30);
    const batchingWindow = Duration.seconds(5);
    const visibilityTimeout = Duration.seconds(6 * (functionTimeout.toSeconds() + batchingWindow.toSeconds()));

    // Buffer between the topics and the function. It is what lets several topics fan in,
    // and it upgrades the retry story: failed messages come back individually via
    // ReportBatchItemFailures and land in the dead-letter queue after maxReceiveCount,
    // instead of the whole invocation being retried.
    this.alarmIngressQueue = new sqs.Queue(this, 'AlarmIngressQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout,
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    const logGroupClass = props.logGroupClass ?? logs.LogGroupClass.STANDARD;
    const indexAuditFields = props.indexAuditFields ?? true;

    if (logGroupClass === logs.LogGroupClass.INFREQUENT_ACCESS && indexAuditFields) {
      throw new Error(
        'indexAuditFields cannot be combined with LogGroupClass.INFREQUENT_ACCESS: field index ' +
          'policies are only supported on the Standard log class. Set indexAuditFields: false ' +
          'to accept Infrequent Access without indexes.',
      );
    }

    const logGroup = new logs.LogGroup(this, 'BridgeLogs', {
      // Three months: long enough for a quarterly audit or incident review, short enough
      // that storage does not accumulate indefinitely.
      retention: logs.RetentionDays.THREE_MONTHS,
      logGroupClass,
      // Indexes the fields the audit records actually emit, so a query filtering on an
      // incident, task or alarm skips log events that cannot match. Spread, because the
      // property must be absent rather than undefined on the Infrequent Access path.
      ...(logGroupClass === logs.LogGroupClass.STANDARD && indexAuditFields
        ? { fieldIndexPolicies: [new logs.FieldIndexPolicy({ fields: [...INDEXED_LOG_FIELDS] })] }
        : {}),
      // Retained on purpose: this is the audit trail, and deleting the stack should not
      // destroy three months of records about what the agent was asked to investigate. The
      // orphaned group is the price, and it ages out on its own retention.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // An explicit role keeps the function off AWSLambdaBasicExecutionRole, so log access
    // is scoped to this one log group instead of every group in the account.
    const role = new iam.Role(this, 'BridgeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the DevOps Agent alarm bridge',
    });
    logGroup.grantWrite(role);

    // Written out rather than using queue.grantSendMessages(), which adds
    // GetQueueAttributes/GetQueueUrl the function never calls. With SQS-managed
    // encryption there are no KMS actions to grant either, so the role holds no
    // wildcard action and needs no cdk-nag acknowledgement.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [this.deadLetterQueue.queueArn],
      }),
    );

    if (deliveryMode === 'api') {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['aidevops:CreateBacklogTask'],
          resources: [
            this.formatArn({
              service: 'aidevops',
              region: agentSpaceRegion,
              resource: 'agentspace',
              resourceName: props.agentSpaceId,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ],
        }),
      );
    } else {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [requireWebhookSecretArn()],
        }),
      );
    }

    this.bridgeFunction = new NodejsFunction(this, 'Bridge', {
      entry: path.join(__dirname, '..', 'lambda', 'handlers', 'alarm-to-devops-agent.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 256,
      timeout: functionTimeout,
      role,
      logGroup,
      deadLetterQueue: this.deadLetterQueue,
      reservedConcurrentExecutions: 10,
      environment: {
        // Without this Node never reads the emitted source map, so stack traces stay
        // minified and the map is dead weight in the package.
        NODE_OPTIONS: '--enable-source-maps',
        // Powertools owns log levels and always emits JSON. Lambda's JSON advanced logging
        // control is deliberately left off: it would nest each already-JSON line under
        // `message` and break the flat field indexes above.
        POWERTOOLS_SERVICE_NAME: 'alarm-to-devops-agent',
        POWERTOOLS_LOG_LEVEL: props.logLevel ?? 'INFO',
        DELIVERY_MODE: deliveryMode,
        AGENT_SPACE_ID: props.agentSpaceId,
        DEVOPS_AGENT_REGION: agentSpaceRegion,
        ...(webhookSecretArn ? { WEBHOOK_SECRET_ARN: webhookSecretArn } : {}),
      },
      bundling: {
        // Nothing external. NodejsFunction otherwise leaves `@aws-sdk/*` to the runtime,
        // and the Lambda runtime's bundled SDK does not include client-devops-agent —
        // `api` mode would fail at import time. test/bundle.test.ts guards this.
        externalModules: [],
        minify: true,
        sourceMap: true,
      },
    });

    // Raw delivery on subscriptions we create, so the message body is the alarm
    // notification itself. The parser also accepts the SNS envelope form, for a topic
    // somebody else already subscribed to this queue without raw delivery.
    this.alarmTopic.addSubscription(
      new subscriptions.SqsSubscription(this.alarmIngressQueue, { rawMessageDelivery: true }),
    );

    for (const topicArn of additionalTopicArns) {
      // Keyed on the topic name rather than its index, so reordering the list does not
      // replace unrelated subscriptions.
      const id = `AdditionalTopic${(topicArn.split(':').pop() ?? '').replace(/[^A-Za-z0-9]/g, '')}`;
      sns.Topic.fromTopicArn(this, id, topicArn).addSubscription(
        new subscriptions.SqsSubscription(this.alarmIngressQueue, { rawMessageDelivery: true }),
      );
    }

    this.bridgeFunction.addEventSource(
      new eventsources.SqsEventSource(this.alarmIngressQueue, {
        batchSize: 10,
        maxBatchingWindow: batchingWindow,
        reportBatchItemFailures: true,
      }),
    );

    // The only acknowledgement in this stack. AwsSolutions-SQS3 requires every queue to
    // have a redrive policy; the rule cannot tell that this queue *is* the redrive target,
    // and giving it its own dead-letter queue would just move the finding one queue along.
    Validations.of(this.deadLetterQueue).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason:
        'This queue is the redrive target for the ingress queue and the dead-letter queue for ' +
        'the function. A DLQ cannot itself have a DLQ without recursing.',
    });

    new CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'Subscribe CloudWatch alarms to this topic (AlarmActions), including cross-account',
    });
    new CfnOutput(this, 'BridgeFunctionName', { value: this.bridgeFunction.functionName });
    new CfnOutput(this, 'AlarmIngressQueueUrl', {
      value: this.alarmIngressQueue.queueUrl,
      description:
        'Queue the bridge drains. To fan in a topic you already own, pass it in ' +
        'additionalAlarmTopicArns — subscribing it by hand is not enough, because this ' +
        "queue's policy allows SNS to send only from the topic ARNs passed that way",
    });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: this.deadLetterQueue.queueUrl });
  }
}
