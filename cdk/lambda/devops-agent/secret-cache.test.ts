import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { getWebhookCredentials, resetWebhookCredentialsCache } from './secret-cache';

const secretsMock = mockClient(SecretsManagerClient);
const SECRET_ARN = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:devops-agent-webhook-AbCdEf';

function secretValue(webhookSecret: string) {
  return {
    SecretString: JSON.stringify({
      webhookUrl: 'https://event-ai.ap-southeast-1.api.aws/webhook/generic/abc123',
      webhookSecret,
    }),
  };
}

beforeEach(() => {
  secretsMock.reset();
  resetWebhookCredentialsCache();
  jest.useRealTimers();
});

describe('getWebhookCredentials', () => {
  it('reads the URL and secret from the secret payload', async () => {
    secretsMock.on(GetSecretValueCommand).resolves(secretValue('v1'));

    await expect(getWebhookCredentials(SECRET_ARN)).resolves.toEqual({
      webhookUrl: 'https://event-ai.ap-southeast-1.api.aws/webhook/generic/abc123',
      webhookSecret: 'v1',
    });
    expect(secretsMock).toHaveReceivedCommandWith(GetSecretValueCommand, { SecretId: SECRET_ARN });
  });

  it('caches within the TTL so a burst of alarms makes one Secrets Manager call', async () => {
    secretsMock.on(GetSecretValueCommand).resolves(secretValue('v1'));

    await getWebhookCredentials(SECRET_ARN);
    await getWebhookCredentials(SECRET_ARN);
    await getWebhookCredentials(SECRET_ARN);

    expect(secretsMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
  });

  it('re-reads after the TTL, so a rotated webhook secret is picked up without a redeploy', async () => {
    secretsMock.on(GetSecretValueCommand).resolves(secretValue('v1'));
    jest.useFakeTimers({ now: new Date('2026-09-25T00:00:00.000Z') });

    await expect(getWebhookCredentials(SECRET_ARN)).resolves.toMatchObject({ webhookSecret: 'v1' });

    // Rotation invalidates the old secret immediately; a warm container holding it would
    // fail every delivery until recycled.
    secretsMock.on(GetSecretValueCommand).resolves(secretValue('v2'));
    jest.setSystemTime(new Date('2026-09-25T00:06:00.000Z'));

    await expect(getWebhookCredentials(SECRET_ARN)).resolves.toMatchObject({ webhookSecret: 'v2' });
    expect(secretsMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
  });

  it('re-reads when asked for a different secret inside the TTL', async () => {
    secretsMock.on(GetSecretValueCommand, { SecretId: SECRET_ARN }).resolves(secretValue('first'));
    secretsMock.on(GetSecretValueCommand, { SecretId: 'arn:aws:secretsmanager:::secret:other' }).resolves(
      secretValue('second'),
    );

    await expect(getWebhookCredentials(SECRET_ARN)).resolves.toMatchObject({ webhookSecret: 'first' });
    // Returning the cached value here would sign with the wrong secret and every POST
    // would come back 403 with nothing to explain it.
    await expect(getWebhookCredentials('arn:aws:secretsmanager:::secret:other')).resolves.toMatchObject({
      webhookSecret: 'second',
    });
  });

  it('fails loudly when the secret is missing a required field', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ webhookUrl: 'https://x' }) });

    await expect(getWebhookCredentials(SECRET_ARN)).rejects.toThrow(/webhookUrl and webhookSecret/);
  });

  it('fails when the secret holds binary only', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({});

    await expect(getWebhookCredentials(SECRET_ARN)).rejects.toThrow(/no string value/);
  });

  it('propagates access errors rather than silently skipping delivery', async () => {
    secretsMock.on(GetSecretValueCommand).rejects(new Error('AccessDeniedException'));

    await expect(getWebhookCredentials(SECRET_ARN)).rejects.toThrow('AccessDeniedException');
  });
});
