import { useState } from "react";
import { UserRound } from "lucide-react";
import { shortenInspectionFindingTitle, type InspectionFinding } from "@contracts";
import { Button } from "./components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { formatTime } from "./review-ui-utils";

export function InspectionFindingOwner({ finding }: { finding: InspectionFinding }) {
  const jira = finding.jira;
  const owner = jira.ownership?.status === "resolved" ? jira.ownership.assignee : jira.assignee;
  const name = jira.assigneeName || owner;
  const label = name ? `负责人：${name}` : "负责人待确认";
  return <span className="inspection-owner" title={finding.jira.ownership?.reason || label}><UserRound aria-hidden="true" />{label}</span>;
}

export function hasInspectionFindingOwner(finding: InspectionFinding): boolean {
  return finding.jira.ownership?.status === "resolved" && Boolean(finding.jira.ownership.assignee);
}

export function InspectionOwnershipEvidence({ finding }: { finding: InspectionFinding }) {
  const ownership = finding.jira.ownership;
  if (!ownership) return null;
  return <section className="inspection-finding-detail-block">
    <span>AI 负责人判断 · {formatTime(ownership.checkedAt)}</span>
    <p>{ownership.reason}</p>
    {ownership.evidence.length > 0 && <div className="grid gap-1 text-xs text-muted-foreground">{ownership.evidence.map((item) => <div key={item.id}>
      {item.url && /^https?:\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a> : item.title}
    </div>)}</div>}
  </section>;
}

export type InspectionBatchAction = "owner" | "jira";

export function InspectionBatchActionDialog({ mode, findings, busy, onClose, onConfirm }: {
  mode: InspectionBatchAction;
  findings: InspectionFinding[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const ownerMode = mode === "owner";
  const resolved = findings.filter(hasInspectionFindingOwner);
  const pending = findings.length - resolved.length;
  const title = ownerMode ? "批量确认负责人" : "批量创建 Jira";
  return <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <AlertDialogContent className="inspection-batch-action-dialog inspection-batch-assignment-dialog max-h-[90dvh] overflow-y-auto">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          {ownerMode
            ? <>将对 {findings.length} 个未确认问题调用 AI 判断负责人，不会创建 Jira。{resolved.length > 0 ? `其中 ${resolved.length} 个已有负责人判断。` : ""}{pending > 0 ? `其余 ${pending} 个会重新交给 AI 判断。` : ""}AI 无法确定的会保留为待确认。</>
            : <>将为 {findings.length} 个已确认负责人的问题创建 Jira，不会再次判断负责人。创建失败的问题会保留在当前清单中，便于单独重试。</>}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="grid gap-3">
        <div className="inspection-batch-assignment-stats"><span>已有负责人 <strong>{resolved.length}</strong> 个</span><span>{ownerMode ? "待确认" : "待创建"} <strong>{ownerMode ? pending : findings.length}</strong> 个</span></div>
        <div className="inspection-batch-assignment-list" aria-label={`${title}的问题列表`}>
          {findings.slice(0, 8).map((finding) => <div key={`${finding.id}:${finding.path}`}><span>{hasInspectionFindingOwner(finding) ? "已确认" : ownerMode ? "待确认" : "负责人已确认"}</span><strong title={finding.issue}>{shortenInspectionFindingTitle(finding.issue, finding.path, finding.line)}</strong><small>{finding.jira.assigneeName || finding.jira.assignee || (ownerMode ? "交给 AI 判断" : "已确认负责人")}</small></div>)}
          {findings.length > 8 && <small>还有 {findings.length - 8} 个问题将一并处理。</small>}
        </div>
        <p className="inspection-batch-assignment-hint">{ownerMode ? "这里只确认负责人；确认后请单独点击“创建 Jira”。" : "这里只创建 Jira；不会重新触发负责人判断。"}</p>
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel asChild><Button variant="ghost" type="button" disabled={busy}>取消</Button></AlertDialogCancel>
        <Button type="button" disabled={busy || findings.length === 0} onClick={async () => { setError(null); const message = await onConfirm(); if (message) setError(message); }}>{busy ? ownerMode ? "正在确认负责人…" : "正在创建 Jira…" : ownerMode ? `开始确认负责人（${findings.length}）` : `开始创建 Jira（${findings.length}）`}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
