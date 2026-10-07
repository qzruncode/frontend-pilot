import { useForm, type Control } from "react-hook-form";
import { useState } from "react";
import type { ReviewJob, ReviewStatus } from "@contracts";
import { ChevronDown, Plus } from "lucide-react";
import { createReview, resolveMergeRequest, statusLabel, type CreateReviewBody, type HealthResponse } from "./api";
import { ReviewJobList } from "./review-job-list";
import { ReviewSessionDrawer } from "./review-session-drawer";
import { errorMessage } from "./review-ui-utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

type ReviewFormValues = CreateReviewBody & { mergeRequestUrl: string };

const initialFormValues: ReviewFormValues = {
  projectId: "",
  projectPath: "",
  mrIid: "",
  headSha: "",
  targetBranch: "dev",
  mergeRequestUrl: "",
};

type ReviewDashboardProps = {
  jobs: ReviewJob[];
  health: HealthResponse | null;
  sessionReady: boolean;
  sessionLoading: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onCancel: (job: ReviewJob) => void | Promise<void>;
};

function Stat({ label, value, tone, note, status, activeStatus, onSelect }: { label: string; value: number; tone?: string; note: string; status: ReviewStatus; activeStatus: ReviewStatus | null; onSelect: (status: ReviewStatus | null) => void }) {
  const active = activeStatus === status;
  return <Button variant="ghost" className={`stat-card ${tone ?? ""} ${active ? "is-selected" : ""}`} type="button" aria-pressed={active} aria-label={`${label} ${value} 条，${active ? "取消筛选" : "点击筛选"}`} onClick={() => onSelect(active ? null : status)}><div className="stat-label"><i aria-hidden="true" />{label}</div><strong>{value}</strong><span className="stat-note">{note}</span></Button>;
}

export function ReviewDashboard({ jobs, health, sessionReady, sessionLoading, onRefresh, onNotice, onError, onCancel }: ReviewDashboardProps) {
  const form = useForm<ReviewFormValues>({ defaultValues: initialFormValues });
  const mergeRequestUrl = form.watch("mergeRequestUrl");
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [manualFieldsOpen, setManualFieldsOpen] = useState(false);
  const [activeStatus, setActiveStatus] = useState<ReviewStatus | null>(null);
  const [sessionDetailJobId, setSessionDetailJobId] = useState<string | null>(null);
  const [cancelingSessionJobId, setCancelingSessionJobId] = useState<string | null>(null);
  const sessionDetailJob = jobs.find((job) => job.id === sessionDetailJobId) ?? null;
  const visibleJobs = activeStatus ? jobs.filter((job) => job.status === activeStatus) : jobs;

  const cancelSession = () => {
    if (!sessionDetailJob || cancelingSessionJobId) return;
    setCancelingSessionJobId(sessionDetailJob.id);
    void Promise.resolve(onCancel(sessionDetailJob)).finally(() => setCancelingSessionJobId(null));
  };

  const identifyMergeRequest = async () => {
    const url = form.getValues("mergeRequestUrl").trim();
    if (!url) return onError("请先粘贴 GitLab MR 地址。");
    setResolving(true);
    try {
      const resolved = await resolveMergeRequest(url);
      form.reset({ mergeRequestUrl: url, projectId: resolved.projectId, projectPath: resolved.projectPath, mrIid: resolved.mrIid, headSha: resolved.headSha ?? "", targetBranch: resolved.targetBranch ?? "" });
      onNotice(`已识别 ${resolved.projectPath}!${resolved.mrIid}，可以直接开始审查。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setResolving(false);
    }
  };

  const submit = async (values: ReviewFormValues) => {
    setLoading(true);
    try {
      const { mergeRequestUrl: _mergeRequestUrl, ...draft } = values;
      const result = await createReview(draft);
      onNotice(result.deduplicated ? "这个 MR commit 已经有任务，已复用原任务。" : "Review 已进入队列。页面会自动刷新任务状态。");
      await onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="content">
      {health?.dryRun && <Alert className="banner banner-warning"><AlertTitle>当前是 dry-run 模式。</AlertTitle><AlertDescription>任务链路会执行，但不会调用真实 Claude API。</AlertDescription></Alert>}
      <section className="stats-grid" aria-label="按状态筛选任务"><Stat label="排队中" value={health?.queued ?? 0} tone="tone-blue" note="待处理" status="queued" activeStatus={activeStatus} onSelect={setActiveStatus} /><Stat label="审查中" value={health?.running ?? 0} tone="tone-purple" note="实时输出" status="running" activeStatus={activeStatus} onSelect={setActiveStatus} /><Stat label="已完成" value={health?.completed ?? 0} tone="tone-green" note="已结束" status="completed" activeStatus={activeStatus} onSelect={setActiveStatus} /><Stat label="失败" value={health?.failed ?? 0} tone="tone-red" note="需要关注" status="failed" activeStatus={activeStatus} onSelect={setActiveStatus} /></section>
      <section className="workspace-grid">
        <Form {...form}>
          <form className="submit-form" onSubmit={form.handleSubmit(submit, () => setManualFieldsOpen(true))}>
            <Card className="panel submit-panel">
              <CardHeader className="panel-heading"><div className="panel-heading-copy"><h2>提交 Review</h2></div></CardHeader>
              <CardContent className="submit-panel-content">
                <div className="url-resolver"><FormField control={form.control} name="mergeRequestUrl" render={({ field }) => <FormItem className="field field-url"><FormLabel>GitLab MR 地址</FormLabel><div className="resolver-row"><FormControl><Input {...field} placeholder="https://gitlab.example.com/group/project/-/merge_requests/17" /></FormControl><Button variant="outline" size="sm" type="button" onClick={() => void identifyMergeRequest()} disabled={resolving || !sessionReady || !mergeRequestUrl.trim()}>{resolving ? "识别中…" : "一键识别"}</Button></div><FormDescription>粘贴地址后自动填写 Project ID、MR IID、Head SHA 和目标分支。</FormDescription><FormMessage /></FormItem>} /></div>
                <Collapsible className="manual-fields-root" open={manualFieldsOpen} onOpenChange={setManualFieldsOpen}><div className="manual-fields-label"><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="manual-fields-toggle" type="button"><span className="manual-fields-toggle-title">手动填写配置</span><span className="manual-fields-toggle-meta">可选</span><ChevronDown className="manual-fields-toggle-icon" aria-hidden="true" /></Button></CollapsibleTrigger></div><CollapsibleContent forceMount id="manual-review-fields" className="manual-fields"><div className="field-row"><Field control={form.control} name="projectId" label="GitLab Project ID" placeholder="例如 123" required /><Field control={form.control} name="mrIid" label="MR IID" placeholder="例如 42" required /></div><Field control={form.control} name="projectPath" label="项目路径" placeholder="group/project（可选，用于选择规则 profile）" /><Field control={form.control} name="headSha" label="Head SHA" placeholder="留空则读取当前 MR 的 head SHA" /><Field control={form.control} name="targetBranch" label="目标分支" placeholder="dev" /></CollapsibleContent></Collapsible>
                <Button className="button-wide" type="submit" disabled={loading || !sessionReady}>{loading ? "提交中…" : "开始审查 →"}</Button>
                <p className="form-footer-note"><i aria-hidden="true" />提交后会自动追踪状态和实时输出</p>
                <div className="submit-workflow" aria-label="Review 流程"><span className="submit-workflow-label">REVIEW FLOW</span><div className="submit-workflow-steps"><span><b>01</b><small>识别 MR</small></span><i aria-hidden="true" /><span><b>02</b><small>读取上下文</small></span><i aria-hidden="true" /><span><b>03</b><small>输出结果</small></span></div></div>
              </CardContent>
            </Card>
          </form>
        </Form>
        <Card className="panel jobs-panel"><CardHeader className="panel-heading"><div className="panel-heading-copy"><div className="panel-title-row"><h2>任务记录</h2><span className="panel-count">{visibleJobs.length} 条{activeStatus ? ` · ${statusLabel(activeStatus)}` : ""}</span></div></div><span className="panel-live"><i aria-hidden="true" />自动刷新</span></CardHeader><CardContent className="jobs-panel-content">{!sessionReady ? <div className="empty-state"><div className="empty-icon">⌁</div><strong>{sessionLoading ? "正在连接服务" : "页面会话建立失败"}</strong><p>页面会自动建立安全会话，不需要填写内部服务令牌。</p></div> : visibleJobs.length === 0 ? <div className="empty-state"><div className="empty-icon" aria-hidden="true"><Plus /></div><span className="empty-eyebrow">{activeStatus ? "FILTER IS CLEAR" : "QUEUE IS CLEAR"}</span><strong>{activeStatus ? `没有${statusLabel(activeStatus)}任务` : "还没有 Review 任务"}</strong><p>{activeStatus ? "点击当前状态卡可取消筛选。" : "提交第一个 MR 后，审查进度、结果和问题摘要会按时间出现在这里。"}</p>{!activeStatus && <div className="empty-points"><span>实时状态</span><span>完整上下文</span><span>结果摘要</span></div>}</div> : <ReviewJobList className="review-dashboard-job-list" jobs={visibleJobs} selectedId={sessionDetailJobId} onSelect={(job) => setSessionDetailJobId(job.id)} onCancel={onCancel} cancelingId={cancelingSessionJobId} />}</CardContent></Card>
      </section>
      <ReviewSessionDrawer
        job={sessionDetailJob}
        canceling={Boolean(sessionDetailJob && cancelingSessionJobId === sessionDetailJob.id)}
        onCancel={cancelSession}
        onClose={() => setSessionDetailJobId(null)}
      />
    </main>
  );
}

function Field({ control, name, label, placeholder, required = false }: { control: Control<ReviewFormValues>; name: keyof ReviewFormValues; label: string; placeholder: string; required?: boolean }) {
  return <FormField control={control} name={name} rules={required ? { required: `请输入 ${label}` } : undefined} render={({ field }) => <FormItem className="field"><FormLabel>{label} {required && <em>*</em>}</FormLabel><FormControl><Input {...field} placeholder={placeholder} /></FormControl><FormMessage /></FormItem>} />;
}
