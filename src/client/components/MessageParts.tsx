import {
  getToolInput,
  getToolOutput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { CaretDownIcon } from "@phosphor-icons/react";
import {
  getToolName as getUiToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { useMemo, useState } from "react";

type MessagePart = UIMessage["parts"][number];
type ToolPart = Parameters<typeof getUiToolName>[0];

export function MessageParts({ parts }: { parts: MessagePart[] }) {
  const visibleParts = useMemo(
    () => parts.filter((part) => part.type !== "step-start"),
    [parts],
  );

  return (
    <div className="agent-message-parts">
      {visibleParts.map((part, index) => (
        <MessagePartView key={`${part.type}-${index}`} part={part} />
      ))}
    </div>
  );
}

function MessagePartView({ part }: { part: MessagePart }) {
  if (isTextUIPart(part)) {
    return <TextBlock text={part.text} />;
  }

  if (isReasoningUIPart(part)) {
    return (
      <ThinkingDisclosure
        title="Reasoning"
        summary="Model reasoning"
        body={part.text}
      />
    );
  }

  if (isToolUIPart(part)) {
    return <ToolDisclosure part={part} />;
  }

  return (
    <ThinkingDisclosure
      title={humanizePartType(part.type)}
      summary="Message event"
      body={formatValue(part)}
    />
  );
}

function TextBlock({ text }: { text: string }) {
  if (!text.trim()) {
    return null;
  }

  return (
    <div className="agent-text-block">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{renderInlineMarkdown(paragraph)}</p>
      ))}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    return part;
  });
}

function ToolDisclosure({ part }: { part: ToolPart }) {
  const input = getToolInput(part);
  const output = getToolOutput(part);
  const error = getToolError(part);
  const details = [
    input !== undefined ? `Input\n${formatValue(input)}` : undefined,
    output !== undefined ? `Output\n${formatValue(output)}` : undefined,
    error ? `Error\n${error}` : undefined,
  ]
    .filter((detail) => detail !== undefined)
    .join("\n\n");

  return (
    <ThinkingDisclosure
      title={humanizePartType(getUiToolName(part))}
      summary={humanizePartType(getToolPartState(part))}
      body={details || formatValue(part)}
    />
  );
}

function ThinkingDisclosure({
  title,
  summary,
  body,
}: {
  title: string;
  summary: string;
  body: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="agent-thinking-block">
      <button
        type="button"
        className="agent-thinking-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <CaretDownIcon size={12} weight="bold" />
        <span>{expanded ? "hide thinking" : "see thinking"}</span>
        <span className="agent-thinking-summary">
          {title} · {summary}
        </span>
      </button>
      {expanded ? <pre className="agent-thinking-body">{body}</pre> : null}
    </div>
  );
}

function getToolError(part: ToolPart) {
  return "errorText" in part ? part.errorText : undefined;
}

function humanizePartType(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}
