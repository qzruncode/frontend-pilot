import { lazy, Suspense } from "react";
import { Code2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type GitLabMarkdownEditorMode = "source" | "preview";

const GitLabMarkdownRenderer = lazy(() => import("./gitlab-markdown-renderer"));

export function GitLabMarkdown({ source }: { source: string }) {
  return (
    <div className="gitlab-markdown">
      <Suspense fallback={<span className="gitlab-markdown-loading">正在加载 Markdown 预览…</span>}>
        <GitLabMarkdownRenderer source={source} />
      </Suspense>
    </div>
  );
}

export function GitLabMarkdownEditor({
  value,
  mode,
  onChange,
  onModeChange,
  placeholder,
  rows = 3,
  ariaLabel = "Markdown 评论源码",
}: {
  value: string;
  mode: GitLabMarkdownEditorMode;
  onChange: (value: string) => void;
  onModeChange: (mode: GitLabMarkdownEditorMode) => void;
  placeholder: string;
  rows?: number;
  ariaLabel?: string;
}) {
  return (
    <>
      <div className="gitlab-markdown-editor-tabs" role="tablist" aria-label="Markdown 编辑模式">
        <Button
          variant="ghost"
          size="sm"
          className={`gitlab-markdown-editor-tab ${mode === "source" ? "is-active" : ""}`}
          type="button"
          role="tab"
          aria-selected={mode === "source"}
          onClick={() => onModeChange("source")}
        >
          <Code2 aria-hidden="true" />源码
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={`gitlab-markdown-editor-tab ${mode === "preview" ? "is-active" : ""}`}
          type="button"
          role="tab"
          aria-selected={mode === "preview"}
          onClick={() => onModeChange("preview")}
        >
          <Eye aria-hidden="true" />预览
        </Button>
      </div>
      {mode === "source" ? (
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={rows}
          aria-label={ariaLabel}
          spellCheck={false}
        />
      ) : (
        <div className="gitlab-markdown-preview">
          {value.trim() ? <GitLabMarkdown source={value} /> : <span>在源码模式输入 Markdown 后，这里会显示预览。</span>}
        </div>
      )}
    </>
  );
}
