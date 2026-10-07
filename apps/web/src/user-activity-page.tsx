import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BarChart3, Clock3, Filter, GitPullRequest, LoaderCircle, MessageSquareText, RefreshCw, Search, Users, X } from "lucide-react";
import type { UserActivityAction, UserActivityResponse } from "@contracts";
import { getUserActivity } from "./api";
import { errorMessage } from "./review-ui-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  actionLabels,
  ActivityActions,
  formatDate,
  MetricCard,
  PaginationBar,
  RecentActivity,
  TrendChart,
  UserActivityTable,
} from "./user-activity-components";

type UserActivityPageProps = {
  sessionReady: boolean;
  isAdmin: boolean;
  onError: (message: string | null) => void;
};

const PAGE_SIZE = 20;

const periodOptions = [
  { value: "7", label: "最近 7 天" },
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
];

const actionOptions = (Object.keys(actionLabels) as UserActivityAction[]).map((action) => ({
  value: action,
  label: actionLabels[action],
}));

export function UserActivityPage({ sessionReady, isAdmin, onError }: UserActivityPageProps) {
  const [days, setDays] = useState(30);
  const [userDraft, setUserDraft] = useState("");
  const [user, setUser] = useState("");
  const [action, setAction] = useState<UserActivityAction | "all">("all");
  const [usersPage, setUsersPage] = useState(1);
  const [recentPage, setRecentPage] = useState(1);
  const [stats, setStats] = useState<UserActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextUser = userDraft.trim();
      setUser(nextUser);
      setUsersPage(1);
      setRecentPage(1);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [userDraft]);

  const loadStats = useCallback(async () => {
    const currentRequestId = requestId.current + 1;
    requestId.current = currentRequestId;
    if (!sessionReady || !isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getUserActivity({
        days,
        user: user || undefined,
        action: action === "all" ? undefined : action,
        usersPage,
        usersPageSize: PAGE_SIZE,
        recentPage,
        recentPageSize: PAGE_SIZE,
      });
      if (currentRequestId !== requestId.current) return;
      setStats(result);
      onError(null);
    } catch (loadError) {
      if (currentRequestId !== requestId.current) return;
      const message = errorMessage(loadError);
      setError(message);
      onError(message);
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, [action, days, isAdmin, onError, recentPage, sessionReady, user, usersPage]);

  useEffect(() => {
    void loadStats();
    return () => { requestId.current += 1; };
  }, [loadStats]);

  const resetPages = useCallback(() => {
    setUsersPage(1);
    setRecentPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setUserDraft("");
    setUser("");
    setAction("all");
    resetPages();
  }, [resetPages]);

  const selectUser = useCallback((username: string) => {
    setUserDraft(username);
    setUser(username);
    resetPages();
  }, [resetPages]);

  const metrics = useMemo(() => {
    if (!stats) return [];
    return [
      { label: "活跃用户", value: stats.summary.activeUsers, hint: "当前筛选范围", icon: Users },
      { label: "行为总数", value: stats.summary.totalEvents, hint: "已记录的操作", icon: Activity },
      { label: "助手对话", value: stats.summary.assistantMessageCount, hint: "发送消息次数", icon: MessageSquareText },
      { label: "Review 操作", value: stats.summary.reviewActionCount, hint: "发起、取消或重试", icon: GitPullRequest },
    ] as const;
  }, [stats]);

  const isFiltered = Boolean(user || action !== "all");
  const filterSummary = [
    user ? "账号：" + user : "",
    action !== "all" ? "行为：" + actionLabels[action] : "",
  ].filter(Boolean).join(" · ");

  if (!isAdmin) {
    return <section className="user-activity-page"><div className="user-activity-inner"><div className="user-activity-state is-error" role="alert"><Users aria-hidden="true" /><span>只有管理员可以查看用户行为统计。</span></div></div></section>;
  }

  return (
    <section className="user-activity-page" aria-label="用户行为统计">
      <div className="user-activity-inner">
        <header className="user-activity-heading">
          <div className="user-activity-controls">
            <Select value={String(days)} onValueChange={(value) => { setDays(Number(value)); resetPages(); }}>
              <SelectTrigger className="user-activity-period" aria-label="统计时间范围"><Clock3 aria-hidden="true" /><SelectValue /></SelectTrigger>
              <SelectContent>{periodOptions.map((option) => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" size="sm" type="button" onClick={() => void loadStats()} disabled={loading}>
              <RefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} />刷新
            </Button>
          </div>
        </header>

        <div className="user-activity-filter-bar">
          <label className="user-activity-filter-field user-activity-user-filter">
            <span>账号筛选</span>
            <div className="user-activity-filter-input"><Search aria-hidden="true" /><Input value={userDraft} onChange={(event) => setUserDraft(event.target.value)} placeholder="搜索用户名…" aria-label="搜索用户名" /></div>
          </label>
          <label className="user-activity-filter-field">
            <span>行为类型</span>
            <Select value={action} onValueChange={(value) => { setAction(value as UserActivityAction | "all"); resetPages(); }}>
              <SelectTrigger className="user-activity-action-select" aria-label="行为类型"><Filter aria-hidden="true" /><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部行为</SelectItem>
                {actionOptions.map((option) => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          {isFiltered ? <Button variant="ghost" size="sm" type="button" className="user-activity-clear-filter" onClick={clearFilters}><X aria-hidden="true" />清除筛选</Button> : <span className="user-activity-filter-hint">统计全部行为</span>}
        </div>

        {loading && stats ? <div className="user-activity-refresh-status" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在更新当前筛选…</div> : null}
        {error && stats ? <div className="user-activity-inline-error" role="alert"><span>{error}</span><Button variant="ghost" size="sm" type="button" onClick={() => void loadStats()}>重试</Button></div> : null}

        {loading && !stats ? <div className="user-activity-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取行为数据…</div>
          : error && !stats ? <div className="user-activity-state is-error" role="alert"><span>{error}</span><Button variant="ghost" size="sm" type="button" onClick={() => void loadStats()}>重新读取</Button></div>
            : stats && <>
              <div className="user-activity-metrics">{metrics.map((metric) => <MetricCard {...metric} key={metric.label} />)}</div>
              <div className="user-activity-chart-grid">
                <section className="user-activity-panel user-activity-trend-panel" aria-labelledby="user-activity-trend-title">
                  <header><div><h4 id="user-activity-trend-title">行为趋势</h4><p>{filterSummary || "每天记录的操作次数和活跃用户"}</p></div><BarChart3 aria-hidden="true" /></header>
                  <TrendChart stats={stats} />
                </section>
                <section className="user-activity-panel" aria-labelledby="user-activity-actions-title">
                  <header><div><h4 id="user-activity-actions-title">行为分布</h4><p>按行为类型汇总当前筛选结果</p></div><Activity aria-hidden="true" /></header>
                  <ActivityActions stats={stats} />
                </section>
              </div>
              <section className="user-activity-panel user-activity-users-panel" aria-labelledby="user-activity-users-title">
                <header>
                  <div><h4 id="user-activity-users-title">用户活跃度</h4><p>按行为次数排序，点击账号可直接查看该用户行为</p></div>
                  <span className="user-activity-panel-count">{stats.usersTotal.toLocaleString("zh-CN")} 个账号</span>
                </header>
                <UserActivityTable stats={stats} onSelectUser={selectUser} />
                <PaginationBar label="用户活跃度分页" page={stats.usersPage} pageSize={stats.usersPageSize} total={stats.usersTotal} onPageChange={setUsersPage} disabled={loading} />
              </section>
              <section className="user-activity-panel user-activity-recent-panel" aria-labelledby="user-activity-recent-title">
                <header>
                  <div><h4 id="user-activity-recent-title">行为明细</h4><p>保留脱敏后的行为类型和路径，不包含密码、Token 或消息正文</p></div>
                  <span className="user-activity-panel-count">{stats.recentTotal.toLocaleString("zh-CN")} 条记录</span>
                </header>
                <RecentActivity stats={stats} />
                <PaginationBar label="行为明细分页" page={stats.recentPage} pageSize={stats.recentPageSize} total={stats.recentTotal} onPageChange={setRecentPage} disabled={loading} />
              </section>
              <p className="user-activity-note">统计范围：{formatDate(stats.from, false)} 至今 · {filterSummary || "全部账号、全部行为"} · 最多保留 200,000 条行为记录</p>
            </>}
      </div>
    </section>
  );
}
