import { createHmac } from 'node:crypto';

/**
 * A request body plus the headers that authenticate it. The body is returned as a
 * string on purpose: DevOps Agent verifies the signature against the exact bytes it
 * receives, so the caller must post this string verbatim. Re-serializing the payload
 * after signing (even with identical semantics) invalidates the signature.
 */
export interface SignedWebhookRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
}

/**
 * Signs a payload for a DevOps Agent generic webhook that was created with HMAC
 * authentication.
 *
 * The service recomputes Base64(HMAC-SHA256(secret, `${timestamp}:${body}`)) and
 * compares it to `x-amzn-event-signature`. Because the timestamp is inside the signed
 * string, the endpoint can reject stale replays — which is also why the header and the
 * signed value have to be the same string.
 */
export function signWebhookRequest(
  payload: unknown,
  webhookSecret: string,
  now: Date = new Date(),
): SignedWebhookRequest {
  const body = JSON.stringify(payload);
  const timestamp = now.toISOString();
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}:${body}`, 'utf8')
    .digest('base64');

  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-amzn-event-timestamp': timestamp,
      'x-amzn-event-signature': signature,
    },
  };
}

/**
 * Equivalent for a webhook created with API key (bearer token) authentication. The
 * token authenticates the sender but does not protect the payload and carries no
 * replay protection, so prefer HMAC for anything we own end to end.
 */
export function bearerWebhookRequest(
  payload: unknown,
  apiKey: string,
  now: Date = new Date(),
): SignedWebhookRequest {
  return {
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      'x-amzn-event-timestamp': now.toISOString(),
      authorization: `Bearer ${apiKey}`,
    },
  };
}
