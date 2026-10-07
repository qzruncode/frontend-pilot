import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, CircleAlert, Code2, LoaderCircle, X } from "lucide-react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { getAssistantEditDiff, type AssistantEditOperation } from "./api";

type AssistantEditOperationCardProps = {
  operation: AssistantEditOperation;
  published?: boolean;
};

function statusLabel(status: AssistantEditOperation["status"]): string {
  if (status === "pending") return "历史修改待处理";
  if (status === "applied") return "已修改工作区";
  if (status === "rejected") return "已拒绝";
  if (status === "conflict") return "文件已变化，无法应用";
  return "修改失败";
}

export function AssistantDiffView({ diff }: { diff: string }) {
  const files = useMemo(() => {
    try {
      return parseDiff(diff);
    } catch {
      return null;
    }
  }, [diff]);

  if (!files?.length) {
    return <pre className="assistant-edit-operation-diff-fallback">{diff}</pre>;
  }

  return (
    <div className="assistant-edit-operation-diff-view">
      {files.map((file, fileIndex) => (
        <Diff
          key={`${file.type}-${fileIndex}`}
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
        >
          {(hunks) => hunks.map((hunk, hunkIndex) => (
            <Hunk key={`${fileIndex}-${hunkIndex}-${hunk.content}`} hunk={hunk} />
          ))}
        </Diff>
      ))}
    </div>
  );
}

export function AssistantEditOperationCard({ operation, published = false }: AssistantEditOperationCardProps) {
  const [diffOpen, setDiffOpen] = useState(operation.status !== "rejected");

  useEffect(() => {
    setDiffOpen(operation.status !== "rejected");
  }, [operation.id, operation.status]);

  return (
    <section className={`assistant-edit-operation-card status-${operation.status}`} aria-label="代码修改结果">
      <div className="assistant-edit-operation-heading">
        <div className="assistant-edit-operation-heading-main">
          <span className="assistant-edit-operation-icon"><Code2 aria-hidden="true" /></span>
          <div>
            <strong>{operation.status === "applied" ? "修改完成" : operation.status === "pending" ? "历史修改" : "代码修改"}</strong>
            <code title={operation.path}>{operation.path}</code>
          </div>
        </div>
        <div className="assistant-edit-operation-status"><span>{statusLabel(operation.status)}</span>{operation.status === "pending" ? <CircleAlert aria-hidden="true" /> : operation.status === "applied" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</div>
      </div>
      <p className="assistant-edit-operation-summary">{operation.summary}</p>
      <details className="assistant-edit-operation-diff" open={diffOpen} onToggle={(event) => setDiffOpen(event.currentTarget.open)}>
        <summary><ChevronDown aria-hidden="true" /><span>查看 Diff</span><small>查看实际改动</small></summary>
        <AssistantDiffView diff={operation.diff} />
      </details>
      {operation.status === "applied" && <p className="assistant-edit-operation-result-note">{published ? "改动已提交至 MR，可在 MR 详情中审阅。" : "已直接写入隔离工作区，未提交、推送或创建 MR。"}</p>}
      {operation.error && <p className="assistant-edit-operation-error">{operation.error}</p>}
    </section>
  );
}

export function AssistantWorkspaceDiffCard({ sessionId, changedFiles, live = false, published = false }: { sessionId: string; changedFiles: number; live?: boolean; published?: boolean }) {
  const [snapshot, setSnapshot] = useState<{ diff: string; changedFiles: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(true);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let firstLoad = true;
    const controller = new AbortController();
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      if (firstLoad) setLoading(true);
      try {
        const next = await getAssistantEditDiff(sessionId, controller.signal);
        if (!active) return;
        setSnapshot({ diff: next.diff, changedFiles: next.changedFiles });
        setError(null);
      } catch (nextError) {
        if (active && !controller.signal.aborted) setError(nextError instanceof Error ? nextError.message : "读取工作区 Diff 失败");
      } finally {
        if (active) {
          inFlight = false;
          firstLoad = false;
          setLoading(false);
        }
      }
    };
    void load();
    const timer = live ? window.setInterval(() => void load(), 2_500) : null;
    return () => {
      active = false;
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [changedFiles, live, sessionId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setLoading(true);
    setDiffOpen(true);
  }, [sessionId]);

  const actualChangedFiles = Math.max(changedFiles, snapshot?.changedFiles ?? 0);
  const hasDiff = Boolean(snapshot?.diff.trim());
  return (
    <section className="assistant-edit-operation-card assistant-edit-workspace-diff-card status-applied" aria-label="代码修改结果">
      <div className="assistant-edit-operation-heading">
        <div className="assistant-edit-operation-heading-main">
          <span className="assistant-edit-operation-icon"><Code2 aria-hidden="true" /></span>
          <div>
            <strong>{live ? "正在修改工作区" : "修改完成"}</strong>
            <code>{actualChangedFiles} 个变更文件</code>
          </div>
        </div>
        <div className="assistant-edit-operation-status"><span>{loading ? "正在同步" : "已修改工作区"}</span>{loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}</div>
      </div>
      <p className="assistant-edit-operation-summary">Claude 原生文件工具已直接写入隔离工作区，下面展示工作区当前的实际 Diff。</p>
      <details className="assistant-edit-operation-diff" open={diffOpen} onToggle={(event) => setDiffOpen(event.currentTarget.open)}>
        <summary><ChevronDown aria-hidden="true" /><span>查看 Diff</span><small>{loading ? "正在同步" : hasDiff ? "查看实际改动" : "暂无可展示内容"}</small></summary>
        {hasDiff ? <AssistantDiffView diff={snapshot!.diff} /> : <p className="assistant-edit-workspace-diff-empty"><Code2 aria-hidden="true" />{error ? error : live ? "文件已修改，正在同步 Diff…" : "当前没有可展示的 Diff。"}</p>}
      </details>
      <p className="assistant-edit-operation-result-note">{published ? "改动已提交至 MR，可在 MR 详情中审阅。" : "已直接写入隔离工作区，后续由后端统一提交、推送和创建 MR。"}</p>
    </section>
  );
}
