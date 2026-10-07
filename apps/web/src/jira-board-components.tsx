import { ArrowUpRight, CircleAlert, LoaderCircle, RefreshCw, Users } from "lucide-react";
import type { JiraBoardColumn, JiraBoardColumnId, JiraBoardResponse, JiraIssue, OrdinaryJiraAiPrecheckSummary, OrdinaryJiraAiTaskSummary } from "@contracts";
import { Button } from "@/components/ui/button";
import { JiraAiPrecheckStatusBadge, JiraAiTaskStatusBadge } from "./jira-ai-task-status";

function initials(value: string): string {
  return Array.from(value.replace(/\s+/g, "").slice(0, 2)).join("").toUpperCase() || "?";
}

function displayDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function columnClass(id: JiraBoardColumnId): string {
  return id.replace("_", "-");
}

function issueAssignee(issue: JiraIssue): string {
  return issue.assignee?.name || issue.assignee?.username || "未分配";
}

function memberSecondaryLabel(member: JiraBoardResponse["members"][number]): string {
  return member.name === member.username ? "系统账户" : member.accountUsername;
}

function isSelectedMember(member: JiraBoardResponse["members"][number], selectedMember: string | null): boolean {
  if (!selectedMember) return false;
  const normalized = selectedMember.trim().toLowerCase();
  return normalized === member.accountUsername.toLowerCase() || normalized === member.username.toLowerCase();
}

function BoardIssueCard({ issue, onSelect, aiTasks, aiPrechecks }: { issue: JiraIssue; onSelect: (issue: JiraIssue) => void; aiTasks?: Readonly<Record<string, OrdinaryJiraAiTaskSummary>>; aiPrechecks?: Readonly<Record<string, OrdinaryJiraAiPrecheckSummary>> }) {
  const assignee = issueAssignee(issue);
  const aiTask = aiTasks?.[issue.key.trim().toLowerCase()];
  const aiPrecheck = aiPrechecks?.[issue.key.trim().toLowerCase()];
  return (
    <Button variant="ghost" className="jira-board-card" type="button" onClick={() => onSelect(issue)} aria-label={`打开 ${issue.key} ${issue.summary}`}>
      <span className="jira-board-card-topline"><strong>{issue.key}</strong>{aiTask ? <JiraAiTaskStatusBadge task={aiTask} /> : aiPrecheck ? <JiraAiPrecheckStatusBadge precheck={aiPrecheck} /> : <small>{displayDate(issue.updatedAt)}</small>}</span>
      <span className="jira-board-card-summary">{issue.summary}</span>
      <span className="jira-board-card-meta"><em>{issue.issueType}</em>{issue.priority && <em>{issue.priority}</em>}{issue.labels.slice(0, 2).map((label) => <em key={label}>{label}</em>)}</span>
      <span className="jira-board-card-assignee"><span aria-hidden="true">{initials(assignee)}</span>{assignee}</span>
    </Button>
  );
}

function BoardColumn({ column, onSelectIssue, onOpenIssues, aiTasks, aiPrechecks }: { column: JiraBoardColumn; onSelectIssue: (issue: JiraIssue) => void; onOpenIssues: (state: JiraBoardColumnId) => void; aiTasks?: Readonly<Record<string, OrdinaryJiraAiTaskSummary>>; aiPrechecks?: Readonly<Record<string, OrdinaryJiraAiPrecheckSummary>> }) {
  const remaining = Math.max(0, column.total - column.issues.length);
  return (
    <section className={`jira-board-column is-${columnClass(column.id)}`} aria-labelledby={`jira-board-column-${column.id}`}>
      <header className="jira-board-column-header"><div><strong id={`jira-board-column-${column.id}`}>{column.label}</strong><small>{column.issues.length} 条已加载</small></div><span className="jira-board-column-count">{column.total.toLocaleString("zh-CN")}</span></header>
      <div className="jira-board-column-list" aria-label={`${column.label}问题`}>
        {column.issues.length > 0 ? column.issues.map((issue) => <BoardIssueCard key={issue.id} issue={issue} onSelect={onSelectIssue} aiTasks={aiTasks} aiPrechecks={aiPrechecks} />) : <div className="jira-board-empty"><CircleAlert aria-hidden="true" /><span>当前没有问题</span></div>}
      </div>
      {column.hasMore && <Button variant="ghost" className="jira-board-column-more" type="button" onClick={() => onOpenIssues(column.id)}>还有 {remaining.toLocaleString("zh-CN")} 个问题，进入问题库<ArrowUpRight aria-hidden="true" /></Button>}
    </section>
  );
}

export function JiraBoardView({ board, loading, selectedMember, onMemberChange, onRefresh, onSelectIssue, onOpenIssues, aiTasks, aiPrechecks }: {
  board: JiraBoardResponse | null;
  loading: boolean;
  selectedMember: string | null;
  onMemberChange: (member: string | null) => void;
  onRefresh: () => void;
  onSelectIssue: (issue: JiraIssue) => void;
  onOpenIssues: (state: JiraBoardColumnId) => void;
  aiTasks?: Readonly<Record<string, OrdinaryJiraAiTaskSummary>>;
  aiPrechecks?: Readonly<Record<string, OrdinaryJiraAiPrecheckSummary>>;
}) {
  if (loading && !board) return <div className="jira-board-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在读取团队看板</strong><span>正在同步 Jira 的五个工作状态。</span></div>;
  if (!board) return <div className="jira-board-state"><CircleAlert aria-hidden="true" /><strong>团队看板暂不可用</strong><span>可以刷新后重新读取 Jira 团队数据。</span><Button variant="outline" size="sm" type="button" onClick={onRefresh}><RefreshCw aria-hidden="true" />重新读取</Button></div>;

  return (
    <div className="jira-board-shell" aria-busy={loading}>
      <header className="jira-board-heading"><div className="jira-board-heading-copy"><h3>团队看板</h3><p>按 Jira 的工作流查看组内成员当前负责的问题，点击卡片可继续处理详情。</p></div><div className="jira-board-heading-actions"><span className={loading ? "jira-board-sync is-loading" : "jira-board-sync"}>{loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <span aria-hidden="true" />} {loading ? "同步中…" : `${board.total.toLocaleString("zh-CN")} 个问题`}</span><Button className="jira-action-button jira-refresh-button" variant="outline" size="sm" type="button" onClick={onRefresh} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} />刷新看板</Button></div></header>
      <section className="jira-board-member-bar" aria-label="团队成员筛选"><div className="jira-board-member-label"><Users aria-hidden="true" /><div><strong>组内成员</strong><small>{board.members.length} 位已接入 Jira 的成员</small></div></div><div className="jira-board-member-filters" role="group" aria-label="按成员筛选 Jira 看板">{board.members.map((member) => { const active = isSelectedMember(member, selectedMember); return <Button key={member.accountUsername} variant="ghost" className={active ? "is-active" : ""} type="button" aria-pressed={active} onClick={() => onMemberChange(active ? null : member.accountUsername)}><span>{member.name || member.username}</span><small>{memberSecondaryLabel(member)}</small></Button>; })}</div></section>
      <div className="jira-board-columns" aria-label="Jira 团队工作流看板">{board.columns.map((column) => <BoardColumn key={column.id} column={column} onSelectIssue={onSelectIssue} onOpenIssues={onOpenIssues} aiTasks={aiTasks} aiPrechecks={aiPrechecks} />)}</div>
    </div>
  );
}
