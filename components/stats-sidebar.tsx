import { getJobStats } from "@/lib/stats";
import { Briefcase, TrendingUp } from "lucide-react";

/**
 * Async server component — the "slow" Stats sidebar. It awaits the aggregation
 * in lib/stats.ts. Rendered inside a <Suspense> boundary in the dashboard so it
 * streams in after the job list rather than blocking it (Task 3).
 */
export default async function StatsSidebar({ tenantId }: { tenantId: string }) {
  const stats = await getJobStats(tenantId);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          icon={<Briefcase className="h-4 w-4" />}
          label="Total"
          value={stats.total}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="This week"
          value={stats.addedThisWeek}
        />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">By stage</h2>
        {stats.byStage.length === 0 ? (
          <p className="text-sm text-gray-500">No applications yet.</p>
        ) : (
          <ul className="space-y-2">
            {stats.byStage.map((stage) => (
              <li
                key={stage.name}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-gray-700">{stage.name}</span>
                <span className="font-medium text-gray-900 tabular-nums">
                  {stage.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-1 flex items-center gap-1.5 text-gray-500">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
    </div>
  );
}

/** Suspense fallback — mirrors the sidebar layout so it doesn't jump on load. */
export function StatsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[76px] animate-pulse rounded-lg border border-gray-200 bg-gray-100"
          />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-100" />
    </div>
  );
}
