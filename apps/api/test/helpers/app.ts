import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import { signPayload } from '../../src/webhooks/signature.js';

export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

export function createTestApp(database: DatabaseHandle): Promise<FastifyInstance> {
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    LOG_LEVEL: 'silent',
    TRIAGE_PROVIDER: 'fake',
  });
  return buildApp({ config, db: database.db, logger: pino({ level: 'silent' }) });
}

export interface Delivery {
  event: string;
  payload: unknown;
  deliveryId?: string;
  /** Secret to sign with. Defaults to the app's secret. */
  secret?: string;
  /** Overrides the computed `X-Hub-Signature-256`; `null` omits the header. */
  signature?: string | null;
  /** Raw body to send instead of the JSON-encoded payload. */
  rawBody?: string;
  headers?: Record<string, string>;
}

let deliveryCounter = 0;

/** Sends a webhook delivery the way GitHub does: JSON body, signed, with delivery headers. */
export function deliver(app: FastifyInstance, delivery: Delivery): Promise<LightMyRequestResponse> {
  const body = delivery.rawBody ?? JSON.stringify(delivery.payload);
  const signature =
    delivery.signature === undefined
      ? signPayload(delivery.secret ?? TEST_WEBHOOK_SECRET, body)
      : delivery.signature;
  deliveryCounter += 1;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'GitHub-Hookshot/test',
    'x-github-event': delivery.event,
    'x-github-delivery':
      delivery.deliveryId ?? `00000000-0000-4000-8000-${String(deliveryCounter).padStart(12, '0')}`,
    ...delivery.headers,
  };
  if (signature !== null) {
    headers['x-hub-signature-256'] = signature;
  }

  return app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
}
