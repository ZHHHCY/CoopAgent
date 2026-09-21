import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./MarkdownMessage.css";

type Props = {
  children: string;
};

export function MarkdownMessage({ children }: Props) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        components={{
          a: ({ children: linkChildren, href }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {linkChildren}
            </a>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
