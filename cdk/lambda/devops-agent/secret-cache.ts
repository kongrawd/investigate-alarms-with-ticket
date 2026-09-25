import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Shape of the secret that holds the generic webhook credentials. DevOps Agent reveals
 * the secret exactly once (at webhook creation, or from the AssociateService response),
 * so it has to be captured into Secrets Manager at that moment. Recovery means rotating
 * the webhook, which keeps the URL and mints a new secret.
 */
export interface WebhookCredentials {
  readonly webhookUrl: string;
  readonly webhookSecret: string;
}

const client = new SecretsManagerClient({});

/**
 * Short TTL rather than cache-forever: rotating the webhook invalidates the old secret
 * immediately, and a warm container holding a stale value would fail every delivery
 * until it was recycled.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { secretId: string; value: WebhookCredentials; fetchedAt: number } | undefined;

export async function getWebhookCredentials(secretId: string): Promise<WebhookCredentials> {
  // Keyed by secretId, not just time: without it a second ARN would silently receive the
  // first one's credentials and every signed request would come back 403.
  if (cached && cached.secretId === secretId && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) {
    throw new Error(`Secret ${secretId} has no string value`);
  }

  const parsed = JSON.parse(SecretString) as Partial<WebhookCredentials>;
  if (!parsed.webhookUrl || !parsed.webhookSecret) {
    throw new Error(`Secret ${secretId} must contain webhookUrl and webhookSecret`);
  }

  const value: WebhookCredentials = {
    webhookUrl: parsed.webhookUrl,
    webhookSecret: parsed.webhookSecret,
  };
  cached = { secretId, value, fetchedAt: Date.now() };
  return value;
}

/** Test seam: drops the cached credentials so the next call re-reads the secret. */
export function resetWebhookCredentialsCache(): void {
  cached = undefined;
}
