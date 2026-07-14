import { AuditLog, JobApplication } from "./models";
import type { AuditEventType } from "./models/audit-log";

/** How many recent events the Outlier preview keeps on the job document. */
export const RECENT_EVENTS_LIMIT = 3;

interface RecordJobEventParams {
  jobId: string;
  userId: string; // tenant scope
  type: AuditEventType;
  summary: string;
  changes?: Record<string, unknown>;
}

/**
 * Record one audit event. Two writes, by design (Task 4):
 *
 *   1. Append the FULL event to the separate `AuditLog` collection — unbounded
 *      history that never touches (or bloats) the job document.
 *   2. Push a compact snapshot onto the job's `recentEvents`, capped to the last
 *      N via $slice — the Outlier "last 3 events" preview for fast, join-free
 *      reads on the board.
 *
 * For "deleted" we skip step 2 (the job document is gone) but still keep step 1,
 * so the history survives the record it describes.
 */
export async function recordJobEvent({
  jobId,
  userId,
  type,
  summary,
  changes,
}: RecordJobEventParams): Promise<void> {
  await AuditLog.create({ jobId, userId, type, summary, changes });

  if (type !== "deleted") {
    await JobApplication.updateOne(
      { _id: jobId },
      {
        $push: {
          recentEvents: {
            $each: [{ type, summary, at: new Date() }],
            $slice: -RECENT_EVENTS_LIMIT, // keep only the last N
          },
        },
      }
    );
  }
}
