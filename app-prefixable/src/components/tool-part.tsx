import { createSignal, createEffect, createMemo, Show, For, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Part, ToolPart as SDKToolPart, ToolState } from "../sdk/client";
import { ChevronDown, ExternalLink, Users } from "lucide-solid";
import { ContentDiff } from "./diff/content-diff";
import { useSync } from "../context/sync";
import { useParams, useNavigate } from "@solidjs/router";
import { base64Encode } from "../utils/path";
import { useSDK } from "../context/sdk";

// Use the SDK's ToolPart type
type ToolPart = SDKToolPart;

// Limit how many tool part expansion states we keep to avoid unbounded growth.
const MAX_EXPANDED_STATES = 1000;

// Module-level store for expanded states that persists across re-renders
// Wrapped in createRoot to avoid "no owner" warnings and ensure proper reactive context
const expandedStore = createRoot(() => {
  const expandedKeys: string[] = [];
  const [states, setStates] = createStore<Record<string, boolean>>({});

  return {
    get: (id: string) => states[id] ?? false,
    set: (id: string, value: boolean) => {
      const isNewKey = !(id in states);
      
      // Only update if value actually changes
      if (!isNewKey && states[id] === value) return;
      
      setStates(produce(state => {
        state[id] = value;
        
        if (isNewKey) {
          expandedKeys.push(id);
          // Evict oldest entry if over limit
          if (expandedKeys.length > MAX_EXPANDED_STATES) {
            const oldest = expandedKeys.shift();
            if (oldest && oldest in state && oldest !== id) {
              delete state[oldest];
            }
          }
        }
      }));
    },
    toggle: (id: string) => {
      expandedStore.set(id, !expandedStore.get(id));
    },
  };
});

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

// Get status from tool state
function getStatus(
  state: ToolState,
): "pending" | "running" | "completed" | "error" {
  return state.status;
}

// Check if state has output
function hasOutput(state: ToolState): boolean {
  return state.status === "completed" || state.status === "error";
}

// Get output from state
function getOutput(state: ToolState): string | undefined {
  if (state.status === "completed") return state.output;
  return undefined;
}

// Get error from state
function getError(state: ToolState): string | undefined {
  if (state.status === "error") return state.error;
  return undefined;
}

// Get input from state
function getInput(state: ToolState): Record<string, unknown> | undefined {
  return state.input;
}

// Get title from state
function getTitle(state: ToolState): string | undefined {
  if (state.status === "completed") return state.title;
  if (state.status === "running") return state.title;
  return undefined;
}

// Get icon for tool type
function getToolIcon(tool: string): string {
  const icons: Record<string, string> = {
    bash: "M4 17l6-6-6-6M12 19h8",
    read: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
    write:
      "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    glob: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
    grep: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
    list: "M4 6h16M4 10h16M4 14h16M4 18h16",
    webfetch:
      "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9",
    task: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    todowrite:
      "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4",
    question:
      "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  };
  return icons[tool] || "M13 10V3L4 14h7v7l9-11h-7z"; // Default: lightning bolt
}

// Get status color
function getStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "var(--icon-success-base)";
    case "running":
      return "var(--text-interactive-base)";
    case "pending":
      return "var(--text-weak)";
    case "error":
      return "var(--icon-critical-base)";
    default:
      return "var(--text-weak)";
  }
}

// Format tool input for display
function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// Get language from file extension for syntax highlighting
function getLangFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    graphql: "graphql",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
  };
  return langMap[ext] || "text";
}

// Get metadata from state
function getMetadata(state: ToolState): Record<string, unknown> | undefined {
  if (state.status === "completed")
    return state.metadata as Record<string, unknown> | undefined;
  if (state.status === "running")
    return state.metadata as Record<string, unknown> | undefined;
  return undefined;
}

// Extract child session ID from task tool metadata or output
function getChildSessionId(state: ToolState): string | undefined {
  const metadata = getMetadata(state);
  if (metadata?.sessionId) return metadata.sessionId as string;

  // Fallback: parse from output if metadata not available
  const output = getOutput(state);
  if (output) {
    const match = output.match(/task_id:\s*([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
  }
  return undefined;
}

// Get tool summary from child session messages
function getChildToolSummary(
  tools: { tool: string; status: string }[],
): string {
  if (tools.length === 0) return "";
  const counts = tools.reduce(
    (acc, t) => {
      acc[t.tool] = (acc[t.tool] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  return Object.entries(counts)
    .map(([tool, count]) => `${tool}${count > 1 ? ` (${count})` : ""}`)
    .join(", ");
}

// Task tool display with child session visualization
function TaskToolDisplay(props: { part: ToolPart }) {
  const sync = useSync();
  const params = useParams<{ dir: string }>();
  const navigate = useNavigate();
  const { directory } = useSDK();

  // Use the module-level store for expanded state to persist across re-renders
  const expanded = () => expandedStore.get(props.part.id);

  const state = () => props.part.state;
  const status = () => getStatus(state());
  const metadata = () => getMetadata(state());
  const title = () => getTitle(state()) || "Delegating work";
  const childId = () => getChildSessionId(state());

  // Get child session messages to show tool usage
  const childMessages = createMemo(() => {
    const id = childId();
    if (!id) return [];
    return sync.messages(id);
  });

  // Extract tool parts from child session
  const childTools = createMemo(() => {
    return childMessages().flatMap((msg) =>
      msg.parts
        .filter((p): p is ToolPart => p.type === "tool")
        .map((p) => ({ tool: p.tool, status: getStatus(p.state) })),
    );
  });

  // Sync child session data when we have a child ID
  createEffect(() => {
    const id = childId();
    if (id) {
      sync.session.sync(id);
    }
  });

  const dirSlug = createMemo(() =>
    directory ? base64Encode(directory) : params.dir,
  );

  function navigateToChild(e: MouseEvent) {
    e.stopPropagation();
    const id = childId();
    if (!id) return;
    navigate(`/${dirSlug()}/session/${id}`);
  }

  return (
    <div
      class="rounded-md overflow-hidden"
      style={{
        border: "1px solid var(--border-base)",
        background: "var(--background-base)",
      }}
    >
      {/* Header */}
      <button
        onClick={() => expandedStore.toggle(props.part.id)}
        class="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
        style={{
          background: expanded() ? "var(--surface-inset)" : "transparent",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          if (!expanded())
            e.currentTarget.style.background = "var(--surface-inset)";
        }}
        onMouseLeave={(e) => {
          if (!expanded()) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Task/Agent icon */}
        <Users
          class="w-4 h-4 shrink-0"
          style={{ color: getStatusColor(status()) }}
        />

        {/* Title */}
        <span
          class="font-mono text-sm flex-1 truncate"
          style={{ color: "var(--text-strong)" }}
        >
          {title()}
        </span>

        {/* Status indicator */}
        <span
          class="text-xs shrink-0"
          style={{ color: getStatusColor(status()) }}
        >
          {status() === "running" && "delegating..."}
          {status() === "pending" && "pending"}
          {status() === "error" && "error"}
        </span>

        {/* Expand arrow */}
        <ChevronDown
          class="w-4 h-4 shrink-0 transition-transform"
          style={{
            color: "var(--icon-weak)",
            transform: expanded() ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </button>

      {/* Expanded content */}
      <Show when={expanded()}>
        <div
          class="px-3 py-2 text-sm"
          style={{
            "border-top": "1px solid var(--border-base)",
            background: "var(--background-stronger)",
          }}
        >
          {/* Task prompt/description */}
          <Show
            when={(getInput(state()) as { description?: string })?.description}
          >
            {(desc) => (
              <div class="mb-2">
                <div class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                  Task:
                </div>
                <div class="text-xs" style={{ color: "var(--text-base)" }}>
                  {desc()}
                </div>
              </div>
            )}
          </Show>

          {/* Child session tools summary */}
          <Show when={childTools().length > 0}>
            <div class="mb-2">
              <div class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                Tools used ({childTools().length}):
              </div>
              <div class="flex flex-wrap gap-1">
                <For each={childTools()}>
                  {(tool) => (
                    <span
                      class="px-1.5 py-0.5 rounded text-xs font-mono"
                      style={{
                        background: "var(--surface-inset)",
                        color: getStatusColor(tool.status),
                      }}
                    >
                      {tool.tool}
                    </span>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Link to child session */}
          <Show when={childId()}>
            <button
              onClick={navigateToChild}
              class="flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors"
              style={{
                color: "var(--text-interactive-base)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--surface-inset)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <ExternalLink class="w-3 h-3" />
              <span>View sub-agent session</span>
            </button>
          </Show>

          {/* Output (collapsed by default, only shown if no child tools) */}
          <Show when={getOutput(state()) && childTools().length === 0}>
            {(output) => (
              <div class="mt-2">
                <div class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                  Result:
                </div>
                <pre
                  class="whitespace-pre-wrap text-xs max-h-32 overflow-y-auto"
                  style={{ color: "var(--text-base)" }}
                >
                  {output()}
                </pre>
              </div>
            )}
          </Show>

          {/* Error */}
          <Show when={getError(state())}>
            {(err) => (
              <div
                class="px-2 py-1 rounded text-xs mt-2"
                style={{
                  background: "var(--status-danger-dim)",
                  color: "var(--status-danger-text)",
                }}
              >
                {err()}
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function ToolPartDisplay(props: { part: ToolPart }) {
  // Use special rendering for task tool
  if (props.part.tool === "task") {
    return <TaskToolDisplay part={props.part} />;
  }

  // Use the module-level store for expanded state to persist across re-renders
  const expanded = () => expandedStore.get(props.part.id);

  const state = () => props.part.state;
  const status = () => getStatus(state());
  const metadata = () => getMetadata(state());
  const isFileChange = () =>
    props.part.tool === "edit" || props.part.tool === "write";
  const hasDiff = () => isFileChange() && metadata()?.diff;
  // Can expand if has output OR has diff
  const canExpand = () => hasOutput(state()) || hasDiff();
  const title = () => getTitle(state()) || props.part.tool;
  const filePath = () =>
    (getInput(state()) as { filePath?: string })?.filePath || "";

  // Track if we've already auto-expanded this tool part
  const autoExpandedKey = `auto-${props.part.id}`;
  
  // Auto-expand edit tools when diff becomes available (only once)
  createEffect(() => {
    if (hasDiff() && !expandedStore.get(autoExpandedKey)) {
      expandedStore.set(autoExpandedKey, true);
      expandedStore.set(props.part.id, true);
    }
  });

  return (
    <div
      class="rounded-md overflow-hidden"
      style={{
        border: "1px solid var(--border-base)",
        background: "var(--background-base)",
      }}
    >
      {/* Header - always visible */}
      <button
        onClick={() => canExpand() && expandedStore.toggle(props.part.id)}
        class="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
        style={{
          background: expanded() ? "var(--surface-inset)" : "transparent",
          cursor: canExpand() ? "pointer" : "default",
        }}
        onMouseEnter={(e) => {
          if (canExpand() && !expanded())
            e.currentTarget.style.background = "var(--surface-inset)";
        }}
        onMouseLeave={(e) => {
          if (!expanded()) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Tool icon */}
        <svg
          class="w-4 h-4 shrink-0"
          style={{ color: getStatusColor(status()) }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d={getToolIcon(props.part.tool)}
          />
        </svg>

        {/* Tool name/title */}
        <span
          class="font-mono text-sm flex-1 truncate"
          style={{ color: "var(--text-strong)" }}
        >
          {title()}
        </span>

        {/* Status indicator */}
        <span
          class="text-xs shrink-0"
          style={{ color: getStatusColor(status()) }}
        >
          {status() === "running" && "running..."}
          {status() === "pending" && "pending"}
          {status() === "error" && "error"}
        </span>

        {/* Expand arrow */}
        <Show when={canExpand()}>
          <ChevronDown
            class="w-4 h-4 shrink-0 transition-transform"
            style={{
              color: "var(--icon-weak)",
              transform: expanded() ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </Show>
      </button>

      {/* Diff display for edit tools - controlled by expanded state */}
      <Show when={expanded() && hasDiff()}>
        <div
          class="px-3 py-2"
          style={{ "border-top": "1px solid var(--border-base)" }}
        >
          <ContentDiff
            diff={metadata()?.diff as string}
            lang={getLangFromPath(filePath())}
          />
        </div>
      </Show>

      {/* Expanded content for non-edit tools or when no diff */}
      <Show when={expanded() && canExpand() && !hasDiff()}>
        <div
          class="px-3 py-2 text-sm font-mono overflow-x-auto"
          style={{
            "border-top": "1px solid var(--border-base)",
            background: "var(--background-stronger)",
          }}
        >
          {/* Input */}
          <Show when={getInput(state())}>
            {(input) => (
              <div class="mb-2">
                <div class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                  Input:
                </div>
                <pre
                  class="whitespace-pre-wrap text-xs"
                  style={{ color: "var(--text-base)" }}
                >
                  {formatInput(input())}
                </pre>
              </div>
            )}
          </Show>

          {/* Output */}
          <Show when={getOutput(state())}>
            {(output) => (
              <div>
                <div class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                  Output:
                </div>
                <pre
                  class="whitespace-pre-wrap text-xs max-h-64 overflow-y-auto"
                  style={{ color: "var(--text-base)" }}
                >
                  {output()}
                </pre>
              </div>
            )}
          </Show>

          {/* Error */}
          <Show when={getError(state())}>
            {(err) => (
              <div
                class="px-2 py-1 rounded text-xs"
                style={{
                  background: "var(--status-danger-dim)",
                  color: "var(--status-danger-text)",
                }}
              >
                {err()}
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

// Render tool parts from a message
export function MessageParts(props: { parts: Part[] }) {
  // Filter to only tool parts
  const toolParts = () => props.parts.filter(isToolPart);

  return (
    <Show when={toolParts().length > 0}>
      <div class="space-y-2 mt-3">
        <For each={toolParts()}>
          {(part) => <ToolPartDisplay part={part} />}
        </For>
      </div>
    </Show>
  );
}
