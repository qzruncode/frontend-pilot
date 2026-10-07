import { lazy, Suspense } from "react";

const AssistantMarkdownRenderer = lazy(() => import("./assistant-markdown-renderer"));

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="assistant-markdown">
      <Suspense fallback={<span className="assistant-markdown-loading" role="status">正在整理格式…</span>}>
        <AssistantMarkdownRenderer text={text} />
      </Suspense>
    </div>
  );
}
