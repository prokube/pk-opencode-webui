import {
  createSignal,
  createEffect,
  createMemo,
  Show,
  onCleanup,
  For,
} from "solid-js";
import * as Diff from "diff";
import type { FileDiff, FileNode } from "../sdk/client";
import { useSDK } from "../context/sdk";
import { useEvents } from "../context/events";
import { useLayout } from "../context/layout";

import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { ContentDiff } from "./diff/content-diff";
import { Tabs } from "./ui/tabs";
import { Spinner } from "./ui/spinner";
import { ChevronRight, FileCode, GitBranch, RefreshCw, X } from "lucide-solid";

// Helper to create unified diff patch string
function createPatch(filename: string, before: string, after: string): string {
  // Use diff library's createTwoFilesPatch if available (runtime)
  const diffLib = Diff as unknown as {
    createTwoFilesPatch?: (
      oldFileName: string,
      newFileName: string,
      oldStr: string,
      newStr: string,
    ) => string;
  };
  if (diffLib.createTwoFilesPatch) {
    return diffLib.createTwoFilesPatch(filename, filename, before, after);
  }
  // Fallback: return empty patch (shouldn't happen)
  return "";
}

interface ReviewPanelProps {
  sessionId: string;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { client } = useSDK();
  const events = useEvents();
  const layout = useLayout();

  const [diffs, setDiffs] = createSignal<FileDiff[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [tab, setTab] = createSignal<"changes" | "all">("changes");
  const [isGitRepo, setIsGitRepo] = createSignal<boolean | null>(null); // null = unknown

  // Track the latest request to prevent race conditions
  let version = 0;

  async function checkGitRepo() {
    try {
      // Try to get VCS info - if it fails or returns no branch, it's not a git repo
      const res = await client.vcs.get();
      setIsGitRepo(res.data?.branch !== undefined);
    } catch {
      setIsGitRepo(false);
    }
  }

  async function loadDiffs() {
    const current = ++version;
    setLoading(true);
    try {
      const res = await client.session.diff({ sessionID: props.sessionId });
      // Only update state if this is still the latest request
      if (current !== version) return;
      if (res.data) {
        setDiffs(res.data);
        setIsGitRepo(true); // If we got diffs, it's definitely a git repo
        // Auto-select first file if none selected or selection no longer exists
        const files = res.data.map((d) => d.file);
        const sel = selected();
        if (!sel || !files.includes(sel)) {
          setSelected(res.data.length > 0 ? res.data[0].file : null);
        }
      } else {
        // No diffs returned - check if it's because no git repo
        await checkGitRepo();
      }
    } catch (e) {
      if (current !== version) return;
      console.error("[ReviewPanel] Failed to load diffs:", e);
      // Check if it's a git repo issue
      await checkGitRepo();
    } finally {
      if (current === version) setLoading(false);
    }
  }

  // Load diffs when session changes
  createEffect(() => {
    const id = props.sessionId;
    if (id) {
      // Reset selection when session changes
      setSelected(null);
      loadDiffs();
    } else {
      setDiffs([]);
      setSelected(null);
    }
  });

  // Subscribe to diff events for real-time updates
  createEffect(() => {
    const id = props.sessionId;
    if (!id) return;

    const unsub = events.subscribe((event) => {
      if (event.type === "session.diff") {
        const eventProps = event.properties as {
          sessionID?: string;
          diff?: FileDiff[];
        };
        if (eventProps.sessionID === id && eventProps.diff) {
          setDiffs(eventProps.diff);
          // Auto-select first file if none selected or selection no longer exists
          const files = eventProps.diff.map((d) => d.file);
          const sel = selected();
          if (!sel || !files.includes(sel)) {
            setSelected(
              eventProps.diff.length > 0 ? eventProps.diff[0].file : null,
            );
          }
        }
      }
      // Reload on session status idle to catch completed changes
      if (event.type === "session.status") {
        const eventProps = event.properties as {
          sessionID?: string;
          status?: { type: string };
        };
        if (eventProps.sessionID === id && eventProps.status?.type === "idle") {
          loadDiffs();
        }
      }
    });

    onCleanup(unsub);
  });

  const selectedDiff = createMemo(() => {
    const file = selected();
    if (!file) return null;
    return diffs().find((d) => d.file === file) ?? null;
  });

  const patch = createMemo(() => {
    const diff = selectedDiff();
    if (!diff) return "";
    return createPatch(diff.file, diff.before, diff.after);
  });

  const lang = createMemo(() => {
    const file = selected();
    if (!file) return undefined;
    const ext = file.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "ts":
      case "tsx":
        return "typescript";
      case "js":
      case "jsx":
        return "javascript";
      case "py":
        return "python";
      case "go":
        return "go";
      case "rs":
        return "rust";
      case "md":
        return "markdown";
      case "json":
        return "json";
      case "css":
        return "css";
      case "html":
        return "html";
      case "yaml":
      case "yml":
        return "yaml";
      default:
        return undefined;
    }
  });

  const count = createMemo(() => diffs().length);

  // List of changed file paths for filtering
  const diffFiles = createMemo(() => diffs().map((d) => d.file));

  // Build kinds map for highlighting (mix = modified)
  const kinds = createMemo(() => {
    const map = new Map<string, "add" | "del" | "mix">();
    for (const d of diffs()) {
      // Use status field if available, fallback to before/after inference
      if (d.status === "added") {
        map.set(d.file, "add");
      } else if (d.status === "deleted") {
        map.set(d.file, "del");
      } else {
        map.set(d.file, "mix");
      }
    }
    return map;
  });

  function handleFileClick(node: FileNode) {
    // In "All Files" tab, clicking a file opens it in a new tab
    layout.tabs.open(node.path);
  }

  function handleDiffClick(path: string) {
    setSelected(path);
    // Switch back to Review tab when clicking a changed file
    layout.tabs.setActive(null);
  }

  const fileTabs = () => layout.tabs.all();
  const activeTab = () => layout.tabs.active();

  return (
    <div
      class="w-full h-full flex flex-col overflow-hidden"
      style={{ background: "var(--background-base)" }}
    >
      {/* Tab Bar - Review + File Tabs */}
      <div
        class="flex items-center overflow-x-auto shrink-0"
        style={{
          "border-bottom": "1px solid var(--border-base)",
          background: "var(--surface-inset)",
        }}
      >
        {/* Review Tab */}
        <button
          type="button"
          onClick={() => layout.tabs.setActive(null)}
          class="flex items-center gap-1.5 px-3 py-2 text-xs shrink-0 border-b-2 transition-colors"
          style={{
            "border-color":
              activeTab() === null ? "var(--interactive-base)" : "transparent",
            color:
              activeTab() === null ? "var(--text-strong)" : "var(--text-weak)",
            background:
              activeTab() === null ? "var(--background-base)" : "transparent",
          }}
        >
          <FileCode class="w-3.5 h-3.5" />
          <span>Review</span>
          <Show when={count() > 0}>
            <span
              class="px-1.5 py-0.5 rounded-full text-[10px] font-medium"
              style={{
                background: "var(--interactive-base)",
                color: "var(--text-on-interactive)",
              }}
            >
              {count()}
            </span>
          </Show>
        </button>

        {/* File Tabs */}
        <For each={fileTabs()}>
          {(fileTab) => (
            <div
              role="tab"
              tabIndex={0}
              onClick={() => layout.tabs.setActive(fileTab.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  layout.tabs.setActive(fileTab.path);
                }
              }}
              class="group flex items-center gap-1 px-2 py-2 text-xs shrink-0 border-b-2 transition-colors cursor-pointer"
              style={{
                "border-color":
                  activeTab() === fileTab.path
                    ? "var(--interactive-base)"
                    : "transparent",
                color:
                  activeTab() === fileTab.path
                    ? "var(--text-strong)"
                    : "var(--text-weak)",
                background:
                  activeTab() === fileTab.path
                    ? "var(--background-base)"
                    : "transparent",
              }}
            >
              <span class="max-w-[100px] truncate">{fileTab.name}</span>
              <button
                type="button"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  layout.tabs.close(fileTab.path);
                }}
                class="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-50 group-hover:opacity-100"
              >
                <X class="w-3 h-3" />
              </button>
            </div>
          )}
        </For>
      </div>

      {/* Content: Either Review tab or File Viewer */}
      <Show
        when={activeTab() !== null}
        fallback={
          /* Review Tab Content */
          <>
            {/* Header */}
            <div
              class="flex items-center justify-between px-3 py-2 shrink-0"
              style={{ "border-bottom": "1px solid var(--border-base)" }}
            >
              <div class="flex items-center gap-2">
                <button
                  onClick={() => loadDiffs()}
                  class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  style={{ color: "var(--icon-weak)" }}
                  title="Refresh"
                >
                  <RefreshCw
                    class="w-3.5 h-3.5"
                    classList={{ "animate-spin": loading() }}
                  />
                </button>
              </div>
              <button
                onClick={() => layout.review.close()}
                class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
                style={{ color: "var(--icon-weak)" }}
              >
                <ChevronRight class="w-4 h-4" />
              </button>
            </div>

            {/* Tabs for Changed Files / All Files */}
            <Tabs
              variant="pill"
              value={tab()}
              onChange={(value) => {
                setTab(value as "changes" | "all");
                // Clear selection when switching to changes tab if selected file has no changes
                if (value === "changes") {
                  const sel = selected();
                  if (sel && !diffFiles().includes(sel)) {
                    setSelected(null);
                  }
                }
              }}
              class="flex flex-col flex-1 min-h-0"
            >
              <div
                class="px-2 py-2"
                style={{ "border-bottom": "1px solid var(--border-base)" }}
              >
                <Tabs.List class="flex gap-1">
                  <Tabs.Trigger
                    value="changes"
                    class="flex-1"
                    classes={{ button: "w-full text-xs py-1" }}
                  >
                    {count()} {count() === 1 ? "Change" : "Changes"}
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="all"
                    class="flex-1"
                    classes={{ button: "w-full text-xs py-1" }}
                  >
                    All Files
                  </Tabs.Trigger>
                </Tabs.List>
              </div>

              {/* Changed Files Tab */}
              <Tabs.Content
                value="changes"
                class="flex-1 flex flex-col min-h-0 overflow-hidden"
              >
                {/* File List */}
                <div
                  class="shrink-0 max-h-40 overflow-auto"
                  style={{ "border-bottom": "1px solid var(--border-base)" }}
                >
                  <Show when={loading() && diffs().length === 0}>
                    <div class="flex items-center justify-center gap-2 p-4">
                      <Spinner class="w-4 h-4" />
                      <span
                        class="text-xs"
                        style={{ color: "var(--text-weak)" }}
                      >
                        Loading changes...
                      </span>
                    </div>
                  </Show>
                  <Show when={!loading() || diffs().length > 0}>
                    <Show
                      when={count() > 0}
                      fallback={
                        <div
                          class="p-4 text-center text-xs"
                          style={{ color: "var(--text-weak)" }}
                        >
                          <Show
                            when={isGitRepo() === true}
                            fallback={
                              <div class="flex flex-col items-center gap-2">
                                <GitBranch
                                  class="w-5 h-5"
                                  style={{ opacity: 0.5 }}
                                />
                                <span>Not a Git repository</span>
                                <span
                                  class="text-[10px]"
                                  style={{ opacity: 0.7 }}
                                >
                                  Initialize Git to track changes
                                </span>
                              </div>
                            }
                          >
                            <span>No changes in this session</span>
                          </Show>
                        </div>
                      }
                    >
                      <div class="p-2">
                        <FileTree
                          path=""
                          allowed={diffFiles()}
                          kinds={kinds()}
                          active={selected() ?? undefined}
                          onFileClick={(node) => handleDiffClick(node.path)}
                        />
                      </div>
                    </Show>
                  </Show>
                </div>

                {/* Diff View */}
                <div class="flex-1 overflow-auto min-h-0">
                  <Show
                    when={selectedDiff()}
                    fallback={
                      <div class="flex flex-col items-center justify-center h-full text-center px-4">
                        <FileCode
                          class="w-8 h-8 mb-2"
                          style={{ color: "var(--icon-weak)", opacity: 0.3 }}
                        />
                        <span
                          class="text-xs"
                          style={{ color: "var(--text-weak)" }}
                        >
                          {count() > 0
                            ? "Select a file to view changes"
                            : "No changes in this session"}
                        </span>
                      </div>
                    }
                  >
                    {(diff) => (
                      <div class="p-2">
                        <div
                          class="rounded overflow-hidden"
                          style={{ border: "1px solid var(--border-base)" }}
                        >
                          <div
                            class="px-3 py-1.5 text-xs truncate"
                            style={{
                              background: "var(--surface-inset)",
                              color: "var(--text-base)",
                            }}
                          >
                            {diff().file}
                          </div>
                          <div class="overflow-x-auto">
                            <ContentDiff diff={patch()} lang={lang()} />
                          </div>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              </Tabs.Content>

              {/* All Files Tab */}
              <Tabs.Content value="all" class="flex-1 overflow-auto min-h-0">
                <div class="p-2">
                  <FileTree
                    path=""
                    modified={diffFiles()}
                    kinds={kinds()}
                    active={selected() ?? undefined}
                    onFileClick={handleFileClick}
                  />
                </div>
              </Tabs.Content>
            </Tabs>
          </>
        }
      >
        {/* File Viewer Content */}
        <div class="flex flex-col flex-1 min-h-0 relative">
          <div
            class="flex items-center justify-end px-2 py-1 shrink-0"
            style={{ "border-bottom": "1px solid var(--border-base)" }}
          >
            <button
              onClick={() => layout.review.close()}
              class="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: "var(--icon-weak)" }}
            >
              <ChevronRight class="w-4 h-4" />
            </button>
          </div>
          <FileViewer path={activeTab()!} />
        </div>
      </Show>
    </div>
  );
}
