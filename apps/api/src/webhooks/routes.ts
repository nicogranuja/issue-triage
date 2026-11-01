import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Database, Transaction } from '../db/client.js';
import { claimDelivery } from './deliveries.js';
import { upsertIssue } from './issues.js';
import { isHandledIssueAction, issuesEventSchema, readAction } from './payloads.js';
import { SIGNATURE_HEADER, verifySignature } from './signature.js';

export interface GithubWebhookOptions {
  db: Database;
  secret: string;
}

/** Body of every 2xx webhook response. */
export interface WebhookResponse {
  status: 'processed' | 'ignored' | 'duplicate';
}

const deliveryHeadersSchema = z.object({
  'x-github-delivery': z.string().min(1).max(128),
  'x-github-event': z.string().min(1).max(64),
});

interface HandledDelivery {
  status: WebhookResponse['status'];
  /** Log context describing what was applied. */
  details?: Record<string, unknown> | undefined;
}

/** What to do with a verified delivery, decided before opening a transaction. */
type DeliveryPlan =
  | { kind: 'process'; apply: (tx: Transaction) => Promise<Record<string, unknown>> }
  | { kind: 'ignore' }
  | { kind: 'reject'; error: z.ZodError };

function planDelivery(event: string, action: string | null, payload: unknown): DeliveryPlan {
  if (event === 'issues' && isHandledIssueAction(action)) {
    const parsed = issuesEventSchema.safeParse(payload);
    if (!parsed.success) {
      return { kind: 'reject', error: parsed.error };
    }
    return {
      kind: 'process',
      apply: async (tx) => ({
        issueNumber: parsed.data.issue.number,
        repository: parsed.data.repository.full_name,
        result: await upsertIssue(tx, parsed.data),
      }),
    };
  }
  // Everything else (ping, other events, other issue actions) is acknowledged and recorded.
  return { kind: 'ignore' };
}

/**
 * `POST /webhooks/github`: verifies the signature, deduplicates by delivery id, and mirrors
 * issue events into the database.
 */
export const githubWebhookRoutes: FastifyPluginAsync<GithubWebhookOptions> = async (
  app,
  { db, secret },
) => {
  // The signature covers the exact bytes GitHub sent, so this plugin receives JSON bodies as raw
  // Buffers and parses them only after verifying. Plugin encapsulation keeps other routes on the
  // default parser. Issue payloads stay well under Fastify's default 1 MiB body limit.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/webhooks/github', async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = request.headers[SIGNATURE_HEADER];
    if (!verifySignature(secret, rawBody, typeof signature === 'string' ? signature : undefined)) {
      request.log.warn(
        { signature: signature === undefined ? 'missing' : 'invalid' },
        'rejected webhook: bad signature',
      );
      return reply.code(401).send({ error: 'Invalid or missing signature' });
    }

    const headers = deliveryHeadersSchema.safeParse(request.headers);
    if (!headers.success) {
      return reply.code(400).send({ error: 'Missing X-GitHub-Delivery or X-GitHub-Event header' });
    }
    const deliveryId = headers.data['x-github-delivery'];
    const event = headers.data['x-github-event'];

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'Body is not valid JSON' });
    }

    const action = readAction(payload);
    const log = request.log.child({ deliveryId, event, action });
    const plan = planDelivery(event, action, payload);
    if (plan.kind === 'reject') {
      // Not recorded as delivered, so GitHub shows the failure and it can be redelivered once
      // the schema is fixed.
      const problems = plan.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      log.warn({ problems }, 'rejected webhook: unexpected payload');
      return reply.code(400).send({ error: `Unexpected ${event} payload` });
    }

    const { status, details } = await db.transaction(async (tx): Promise<HandledDelivery> => {
      const outcome = plan.kind === 'process' ? 'processed' : 'ignored';
      const claimed = await claimDelivery(tx, { deliveryId, event, action, outcome });
      if (!claimed) {
        return { status: 'duplicate' };
      }
      const details = plan.kind === 'process' ? await plan.apply(tx) : undefined;
      return { status: outcome, details };
    });

    // Logged after commit, so a line here means the outcome is durable.
    log.info({ status, ...details }, 'webhook handled');
    return reply.code(200).send({ status } satisfies WebhookResponse);
  });
};
