import type { Message } from "ai";
import ReactMarkdown, { type Components } from "react-markdown";

export type MessagePart = NonNullable<Message["parts"]>[number];

interface ChatMessageProps {
  parts?: MessagePart[];
  text: string;
  role: string;
  userName: string;
}

const components: Components = {
  // Override default elements with custom styling
  p: ({ children }) => <p className="mb-4 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-4 list-disc pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 list-decimal pl-4">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  code: ({ className, children, ...props }) => (
    <code className={`${className ?? ""}`} {...props}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-4 overflow-x-auto rounded-lg bg-gray-700 p-4">
      {children}
    </pre>
  ),
  a: ({ children, ...props }) => (
    <a
      className="text-blue-400 underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
};

const Markdown = ({ children }: { children: string }) => {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
};

const ToolInvocation = ({ part }: { part: MessagePart & { type: "tool-invocation" } }) => {
  const { toolInvocation } = part;
  const { toolName, args } = toolInvocation;

  return (
    <div className="mb-4 rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-sm text-gray-400">{toolName}</span>
        <span className="text-xs text-gray-500">
          {toolInvocation.state === "result" ? "completed" : "in progress"}
        </span>
      </div>
      
      <div className="space-y-2">
        <div>
          <p className="text-xs text-gray-500">Arguments:</p>
          <pre className="overflow-x-auto rounded bg-gray-900 p-2 text-sm">
            <code>{JSON.stringify(args, null, 2)}</code>
          </pre>
        </div>

        {toolInvocation.state === "result" && (
          <div>
            <p className="text-xs text-gray-500">Result:</p>
            <pre className="overflow-x-auto rounded bg-gray-900 p-2 text-sm">
              <code>{JSON.stringify(toolInvocation.result, null, 2)}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

const MessageContent = ({ part }: { part: MessagePart }) => {
  switch (part.type) {
    case "text":
      return <Markdown>{part.text}</Markdown>;
    case "tool-invocation":
      return <ToolInvocation part={part} />;
    default:
      return null;
  }
};

export const ChatMessage = ({ parts, text, role, userName }: ChatMessageProps) => {
  const isAI = role === "assistant";

  return (
    <div className="mb-6">
      <div
        className={`rounded-lg p-4 ${
          isAI ? "bg-gray-800 text-gray-300" : "bg-gray-900 text-gray-300"
        }`}
      >
        <p className="mb-2 text-sm font-semibold text-gray-400">
          {isAI ? "AI" : userName}
        </p>

        <div className="prose prose-invert max-w-none">
          {parts ? (
            parts.map((part, index) => (
              <MessageContent key={index} part={part} />
            ))
          ) : (
            <Markdown>{text}</Markdown>
          )}
        </div>
      </div>
    </div>
  );
};
