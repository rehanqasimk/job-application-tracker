import { getTenantId } from "@/lib/tenant/server";
import { jobsTag } from "@/lib/cache-tags";
import connectDB from "@/lib/db";
import { Board } from "@/lib/models";
import { cacheTag } from "next/cache";
import { redirect } from "next/navigation";
import KanbanBoard from "@/components/kanban-board";
import StatsSidebar, { StatsSkeleton } from "@/components/stats-sidebar";
import { Suspense } from "react";

async function getBoard(tenantId: string) {
  "use cache";
  // Tag this cached read so a mutation can purge exactly this tenant's job list
  // via updateTag(jobsTag(tenantId)) — instead of the coarse
  // revalidatePath("/dashboard") that blew away the whole route's cache.
  cacheTag(jobsTag(tenantId));

  await connectDB();

  const boardDoc = await Board.findOne({
    userId: tenantId,
    name: "Job Hunt",
  }).populate({
    path: "columns",
    populate: {
      path: "jobApplications",
    },
  });

  if (!boardDoc) return null;

  const board = JSON.parse(JSON.stringify(boardDoc));

  return board;
}

/**
 * The job list. Fast: reads the CACHED, tag-invalidated board (Task 2). Lives in
 * its own Suspense boundary so it streams in independently of — and well before
 * — the slow Stats sidebar.
 */
async function BoardSection() {
  const tenantId = await getTenantId();
  if (!tenantId) redirect("/sign-in");

  const board = await getBoard(tenantId);
  return <KanbanBoard board={board} userId={tenantId} />;
}

/**
 * The Stats sidebar. Slow: an uncached MongoDB aggregation. It is behind its OWN
 * Suspense boundary (below) so its latency never blocks the job list.
 */
async function StatsSection() {
  const tenantId = await getTenantId();
  if (!tenantId) return null;

  return <StatsSidebar tenantId={tenantId} />;
}

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-white">
      <div className="container mx-auto p-6">
        {/* Static shell — prerendered, instant. */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-black">Job Hunt</h1>
          <p className="text-gray-600">Track your job applications</p>
        </div>

        <div className="flex flex-col gap-6 lg:flex-row">
          {/*
            TWO independent Suspense boundaries — this is the Task 3 decision.
            The boundary is drawn at each "independent data + distinct latency"
            seam: the cached board resolves fast and streams first; the slow
            aggregation streams into the sidebar afterward and never blocks it.
            A single boundary around both would couple the board's paint to the
            slow stats query — the exact thing we're avoiding.
          */}
          <main className="min-w-0 flex-1">
            <Suspense fallback={<BoardSkeleton />}>
              <BoardSection />
            </Suspense>
          </main>

          <aside className="w-full shrink-0 lg:w-80">
            <Suspense fallback={<StatsSkeleton />}>
              <StatsSection />
            </Suspense>
          </aside>
        </div>
      </div>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-64 flex-1 animate-pulse rounded-lg border border-gray-200 bg-gray-100"
        />
      ))}
    </div>
  );
}
