import { ChevronLeft, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { UserActivityAction, UserActivityResponse } from "@contracts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const actionLabels: Record<UserActivityAction, string> = {
  login: "登录",
  logout: "退出登录",
  page_view: "页面访问",
  assistant_message: "助手对话",
  assistant_cancel: "取消对话",
  review_submit: "发起 Review",
  review_cancel: "取消 Review",
  review_retry: "重试 Review",
  gitlab_action: "GitLab 操作",
  gitlab_connect: "GitLab 连接",
  jira_action: "Jira 操作",
  jira_connect: "Jira 连接",
  feedback_submit: "提交反馈",
  user_management: "用户管理",
  settings_update: "配置修改",
  review_rules_update: "规则修改",
};

export function formatDate(value: string, includeTime = true): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", includeTime
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { month: "2-digit", day: "2-digit" }).format(date);
}

function activityLevel(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "level-0";
  return "level-" + Math.min(5, Math.max(1, Math.ceil((value / max) * 5)));
}

export function MetricCard({ label, value, hint, icon: Icon }: {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
}) {
  return (
    <article className="user-activity-metric">
      <div className="user-activity-metric-icon"><Icon aria-hidden="true" /></div>
      <div><span>{label}</span><strong>{value.toLocaleString("zh-CN")}</strong><small>{hint}</small></div>
    </article>
  );
}

export function TrendChart({ stats }: { stats: UserActivityResponse }) {
  const max = Math.max(...stats.trend.map((item) => item.total), 1);
  return (
    <div className="user-activity-trend-scroll">
      <div className="user-activity-trend" role="img" aria-label={"近 " + stats.days + " 天用户行为趋势"}>
        {stats.trend.map((item) => (
          <div
            className="user-activity-trend-column"
            key={item.date}
            title={formatDate(item.date, false) + " · " + item.total + " 次 · " + item.users + " 人"}
          >
            <span className={"user-activity-trend-bar " + activityLevel(item.total, max)}><span /></span>
            <small>{formatDate(item.date, false)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ActivityActions({ stats }: { stats: UserActivityResponse }) {
  const max = Math.max(...stats.actionCounts.map((item) => item.count), 1);
  const total = Math.max(stats.summary.totalEvents, 1);
  const visibleActions = stats.actionCounts.filter((item) => item.count > 0);
  return (
    <div className="user-activity-action-list">
      {visibleActions.length === 0 ? <div className="user-activity-empty">当前筛选下还没有行为。</div> : visibleActions.map((item) => (
        <div className="user-activity-action-row" key={item.action}>
          <div>
            <span>{actionLabels[item.action]}</span>
            <strong>{item.count.toLocaleString("zh-CN")} <small>{Math.round((item.count / total) * 100)}%</small></strong>
          </div>
          <span className={"user-activity-action-bar " + activityLevel(item.count, max)}><span /></span>
        </div>
      ))}
    </div>
  );
}

export function UserActivityTable({ stats, onSelectUser }: {
  stats: UserActivityResponse;
  onSelectUser: (username: string) => void;
}) {
  return (
    <div className="user-activity-table-wrap">
      {stats.users.length === 0 ? <div className="user-activity-empty">当前筛选下没有用户活动。</div> : (
        <table className="user-activity-table">
          <thead><tr><th>用户</th><th>行为次数</th><th>登录</th><th>页面访问</th><th>对话</th><th>Review</th><th>最近活动</th><th aria-label="操作" /></tr></thead>
          <tbody>{stats.users.map((user) => (
            <tr key={user.username}>
              <th scope="row">
                <span className="user-activity-user-avatar" aria-hidden="true">{Array.from(user.username)[0]?.toUpperCase() ?? "U"}</span>
                {user.username}
              </th>
              <td>{user.total.toLocaleString("zh-CN")}</td>
              <td>{user.loginCount.toLocaleString("zh-CN")}</td>
              <td>{user.pageViewCount.toLocaleString("zh-CN")}</td>
              <td>{user.assistantMessageCount.toLocaleString("zh-CN")}</td>
              <td>{user.reviewActionCount.toLocaleString("zh-CN")}</td>
              <td>{user.lastActiveAt ? formatDate(user.lastActiveAt) : "—"}</td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="user-activity-row-action"
                  onClick={() => onSelectUser(user.username)}
                >
                  查看行为
                </Button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

export function RecentActivity({ stats }: { stats: UserActivityResponse }) {
  return (
    <div className="user-activity-recent-list">
      {stats.recent.length === 0 ? <div className="user-activity-empty">当前筛选下没有行为记录。</div> : stats.recent.map((event) => (
        <div className="user-activity-recent-item" key={event.id}>
          <span className="user-activity-recent-dot" aria-hidden="true" />
          <div>
            <strong>{event.username}</strong>
            <span className="user-activity-action-pill">{actionLabels[event.action]}</span>
            <code title={event.path}>{event.path}</code>
          </div>
          <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
        </div>
      ))}
    </div>
  );
}

export function PaginationBar({ label, page, pageSize, total, onPageChange, disabled = false, pageSizeOptions, onPageSizeChange }: {
  label: string;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showPageSize = Boolean(pageSizeOptions?.length && onPageSizeChange);
  return (
    <nav className="user-activity-pagination" aria-label={label}>
      {showPageSize ? <div className="jira-pagination-summary"><span>{total.toLocaleString("zh-CN")} 条</span><label className="jira-pagination-page-size"><span>每页</span><Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange?.(Number(value))} disabled={disabled}><SelectTrigger aria-label="每页问题数量"><SelectValue /></SelectTrigger><SelectContent>{pageSizeOptions?.map((option) => <SelectItem key={option} value={String(option)}>{option} 条</SelectItem>)}</SelectContent></Select></label></div> : <span>{total.toLocaleString("zh-CN")} 条</span>}
      <div>
        <span>第 {page} / {pageCount} 页</span>
        <Button variant="ghost" size="sm" type="button" onClick={() => onPageChange(page - 1)} disabled={disabled || page <= 1} aria-label="上一页">
          <ChevronLeft aria-hidden="true" />上一页
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={() => onPageChange(page + 1)} disabled={disabled || page >= pageCount} aria-label="下一页">
          下一页<ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
