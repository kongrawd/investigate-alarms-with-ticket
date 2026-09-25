import { signWebhookRequest } from './webhook-signature';

export type IncidentAction = 'created' | 'updated' | 'closed' | 'resolved';

export type IncidentPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';

/**
 * Payload accepted by the DevOps Agent generic webhook.
 *
 * Only `title`, `description`, `priority` and the incident reference reach the agent as
 * investigation context. `data` is accepted and ignored, so anything the agent needs to
 * reason about belongs in `description` — see foldContext() in alarm-event.ts.
 */
export interface IncidentEvent {
  readonly eventType: 'incident';
  readonly incidentId: string;
  readonly action: IncidentAction;
  readonly priority: IncidentPriority;
  readonly title: string;
  readonly description?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly service?: string | undefined;
  readonly data?: Record<string, unknown>;
}

export interface PostIncidentOptions {
  readonly timeoutMs?: number | undefined;
  /** Test seam. Defaults to the runtime's global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export class WebhookDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`DevOps Agent webhook returned ${status}: ${responseBody.slice(0, 512)}`);
    this.name = 'WebhookDeliveryError';
  }
}

/**
 * Posts an HMAC-signed incident to the webhook URL.
 *
 * A 2xx means authenticated and queued — not that an investigation started. Duplicate
 * incidentId/timestamp pairs are deduplicated server side, and a payload that parses but
 * does not match the schema is also accepted silently, so confirm the first delivery of
 * any new payload shape in the Operator Web App rather than trusting the status code.
 */
export async function postIncident(
  webhookUrl: string,
  webhookSecret: string,
  incident: IncidentEvent,
  options: PostIncidentOptions = {},
): Promise<number> {
  const { body, headers } = signWebhookRequest(incident, webhookSecret);
  // Injected rather than reaching for the global so tests can assert on the exact bytes
  // sent. Jest does not let undici's MockAgent intercept native fetch (its globals live
  // in a separate vm context), so a stub passed in here is the only reliable seam.
  const send = options.fetchImpl ?? fetch;

  const response = await send(webhookUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });

  if (!response.ok) {
    // 4xx here is almost always the signature or the headers, not the payload.
    throw new WebhookDeliveryError(response.status, await response.text());
  }
  return response.status;
}
