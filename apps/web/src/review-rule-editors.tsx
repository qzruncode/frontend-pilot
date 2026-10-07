import { useState, type DragEvent, type KeyboardEvent } from "react";
import { CircleAlert, CircleHelp, FileText, GripVertical, LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { ReviewRule } from "@contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import type { ReviewRuleDraft } from "./review-rule-utils";

export type PromptRuleItem = Pick<ReviewRule, "id" | "name" | "description" | "enabled" | "order" | "content">;
export type PromptRuleDialogMode = "create" | "edit";

export function RuleList({
  rules,
  selectedId,
  onSelect,
  onCreate,
  onReorder,
  onToggle,
  reordering,
  togglingRuleId,
  createLabel = "新建规则",
  emptyDetail = "为这个规则集添加第一条提示词。",
}: {
  rules: PromptRuleItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
  reordering: boolean;
  togglingRuleId: string | null;
  createLabel?: string;
  emptyDetail?: string;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const isBusy = reordering || togglingRuleId !== null;

  const handleDragStart = (event: DragEvent<HTMLDivElement>, ruleId: string) => {
    if (isBusy) {
      event.preventDefault();
      return;
    }
    setDraggedId(ruleId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", ruleId);
  };

  const clearDragState = () => {
    setDraggedId(null);
    setDropTargetId(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggedId;
    if (sourceId) onReorder(sourceId, targetId);
    clearDragState();
  };

  const handleItemKeyDown = (event: KeyboardEvent<HTMLDivElement>, ruleId: string, index: number) => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const target = rules[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) onReorder(ruleId, target.id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(ruleId);
    }
  };

  return (
    <div className="review-rules-rule-list" aria-label="提示词规则列表" aria-busy={isBusy}>
      <div className="review-rules-rule-list-heading">
        <div className="review-rules-rule-list-heading-copy"><span>规则列表</span></div>
        <Button variant="outline" size="sm" type="button" onClick={onCreate} disabled={isBusy}><Plus aria-hidden="true" />{createLabel}</Button>
      </div>
      {rules.length === 0 ? (
        <div className="review-rules-empty-rules"><FileText aria-hidden="true" /><strong>还没有提示词</strong><span>{emptyDetail}</span></div>
      ) : rules.map((rule, index) => (
        <div
          key={rule.id}
          className={`review-rules-rule-item ${rule.id === selectedId ? "is-selected" : ""} ${rule.id === dropTargetId ? "is-drop-target" : ""}`}
          role="button"
          tabIndex={isBusy ? -1 : 0}
          draggable={!isBusy}
          aria-label={`${rule.name}，第 ${index + 1} 条`}
          onClick={() => onSelect(rule.id)}
          onKeyDown={(event) => handleItemKeyDown(event, rule.id, index)}
          onDragStart={(event) => handleDragStart(event, rule.id)}
          onDragOver={(event) => { if (!isBusy) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetId(rule.id); } }}
          onDrop={(event) => handleDrop(event, rule.id)}
          onDragEnd={clearDragState}
        >
          <span className="review-rules-rule-drag-handle" aria-hidden="true"><GripVertical /></span>
          <span className="review-rules-rule-order" aria-hidden="true">{index + 1}</span>
          <span className="review-rules-rule-item-icon"><FileText aria-hidden="true" /></span>
          <span className="review-rules-rule-item-copy"><span className="review-rules-rule-item-title"><strong>{rule.name}</strong><code>{rule.id}</code></span><small>{rule.description || "未填写说明"}</small></span>
          <span className={`review-rules-rule-item-status ${rule.enabled ? "is-enabled" : ""}`}>
            <button
              type="button"
              role="switch"
              className={`review-rules-rule-switch ${rule.enabled ? "is-enabled" : ""}`}
              aria-checked={rule.enabled}
              aria-label={`${rule.name}${rule.enabled ? "已启用" : "已停用"}`}
              aria-busy={togglingRuleId === rule.id}
              disabled={isBusy}
              onClick={(event) => { event.stopPropagation(); onToggle(rule.id, !rule.enabled); }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span className="review-rules-rule-switch-thumb">{togglingRuleId === rule.id && <LoaderCircle aria-hidden="true" />}</span>
            </button>
            <span>{togglingRuleId === rule.id ? "保存中…" : rule.enabled ? "启用" : "停用"}</span>
          </span>
        </div>
      ))}
      {reordering && <span className="review-rules-order-saving" role="status">正在保存规则顺序…</span>}
      {togglingRuleId && <span className="review-rules-order-saving" role="status">正在保存启用状态…</span>}
    </div>
  );
}

export function PromptRuleDialog({
  open,
  mode,
  draft,
  dirty,
  saving,
  taskLabel = "巡检",
  fieldIdPrefix = "inspection-rule",
  onOpenChange,
  onChange,
  onSubmit,
  onReset,
  onDelete,
}: {
  open: boolean;
  mode: PromptRuleDialogMode;
  draft: ReviewRuleDraft;
  dirty: boolean;
  saving: boolean;
  taskLabel?: string;
  fieldIdPrefix?: string;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<ReviewRuleDraft>) => void;
  onSubmit: () => void;
  onReset?: () => void;
  onDelete?: () => void;
}) {
  const isCreate = mode === "create";
  const dialogTitle = isCreate ? "新建巡检提示词" : "编辑巡检提示词";
  const dialogDescription = isCreate ? "保存后只参与巡检，不会出现在 Review 规则中。" : `保存后只影响之后新发起的${taskLabel}任务。`;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="inspection-prompt-dialog">
        <AlertDialogHeader className="inspection-prompt-dialog-header">
          <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
          <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <form className="inspection-prompt-dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          <div className="review-rules-rule-meta-grid">
            <Input id={`${fieldIdPrefix}-name`} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="提示词名称" aria-label="提示词名称" />
            <Input id={`${fieldIdPrefix}-description`} value={draft.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="提示词说明（可选）" aria-label="提示词说明" />
          </div>
          <Textarea id={`${fieldIdPrefix}-content`} className="review-rules-new-rule-textarea" value={draft.content} onChange={(event) => onChange({ content: event.target.value })} placeholder="写下这条巡检提示词的检查边界、证据要求和排除项" aria-label="提示词正文" rows={8} />
          <AlertDialogFooter className={`inspection-prompt-dialog-actions ${isCreate ? "" : "is-edit"}`}>
            {!isCreate && <Button variant="ghost" className="review-rules-delete-button" type="button" onClick={onDelete} disabled={saving}><Trash2 aria-hidden="true" />删除规则</Button>}
            <AlertDialogCancel asChild>
              <Button variant="ghost" type="button" disabled={saving}>取消</Button>
            </AlertDialogCancel>
            {!isCreate && <Button variant="outline" type="button" onClick={onReset} disabled={!dirty || saving}>放弃修改</Button>}
            <Button type="submit" disabled={isCreate ? saving : !dirty || saving}>{saving ? (isCreate ? "创建中…" : "保存中…") : isCreate ? "创建提示词" : "保存规则"}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RuleEditor({
  rule,
  draft,
  dirty,
  saving,
  onChange,
  onSave,
  onReset,
  onDelete,
  taskLabel = "审查",
  fieldIdPrefix = "review-rule",
}: {
  rule: PromptRuleItem;
  draft: ReviewRuleDraft;
  dirty: boolean;
  saving: boolean;
  onChange: (patch: Partial<ReviewRuleDraft>) => void;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
  taskLabel?: string;
  fieldIdPrefix?: string;
}) {
  const outputTipId = `${fieldIdPrefix}-output-tip`;
  const contentTipId = `${fieldIdPrefix}-content-tip`;
  return (
    <div className="review-rules-editor-content">
      <div className="review-rules-editor-heading">
        <div className="review-rules-editor-title-row"><h4>{rule.name}</h4><span className="review-rules-tooltip-trigger review-rules-editor-hint" tabIndex={0} aria-describedby={outputTipId}><CircleHelp aria-hidden="true" /><span id={outputTipId} className="review-rules-tooltip" role="tooltip">规则内容会作为独立{taskLabel}检查项提供给模型。</span></span></div>
        <span className={`review-rules-editor-status ${dirty ? "is-dirty" : "is-clean"}`}>{dirty ? "未保存修改" : "已同步"}</span>
      </div>

      <div className="review-rules-rule-meta-grid">
        <div className="review-rules-field"><Label htmlFor={`${fieldIdPrefix}-name`}>规则名称</Label><Input id={`${fieldIdPrefix}-name`} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} /></div>
        <div className="review-rules-field"><Label htmlFor={`${fieldIdPrefix}-description`}>规则说明</Label><Input id={`${fieldIdPrefix}-description`} value={draft.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="这条规则重点检查什么" /></div>
      </div>

      <div className="review-rules-editor-card">
        <div className="review-rules-editor-card-heading"><div className="review-rules-editor-card-title-row"><h5>规则正文</h5><span className="review-rules-tooltip-trigger review-rules-editor-card-hint" tabIndex={0} aria-describedby={contentTipId}><CircleHelp aria-hidden="true" /><span id={contentTipId} className="review-rules-tooltip" role="tooltip">写清检查边界、证据要求和不应报告的情况。</span></span></div><span>{draft.content.length.toLocaleString("zh-CN")} 字符</span></div>
        <Textarea id={`${fieldIdPrefix}-content`} className="review-rules-textarea" value={draft.content} onChange={(event) => onChange({ content: event.target.value })} spellCheck={false} aria-label="规则正文" rows={18} />
      </div>

      <div className="review-rules-footer">
        <div className="review-rules-footer-note"><CircleAlert aria-hidden="true" /><span>保存后只影响之后新发起的{taskLabel}任务。</span></div>
        <div className="review-rules-footer-actions">
          <Button variant="ghost" size="sm" type="button" className="review-rules-delete-button" onClick={onDelete}><Trash2 aria-hidden="true" />删除规则</Button>
          <Button variant="outline" size="sm" type="button" onClick={onReset} disabled={!dirty || saving}>放弃修改</Button>
          <Button size="sm" type="button" onClick={onSave} disabled={!dirty || saving}>{saving ? "保存中…" : "保存规则"}</Button>
        </div>
      </div>
    </div>
  );
}
