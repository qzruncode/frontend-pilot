import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle, Plus, X } from "lucide-react";
import { JiraCreateIssueInputSchema } from "@contracts";
import type { JiraCreateIssueInput, JiraCreateIssueOptions, JiraIssueDetails } from "@contracts";
import { useIntegrationApi } from "./integration-api-context";
import { initialDraft, JiraCreateIssueFields, type CreateIssueDraft, type SupportingField } from "./jira-create-issue-fields";
import { errorMessage } from "./review-ui-utils";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { Button } from "@/components/ui/button";

const SUPPORTING_FIELDS: readonly SupportingField[] = ["assignees", "components", "fixVersions", "labels"];

function preferredOption(options: JiraCreateIssueOptions["issueTypes"], fallbackName: string): string {
  return options.find((option) => option.name === fallbackName)?.id ?? options[0]?.id ?? "";
}

function customFieldsFor(draft: CreateIssueDraft, options: JiraCreateIssueOptions): JiraCreateIssueInput["customFields"] {
  const customFields: JiraCreateIssueInput["customFields"] = {};
  if (draft.customerName && options.customFieldIds.customerName) customFields[options.customFieldIds.customerName] = draft.customerName;
  if (draft.epicKey && options.customFieldIds.epicLink) customFields[options.customFieldIds.epicLink] = draft.epicKey;
  if (draft.sprintId && options.customFieldIds.sprint) customFields[options.customFieldIds.sprint] = Number(draft.sprintId) || draft.sprintId;
  return customFields;
}

function draftPayload(draft: CreateIssueDraft, options: JiraCreateIssueOptions): JiraCreateIssueInput {
  return {
    summary: draft.summary,
    issueType: draft.issueType,
    dueDate: draft.dueDate,
    components: draft.components,
    fixVersions: draft.fixVersions,
    description: draft.description,
    priority: draft.priority,
    assignee: draft.assignee,
    reporter: draft.reporter,
    originalEstimate: draft.originalEstimate,
    remainingEstimate: draft.remainingEstimate,
    linkedIssueType: draft.linkedIssueType as JiraCreateIssueInput["linkedIssueType"],
    linkedIssueKey: draft.linkedIssueKey,
    customFields: customFieldsFor(draft, options),
    labels: draft.labels,
  };
}

function CreateIssueForm({ open, projectKey, onClose, onCreated, onNotice, onError }: {
  open: boolean;
  projectKey: string;
  onClose: () => void;
  onCreated: (issue: JiraIssueDetails) => void | Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { createJiraIssue, getJiraCreateIssueAdvancedOptions, getJiraCreateIssueOptions, getJiraCreateIssueSupportingPatch, uploadJiraIssueAttachments } = useIntegrationApi();
  const [draft, setDraft] = useState<CreateIssueDraft>(initialDraft);
  const [options, setOptions] = useState<JiraCreateIssueOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [supportingLoading, setSupportingLoading] = useState(false);
  const supportingLoadingRef = useRef(false);
  const [supportingLoaded, setSupportingLoaded] = useState(false);
  const [supportingError, setSupportingError] = useState<string | null>(null);
  const [supportingPending, setSupportingPending] = useState<ReadonlySet<SupportingField>>(() => new Set(SUPPORTING_FIELDS));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedLoading, setAdvancedLoading] = useState(false);
  const [advancedLoaded, setAdvancedLoaded] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadSupportingOptions = useCallback(async (fields: readonly SupportingField[] = SUPPORTING_FIELDS) => {
    if (supportingLoadingRef.current) return;
    supportingLoadingRef.current = true;
    setSupportingLoading(true);
    setSupportingError(null);
    setSupportingLoaded(false);
    setSupportingPending(new Set(fields));
    const results = await Promise.allSettled(fields.map(async (field) => {
      const patch = await getJiraCreateIssueSupportingPatch(field);
      setOptions((current) => {
        if (!current) return current;
        const next = { ...current, ...patch };
        if (patch.assignees) next.reporters = [...new Map([current.currentUser, ...patch.assignees].map((reporter) => [reporter.username, reporter])).values()];
        return next;
      });
      setSupportingPending((current) => {
        const next = new Set(current);
        next.delete(field);
        return next;
      });
    }));
    const failed = results.some((result) => result.status === "rejected");
    if (failed) {
      const message = "部分 Jira 下拉选项读取失败，可以点击重新读取。";
      setSupportingError(message);
      onError(message);
    } else {
      setSupportingLoaded(true);
      onError(null);
    }
    setSupportingPending(new Set());
    supportingLoadingRef.current = false;
    setSupportingLoading(false);
  }, [onError]);

  const loadAdvancedOptions = useCallback(async () => {
    if (!options || advancedLoading || advancedLoaded) return;
    setAdvancedLoading(true);
    setAdvancedError(null);
    try {
      const advanced = await getJiraCreateIssueAdvancedOptions();
      setOptions((current) => current ? { ...current, ...advanced } : current);
      setAdvancedLoaded(true);
      onError(null);
    } catch (error) {
      const message = errorMessage(error);
      setAdvancedError(message);
      onError(message);
    } finally {
      setAdvancedLoading(false);
    }
  }, [advancedLoaded, advancedLoading, onError, options]);

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsError(null);
    setSupportingLoading(false);
    setSupportingLoaded(false);
    setSupportingError(null);
    setSupportingPending(new Set(SUPPORTING_FIELDS));
    setAdvancedOpen(false);
    setAdvancedLoading(false);
    setAdvancedLoaded(false);
    setAdvancedError(null);
    setFormError(null);
    onError(null);
    try {
      const next = await getJiraCreateIssueOptions();
      setOptions(next);
      setDraft({
        ...initialDraft,
        issueType: preferredOption(next.issueTypes, "新功能"),
        priority: preferredOption(next.priorities, "次要"),
        reporter: next.currentUser.username,
      });
      void loadSupportingOptions();
    } catch (error) {
      const message = errorMessage(error);
      setOptionsError(message);
      onError(message);
    } finally {
      setOptionsLoading(false);
    }
  }, [loadSupportingOptions, onError]);

  const handleSupportingRetry = () => {
    if (options && !supportingLoading && !supportingLoaded) void loadSupportingOptions();
  };

  const handleAdvancedToggle = (open: boolean) => {
    setAdvancedOpen(open);
    if (open) void loadAdvancedOptions();
  };

  useEffect(() => {
    if (open) void loadOptions();
  }, [loadOptions, open]);

  const updateDraft = (patch: Partial<CreateIssueDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(null);
    onError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!options) return;
    const parsed = JiraCreateIssueInputSchema.safeParse(draftPayload(draft, options));
    if (!parsed.success) {
      const messages = [...new Set(parsed.error.issues.map((issue) => issue.message).filter(Boolean))];
      const message = messages.join("；") || "请检查表单内容";
      setFormError(message);
      onError(message);
      return;
    }
    if (options.priorityRequired && !draft.priority.trim()) {
      const message = "请选择优先级";
      setFormError(message);
      onError(message);
      return;
    }

    setSaving(true);
    setFormError(null);
    onError(null);
    try {
      const created = await createJiraIssue(parsed.data);
      if (draft.attachments.length > 0) {
        try {
          await uploadJiraIssueAttachments(created.key, draft.attachments);
        } catch (error) {
          await onCreated(created);
          const message = `${created.key} 已创建，但附件上传失败：${errorMessage(error)}`;
          setFormError(message);
          onError(message);
          onNotice(`${created.key} 已创建，附件上传失败，请在问题详情中重试`);
          return;
        }
      }
      await onCreated(created);
      onNotice(`${created.key} 已创建，已打开问题详情`);
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="jira-create-issue-form" onSubmit={(event) => void submit(event)} noValidate>
      {optionsLoading && <div className="jira-create-issue-options-status" role="status"><LoaderCircle aria-hidden="true" className="is-spinning" /><span>正在读取当前 Jira 项目的可选项…</span></div>}
      {optionsError && <div className="jira-create-issue-options-status is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{optionsError}</span><Button type="button" variant="ghost" onClick={() => void loadOptions()} disabled={optionsLoading}>重新读取</Button></div>}
      {options && <JiraCreateIssueFields draft={draft} projectKey={projectKey} options={options} disabled={saving || optionsLoading} supportingLoading={supportingLoading} supportingError={supportingError} supportingPending={supportingPending} onSupportingRetry={handleSupportingRetry} advancedOpen={advancedOpen} advancedLoading={advancedLoading} advancedError={advancedError} onAdvancedToggle={handleAdvancedToggle} onChange={updateDraft} />}
      {formError && <div className="jira-create-issue-form-error" role="alert"><CircleAlert aria-hidden="true" /><span>{formError}</span></div>}
      <div className="jira-create-issue-footer">
        <Button variant="ghost" type="button" onClick={onClose} disabled={saving}><X aria-hidden="true" />取消</Button>
        <Button type="submit" disabled={saving || optionsLoading || !options || options.issueTypes.length === 0 || !draft.summary.trim() || !draft.issueType.trim()}>{saving ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Plus aria-hidden="true" />}{saving ? "创建中…" : "创建问题"}</Button>
      </div>
    </form>
  );
}

const DRAWER_EXIT_DURATION_MS = 220;

export function JiraCreateIssueDrawer({ open, projectKey, onClose, onCreated, onNotice, onError }: {
  open: boolean;
  projectKey: string;
  onClose: () => void;
  onCreated: (issue: JiraIssueDetails) => void | Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [rendered, setRendered] = useState(open);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setIsClosing(false);
    } else if (rendered && !isClosing) {
      setIsClosing(true);
    }
  }, [isClosing, open, rendered]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(() => setRendered(false), DRAWER_EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    onClose();
    setIsClosing(true);
  }, [isClosing, onClose]);

  if (!rendered) return null;
  return <ReviewDrawerShell eyebrow={null} title="新建问题" titleId="jira-create-issue-drawer-title" closeLabel="关闭新建 Jira 问题" isClosing={isClosing} onRequestClose={requestClose} contentClassName="jira-create-issue-drawer-content"><CreateIssueForm open={open} projectKey={projectKey} onClose={requestClose} onCreated={onCreated} onNotice={onNotice} onError={onError} /></ReviewDrawerShell>;
}
