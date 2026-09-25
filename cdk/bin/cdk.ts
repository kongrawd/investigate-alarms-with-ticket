#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AlarmToDevOpsAgentStack, type DeliveryMode } from '../lib/alarm-to-devops-agent-stack';

const app = new cdk.App();

/**
 * Configuration comes from context so the same app can point at any existing Agent Space:
 *
 *   npx cdk deploy -c agentSpaceId=<id> -c agentSpaceRegion=ap-southeast-1
 *                  [-c deliveryMode=webhook -c webhookSecretArn=<arn>]
 *                  [-c alarmPublisherAccountIds=111122223333,444455556666]
 *                  [-c additionalAlarmTopicArns=arn:aws:sns:...:team-a,arn:aws:sns:...:team-b]
 *
 * Values can also be set once in cdk.json under "context".
 */
/**
 * Reads a context value, treating an empty string as absent. `-c agentSpaceRegion=` would
 * otherwise pass a `??` guard and produce an ARN with a blank Region and an SDK client with
 * no Region — a deploy that succeeds and then fails on every invocation.
 */
const context = (key: string): string | undefined => {
  const value = app.node.tryGetContext(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

const agentSpaceId = context('agentSpaceId');
if (!agentSpaceId) {
  throw new Error('Missing context: -c agentSpaceId=<existing Agent Space id>');
}

/** Reads a comma-separated context value, tolerating spaces and trailing commas. */
const commaList = (key: string): string[] =>
  (context(key) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

new AlarmToDevOpsAgentStack(app, 'AlarmToDevOpsAgentStack', {
  // Deploys to the account/Region of the current CLI credentials. The Agent Space may sit
  // in a different Region, and the alarms in different accounts entirely. Spread rather than
  // assigned so an unset variable leaves the stack environment-agnostic instead of pinning
  // `account: undefined`.
  env: {
    ...(process.env['CDK_DEFAULT_ACCOUNT'] ? { account: process.env['CDK_DEFAULT_ACCOUNT'] } : {}),
    ...(process.env['CDK_DEFAULT_REGION'] ? { region: process.env['CDK_DEFAULT_REGION'] } : {}),
  },
  agentSpaceId,
  agentSpaceRegion: context('agentSpaceRegion'),
  // Passed through as-is; the stack validates it, so a typo fails at synth rather than
  // deploying a function that throws on every invocation.
  deliveryMode: context('deliveryMode') as DeliveryMode | undefined,
  webhookSecretArn: context('webhookSecretArn'),
  alarmPublisherAccountIds: commaList('alarmPublisherAccountIds'),
  // SNS topics you already own. Each is subscribed to the ingress queue, which is how
  // several topics fan in without touching their existing subscribers.
  additionalAlarmTopicArns: commaList('additionalAlarmTopicArns'),
});

// Run cdk-nag's AWS Solutions rule pack on every synth. Findings land in the
// cloud assembly's policy-validation-report.json; use
// cdk.Validations.of(scope).acknowledge({ id, reason }) for accepted risks.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
