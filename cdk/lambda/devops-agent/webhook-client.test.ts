import { createHmac } from 'node:crypto';
import { parseAlarmEvents, toIncidentEvent } from './alarm-event';
import { WebhookDeliveryError, postIncident } from './webhook-client';
import { snsEvent } from './cloudwatch-alarms.fixtures';

const WEBHOOK_URL = 'https://event-ai.ap-southeast-1.api.aws/webhook/generic/abc123';
const SECRET = 'shhh';

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * A stub fetch. Jest cannot use undici's MockAgent to intercept native fetch — its
 * globals live in a separate vm context (nodejs/undici#1882) — so the implementation
 * takes an injected fetch and the test asserts on what it was handed.
 */
function stubFetch(status: number, body = 'webhook received'): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  };
  return { fetchImpl, calls };
}

const incident = toIncidentEvent(parseAlarmEvents(snsEvent())[0]!);

describe('postIncident', () => {
  it('POSTs the signed bytes to the webhook URL', async () => {
    const { fetchImpl, calls } = stubFetch(200);

    const status = await postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl });

    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('sends a signature the service can verify against the transmitted body', async () => {
    const { fetchImpl, calls } = stubFetch(200);

    await postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl });

    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = calls[0]!.init.body as string;
    // Recompute the way the service does: over the bytes actually sent, with the
    // timestamp from the header. This is the assertion that catches a body that was
    // re-serialized after signing.
    const expected = createHmac('sha256', SECRET)
      .update(`${headers['x-amzn-event-timestamp']}:${body}`, 'utf8')
      .digest('base64');

    expect(headers['x-amzn-event-signature']).toBe(expected);
    expect(JSON.parse(body)).toEqual(incident);
  });

  it('sets a timeout signal so a hung endpoint cannot pin the function open', async () => {
    const { fetchImpl, calls } = stubFetch(200);

    await postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl, timeoutMs: 1_000 });

    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws WebhookDeliveryError with the status on 4xx, which means auth or headers', async () => {
    const { fetchImpl } = stubFetch(403, 'invalid signature');

    await expect(postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl })).rejects.toMatchObject({
      name: 'WebhookDeliveryError',
      status: 403,
    });
  });

  it('throws on 5xx so the caller can retry or dead-letter', async () => {
    const { fetchImpl } = stubFetch(500, 'internal error');

    await expect(postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl })).rejects.toBeInstanceOf(
      WebhookDeliveryError,
    );
  });

  it('accepts 202 as delivered', async () => {
    const { fetchImpl } = stubFetch(202);

    await expect(postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl })).resolves.toBe(202);
  });

  it('propagates transport failures', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };

    await expect(postIncident(WEBHOOK_URL, SECRET, incident, { fetchImpl })).rejects.toThrow('fetch failed');
  });
});
