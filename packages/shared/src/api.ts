import { z } from 'zod';

/** Response body of `GET /healthz`, a liveness check. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
