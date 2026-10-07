import type { ReactNode } from "react";
import type { JiraCreateIssueOption, JiraCreateIssueOptions } from "@contracts";
import { JiraAssigneePicker, JiraLabelPicker, JiraMultiOptionPicker, JiraOptionPicker } from "./jira-create-issue-pickers";
import { JiraCreateIssueAttachments } from "./jira-create-issue-attachments";
import { JiraDatePicker } from "./jira-create-issue-date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export type CreateIssueDraft = {
  summary: string;
  issueType: string;
  dueDate: string;
  components: string[];
  fixVersions: string[];
  description: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string[];
  customerName: string;
  attachments: File[];
  originalEstimate: string;
  remainingEstimate: string;
  epicKey: string;
  linkedIssueType: string;
  linkedIssueKey: string;
  sprintId: string;
};

export type SupportingField = "assignees" | "components" | "fixVersions" | "labels";

export const initialDraft: CreateIssueDraft = {
  summary: "",
  issueType: "",
  dueDate: "",
  components: [],
  fixVersions: [],
  description: "",
  priority: "",
  assignee: "",
  reporter: "",
  labels: [],
  customerName: "",
  attachments: [],
  originalEstimate: "",
  remainingEstimate: "",
  epicKey: "",
  linkedIssueType: "blocks",
  linkedIssueKey: "",
  sprintId: "",
};

const LINK_TYPES = [
  "blocks",
  "is blocked by",
  "is children of",
  "is parent of",
  "clones",
  "is cloned by",
  "duplicates",
  "is duplicated by",
  "relates to",
  "causes",
  "is caused by",
  "tests",
  "tested by",
] as const;

const linkTypeOptions: JiraCreateIssueOption[] = LINK_TYPES.map((name) => ({ id: name, name }));

function namedOptions(values: string[]): JiraCreateIssueOption[] {
  return values.map((name) => ({ id: name, name }));
}

function Field({ label, htmlFor, optional = false, required = false, wide = false, children }: { label: string; htmlFor?: string; optional?: boolean; required?: boolean; wide?: boolean; children: ReactNode }) {
  return <div className={`jira-create-issue-field${wide ? " jira-create-issue-field-wide" : ""}`}>
    <Label htmlFor={htmlFor}>{label} {required && <span className="jira-create-issue-required" aria-hidden="true">*</span>} {optional && <span>可选</span>}</Label>
    {children}
  </div>;
}

export function JiraCreateIssueFields({ draft, projectKey, options, disabled, supportingLoading, supportingError, supportingPending, onSupportingRetry, advancedOpen, advancedLoading, advancedError, onAdvancedToggle, onChange }: {
  draft: CreateIssueDraft;
  projectKey: string;
  options: JiraCreateIssueOptions;
  disabled: boolean;
  supportingLoading: boolean;
  supportingError: string | null;
  supportingPending: ReadonlySet<SupportingField>;
  onSupportingRetry: () => void;
  advancedOpen: boolean;
  advancedLoading: boolean;
  advancedError: string | null;
  onAdvancedToggle: (open: boolean) => void;
  onChange: (patch: Partial<CreateIssueDraft>) => void;
}) {
  const pickerDisabled = disabled || !options;
  const componentsPickerDisabled = pickerDisabled || supportingPending.has("components");
  const fixVersionsPickerDisabled = pickerDisabled || supportingPending.has("fixVersions");
  const assigneesPickerDisabled = pickerDisabled || supportingPending.has("assignees");
  const labelsPickerDisabled = pickerDisabled || supportingPending.has("labels");
  return <>
    <section className="jira-create-issue-section" aria-labelledby="jira-create-basic-heading">
      <div className="jira-create-issue-section-heading"><div><h4 id="jira-create-basic-heading">基础信息</h4></div><small>项目：Sophon（{projectKey}）</small></div>
      <div className="jira-create-issue-fields">
        <Field label="问题标题" htmlFor="jira-create-summary" required wide><Input id="jira-create-summary" value={draft.summary} onChange={(event) => onChange({ summary: event.target.value })} placeholder="例如：完善发布流程的错误提示" maxLength={255} autoFocus disabled={disabled} /><small>{draft.summary.length}/255</small></Field>
        <Field label="问题类型" htmlFor="jira-create-issue-type" required><JiraOptionPicker id="jira-create-issue-type" ariaLabel="问题类型" options={options.issueTypes} value={draft.issueType} valueKey="id" onChange={(issueType) => onChange({ issueType })} placeholder="选择问题类型" searchPlaceholder="搜索问题类型…" disabled={pickerDisabled} /><small>与 Jira 当前项目的可选类型保持一致。</small></Field>
        <Field label="优先级" htmlFor="jira-create-priority" required={options.priorityRequired} optional={!options.priorityRequired}><JiraOptionPicker id="jira-create-priority" ariaLabel="优先级" options={options.priorities} value={draft.priority} valueKey="id" onChange={(priority) => onChange({ priority })} placeholder="选择优先级" searchPlaceholder="搜索优先级…" noneLabel={options.priorityRequired ? undefined : "不设置优先级"} disabled={pickerDisabled} /></Field>
        <Field label="到期日" htmlFor="jira-create-due-date" optional><JiraDatePicker id="jira-create-due-date" ariaLabel="到期日 可选" value={draft.dueDate} onChange={(dueDate) => onChange({ dueDate })} disabled={disabled} /></Field>
        <Field label="模块" htmlFor="jira-create-components" required><JiraMultiOptionPicker id="jira-create-components" ariaLabel="模块" options={options.components} value={draft.components} onChange={(components) => onChange({ components })} placeholder="选择模块" searchPlaceholder="搜索模块…" disabled={componentsPickerDisabled} maxSelected={10} /></Field>
        <Field label="修复的版本" htmlFor="jira-create-fix-versions" required><JiraMultiOptionPicker id="jira-create-fix-versions" ariaLabel="修复的版本" options={options.fixVersions} value={draft.fixVersions} onChange={(fixVersions) => onChange({ fixVersions })} placeholder="选择修复版本" searchPlaceholder="搜索版本…" disabled={fixVersionsPickerDisabled} maxSelected={10} /></Field>
      </div>
    </section>

    <section className="jira-create-issue-section" aria-labelledby="jira-create-collaboration-heading">
      <div className="jira-create-issue-section-heading"><div><h4 id="jira-create-collaboration-heading">人员与标签</h4></div><small>只从 Jira 返回的用户和标签中选择</small></div>
      {supportingLoading && <div className="jira-create-issue-options-status" role="status"><span>正在同步模块、版本、用户和标签…</span></div>}
      {supportingError && <div className="jira-create-issue-options-status is-error" role="alert"><span>{supportingError}</span><Button type="button" variant="ghost" onClick={onSupportingRetry}>重新读取</Button></div>}
      <div className="jira-create-issue-fields">
        <Field label="经办人" htmlFor="jira-create-assignee" optional><JiraAssigneePicker options={options.assignees} currentUser={options.currentUser} value={draft.assignee} disabled={assigneesPickerDisabled} onChange={(assignee) => onChange({ assignee })} /></Field>
        <Field label="报告人" htmlFor="jira-create-reporter" optional><JiraAssigneePicker id="jira-create-reporter" ariaLabel="报告人 可选" placeholder="选择报告人" searchPlaceholder="搜索报告人…" options={options.reporters} value={draft.reporter} disabled={assigneesPickerDisabled} onChange={(reporter) => onChange({ reporter })} /></Field>
        {options.customFieldIds.customerName && <Field label="Customer Name" htmlFor="jira-create-customer" optional><JiraOptionPicker id="jira-create-customer" ariaLabel="Customer Name" options={namedOptions(options.customers)} value={draft.customerName} onChange={(customerName) => onChange({ customerName })} placeholder="选择客户" searchPlaceholder="搜索客户…" noneLabel="不设置客户" disabled={pickerDisabled} /></Field>}
        <Field label="标签" htmlFor="jira-create-labels" optional><JiraLabelPicker options={options.labels} value={draft.labels} disabled={labelsPickerDisabled} onChange={(labels) => onChange({ labels })} /></Field>
      </div>
    </section>

    <section className="jira-create-issue-section" aria-label="描述">
      <div className="jira-create-issue-fields">
        <Field label="描述" htmlFor="jira-create-description" required wide>
          <JiraCreateIssueAttachments embedded files={draft.attachments} disabled={disabled} onChange={(attachments) => onChange({ attachments })}>
            <Textarea id="jira-create-description" value={draft.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="补充背景、复现步骤、预期结果或验收标准…" maxLength={50_000} required disabled={disabled} />
          </JiraCreateIssueAttachments>
          <small>{draft.description.length.toLocaleString("zh-CN")}/50,000</small>
        </Field>
      </div>
    </section>

    <details className="jira-create-issue-advanced" open={advancedOpen} onToggle={(event) => onAdvancedToggle(event.currentTarget.open)}>
      <summary><span><strong>更多字段</strong><small>工时、Epic、关联问题和 Sprint</small></span><span>展开</span></summary>
      {advancedLoading && <div className="jira-create-issue-options-status" role="status"><span>正在读取更多 Jira 字段…</span></div>}
      {advancedError && <div className="jira-create-issue-options-status is-error" role="alert"><span>{advancedError}</span></div>}
      <div className="jira-create-issue-fields">
        <Field label="初始预估" htmlFor="jira-create-original-estimate" optional><Input id="jira-create-original-estimate" value={draft.originalEstimate} onChange={(event) => onChange({ originalEstimate: event.target.value })} placeholder="例如：3w 4d 12h" maxLength={32} disabled={disabled} /></Field>
        <Field label="剩余的估算" htmlFor="jira-create-remaining-estimate" optional><Input id="jira-create-remaining-estimate" value={draft.remainingEstimate} onChange={(event) => onChange({ remainingEstimate: event.target.value })} placeholder="例如：1w 2d" maxLength={32} disabled={disabled} /></Field>
        {options.customFieldIds.epicLink && <Field label="Epic Link" htmlFor="jira-create-epic" optional><JiraOptionPicker id="jira-create-epic" ariaLabel="Epic Link" options={options.epics} value={draft.epicKey} valueKey="id" onChange={(epicKey) => onChange({ epicKey })} placeholder="选择 Epic" searchPlaceholder="搜索 Epic…" noneLabel="不关联 Epic" disabled={pickerDisabled} /></Field>}
        <Field label="关联关系" htmlFor="jira-create-link-type" optional><JiraOptionPicker id="jira-create-link-type" ariaLabel="关联关系" options={linkTypeOptions} value={draft.linkedIssueType} onChange={(linkedIssueType) => onChange({ linkedIssueType })} placeholder="选择关联关系" searchPlaceholder="搜索关系…" disabled={disabled} /></Field>
        <Field label="关联问题" htmlFor="jira-create-linked-issue" optional><JiraOptionPicker id="jira-create-linked-issue" ariaLabel="关联问题" options={options.linkableIssues} value={draft.linkedIssueKey} valueKey="id" onChange={(linkedIssueKey) => onChange({ linkedIssueKey })} placeholder="选择要关联的问题" searchPlaceholder="搜索问题关键字…" noneLabel="不关联问题" disabled={pickerDisabled} /></Field>
        {options.customFieldIds.sprint && <Field label="Sprint" htmlFor="jira-create-sprint" optional><JiraOptionPicker id="jira-create-sprint" ariaLabel="Sprint" options={options.sprints} value={draft.sprintId} valueKey="id" onChange={(sprintId) => onChange({ sprintId })} placeholder="选择 Sprint" searchPlaceholder="搜索 Sprint…" noneLabel="不设置 Sprint" disabled={pickerDisabled} /></Field>}
      </div>
    </details>
  </>;
}
