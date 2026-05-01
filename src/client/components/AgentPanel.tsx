import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Textarea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowUpIcon, BrainIcon, StopIcon } from "@phosphor-icons/react";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isInternalTurnMessageId } from "../../shared/messages";
import type { RuntimeEvent } from "../../shared/types";
import { MessageParts } from "./MessageParts";

type AgentPanelProps = {
  /**
   * The agent connection from useAgent in the parent. Sharing it means
   * gameplay state sync and chat ride the same WebSocket instead of opening
   * a second connection to the same Durable Object.
   */
  agent: Parameters<typeof useAgentChat>[0]["agent"];
  runtimeEvents?: RuntimeEvent[];
  title?: string;
  description?: string;
  headerAccessory?: ReactNode;
  placeholder?: string;
  showRuntimeTimeline?: boolean;
  runtimeEmptyDescription?: string;
  onResponseComplete?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
};

export function AgentPanel({
  agent,
  runtimeEvents = [],
  title = "Agent Chat",
  description = "Watch the model reason, call tools, and explain its moves.",
  headerAccessory,
  placeholder = "Ask why it chose a move...",
  showRuntimeTimeline = true,
  runtimeEmptyDescription = "Make a move to watch the harness run.",
  onResponseComplete,
  emptyTitle = "Ask about the position.",
  emptyDescription =
    "The transcript will show text, reasoning parts, and tool calls from the chess agent.",
}: AgentPanelProps) {
  const [message, setMessage] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);
  const { messages, sendMessage, status, stop } = useAgentChat({ agent });
  const isStreaming = status === "streaming" || status === "submitted";
  const visibleMessages = useMemo(
    () => messages.filter((chatMessage) => !isInternalTurnPrompt(chatMessage)),
    [messages],
  );

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }

    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }, [visibleMessages, status]);

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      onResponseComplete?.();
    }

    wasStreamingRef.current = isStreaming;
  }, [isStreaming, onResponseComplete]);

  return (
    <LayerCard className="panel side-panel agent-chat-shell">
      <header className="agent-chat-header">
        <div>
          <Text variant="heading2">{title}</Text>
          <Text variant="secondary">{description}</Text>
        </div>
        <div className="agent-chat-header-actions">
          {headerAccessory}
          <div
            className="agent-chat-status"
            data-active={isStreaming ? "true" : "false"}
          >
            {isStreaming ? "Thinking" : "Ready"}
          </div>
        </div>
      </header>

      {showRuntimeTimeline ? (
        <section className="runtime-timeline" aria-label="Think runtime timeline">
          <div className="runtime-timeline-header">
            <Text bold>Think Runtime</Text>
            <Text variant="secondary">Loop events</Text>
          </div>
          {runtimeEvents.length === 0 ? (
            <Text variant="secondary">{runtimeEmptyDescription}</Text>
          ) : (
            <ol>
              {runtimeEvents.map((event) => (
                <li key={event.id}>
                  <time>{formatRuntimeTime(event.at)}</time>
                  <span>{event.label}</span>
                  {event.detail ? <em>{event.detail}</em> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      <div ref={feedRef} className="agent-chat-feed" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <div className="agent-chat-empty">
            <BrainIcon size={28} />
            <Text bold>{emptyTitle}</Text>
            <Text variant="secondary">{emptyDescription}</Text>
          </div>
        ) : null}

        {visibleMessages.map((chatMessage) => (
          <article
            key={chatMessage.id}
            className="agent-message"
            data-role={chatMessage.role}
          >
            <div className="agent-message-bubble">
              <MessageParts parts={chatMessage.parts} />
            </div>
          </article>
        ))}

        {isStreaming ? (
          <div className="agent-streaming-indicator" role="status">
            <BrainIcon size={16} />
            <span>Thinking...</span>
          </div>
        ) : null}
      </div>

      <form
        className="agent-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();

          if (isStreaming) {
            stop?.();
            return;
          }

          if (!message.trim()) {
            return;
          }

          sendMessage({ text: message });
          setMessage("");
        }}
      >
        <Textarea
          aria-label="Message the agent"
          placeholder={placeholder}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="agent-chat-composer-footer">
          <Text variant="secondary">Enter sends. Shift+Enter adds a line.</Text>
          <Button
            type="submit"
            shape="circle"
            disabled={isStreaming ? false : !message.trim()}
            aria-label={isStreaming ? "Stop response" : "Send message"}
          >
            {isStreaming ? (
              <StopIcon weight="fill" />
            ) : (
              <ArrowUpIcon weight="bold" />
            )}
          </Button>
        </div>
      </form>
    </LayerCard>
  );
}

function isInternalTurnPrompt(message: UIMessage) {
  return message.role === "user" && isInternalTurnMessageId(message.id);
}

function formatRuntimeTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
