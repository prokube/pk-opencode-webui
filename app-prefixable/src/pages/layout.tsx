import {
  type ParentProps,
  createSignal,
  For,
  Show,
  onMount,
  createMemo,
  onCleanup,
  createEffect,
} from "solid-js";
import { A, useLocation, useNavigate, useParams } from "@solidjs/router";
import { useBasePath } from "../context/base-path";
import { useSDK } from "../context/sdk";
import { useEvents } from "../context/events";
import { useProviders } from "../context/providers";
import { useTerminal } from "../context/terminal";
import { useLayout } from "../context/layout";
import { base64Encode } from "../utils/path";
import { Spinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { Terminal } from "../components/terminal";
import { ProjectDialog } from "../components/project-dialog";
import {
  getFilename,
  OpenCodeLogo,
  ProjectAvatar,
  type Project,
} from "../components/shared";
import type { Session } from "../sdk/client";
import {
  Plus,
  Settings,
  SquareTerminal,
  MessageCircle,
  Loader2,
  CircleHelp,
  Archive,
  ArchiveRestore,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Pencil,
} from "lucide-solid";
import { useSync } from "../context/sync";

// Storage keys
const PROJECTS_STORAGE_KEY = "opencode.projects";
const SIDEBAR_EXPANDED_KEY = "opencode.sidebarExpanded";
const SHOW_ARCHIVED_KEY = "opencode.showArchived";

// Group sessions by date bucket
export function groupSessionsByDate(
  sessions: Session[],
  now: Date,
): { label: string; sessions: Session[] }[] {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const todayStart = startOfDay(now);
  const yesterdayStart = startOfDay(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
  const sevenDaysAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  const bucket = (t: number): string => {
    if (t >= todayStart) return "Today";
    if (t >= yesterdayStart) return "Yesterday";
    if (t >= sevenDaysAgoMs) return "Last 7 days";
    return "Older";
  };

  const groups: Record<string, Session[]> = {};
  const order = ["Today", "Yesterday", "Last 7 days", "Older"];

  for (const session of sessions) {
    const label = bucket(session.time?.updated ?? 0);
    if (!groups[label]) groups[label] = [];
    groups[label].push(session);
  }

  return order
    .filter((label) => groups[label]?.length)
    .map((label) => ({ label, sessions: groups[label] }));
}

export function Layout(props: ParentProps) {
  const { client, directory } = useSDK();
  const { basePath } = useBasePath();
  const events = useEvents();
  const providers = useProviders();
  const terminal = useTerminal();
  const layout = useLayout();
  const sync = useSync();
  const location = useLocation();
  const navigate = useNavigate();

  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [sidebarExpanded, setSidebarExpanded] = createSignal(true);
  const [showArchived, setShowArchived] = createSignal(false);
  const [projectDialogOpen, setProjectDialogOpen] = createSignal(false);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [windowWidth, setWindowWidth] = createSignal(
    typeof window !== "undefined" ? window.innerWidth : 1200,
  );

  // Responsive breakpoint - collapse sidebar below 900px
  const COLLAPSE_BREAKPOINT = 900;

  // Effective sidebar state: hidden on settings page or small screens
  const showSidebar = createMemo(() => {
    if (location.pathname.endsWith("/settings")) return false;
    if (windowWidth() < COLLAPSE_BREAKPOINT) return false;
    return sidebarExpanded();
  });

  // Load state from storage
  onMount(() => {
    // Load projects
    try {
      const stored = localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (stored) {
        setProjects(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Failed to load projects:", e);
    }

    // Load sidebar state - default to open when a project is active
    try {
      const expanded = localStorage.getItem(SIDEBAR_EXPANDED_KEY);
      if (expanded !== null) {
        setSidebarExpanded(expanded === "true");
      } else if (directory) {
        // Default to open when viewing a project
        setSidebarExpanded(true);
      }
    } catch (e) {
      console.error("Failed to load sidebar state:", e);
    }

    // Load show archived state
    try {
      const archived = localStorage.getItem(SHOW_ARCHIVED_KEY);
      if (archived !== null) {
        setShowArchived(archived === "true");
      }
    } catch (e) {
      console.error("Failed to load show archived state:", e);
    }

    // Add current directory to projects if not present
    if (directory) {
      addProject(directory);
      // Ensure sidebar is open when navigating to a project
      setSidebarExpanded(true);
      localStorage.setItem(SIDEBAR_EXPANDED_KEY, "true");
    }

    // Resize listener for responsive sidebar
    function handleResize() {
      setWindowWidth(window.innerWidth);
    }
    window.addEventListener("resize", handleResize);
    onCleanup(() => window.removeEventListener("resize", handleResize));
  });

  function saveProjects(list: Project[]) {
    setProjects(list);
    try {
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
      console.error("Failed to save projects:", e);
    }
  }

  function toggleSidebar() {
    const next = !sidebarExpanded();
    setSidebarExpanded(next);
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(next));
    } catch (e) {
      console.error("Failed to save sidebar state:", e);
    }
  }

  function toggleShowArchived() {
    const next = !showArchived();
    setShowArchived(next);
    try {
      localStorage.setItem(SHOW_ARCHIVED_KEY, String(next));
    } catch (e) {
      console.error("Failed to save show archived state:", e);
    }
  }

  function addProject(worktree: string) {
    const existing = projects().find((p) => p.worktree === worktree);
    if (!existing) {
      saveProjects([...projects(), { worktree }]);
    }
  }

  function removeProject(worktree: string) {
    saveProjects(projects().filter((p) => p.worktree !== worktree));
  }

  function handleProjectSelect(worktree: string) {
    addProject(worktree);
    navigate(`/${base64Encode(worktree)}/session`);
  }

  const currentProject = createMemo(() =>
    projects().find((p) => p.worktree === directory),
  );

  const projectName = createMemo(() => {
    const project = currentProject();
    if (project?.name) return project.name;
    if (!directory) return "Project";
    return getFilename(directory);
  });

  const dirSlug = createMemo(() => (directory ? base64Encode(directory) : ""));

  const projectSessions = createMemo(() =>
    sessions()
      .filter((s) => s.directory === directory && !s.time?.archived)
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)),
  );

  const archivedSessions = createMemo(() =>
    sync
      .archivedSessions()
      .filter((s) => s.directory === directory)
      .sort((a, b) => (b.time?.archived || 0) - (a.time?.archived || 0)),
  );

  const [now, setNow] = createSignal(new Date());

  onMount(() => {
    const timer = { id: 0 as ReturnType<typeof setTimeout> };
    const schedule = () => {
      const next = new Date();
      next.setHours(24, 0, 0, 0);
      timer.id = setTimeout(() => { setNow(new Date()); schedule(); }, next.getTime() - Date.now());
    };
    schedule();
    onCleanup(() => clearTimeout(timer.id));
  });

  const groupedSessions = createMemo(() =>
    groupSessionsByDate(projectSessions(), now()),
  );

  async function loadSessions() {
    try {
      const res = await client.session.list({ roots: true });
      const data = res.data;
      if (Array.isArray(data)) {
        const valid = data.filter(
          (s): s is Session =>
            s && typeof s === "object" && typeof s.id === "string",
        );
        setSessions(valid);
      } else {
        setSessions([]);
      }
    } catch (e) {
      console.error("Failed to load sessions:", e);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    loadSessions();

    const unsub = events.subscribe((event) => {
      if (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.deleted"
      ) {
        loadSessions();
      }
    });

    function handleKeyDown(e: KeyboardEvent) {
      // Terminal toggle: Ctrl+`
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        terminal.toggle(directory);
      }
      // Sidebar toggle: Ctrl+B
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      // Review panel toggle: Cmd+Shift+R (Mac) or Ctrl+Shift+R
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        layout.review.toggle();
      }
      // Info panel toggle: Cmd+Shift+I (Mac) or Ctrl+Shift+I
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "i"
      ) {
        e.preventDefault();
        layout.info.toggle();
      }
    }
    window.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      unsub();
      window.removeEventListener("keydown", handleKeyDown);
    });
  });

  async function createNewSession() {
    if (!directory) return;
    try {
      const res = await client.session.create({});
      if (res.data) {
        setSessions((prev) => [res.data as Session, ...prev]);
        navigate(`/${dirSlug()}/session/${res.data.id}`);
      }
    } catch (e) {
      console.error("Failed to create session:", e);
    }
  }

  async function archiveSession(session: Session) {
    const currentSessions = projectSessions();
    const index = currentSessions.findIndex((s) => s.id === session.id);
    const nextSession =
      currentSessions[index + 1] ?? currentSessions[index - 1];

    try {
      await client.session.update({
        sessionID: session.id,
        time: { archived: Date.now() },
      });
      setSessions((prev) => prev.filter((s) => s.id !== session.id));

      if (isActive(session.id)) {
        if (nextSession) {
          navigate(`/${dirSlug()}/session/${nextSession.id}`);
        } else {
          navigate(`/${dirSlug()}/session`);
        }
      }
    } catch (e) {
      console.error("Failed to archive session:", e);
    }
  }

  async function restoreSession(session: Session) {
    try {
      await client.session.update({
        sessionID: session.id,
        time: { archived: undefined },
      });
      // Session restoration will be reflected via SSE events updating sync context
    } catch (e) {
      console.error("Failed to restore session:", e);
    }
  }

  async function renameSession(session: Session, title: string) {
    const trimmed = title.trim();
    if (!trimmed || trimmed === session.title) return;
    // Optimistic update
    setSessions((prev) =>
      prev.map((s) => (s.id === session.id ? { ...s, title: trimmed } : s)),
    );
    try {
      await client.session.update({ sessionID: session.id, title: trimmed });
    } catch (e) {
      console.error("Failed to rename session:", e);
      // Revert on failure
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id ? { ...s, title: session.title } : s,
        ),
      );
    }
  }

  // deleteSession is handled directly by SessionHeader; sidebar updates reactively
  // via SSE (session.deleted event triggers loadSessions)

  function isActive(sessionId: string) {
    return location.pathname.includes(sessionId);
  }

  function isSettingsActive() {
    return location.pathname.endsWith("/settings");
  }

  function navigateToProject(worktree: string) {
    // Use router navigation - DirectoryLayout uses keyed For
    // to force full remount when directory changes
    // Also ensure sidebar is expanded when selecting a project
    setSidebarExpanded(true);
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_KEY, "true");
    } catch (e) {
      console.error("Failed to save sidebar state:", e);
    }
    navigate(`/${base64Encode(worktree)}/session`);
  }

  function navigateToHome() {
    navigate("/");
  }

  return (
    <div
      class="flex h-screen"
      style={{ background: "var(--background-stronger)" }}
    >
      {/* Project Dialog */}
      <ProjectDialog
        open={projectDialogOpen()}
        onClose={() => setProjectDialogOpen(false)}
        onSelect={handleProjectSelect}
      />

      {/* Left: Project Icons Strip (always visible) */}
      <div
        class="w-16 shrink-0 flex flex-col items-center"
        style={{
          background: "var(--background-base)",
          "border-right": "1px solid var(--border-base)",
        }}
      >
        {/* OpenCode Logo - navigates to home */}
        <button
          onClick={navigateToHome}
          class="w-full flex items-center justify-center py-3 transition-opacity hover:opacity-80"
          style={{ "border-bottom": "1px solid var(--border-base)" }}
          title="Home"
        >
          <OpenCodeLogo class="w-8 h-10 rounded" />
        </button>

        {/* Project icons */}
        <div class="flex-1 flex flex-col items-center gap-2 overflow-y-auto w-full px-2 py-3">
          <For each={projects()}>
            {(project) => (
              <div
                onClick={() => navigateToProject(project.worktree)}
                class="group relative cursor-pointer"
                title={project.name || getFilename(project.worktree)}
              >
                <ProjectAvatar
                  project={project}
                  size="large"
                  selected={project.worktree === directory}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeProject(project.worktree);
                    if (
                      project.worktree === directory &&
                      projects().length > 1
                    ) {
                      const next = projects().find(
                        (p) => p.worktree !== project.worktree,
                      );
                      if (next) navigateToProject(next.worktree);
                    }
                  }}
                  class="absolute -top-1 -right-1 w-4 h-4 rounded-full hidden group-hover:flex items-center justify-center"
                  style={{
                    background: "var(--surface-strong)",
                    color: "var(--text-base)",
                  }}
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            )}
          </For>

          {/* Add project button */}
          <button
            onClick={() => setProjectDialogOpen(true)}
            class="w-10 h-10 rounded-lg flex items-center justify-center transition-colors"
            style={{
              border: "2px dashed var(--border-base)",
              color: "var(--icon-weak)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.borderColor = "var(--border-strong)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = "var(--border-base)")
            }
            title="Open Project"
          >
            <Plus class="w-5 h-5" />
          </button>
        </div>

        {/* Bottom icons */}
        <div
          class="flex flex-col items-center gap-2 py-3"
          style={{ "border-top": "1px solid var(--border-base)" }}
        >
          <button
            onClick={() => terminal.toggle(directory)}
            class="w-10 h-10 rounded-lg flex items-center justify-center transition-colors"
            style={{
              color: terminal.opened()
                ? "var(--text-interactive-base)"
                : "var(--icon-base)",
              background: terminal.opened()
                ? "var(--surface-inset)"
                : "transparent",
            }}
            title="Terminal (Ctrl+`)"
          >
            <SquareTerminal class="w-5 h-5" />
          </button>
          <button
            onClick={() => navigate(`/${dirSlug()}/settings`)}
            class="w-10 h-10 rounded-lg flex items-center justify-center transition-colors"
            style={{
              color: isSettingsActive()
                ? "var(--text-interactive-base)"
                : "var(--icon-base)",
              background: isSettingsActive()
                ? "var(--surface-inset)"
                : "transparent",
            }}
            title="Settings"
          >
            <Settings class="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Sessions Panel (collapsible) */}
      <div
        class="shrink-0 flex flex-col transition-all duration-200"
        style={{
          width: showSidebar() ? "256px" : "0px",
          overflow: "hidden",
          background: "var(--background-stronger)",
          "border-right": showSidebar()
            ? "1px solid var(--border-base)"
            : "none",
        }}
      >
        <div class="w-64 h-full flex flex-col">
          {/* Project Header with collapse toggle */}
          <div
            class="p-3 flex items-start gap-2"
            style={{ "border-bottom": "1px solid var(--border-base)" }}
          >
            <Show when={currentProject()}>
              {(project) => <ProjectAvatar project={project()} size="small" />}
            </Show>
            <div class="min-w-0 flex-1">
              <div
                class="text-sm font-medium truncate"
                style={{ color: "var(--text-strong)" }}
              >
                {projectName()}
              </div>
              <div
                class="text-xs truncate"
                style={{ color: "var(--text-weak)" }}
              >
                {directory?.replace(/^\/home\/[^/]+/, "~") || ""}
              </div>
            </div>
            <button
              onClick={toggleSidebar}
              class="p-1 rounded transition-colors shrink-0"
              style={{ color: "var(--icon-base)" }}
              title="Collapse Sidebar (Ctrl+B)"
            >
              <ChevronLeft class="w-4 h-4" />
            </button>
          </div>

          {/* New Session Button */}
          <div class="px-3 py-2">
            <Button
              onClick={createNewSession}
              variant="ghost"
              class="w-full justify-start"
              size="sm"
            >
              <Plus class="w-4 h-4" />
              <span>New Session</span>
            </Button>
          </div>

          {/* Sessions List */}
          <div class="flex-1 overflow-y-auto px-2">
            <Show when={loading()}>
              <div
                class="flex flex-col items-center justify-center py-8 gap-2"
                style={{ color: "var(--text-weak)" }}
              >
                <Spinner
                  class="w-5 h-5"
                  style={{ color: "var(--text-interactive-base)" }}
                />
                <span class="text-sm">Loading sessions...</span>
              </div>
            </Show>

            <Show when={!loading()}>
              <Show
                when={
                  projectSessions().length > 0 || archivedSessions().length > 0
                }
                fallback={
                  <div
                    class="py-6 text-center"
                    style={{ color: "var(--text-weak)" }}
                  >
                    <p class="text-sm">No sessions yet</p>
                    <p class="text-xs mt-1">Click "New Session" to start</p>
                  </div>
                }
              >
                {/* Active Sessions — grouped by date */}
                <For each={groupedSessions()}>
                  {(group) => (
                    <div class="pb-2">
                      <h3
                        class="px-2.5 pt-2 pb-1 font-semibold uppercase text-[0.65rem] tracking-[0.06em]"
                        style={{ color: "var(--text-weak)" }}
                      >
                        {group.label}
                      </h3>
                      <div class="space-y-0.5">
                        <For each={group.sessions}>
                          {(session) => (
                            <div class="group relative">
                              <Show
                                when={renamingId() === session.id}
                                fallback={
                                  <A
                                    href={`/${dirSlug()}/session/${session.id}`}
                                    class="flex items-center gap-2 px-2.5 py-2 pr-16 rounded-md text-sm transition-colors"
                                    style={{
                                      color: isActive(session.id)
                                        ? "var(--text-interactive-base)"
                                        : "var(--text-base)",
                                      background: isActive(session.id)
                                        ? "var(--surface-inset)"
                                        : "transparent",
                                    }}
                                    onMouseEnter={(e) => {
                                      if (!isActive(session.id))
                                        e.currentTarget.style.background =
                                          "var(--surface-inset)";
                                    }}
                                    onMouseLeave={(e) => {
                                      if (!isActive(session.id))
                                        e.currentTarget.style.background =
                                          "transparent";
                                    }}
                                  >
                                    <span
                                      class="shrink-0"
                                      style={{ color: "var(--icon-weak)" }}
                                    >
                                      <Show
                                        when={!!events.pendingQuestions[session.id]}
                                        fallback={
                                          <Show
                                            when={
                                              events.status[session.id]?.type === "busy" ||
                                              events.status[session.id]?.type === "retry"
                                            }
                                            fallback={<MessageCircle class="w-4 h-4" />}
                                          >
                                            <Loader2 class="w-4 h-4 animate-spin" />
                                          </Show>
                                        }
                                      >
                                        <CircleHelp class="w-4 h-4" style={{ color: "var(--icon-warning-base)" }} />
                                      </Show>
                                    </span>
                                    <span class="truncate">
                                      {session.title || "Untitled"}
                                    </span>
                                  </A>
                                }
                              >
                                <div
                                  class="flex items-center gap-2 px-2.5 py-1.5 rounded-md"
                                  style={{ background: "var(--surface-inset)" }}
                                >
                                  <span
                                    class="shrink-0"
                                    style={{ color: "var(--icon-weak)" }}
                                  >
                                    <Show
                                      when={!!events.pendingQuestions[session.id]}
                                      fallback={
                                        <Show
                                          when={
                                            events.status[session.id]?.type === "busy" ||
                                            events.status[session.id]?.type === "retry"
                                          }
                                          fallback={<MessageCircle class="w-4 h-4" />}
                                        >
                                          <Loader2 class="w-4 h-4 animate-spin" />
                                        </Show>
                                      }
                                    >
                                      <CircleHelp class="w-4 h-4" style={{ color: "var(--icon-warning-base)" }} />
                                    </Show>
                                  </span>
                                  {/* dataset cancel flag for Escape key; ref selects all text on mount */}
                                  <input
                                    class="flex-1 min-w-0 text-sm bg-transparent outline-none"
                                    style={{ color: "var(--text-base)" }}
                                    value={session.title || ""}
                                    autofocus
                                    ref={(el) => setTimeout(() => { el.focus(); el.select() }, 0)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        renameSession(session, e.currentTarget.value);
                                        setRenamingId(null);
                                      } else if (e.key === "Escape") {
                                        e.currentTarget.dataset.cancelRename = "true";
                                        setRenamingId(null);
                                      }
                                    }}
                                    onBlur={(e) => {
                                      if (e.currentTarget.dataset.cancelRename === "true") return;
                                      renameSession(session, e.currentTarget.value);
                                      setRenamingId(null);
                                    }}
                                  />
                                </div>
                              </Show>
                              <Show when={renamingId() !== session.id}>
                                <div class="absolute right-1.5 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5">
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setRenamingId(session.id);
                                    }}
                                    class="p-1 rounded transition-colors"
                                    style={{ color: "var(--icon-weak)" }}
                                    onMouseEnter={(e) =>
                                      (e.currentTarget.style.color =
                                        "var(--icon-base)")
                                    }
                                    onMouseLeave={(e) =>
                                      (e.currentTarget.style.color =
                                        "var(--icon-weak)")
                                    }
                                    title="Rename session"
                                    aria-label="Rename session"
                                  >
                                    <Pencil class="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      archiveSession(session);
                                    }}
                                    class="p-1 rounded transition-colors"
                                    style={{ color: "var(--icon-weak)" }}
                                    onMouseEnter={(e) =>
                                      (e.currentTarget.style.color =
                                        "var(--icon-base)")
                                    }
                                    onMouseLeave={(e) =>
                                      (e.currentTarget.style.color =
                                        "var(--icon-weak)")
                                    }
                                    title="Archive session"
                                    aria-label="Archive session"
                                  >
                                    <Archive class="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>

                {/* Archived Sessions Toggle */}
                <Show when={archivedSessions().length > 0}>
                  <div class="pt-2 pb-1">
                    <button
                      onClick={toggleShowArchived}
                      class="flex items-center gap-2 px-2.5 py-1.5 w-full text-xs rounded-md transition-colors"
                      style={{ color: "var(--text-weak)" }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background =
                          "var(--surface-inset)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      <Archive class="w-3.5 h-3.5" />
                      <span>
                        {showArchived() ? "Hide" : "Show"} archived (
                        {archivedSessions().length})
                      </span>
                    </button>
                  </div>

                  {/* Archived Sessions List */}
                  <Show when={showArchived()}>
                    <div class="space-y-0.5 pb-2">
                      <For each={archivedSessions()}>
                        {(session) => (
                          <div class="group relative">
                            <A
                              href={`/${dirSlug()}/session/${session.id}`}
                              class="flex items-center gap-2 px-2.5 py-2 pr-8 rounded-md text-sm transition-colors"
                              style={{
                                color: isActive(session.id)
                                  ? "var(--text-interactive-base)"
                                  : "var(--text-weak)",
                                background: isActive(session.id)
                                  ? "var(--surface-inset)"
                                  : "transparent",
                                opacity: isActive(session.id) ? 1 : 0.7,
                              }}
                              onMouseEnter={(e) => {
                                if (!isActive(session.id)) {
                                  e.currentTarget.style.background =
                                    "var(--surface-inset)";
                                  e.currentTarget.style.opacity = "1";
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!isActive(session.id)) {
                                  e.currentTarget.style.background =
                                    "transparent";
                                  e.currentTarget.style.opacity = "0.7";
                                }
                              }}
                            >
                              <span
                                class="shrink-0"
                                style={{ color: "var(--icon-weak)" }}
                              >
                                <Archive class="w-4 h-4" />
                              </span>
                              <span class="truncate">
                                {session.title || "Untitled"}
                              </span>
                            </A>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                restoreSession(session);
                              }}
                              class="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hidden group-hover:flex items-center justify-center transition-colors"
                              style={{ color: "var(--icon-weak)" }}
                              onMouseEnter={(e) =>
                                (e.currentTarget.style.color =
                                  "var(--icon-base)")
                              }
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.color =
                                  "var(--icon-weak)")
                              }
                              title="Restore session"
                              aria-label="Restore session"
                            >
                              <ArchiveRestore class="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>

          {/* Provider Status */}
          <div
            class="p-3"
            style={{ "border-top": "1px solid var(--border-base)" }}
          >
            <div
              class="flex items-center gap-2 text-xs"
              style={{ color: "var(--text-weak)" }}
            >
              <Show
                when={providers.connected.length > 0}
                fallback={
                  <>
                    <span class="w-1.5 h-1.5 bg-yellow-500 rounded-full" />
                    <span>No providers</span>
                  </>
                }
              >
                <span class="w-1.5 h-1.5 bg-green-500 rounded-full" />
                <span>{providers.connected.length} provider(s)</span>
              </Show>
            </div>
          </div>
        </div>
      </div>

      {/* Expand button when manually collapsed (not on settings or small screens) */}
      <Show
        when={
          !sidebarExpanded() &&
          !location.pathname.endsWith("/settings") &&
          windowWidth() >= COLLAPSE_BREAKPOINT
        }
      >
        <button
          onClick={toggleSidebar}
          class="absolute left-16 top-1/2 -translate-y-1/2 z-10 p-1 rounded-r-md transition-colors"
          style={{
            background: "var(--background-base)",
            border: "1px solid var(--border-base)",
            "border-left": "none",
            color: "var(--icon-base)",
          }}
          title="Expand Sidebar (Ctrl+B)"
        >
          <ChevronRight class="w-4 h-4" />
        </button>
      </Show>

      {/* Main Content + Terminal */}
      <div class="flex-1 flex flex-col overflow-hidden">
        <main
          class="flex-1 flex flex-col overflow-hidden"
          style={{ background: "var(--background-stronger)" }}
        >
          {props.children}
        </main>

        {/* Terminal Panel */}
        <Show
          when={
            terminal.sessions().length > 0 ||
            terminal.error() ||
            terminal.creating()
          }
        >
          <div
            class="flex flex-col relative"
            style={{
              height:
                terminal.opened() || terminal.error() || terminal.creating()
                  ? `${terminal.height()}px`
                  : "0px",
              overflow: "hidden",
              "border-top":
                terminal.opened() || terminal.error() || terminal.creating()
                  ? "1px solid var(--border-base)"
                  : "none",
              background: "var(--background-base)",
              transition: terminal.opened() ? "none" : "height 0.15s ease-out",
            }}
          >
            {/* Resize handle */}
            <Show when={terminal.opened()}>
              <div
                class="absolute top-0 left-0 right-0 h-1 cursor-ns-resize z-10 group"
                style={{ background: "transparent" }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startHeight = terminal.height();

                  function onMouseMove(e: MouseEvent) {
                    const delta = startY - e.clientY;
                    const newHeight = Math.max(
                      100,
                      Math.min(600, startHeight + delta),
                    );
                    terminal.setHeight(newHeight);
                  }

                  function onMouseUp() {
                    document.removeEventListener("mousemove", onMouseMove);
                    document.removeEventListener("mouseup", onMouseUp);
                  }

                  document.addEventListener("mousemove", onMouseMove);
                  document.addEventListener("mouseup", onMouseUp);
                }}
              >
                <div
                  class="mx-auto mt-0.5 w-12 h-1 rounded-full transition-colors group-hover:bg-gray-400"
                  style={{ background: "var(--border-base)" }}
                />
              </div>
            </Show>
            {/* Error display */}
            <Show when={terminal.error()}>
              <div
                class="p-4 flex items-start gap-3"
                style={{
                  background: "var(--surface-critical-subtle)",
                  color: "var(--text-critical-base)",
                }}
              >
                <AlertTriangle class="w-5 h-5 shrink-0 mt-0.5" />
                <div class="flex-1">
                  <div class="font-medium text-sm">Terminal Error</div>
                  <div
                    class="text-sm mt-1"
                    style={{ color: "var(--text-base)" }}
                  >
                    {terminal.error()}
                  </div>
                  <div
                    class="text-xs mt-2"
                    style={{ color: "var(--text-weak)" }}
                  >
                    This may happen if the PTY system is not available in this
                    environment. Check the server logs for more details.
                  </div>
                </div>
                <button
                  onClick={() => terminal.clearError()}
                  class="p-1 rounded hover:bg-white/10"
                  style={{ color: "var(--icon-base)" }}
                >
                  <X class="w-4 h-4" />
                </button>
              </div>
            </Show>

            {/* Creating indicator */}
            <Show when={terminal.creating() && !terminal.error()}>
              <div
                class="p-4 flex items-center gap-3"
                style={{ color: "var(--text-weak)" }}
              >
                <Spinner class="w-5 h-5" />
                <span class="text-sm">Creating terminal session...</span>
              </div>
            </Show>

            {/* Terminal tabs and content */}
            <Show when={terminal.sessions().length > 0 && !terminal.error()}>
              <div
                class="flex items-center justify-between px-3 py-1.5 shrink-0"
                style={{ "border-bottom": "1px solid var(--border-base)" }}
              >
                <div class="flex items-center gap-2">
                  <For each={terminal.sessions()}>
                    {(session) => (
                      <div
                        onClick={() => terminal.setActive(session.id)}
                        class="flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors cursor-pointer"
                        style={{
                          background:
                            terminal.active() === session.id
                              ? "var(--surface-inset)"
                              : "transparent",
                          color:
                            terminal.active() === session.id
                              ? "var(--text-strong)"
                              : "var(--text-weak)",
                        }}
                      >
                        <SquareTerminal class="w-3 h-3" />
                        {session.title}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            terminal.close(session.id);
                          }}
                          class="ml-1 p-0.5 rounded hover:bg-white/10"
                          style={{ color: "var(--icon-weak)" }}
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </For>
                  <button
                    onClick={() => terminal.create(directory)}
                    class="p-1 rounded transition-colors"
                    style={{ color: "var(--icon-weak)" }}
                    title="New Terminal"
                  >
                    <Plus class="w-4 h-4" />
                  </button>
                </div>

                <button
                  onClick={() => terminal.toggle(directory)}
                  class="p-1 rounded transition-colors"
                  style={{ color: "var(--icon-weak)" }}
                  title="Close Terminal"
                >
                  <ChevronDown class="w-4 h-4" />
                </button>
              </div>

              <div class="flex-1 overflow-hidden">
                <For each={terminal.sessions()}>
                  {(session) => (
                    <div
                      class="size-full"
                      style={{
                        display:
                          terminal.active() === session.id ? "block" : "none",
                      }}
                    >
                      <Terminal ptyId={session.id} />
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
