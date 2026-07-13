import { getTenantId } from "@/lib/tenant/server";
import { jobsTag } from "@/lib/cache-tags";
import connectDB from "@/lib/db";
import { Board } from "@/lib/models";
import { cacheTag } from "next/cache";
import { redirect } from "next/navigation";
import KanbanBoard from "@/components/kanban-board";
import { Suspense } from "react";

async function getBoard(tenantId: string) {
  "use cache";
  // Tag this cached read so a mutation can purge exactly this tenant's job list
  // via revalidateTag(jobsTag(tenantId)) — instead of the coarse
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

async function DashboardPage() {
  // Tenant identity was verified at the edge and injected as x-tenant-id; no
  // second session/DB round-trip needed here. Missing => not tenant-routed
  // (middleware should have redirected already); fail closed.
  const tenantId = await getTenantId();

  if (!tenantId) {
    redirect("/sign-in");
  }

  const board = await getBoard(tenantId);

  return (
    <div className="min-h-screen bg-white">
      <div className="container mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-black">Job Hunt</h1>
          <p className="text-gray-600">Track your job applications</p>
        </div>
        <KanbanBoard board={board} userId={tenantId} />
      </div>
    </div>
  );
}

export default async function Dashboard() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <DashboardPage />
    </Suspense>
  );
}
