import { bearerWebhookRequest, signWebhookRequest } from './webhook-signature';
import type { IncidentEvent } from './webhook-client';

const incident: IncidentEvent = {
  eventType: 'incident',
  incidentId: 'i-1',
  action: 'created',
  priority: 'HIGH',
  title: 't',
};

describe('signWebhookRequest', () => {
  /**
   * The expected digest was produced outside this codebase with the recipe from the
   * DevOps Agent docs:
   *
   *   printf '%s' "${TS}:${BODY}" | openssl dgst -sha256 -hmac 'shhh' -binary | base64
   *
   * That makes it a real check on the wire format — the signed-string layout and the
   * base64 encoding — rather than a restatement of what the code already does.
   */
  it('signs timestamp:body with HMAC-SHA256 and base64-encodes the digest', () => {
    const { headers, body } = signWebhookRequest(incident, 'shhh', new Date('2026-09-25T00:00:00.000Z'));

    expect(headers['x-amzn-event-timestamp']).toBe('2026-09-25T00:00:00.000Z');
    expect(headers['x-amzn-event-signature']).toBe('YGbJiTbk+xuPmMq6CmlZYzVA1T3/krHpqnoRYC9Hk3k=');
    expect(headers['content-type']).toBe('application/json');
    expect(body).toBe(
      '{"eventType":"incident","incidentId":"i-1","action":"created","priority":"HIGH","title":"t"}',
    );
  });

  it('signs the timestamp it publishes in the header', () => {
    const { headers, body } = signWebhookRequest(incident, 'shhh');
    const resigned = signWebhookRequest(JSON.parse(body), 'shhh', new Date(headers['x-amzn-event-timestamp']!));

    expect(resigned.headers['x-amzn-event-signature']).toBe(headers['x-amzn-event-signature']);
  });

  it('produces a different signature for a different secret', () => {
    const a = signWebhookRequest(incident, 'shhh', new Date('2026-09-25T00:00:00.000Z'));
    const b = signWebhookRequest(incident, 'other', new Date('2026-09-25T00:00:00.000Z'));

    expect(a.headers['x-amzn-event-signature']).not.toBe(b.headers['x-amzn-event-signature']);
  });

  it('produces a different signature for the same payload at a different time', () => {
    const a = signWebhookRequest(incident, 'shhh', new Date('2026-09-25T00:00:00.000Z'));
    const b = signWebhookRequest(incident, 'shhh', new Date('2026-09-25T00:00:01.000Z'));

    expect(a.headers['x-amzn-event-signature']).not.toBe(b.headers['x-amzn-event-signature']);
  });

  it('is sensitive to payload mutation, including key order', () => {
    const reordered = { ...incident, title: 't', priority: 'HIGH' as const };
    const withExtraField = { ...incident, description: 'added' };
    const at = new Date('2026-09-25T00:00:00.000Z');

    // Same keys in the same order serialize identically, so the signature holds.
    expect(signWebhookRequest(reordered, 'shhh', at).headers['x-amzn-event-signature']).toBe(
      signWebhookRequest(incident, 'shhh', at).headers['x-amzn-event-signature'],
    );
    expect(signWebhookRequest(withExtraField, 'shhh', at).headers['x-amzn-event-signature']).not.toBe(
      signWebhookRequest(incident, 'shhh', at).headers['x-amzn-event-signature'],
    );
  });
});

describe('bearerWebhookRequest', () => {
  it('sends the token in the authorization header and signs nothing', () => {
    const { headers } = bearerWebhookRequest(incident, 'api-key-123');

    expect(headers['authorization']).toBe('Bearer api-key-123');
    expect(headers['x-amzn-event-signature']).toBeUndefined();
    expect(headers['x-amzn-event-timestamp']).toBeDefined();
  });
});
