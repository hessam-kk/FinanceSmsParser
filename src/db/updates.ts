/**
 * Deduplication of Telegram webhook deliveries via `processed_updates`.
 *
 * Telegram can retry a webhook request that did not answer 200. Every delivery
 * carries the same `update_id`, so keying on `update_id` is exact: a processed
 * update is never processed twice, and a genuinely new update is never
 * dropped. Callback queries arrive as updates too and share the same rule.
 */

import { nowIso } from "../utils/dates";

export async function isUpdateProcessed(db: D1Database, updateId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM processed_updates WHERE update_id = ?")
    .bind(updateId)
    .first();
  return row !== null;
}

export async function markUpdateProcessed(db: D1Database, updateId: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)")
    .bind(updateId, nowIso())
    .run();
}