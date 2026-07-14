"use server";

import { updateTag } from "next/cache";
import { getTenantId } from "../tenant/server";
import { jobsTag } from "../cache-tags";
import { recordJobEvent } from "../audit";
import connectDB from "../db";
import { Board, Column, JobApplication } from "../models";

// Scalar fields whose edits are worth an audit entry (Task 4).
const AUDITED_FIELDS = [
  "company",
  "position",
  "location",
  "notes",
  "salary",
  "jobUrl",
  "description",
] as const;

// Tenant identity comes from the `x-tenant-id` header injected by proxy.ts after
// it verified the session at the edge — so these actions no longer make a second
// (DB-backed) getSession() call. The header is trusted because middleware always
// overwrites it from the verified session (contract C1). The `userId` filters
// below remain the authoritative isolation boundary (research.md D4).

interface JobApplicationData {
  company: string;
  position: string;
  location?: string;
  notes?: string;
  salary?: string;
  jobUrl?: string;
  columnId: string;
  boardId: string;
  tags?: string[];
  description?: string;
}

export async function createJobApplication(data: JobApplicationData) {
  const tenantId = await getTenantId();

  if (!tenantId) {
    return { error: "Unauthorized" };
  }

  await connectDB();

  const {
    company,
    position,
    location,
    notes,
    salary,
    jobUrl,
    columnId,
    boardId,
    tags,
    description,
  } = data;

  if (!company || !position || !columnId || !boardId) {
    return { error: "Missing required fields" };
  }

  // Verify board ownership + column membership and find the current max order.
  // These three reads are independent, so run them in ONE parallel round-trip
  // instead of three sequential ones (perf: 3 RTTs -> 1).
  const [board, column, maxOrder] = await Promise.all([
    Board.findOne({ _id: boardId, userId: tenantId }),
    Column.findOne({ _id: columnId, boardId: boardId }),
    JobApplication.findOne({ columnId })
      .sort({ order: -1 })
      .select("order")
      .lean<{ order: number } | null>(),
  ]);

  if (!board) {
    return { error: "Board not found" };
  }

  if (!column) {
    return { error: "Column not found" };
  }

  const jobApplication = await JobApplication.create({
    company,
    position,
    location,
    notes,
    salary,
    jobUrl,
    columnId,
    boardId,
    userId: tenantId,
    tags: tags || [],
    description,
    status: "applied",
    order: maxOrder ? maxOrder.order + 1 : 0,
  });

  await Column.findByIdAndUpdate(columnId, {
    $push: { jobApplications: jobApplication._id },
  });

  // Audit log (Task 4): full event → AuditLog collection, plus a capped preview
  // pushed onto the job's recentEvents.
  await recordJobEvent({
    jobId: jobApplication._id.toString(),
    userId: tenantId,
    type: "created",
    summary: `Created — ${company} · ${position}`,
  });

  // Targeted, tenant-scoped invalidation — purges ONLY this tenant's job-list
  // cache, leaving the rest of the layout cached (contrast: revalidatePath would
  // blow away the whole route). updateTag (not revalidateTag) because this runs
  // in a Server Action and the user must see their change on the immediate
  // re-render: updateTag expires the tag NOW (read-your-writes), whereas
  // revalidateTag is stale-while-revalidate. See REASONING.md (Task 2).
  updateTag(jobsTag(tenantId));

  return { data: JSON.parse(JSON.stringify(jobApplication)) };
}

export async function updateJobApplication(
  id: string,
  updates: {
    company?: string;
    position?: string;
    location?: string;
    notes?: string;
    salary?: string;
    jobUrl?: string;
    columnId?: string;
    order?: number;
    tags?: string[];
    description?: string;
  }
) {
  const tenantId = await getTenantId();

  if (!tenantId) {
    return { error: "Unauthorized" };
  }

  const jobApplication = await JobApplication.findById(id);

  if (!jobApplication) {
    return { error: "Job application not found" };
  }

  if (jobApplication.userId !== tenantId) {
    return { error: "Unauthorized" };
  }

  const { columnId, order, ...otherUpdates } = updates;

  const updatesToApply: Partial<{
    company: string;
    position: string;
    location: string;
    notes: string;
    salary: string;
    jobUrl: string;
    columnId: string;
    order: number;
    tags: string[];
    description: string;
  }> = otherUpdates;

  const currentColumnId = jobApplication.columnId.toString();
  const newColumnId = columnId?.toString();

  const isMovingToDifferentColumn =
    newColumnId && newColumnId !== currentColumnId;

  if (isMovingToDifferentColumn) {
    await Column.findByIdAndUpdate(currentColumnId, {
      $pull: { jobApplications: id },
    });

    const jobsInTargetColumn = await JobApplication.find({
      columnId: newColumnId,
      _id: { $ne: id },
    })
      .sort({ order: 1 })
      .lean();

    let newOrderValue: number;

    if (order !== undefined && order !== null) {
      newOrderValue = order * 100;

      // Batch all the order shifts into ONE round-trip instead of one
      // findByIdAndUpdate per card (perf: N serial writes -> 1 bulkWrite).
      const jobsThatNeedToShift = jobsInTargetColumn.slice(order);
      if (jobsThatNeedToShift.length > 0) {
        await JobApplication.bulkWrite(
          jobsThatNeedToShift.map((job) => ({
            updateOne: {
              filter: { _id: job._id },
              update: { $set: { order: job.order + 100 } },
            },
          }))
        );
      }
    } else {
      if (jobsInTargetColumn.length > 0) {
        const lastJobOrder =
          jobsInTargetColumn[jobsInTargetColumn.length - 1].order || 0;
        newOrderValue = lastJobOrder + 100;
      } else {
        newOrderValue = 0;
      }
    }

    updatesToApply.columnId = newColumnId;
    updatesToApply.order = newOrderValue;

    await Column.findByIdAndUpdate(newColumnId, {
      $push: { jobApplications: id },
    });
  } else if (order !== undefined && order !== null) {
    const otherJobsInColumn = await JobApplication.find({
      columnId: currentColumnId,
      _id: { $ne: id },
    })
      .sort({ order: 1 })
      .lean();

    const currentJobOrder = jobApplication.order || 0;
    const currentPositionIndex = otherJobsInColumn.findIndex(
      (job) => job.order > currentJobOrder
    );
    const oldPositionindex =
      currentPositionIndex === -1
        ? otherJobsInColumn.length
        : currentPositionIndex;

    const newOrderValue = order * 100;

    if (order < oldPositionindex) {
      const jobsToShiftDown = otherJobsInColumn.slice(order, oldPositionindex);

      if (jobsToShiftDown.length > 0) {
        await JobApplication.bulkWrite(
          jobsToShiftDown.map((job) => ({
            updateOne: {
              filter: { _id: job._id },
              update: { $set: { order: job.order + 100 } },
            },
          }))
        );
      }
    } else if (order > oldPositionindex) {
      const jobsToShiftUp = otherJobsInColumn.slice(oldPositionindex, order);
      if (jobsToShiftUp.length > 0) {
        await JobApplication.bulkWrite(
          jobsToShiftUp.map((job) => ({
            updateOne: {
              filter: { _id: job._id },
              update: { $set: { order: Math.max(0, job.order - 100) } },
            },
          }))
        );
      }
    }

    updatesToApply.order = newOrderValue;
  }

  const updated = await JobApplication.findByIdAndUpdate(id, updatesToApply, {
    new: true,
  });

  // Audit log (Task 4). A move gets a "moved" event; field edits get an
  // "updated" event listing what changed. A pure reorder (same column, only
  // `order` changed) is intentionally not logged — it isn't a meaningful change.
  const before = jobApplication.toObject() as Record<string, unknown>;
  if (isMovingToDifferentColumn) {
    const [fromCol, toCol] = await Promise.all([
      Column.findById(currentColumnId).select("name").lean<{ name: string } | null>(),
      Column.findById(newColumnId).select("name").lean<{ name: string } | null>(),
    ]);
    await recordJobEvent({
      jobId: id,
      userId: tenantId,
      type: "moved",
      summary: `Moved ${fromCol?.name ?? "?"} → ${toCol?.name ?? "?"}`,
      changes: { fromColumnId: currentColumnId, toColumnId: newColumnId },
    });
  } else {
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of AUDITED_FIELDS) {
      const next = otherUpdates[field];
      if (next !== undefined && next !== before[field]) {
        changed[field] = { from: before[field], to: next };
      }
    }
    if (
      otherUpdates.tags !== undefined &&
      (before.tags as string[] | undefined)?.join(",") !==
        otherUpdates.tags.join(",")
    ) {
      changed.tags = { from: before.tags, to: otherUpdates.tags };
    }
    if (Object.keys(changed).length > 0) {
      await recordJobEvent({
        jobId: id,
        userId: tenantId,
        type: "updated",
        summary: `Updated ${Object.keys(changed).join(", ")}`,
        changes: changed,
      });
    }
  }

  // Targeted, tenant-scoped invalidation — purges ONLY this tenant's job-list
  // cache, leaving the rest of the layout cached (contrast: revalidatePath would
  // blow away the whole route). updateTag (not revalidateTag) because this runs
  // in a Server Action and the user must see their change on the immediate
  // re-render: updateTag expires the tag NOW (read-your-writes), whereas
  // revalidateTag is stale-while-revalidate. See REASONING.md (Task 2).
  updateTag(jobsTag(tenantId));

  return { data: JSON.parse(JSON.stringify(updated)) };
}

export async function deleteJobApplication(id: string) {
  const tenantId = await getTenantId();

  if (!tenantId) {
    return { error: "Unauthorized" };
  }

  const jobApplication = await JobApplication.findById(id);

  if (!jobApplication) {
    return { error: "Job application not found" };
  }

  if (jobApplication.userId !== tenantId) {
    return { error: "Unauthorized" };
  }

  await Column.findByIdAndUpdate(jobApplication.columnId, {
    $pull: { jobApplications: id },
  });

  await JobApplication.deleteOne({ _id: id });

  // Audit log (Task 4): keep the "deleted" event in the AuditLog collection so
  // the history survives the record. recordJobEvent skips the recentEvents push
  // here since the job document no longer exists.
  await recordJobEvent({
    jobId: id,
    userId: tenantId,
    type: "deleted",
    summary: `Deleted — ${jobApplication.company} · ${jobApplication.position}`,
  });

  // Targeted, tenant-scoped invalidation — purges ONLY this tenant's job-list
  // cache, leaving the rest of the layout cached (contrast: revalidatePath would
  // blow away the whole route). updateTag (not revalidateTag) because this runs
  // in a Server Action and the user must see their change on the immediate
  // re-render: updateTag expires the tag NOW (read-your-writes), whereas
  // revalidateTag is stale-while-revalidate. See REASONING.md (Task 2).
  updateTag(jobsTag(tenantId));

  return { success: true };
}
