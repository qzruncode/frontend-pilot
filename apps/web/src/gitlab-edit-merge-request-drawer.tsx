import { useIntegrationApi } from "./integration-api-context";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { GitLabMergeRequest, GitLabMergeRequestCreateOptions, GitLabMergeRequestDetails, GitLabUpdateMergeRequestInput } from "@contracts";
import { CircleAlert, GitBranch, LoaderCircle, Save, Sparkles, X } from "lucide-react";
import { GitLabUpdateMergeRequestInputSchema } from "@contracts";

import { errorMessage } from "./review-ui-utils";
import { GitLabMarkdownEditor, type GitLabMarkdownEditorMode } from "./gitlab-markdown";
import { GitLabMergeRequestFieldLabel, GitLabMergeRequestLabelPicker, GitLabMergeRequestMemberMultiSelect, GitLabMergeRequestMemberSelect, GitLabMergeRequestMilestoneSelect } from "./gitlab-merge-request-field-controls";
import { GitLabSearchableSelect } from "./gitlab-searchable-select";
import { extractJiraKey, titleWithJiraKey } from "./gitlab-mr-prompt-utils";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DRAWER_EXIT_DURATION_MS = 220;

type EditDraft = {
  targetBranch: string;
  title: string;
  description: string;
  assigneeIds: string[];
  reviewerIds: string[];
  milestoneId: string;
  labels: string[];
};

type GitLabEditMergeRequestDrawerProps = {
  open: boolean;
  detail: GitLabMergeRequestDetails;
  onClose: () => void;
  onSaved: (mergeRequest: GitLabMergeRequest) => void | Promise<void>;
  onError: (message: string | null) => void;
};

function initialDraft(detail: GitLabMergeRequestDetails): EditDraft {
  return {
    targetBranch: detail.targetBranch ?? "",
    title: detail.title,
    description: detail.description ?? "",
    assigneeIds: detail.assignees.map((member) => member.id).filter((id): id is string => Boolean(id)),
    reviewerIds: detail.reviewers.map((member) => member.id).filter((id): id is string => Boolean(id)),
    milestoneId: detail.milestone?.id ?? "",
    labels: detail.labels,
  };
}

function updatePayload(draft: EditDraft, jiraKey: string | null): GitLabUpdateMergeRequestInput {
  return {
    targetBranch: draft.targetBranch,
    title: jiraKey ? titleWithJiraKey(draft.title, jiraKey) : draft.title,
    description: draft.description,
    assigneeIds: draft.assigneeIds,
    reviewerIds: draft.reviewerIds,
    milestoneId: draft.milestoneId || null,
    labels: draft.labels,
  };
}

function branchOptions(options: GitLabMergeRequestCreateOptions | null, currentBranch: string) {
  const branches = options?.branches.map((branch) => ({ value: branch.name, label: branch.name })) ?? [];
  if (currentBranch && !branches.some((branch) => branch.value === currentBranch)) branches.unshift({ value: currentBranch, label: currentBranch });
  return branches;
}

function EditMergeRequestForm({ detail, onClose, onSaved, onError }: Omit<GitLabEditMergeRequestDrawerProps, "open">) {
  const { generateGitLabMergeRequestDescription, getGitLabMergeRequestCreateOptions, updateGitLabMergeRequest } = useIntegrationApi();
  const [draft, setDraft] = useState(() => initialDraft(detail));
  const [options, setOptions] = useState<GitLabMergeRequestCreateOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [descriptionMode, setDescriptionMode] = useState<GitLabMarkdownEditorMode>("source");
  const [saving, setSaving] = useState(false);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const requestRef = useRef(0);

  const loadOptions = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const next = await getGitLabMergeRequestCreateOptions(detail.projectId);
      if (requestId !== requestRef.current) return;
      setOptions(next);
      onError(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      const message = errorMessage(error);
      setOptionsError(message);
      onError(message);
    } finally {
      if (requestId === requestRef.current) setOptionsLoading(false);
    }
  }, [detail.projectId, onError]);

  useEffect(() => {
    setDraft(initialDraft(detail));
    setOptions(null);
    setOptionsError(null);
    setFormError(null);
    setDescriptionMode("source");
    setGeneratingDescription(false);
    void loadOptions();
  }, [detail, loadOptions]);

  const updateDraft = (patch: Partial<EditDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(null);
    onError(null);
  };

  const jiraKey = extractJiraKey(detail.title, detail.description);
  const generateDescription = async () => {
    if (!jiraKey || !detail.sourceBranch) {
      const message = !jiraKey
        ? "当前 MR 没有可识别的 Jira key，请先在标题或描述中补充关联 Jira"
        : "当前 MR 没有可识别的源分支，无法生成规范描述";
      setFormError(message);
      onError(message);
      return;
    }
    setGeneratingDescription(true);
    setFormError(null);
    onError(null);
    try {
      const response = await generateGitLabMergeRequestDescription({
        projectPath: detail.projectPath || detail.projectId,
        jiraKey,
        sourceBranch: detail.sourceBranch,
        targetBranch: draft.targetBranch,
        title: titleWithJiraKey(draft.title, jiraKey),
        commitTitle: draft.title,
        commitMessage: draft.description,
        jiraDescription: draft.description,
      });
      setDraft((current) => ({ ...current, title: titleWithJiraKey(current.title, jiraKey), description: response.description }));
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      onError(message);
    } finally {
      setGeneratingDescription(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const parsed = GitLabUpdateMergeRequestInputSchema.safeParse(updatePayload(draft, jiraKey));
    if (!parsed.success) {
      const message = [...new Set(parsed.error.issues.map((issue) => issue.message).filter(Boolean))].join("；") || "请检查表单内容";
      setFormError(message);
      onError(message);
      return;
    }
    setSaving(true);
    setFormError(null);
    onError(null);
    try {
      const updated = await updateGitLabMergeRequest(detail.projectId, detail.iid, parsed.data);
      await onSaved(updated);
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const disabled = saving || generatingDescription;
  const targetBranches = branchOptions(options, draft.targetBranch);
  return <form className="gitlab-create-mr-form" onSubmit={(event) => void submit(event)} noValidate>
    {optionsLoading && <div className="gitlab-create-mr-status" role="status"><LoaderCircle aria-hidden="true" className="is-spinning" /><span>正在读取项目成员和可选项…</span></div>}
    {optionsError && <div className="gitlab-create-mr-status is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{optionsError}</span><Button type="button" variant="ghost" size="sm" onClick={() => void loadOptions()} disabled={optionsLoading}>重新读取</Button></div>}
    <section className="gitlab-create-mr-section">
      <div className="gitlab-create-mr-compare-summary"><GitBranch aria-hidden="true" /><span>源分支</span><code>{detail.sourceBranch || "未知"}</code><span>目标项目</span><code>{detail.projectPath || detail.projectId}</code></div>
      <div className="gitlab-create-mr-fields"><div className="gitlab-create-mr-field gitlab-create-mr-field-wide"><GitLabMergeRequestFieldLabel required>目标分支</GitLabMergeRequestFieldLabel><GitLabSearchableSelect ariaLabel="目标分支" value={draft.targetBranch} options={targetBranches} emptyLabel="选择目标分支" placeholder="选择目标分支" searchPlaceholder="搜索目标分支…" disabled={disabled || optionsLoading} onChange={(value) => updateDraft({ targetBranch: value })} /></div><div className="gitlab-create-mr-field gitlab-create-mr-field-wide"><GitLabMergeRequestFieldLabel required htmlFor="gitlab-edit-mr-title">标题</GitLabMergeRequestFieldLabel><Input id="gitlab-edit-mr-title" value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} maxLength={255} aria-required="true" disabled={disabled} /></div></div>
    </section>
    <section className="gitlab-create-mr-section"><div className="gitlab-create-mr-field gitlab-create-mr-field-wide"><div className="gitlab-create-mr-field-heading"><GitLabMergeRequestFieldLabel hint="支持 Markdown">描述</GitLabMergeRequestFieldLabel><Button type="button" variant="outline" size="sm" onClick={() => void generateDescription()} disabled={disabled || !jiraKey || !detail.sourceBranch}>{generatingDescription ? "生成中…" : <><Sparkles aria-hidden="true" />生成规范描述</>}</Button></div><div className="gitlab-create-mr-editor"><GitLabMarkdownEditor value={draft.description} mode={descriptionMode} onChange={(value) => updateDraft({ description: value })} onModeChange={setDescriptionMode} placeholder="描述本次变更的目标、影响和需要 Reviewer 关注的内容…" rows={8} ariaLabel="Merge Request 描述 Markdown 源码" /></div><small className="gitlab-create-mr-field-note">根据关联 Jira 生成，生成后仍可手动修改。</small></div></section>
    <section className="gitlab-create-mr-section"><div className="gitlab-create-mr-section-heading"><div><span className="gitlab-content-eyebrow">DETAILS</span><h4>参与人和标签</h4><p>Assignee、Reviewers、Milestone 和 Labels 均可在这里修改。</p></div></div><div className="gitlab-create-mr-fields"><GitLabMergeRequestMemberSelect label="Assignee" value={draft.assigneeIds[0] ?? ""} options={options} disabled={disabled || optionsLoading} onChange={(value) => updateDraft({ assigneeIds: value ? [value] : [] })} /><GitLabMergeRequestMemberMultiSelect label="Reviewers" values={draft.reviewerIds} options={options} disabled={disabled || optionsLoading} onChange={(values) => updateDraft({ reviewerIds: values })} /><GitLabMergeRequestMilestoneSelect value={draft.milestoneId} options={options?.milestones ?? []} disabled={disabled || optionsLoading} onChange={(value) => updateDraft({ milestoneId: value })} /><GitLabMergeRequestLabelPicker options={options?.labels ?? []} value={draft.labels} disabled={disabled || optionsLoading} onChange={(value) => updateDraft({ labels: value })} /></div></section>
    {formError && <div className="gitlab-create-mr-form-error" role="alert"><CircleAlert aria-hidden="true" /><span>{formError}</span></div>}
    <footer className="gitlab-create-mr-footer"><Button type="button" variant="ghost" onClick={onClose} disabled={saving}><X aria-hidden="true" />取消</Button><Button type="submit" disabled={saving || optionsLoading || !draft.title.trim() || !draft.targetBranch}><Save aria-hidden="true" />{saving ? "保存中…" : "保存修改"}</Button></footer>
  </form>;
}

export function GitLabEditMergeRequestDrawer(props: GitLabEditMergeRequestDrawerProps) {
  const [rendered, setRendered] = useState(props.open);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (props.open) {
      setRendered(true);
      setIsClosing(false);
    } else if (rendered && !isClosing) {
      setIsClosing(true);
    }
  }, [isClosing, props.open, rendered]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(() => setRendered(false), DRAWER_EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    props.onClose();
    setIsClosing(true);
  }, [isClosing, props]);

  if (!rendered) return null;
  return <ReviewDrawerShell eyebrow={null} title="编辑 Merge Request" titleId="gitlab-edit-mr-drawer-title" closeLabel="关闭编辑 Merge Request" isClosing={isClosing} onRequestClose={requestClose} contentClassName="gitlab-edit-mr-drawer-content"><EditMergeRequestForm detail={props.detail} onClose={requestClose} onSaved={props.onSaved} onError={props.onError} /></ReviewDrawerShell>;
}
