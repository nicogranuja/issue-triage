import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../src/db/client.js';
import { createTestApp } from './helpers/app.js';
import { createTestDatabase } from './helpers/database.js';

describe('GET /healthz', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp(database);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('reports the process is up', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
