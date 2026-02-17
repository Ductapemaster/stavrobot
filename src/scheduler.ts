import pg from "pg";
import { CronExpressionParser } from "cron-parser";
import { listCronEntries, deleteCronEntry } from "./database.js";
import { enqueueMessage } from "./queue.js";

interface ScheduledEntry {
  id: number;
  note: string;
  nextFireAt: Date;
  cronExpression: string | null;
}

let scheduledEntries: ScheduledEntry[] = [];
let schedulerPool: pg.Pool | undefined;

function computeNextFireAt(cronExpression: string): Date {
  const interval = CronExpressionParser.parse(cronExpression);
  return interval.next().toDate();
}

async function loadEntries(pool: pg.Pool): Promise<void> {
  const entries = await listCronEntries(pool);
  scheduledEntries = entries.map((entry) => {
    if (entry.cronExpression !== null) {
      return {
        id: entry.id,
        note: entry.note,
        nextFireAt: computeNextFireAt(entry.cronExpression),
        cronExpression: entry.cronExpression,
      };
    } else {
      return {
        id: entry.id,
        note: entry.note,
        nextFireAt: entry.fireAt!,
        cronExpression: null,
      };
    }
  });
}

function tick(): void {
  const now = new Date();

  // Step 1: Snapshot all entries that are due.
  const toFire = scheduledEntries.filter((entry) => entry.nextFireAt <= now);

  // Step 2: Update in-memory state synchronously before any async work.
  for (const entry of toFire) {
    if (entry.cronExpression !== null) {
      // Recurring: recompute next fire time in-place.
      entry.nextFireAt = computeNextFireAt(entry.cronExpression);
    } else {
      // One-shot: remove from in-memory list immediately so the next tick
      // won't re-fire it, even if the DB deletion hasn't completed yet.
      scheduledEntries = scheduledEntries.filter((e) => e.id !== entry.id);
      // Delete from DB asynchronously; the in-memory list is already updated.
      void deleteCronEntry(schedulerPool!, entry.id);
    }
  }

  // Step 3: Fire all due entries. Fire-and-forget — do not await.
  for (const entry of toFire) {
    const framedNote = `[Cron entry ${entry.id} has fired] ${entry.note}\n\nThis is a scheduled reminder that has just triggered. Act on the note above directly (e.g. send a message, update a memory). Do not create new cron entries in response to this.`;
    void enqueueMessage(framedNote, "cron");
  }
}

export async function initializeScheduler(pool: pg.Pool): Promise<void> {
  schedulerPool = pool;
  await loadEntries(pool);
  setInterval(tick, 60_000);
  console.log(`[stavrobot] Scheduler initialized with ${scheduledEntries.length} entries.`);
}

export async function reloadScheduler(pool: pg.Pool): Promise<void> {
  await loadEntries(pool);
  console.log(`[stavrobot] Scheduler reloaded with ${scheduledEntries.length} entries.`);
}
