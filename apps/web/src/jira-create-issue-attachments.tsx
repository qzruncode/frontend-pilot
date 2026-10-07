import { Paperclip, X } from "lucide-react";
import { useState, type ChangeEvent, type ClipboardEvent, type ReactNode } from "react";
import { JIRA_MAX_ISSUE_ATTACHMENT_BYTES, JIRA_MAX_ISSUE_ATTACHMENTS } from "@contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function fileSizeLabel(size: number): string {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function sameFile(left: File, right: File): boolean {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}

function pastedImageFiles(event: ClipboardEvent<HTMLDivElement>): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function JiraCreateIssueAttachments({ embedded = false, children, files, disabled, onChange }: {
  embedded?: boolean;
  children?: ReactNode;
  files: File[];
  disabled: boolean;
  onChange: (files: File[]) => void;
}) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const appendFiles = (selected: File[]) => {
    if (selected.length === 0 || disabled) return;
    let error: string | null = null;
    const next = [...files];
    for (const file of selected) {
      if (file.size > JIRA_MAX_ISSUE_ATTACHMENT_BYTES) {
        error ??= `${file.name} 超过 ${JIRA_MAX_ISSUE_ATTACHMENT_BYTES / (1024 * 1024)} MB。`;
        continue;
      }
      if (next.length >= JIRA_MAX_ISSUE_ATTACHMENTS) {
        error ??= `最多上传 ${JIRA_MAX_ISSUE_ATTACHMENTS} 个附件。`;
        break;
      }
      if (!next.some((current) => sameFile(current, file))) next.push(file);
    }
    onChange(next);
    setErrorMessage(error);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    appendFiles(selected);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const selected = pastedImageFiles(event);
    if (selected.length === 0 || disabled) return;
    event.preventDefault();
    appendFiles(selected);
  };

  return <div className={`jira-create-issue-attachments${embedded ? " is-embedded" : " jira-create-issue-field-wide"}`} onPaste={children ? handlePaste : undefined}>
    {children}
    <div className="jira-create-issue-attachment-heading">
      <div>
        <strong><Paperclip aria-hidden="true" />附件</strong><span>可选</span>
        <label className="jira-create-issue-attachment-picker" htmlFor="jira-create-attachments">
          <Paperclip aria-hidden="true" />选择文件
          <Input id="jira-create-attachments" type="file" multiple disabled={disabled || files.length >= JIRA_MAX_ISSUE_ATTACHMENTS} onChange={handleFileChange} />
        </label>
      </div>
      <small>{embedded ? "可直接粘贴图片" : `最多 ${JIRA_MAX_ISSUE_ATTACHMENTS} 个，每个不超过 ${JIRA_MAX_ISSUE_ATTACHMENT_BYTES / (1024 * 1024)} MB`}</small>
    </div>
    {errorMessage && <p className="jira-create-issue-attachment-error" role="alert">{errorMessage}</p>}
    {files.length > 0 && <ul className="jira-create-issue-attachment-list" aria-label="待上传附件">
      {files.map((file) => <li key={`${file.name}-${file.lastModified}-${file.size}`}><span><Paperclip aria-hidden="true" /><strong title={file.name}>{file.name}</strong><small>{fileSizeLabel(file.size)}</small></span><Button type="button" variant="ghost" size="icon" aria-label={`移除附件 ${file.name}`} title={`移除附件 ${file.name}`} onClick={() => { onChange(files.filter((current) => current !== file)); setErrorMessage(null); }} disabled={disabled}><X aria-hidden="true" /></Button></li>)}
    </ul>}
  </div>;
}
