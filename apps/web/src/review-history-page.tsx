import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  FileSearch,
  Filter,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import type { ReviewJob, ReviewStats } from "@contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReviewJobList } from "./review-job-list";
import { ReviewSessionDrawer } from "./review-session-drawer";
import {
  countStatus,
  isWithinRange,
  matchesStatusFilter,
  matchesQuery,
  projectLabel,
  ReviewStatusFilter,
  ReviewTimeRange,
  isTerminalReviewStatus,
  statusMeta,
} from "./review-history-shared";

function ReviewHistoryEmpty({ filtered, hasFilters }: { filtered: boolean; hasFilters: boolean }) {
  return (
    <div className="review-history-empty">
      <div className="review-history-empty-icon" aria-hidden="true">
        {filtered ? <Search /> : <FileSearch />}
      </div>
      <strong>{filtered ? "没有匹配的记录" : "还没有 Review 记录"}</strong>
      <p>
        {filtered && hasFilters
          ? "可以清空筛选条件，或换一个项目、MR、SHA 关键词。"
          : "完成一次 Review 后，任务摘要、问题数量和执行事件会保存在这里。"}
      </p>
    </div>
  );
}

function ReviewHistoryStat({
  label,
  value,
  note,
  tone,
  filter,
  selectedFilter,
  onFilterChange,
}: {
  label: string;
  value: number;
  note: string;
  tone: string;
  filter: ReviewStatusFilter;
  selectedFilter: ReviewStatusFilter;
  onFilterChange: (filter: ReviewStatusFilter) => void;
}) {
  const selected = selectedFilter === filter;
  return (
    <Button
      variant="ghost"
      className={`review-history-stat ${tone} ${selected ? "is-selected" : ""}`}
      type="button"
      aria-pressed={selected}
      aria-label={`${label} ${value} 条，${selected ? "取消筛选" : "按此状态筛选"}`}
      onClick={() => onFilterChange(selected ? "all" : filter)}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </Button>
  );
}

export function ReviewHistoryPage({
  jobs,
  stats,
  sessionReady,
  sessionLoading,
  initialSelectedId,
  onSelectedIdChange,
  onCancel,
  onRetry,
  onDelete,
}: {
  jobs: ReviewJob[];
  stats: ReviewStats | null;
  sessionReady: boolean;
  sessionLoading: boolean;
  initialSelectedId?: string;
  onSelectedIdChange?: (id: string | null) => void;
  onCancel: (job: ReviewJob) => Promise<void>;
  onRetry: (job: ReviewJob) => Promise<ReviewJob | null>;
  onDelete: (job: ReviewJob) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState<ReviewTimeRange>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const resolvedInitialSelectedId = useMemo(() => {
    if (!initialSelectedId) return null;
    const focusedJob = jobs.find((job) => job.id === initialSelectedId);
    if (!focusedJob || focusedJob.status !== "failed") return initialSelectedId;
    const latestRetry = jobs
      .filter((job) => job.source === "retry"
        && job.projectId === focusedJob.projectId
        && job.mrIid === focusedJob.mrIid
        && job.headSha === focusedJob.headSha
        && new Date(job.createdAt).getTime() > new Date(focusedJob.createdAt).getTime())
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
    return latestRetry?.id ?? initialSelectedId;
  }, [initialSelectedId, jobs]);

  useEffect(() => {
    if (!resolvedInitialSelectedId) return;
    setSelectedId(resolvedInitialSelectedId);
    if (resolvedInitialSelectedId !== initialSelectedId) onSelectedIdChange?.(resolvedInitialSelectedId);
  }, [initialSelectedId, onSelectedIdChange, resolvedInitialSelectedId]);

  const projectOptions = useMemo(
    () => [...new Set(jobs.map(projectLabel))].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [jobs],
  );
  const filteredJobs = useMemo(
    () => jobs
      .filter((job) => matchesStatusFilter(job, statusFilter))
      .filter((job) => projectFilter === "all" || projectLabel(job) === projectFilter)
      .filter((job) => isWithinRange(job.createdAt, timeFilter))
      .filter((job) => matchesQuery(job, query))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [jobs, projectFilter, query, statusFilter, timeFilter],
  );
  const selectedJob = jobs.find((job) => job.id === selectedId) ?? null;
  const hasFilters = Boolean(query.trim()) || statusFilter !== "all" || projectFilter !== "all" || timeFilter !== "all";
  const totalCount = jobs.length;
  const activeCount = countStatus(jobs, stats, "queued") + countStatus(jobs, stats, "running");
  const completedCount = countStatus(jobs, stats, "completed");
  const failedCount = countStatus(jobs, stats, "failed");

  const cancelSelected = async () => {
    if (!selectedJob || cancelingId) return;
    setCancelingId(selectedJob.id);
    try {
      await onCancel(selectedJob);
    } finally {
      setCancelingId(null);
    }
  };

  const retryJob = async (job: ReviewJob) => {
    if (retryingId || deletingId || job.status !== "failed") return;
    setRetryingId(job.id);
    try {
      const retriedJob = await onRetry(job);
      if (!retriedJob) return;
      if (statusFilter === "failed") setStatusFilter("all");
      setSelectedId(retriedJob.id);
      onSelectedIdChange?.(retriedJob.id);
    } finally {
      setRetryingId(null);
    }
  };

  const deleteJob = async (job: ReviewJob) => {
    if (retryingId || deletingId || !isTerminalReviewStatus(job.status)) return;
    if (!window.confirm(`确定删除 !${job.mrIid} 的 Review 记录吗？删除后不可恢复。`)) return;
    const jobToDelete = job;
    setDeletingId(jobToDelete.id);
    try {
      const deleted = await onDelete(jobToDelete);
      if (!deleted) return;
      if (selectedId === jobToDelete.id) {
        setSelectedId(null);
        onSelectedIdChange?.(null);
      }
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="review-history-page" aria-label="Review 记录">
      <header className="review-history-heading">
        <div>
          <p>集中查看历史审查结果、执行进度和模型输出事件。</p>
        </div>
        <div className="review-history-heading-meta">
          <span className="review-history-refresh"><RefreshCw aria-hidden="true" />自动刷新</span>
        </div>
      </header>

      <div className="review-history-stats" aria-label="Review 记录统计">
        <ReviewHistoryStat label="进行中" value={activeCount} note="排队或审查中" tone="is-active" filter="active" selectedFilter={statusFilter} onFilterChange={setStatusFilter} />
        <ReviewHistoryStat label="已完成" value={completedCount} note="结果可查看" tone="is-complete" filter="completed" selectedFilter={statusFilter} onFilterChange={setStatusFilter} />
        <ReviewHistoryStat label="需关注" value={failedCount} note="审查失败" tone="is-attention" filter="failed" selectedFilter={statusFilter} onFilterChange={setStatusFilter} />
      </div>

      <div className="review-history-workspace">
        <section className="review-history-list-pane" aria-labelledby="review-history-list-title">
          <div className="review-history-list-heading">
            <div>
              <h4 id="review-history-list-title">历史任务</h4>
            </div>
            <label className="review-history-search">
              <Search aria-hidden="true" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、MR、SHA…" aria-label="搜索项目、MR 或 SHA" />
            </label>
            <span className="review-history-list-count">{filteredJobs.length} / {totalCount}</span>
          </div>

          <div className="review-history-filters" aria-label="筛选 Review 记录">
            <div className="review-history-filter-row">
              <label className="review-history-select">
                <span><Filter aria-hidden="true" />状态</span>
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as ReviewStatusFilter)}>
                  <SelectTrigger className="review-history-select-trigger" aria-label="按状态筛选">
                    <SelectValue placeholder="全部状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="active">进行中</SelectItem>
                    {Object.entries(statusMeta).map(([value, meta]) => <SelectItem value={value} key={value}>{meta.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="review-history-select">
                <span><GitBranch aria-hidden="true" />项目</span>
                <Select value={projectFilter} onValueChange={setProjectFilter}>
                  <SelectTrigger className="review-history-select-trigger" aria-label="按项目筛选">
                    <SelectValue placeholder="全部项目" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部项目</SelectItem>
                    {projectOptions.map((project) => <SelectItem value={project} key={project}>{project}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="review-history-select">
                <span><CalendarClock aria-hidden="true" />时间</span>
                <Select value={timeFilter} onValueChange={(value) => setTimeFilter(value as ReviewTimeRange)}>
                  <SelectTrigger className="review-history-select-trigger" aria-label="按时间筛选">
                    <SelectValue placeholder="全部时间" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部时间</SelectItem>
                    <SelectItem value="today">最近 24 小时</SelectItem>
                    <SelectItem value="7d">最近 7 天</SelectItem>
                    <SelectItem value="30d">最近 30 天</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
          </div>

          {!sessionReady ? (
            <div className="review-history-session-state" role="status">
              <LoaderCircle className="is-spinning" aria-hidden="true" />
              <strong>{sessionLoading ? "正在连接服务" : "页面会话建立失败"}</strong>
              <p>记录列表需要先建立安全会话。</p>
            </div>
          ) : filteredJobs.length === 0 ? (
            <ReviewHistoryEmpty filtered={jobs.length > 0} hasFilters={hasFilters} />
          ) : (
            <ReviewJobList
              jobs={filteredJobs}
              selectedId={selectedId}
              onSelect={(job) => {
                setSelectedId(job.id);
                onSelectedIdChange?.(job.id);
              }}
              onRetry={retryJob}
              onDelete={deleteJob}
              retryingId={retryingId}
              deletingId={deletingId}
            />
          )}
        </section>

      </div>
      <ReviewSessionDrawer
        job={selectedJob}
        canceling={Boolean(selectedJob && cancelingId === selectedJob.id)}
        retrying={Boolean(selectedJob && retryingId === selectedJob.id)}
        onCancel={() => void cancelSelected()}
        onRetry={() => {
          if (selectedJob) void retryJob(selectedJob);
        }}
        onClose={() => {
          setSelectedId(null);
          onSelectedIdChange?.(null);
        }}
      />
    </section>
  );
}
