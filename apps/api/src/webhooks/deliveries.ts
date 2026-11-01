import type { Transaction } from '../db/client.js';
import { webhookDeliveries } from '../db/schema.js';

export interface DeliveryRecord {
  deliveryId: string;
  event: string;
  action: string | null;
  outcome: 'processed' | 'ignored';
}

/**
 * Claims a delivery id. Returns false if it was already recorded, meaning this is a redelivery.
 *
 * Call it inside the transaction that applies the event: if processing fails, the claim rolls
 * back with it and a later redelivery is processed normally. A concurrent duplicate blocks on the
 * primary key until the first transaction finishes, so an event is never applied twice.
 */
export async function claimDelivery(tx: Transaction, record: DeliveryRecord): Promise<boolean> {
  const inserted = await tx
    .insert(webhookDeliveries)
    .values(record)
    .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return inserted.length > 0;
}
