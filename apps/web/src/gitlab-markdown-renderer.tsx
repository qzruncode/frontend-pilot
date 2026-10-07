import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function GitLabMarkdownRenderer({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
