import connectDB from "./db";
import { JobApplication } from "./models";

export interface JobStats {
  total: number;
  addedThisWeek: number;
  byStage: { name: string; count: number }[];
}

/**
 * The "slow" dashboard stat: a MongoDB aggregation over a tenant's applications.
 * Tenant-scoped by `userId` (= tenantId), consistent with the rest of the app.
 *
 * Deliberately NOT cached: it is rendered inside a <Suspense> boundary so it
 * streams in ("pops in") after the job list, and stays fresh so a newly-added
 * job is reflected immediately (Task 3). See REASONING.md.
 */
export async function getJobStats(tenantId: string): Promise<JobStats> {
  await connectDB();

  // --- Demo-only latency -----------------------------------------------------
  // On a small seed dataset this aggregation returns in a few ms, so the
  // streaming "pop-in" is invisible. This artificial delay stands in for the
  // production-scale cost the brief describes; REMOVE for real deployments.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // ---------------------------------------------------------------------------

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // A single $facet aggregation computes total, this-week, and per-stage counts
  // in one round-trip instead of three separate queries.
  const [result] = await JobApplication.aggregate([
    { $match: { userId: tenantId } },
    {
      $facet: {
        total: [{ $count: "count" }],
        thisWeek: [
          { $match: { createdAt: { $gte: weekAgo } } },
          { $count: "count" },
        ],
        byStage: [
          { $group: { _id: "$columnId", count: { $sum: 1 } } },
          {
            $lookup: {
              from: "columns",
              localField: "_id",
              foreignField: "_id",
              as: "column",
            },
          },
          { $unwind: "$column" },
          {
            $project: {
              _id: 0,
              name: "$column.name",
              order: "$column.order",
              count: 1,
            },
          },
          { $sort: { order: 1 } },
        ],
      },
    },
  ]);

  return {
    total: result?.total?.[0]?.count ?? 0,
    addedThisWeek: result?.thisWeek?.[0]?.count ?? 0,
    byStage: (result?.byStage ?? []).map(
      (s: { name: string; count: number }) => ({
        name: s.name,
        count: s.count,
      })
    ),
  };
}
