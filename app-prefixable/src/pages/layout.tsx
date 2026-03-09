import {
  type ParentProps,
  createSignal,
  For,
  Show,
  on,
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
import { useLayout, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "../context/layout";
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
  ShieldAlert,
  MoreHorizontal,
  Trash2,
  Sparkles,
  Pin,
  PinOff,
  Search,
  GripVertical,
} from "lucide-solid";
import { useSync } from "../context/sync";
import { usePermission } from "../context/permission";
import { useGlobalEvents } from "../context/global-events";
import { useSavedPrompts } from "../context/saved-prompts";
import { useCommand, isDialogOpen } from "../context/command";
import { ResizeHandle } from "../components/resize-handle";
import { ConfirmDialog } from "../components/confirm-dialog";
import { ShortcutReference } from "../components/shortcut-reference";
import { CommandPalette } from "../components/command-palette";
import { HintMode } from "../components/hint-mode";
import { suggestSessionTitle } from "../utils/ai-rename";
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  createSortable,
} from "@thisbeyond/solid-dnd";
import type { DragEvent as SolidDragEvent } from "@thisbeyond/solid-dnd";
import { ConstrainDragXAxis } from "../utils/solid-dnd";

import { readNotifyMap, cleanupNotifyState, NOTIFY_STORAGE_KEY } from "../utils/notify";
import { readSoundSettings, playSound, primeAudioContext, SOUND_STORAGE_KEY } from "../utils/sound";
import { dispatchStorageEvent } from "../utils/storage";

// Storage keys
const PROJECTS_STORAGE_KEY = "opencode.projects";
const SIDEBAR_EXPANDED_KEY = "opencode.sidebarExpanded";
const SHOW_ARCHIVED_KEY = "opencode.showArchived";
const PINNED_SESSIONS_PREFIX = "opencode.pinnedSessions.";
const MAX_PINNED = 10;

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

function PromptDropdown(props: {
  prompts: { id: string; title: string; text: string }[];
  activeIndex: number;
  onSelect: (text: string) => void;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  let ref: HTMLDivElement | undefined;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      props.onIndexChange(Math.min(props.activeIndex + 1, props.prompts.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      props.onIndexChange(Math.max(props.activeIndex - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const selected = props.prompts[props.activeIndex];
      if (selected) props.onSelect(selected.text);
    }
  }

  // Scroll the active option into view when navigating with keyboard
  createEffect(() => {
    const _index = props.activeIndex;
    const active = ref?.querySelector('[aria-selected="true"]') as HTMLElement | null;
    if (active) active.scrollIntoView({ block: "nearest" });
  });

  onMount(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref && !ref.contains(e.target as Node)) {
        props.onClose();
      }
    }
    document.addEventListener("click", handleClickOutside);
    onCleanup(() => document.removeEventListener("click", handleClickOutside));
    ref?.focus();
  });

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      class="absolute left-0 right-0 mx-3 mt-1 z-50 rounded-lg border shadow-lg overflow-hidden"
      style={{
        background: "var(--background-stronger)",
        "border-color": "var(--border-base)",
      }}
      role="listbox"
      aria-label="Saved prompts"
    >
      <div class="max-h-48 overflow-y-auto py-1">
        <For each={props.prompts}>
          {(prompt, i) => (
            <button
              class="w-full text-left px-3 py-2 text-sm transition-colors truncate"
              style={{
                background: i() === props.activeIndex ? "var(--surface-inset)" : "transparent",
                color: i() === props.activeIndex ? "var(--text-interactive-base)" : "var(--text-base)",
              }}
              role="option"
              aria-selected={i() === props.activeIndex}
              onMouseEnter={() => props.onIndexChange(i())}
              onClick={() => props.onSelect(prompt.text)}
            >
              {prompt.title}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function SortablePinnedSession(props: {
  session: Session;
  render: (session: Session) => import("solid-js").JSX.Element;
}) {
  const sortable = createSortable(props.session.id);
  return (
    <div use:sortable={sortable} class="group/drag relative" classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <button
        type="button"
        aria-label="Reorder pinned session"
        class="absolute left-0 top-0 bottom-0 flex items-center z-10 cursor-grab active:cursor-grabbing opacity-0 group-hover/drag:opacity-100 transition-opacity border-0 bg-transparent p-0"
        style={{
          width: "18px",
          "padding-left": "2px",
        }}
        {...sortable.dragActivators}
      >
        <GripVertical class="w-3 h-3" style={{ color: "var(--icon-weak)" }} />
      </button>
      {props.render(props.session)}
    </div>
  );
}

export function Layout(props: ParentProps) {
  const { client, directory } = useSDK();
  const { basePath } = useBasePath();
  const events = useEvents();
  const providers = useProviders();
  const terminal = useTerminal();
  const layout = useLayout();
  const sync = useSync();
  const permission = usePermission();
  const globalEvents = useGlobalEvents();
  const savedPrompts = useSavedPrompts();
  const command = useCommand();
  const location = useLocation();
  const navigate = useNavigate();

  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [sidebarExpanded, setSidebarExpanded] = createSignal(true);
  const [showArchived, setShowArchived] = createSignal(false);
  const [projectDialogOpen, setProjectDialogOpen] = createSignal(false);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [editTitle, setEditTitle] = createSignal("");
  const [windowWidth, setWindowWidth] = createSignal(
    typeof window !== "undefined" ? window.innerWidth : 1200,
  );
  const [sidebarDragging, setSidebarDragging] = createSignal(false);
  const [menuOpenId, setMenuOpenId] = createSignal<string | null>(null);
  const [aiRenamingId, setAiRenamingId] = createSignal<string | null>(null);
  const [renameError, setRenameError] = createSignal<{ id: string; msg: string } | null>(null);
  const renameErrorTimer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
  const [confirmDeleteSession, setConfirmDeleteSession] = createSignal<Session | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const [promptDropdownOpen, setPromptDropdownOpen] = createSignal(false);
  const [promptDropdownIndex, setPromptDropdownIndex] = createSignal(0);
  const [confirmArchiveSession, setConfirmArchiveSession] = createSignal<Session | null>(null);
  const [pinnedIds, setPinnedIds] = createSignal<string[]>([]);

  // Search state
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<Session[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchFocusIdx, setSearchFocusIdx] = createSignal(-1);
  const searchTimer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
  let searchInputRef: HTMLInputElement | undefined;

  // Keyboard navigation state for session list
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const [menuFocusIndex, setMenuFocusIndex] = createSignal(-1);

  // Responsive breakpoint - collapse sidebar below 900px
  const COLLAPSE_BREAKPOINT = 900;

  // Effective sidebar state: hidden on settings page or small screens
  const showSidebar = createMemo(() => {
    if (location.pathname.endsWith("/settings")) return false;
    if (windowWidth() < COLLAPSE_BREAKPOINT) return false;
    return sidebarExpanded();
  });

  // Reset dragging state when sidebar hides (unmount mid-drag safety)
  createEffect(() => {
    if (!showSidebar()) setSidebarDragging(false);
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

    // Load pinned sessions for current directory
    if (directory) {
      try {
        const stored = localStorage.getItem(PINNED_SESSIONS_PREFIX + directory);
        if (stored) {
          const parsed = JSON.parse(stored) as string[];
          if (Array.isArray(parsed)) setPinnedIds(parsed.slice(0, MAX_PINNED));
        }
      } catch (e) {
        console.error("Failed to load pinned sessions state:", e);
      }
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
    const value = JSON.stringify(list);
    try {
      localStorage.setItem(PROJECTS_STORAGE_KEY, value);
    } catch (e) {
      console.error("Failed to save projects:", e);
      return;
    }
    dispatchStorageEvent(PROJECTS_STORAGE_KEY, value);
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

  function savePinnedIds(ids: string[]) {
    setPinnedIds(ids);
    if (!directory) return;
    try {
      localStorage.setItem(PINNED_SESSIONS_PREFIX + directory, JSON.stringify(ids));
    } catch (e) {
      console.error("Failed to save pinned session IDs:", e);
    }
  }

  function pinSession(id: string) {
    if (pinnedIds().includes(id)) return;
    if (pinnedIds().length >= MAX_PINNED) return;
    savePinnedIds([...pinnedIds(), id]);
  }

  function unpinSession(id: string) {
    if (!pinnedIds().includes(id)) return;
    savePinnedIds(pinnedIds().filter((pid) => pid !== id));
  }

  const [pinDragId, setPinDragId] = createSignal<string | null>(null);

  function handlePinDragStart(event: SolidDragEvent) {
    setPinDragId(event.draggable ? String(event.draggable.id) : null);
  }

  function handlePinDragEnd(event: SolidDragEvent) {
    setPinDragId(null);
    const { draggable, droppable } = event;
    if (!draggable || !droppable) return;
    const from = draggable.id as string;
    const to = droppable.id as string;
    if (from === to) return;
    const ids = [...pinnedIds()];
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(to);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, from);
    savePinnedIds(ids);
  }

  function renderSessionItem(session: Session, pinned: boolean) {
    const showPinItem = () => pinned || pinnedIds().length < MAX_PINNED;
    const idx = (n: number) => showPinItem() ? n : n - 1;
    const DefaultIcon = pinned ? Pin : MessageCircle;

    const statusIcon = () => (
      <Show
        when={aiRenamingId() === session.id}
        fallback={
          <Show
            when={permission.pendingForSession(session.id).length > 0}
            fallback={
              <Show
                when={!!events.pendingQuestions[session.id]}
                fallback={
                  <Show
                    when={
                      events.status[session.id]?.type === "busy" ||
                      events.status[session.id]?.type === "retry"
                    }
                    fallback={<DefaultIcon class="w-4 h-4" />}
                  >
                    <Loader2 class="w-4 h-4 animate-spin" />
                  </Show>
                }
              >
                <CircleHelp class="w-4 h-4" style={{ color: "var(--icon-warning-base)" }} />
              </Show>
            }
          >
            <ShieldAlert class="w-4 h-4" style={{ color: "var(--interactive-base)" }} />
          </Show>
        }
      >
        <Spinner class="w-4 h-4" style={{ color: "var(--text-interactive-base)" }} />
      </Show>
    );

    return (
      <div
        id={`session-${session.id}`}
        class="group relative"
        role="option"
        aria-selected={isActive(session.id)}
      >
        <Show
          when={renamingId() === session.id}
          fallback={
            <A
              data-hint-target
              href={`/${dirSlug()}/session/${session.id}`}
              tabIndex={isActive(session.id) ? 0 : -1}
              class="flex items-center gap-2 py-2 rounded-md text-sm transition-colors"
              style={{
                "padding-left": pinned ? "18px" : "10px",
                "padding-right": "10px",
                color: isActive(session.id)
                  ? "var(--text-interactive-base)"
                  : focusedId() === session.id
                    ? "var(--text-interactive-base)"
                    : "var(--text-base)",
                background: isActive(session.id)
                  ? "var(--surface-inset)"
                  : focusedId() === session.id
                    ? "var(--surface-inset)"
                    : "transparent",
                outline: focusedId() === session.id
                  ? "2px solid var(--interactive-base)"
                  : "none",
                "outline-offset": "-2px",
                "border-radius": "0.375rem",
              }}
              onClick={(e) => { setFocusedId(null); e.currentTarget.blur(); }}
              onMouseEnter={(e) => {
                if (!isActive(session.id))
                  e.currentTarget.style.background =
                    "var(--surface-inset)";
              }}
              onMouseLeave={(e) => {
                if (!isActive(session.id) && focusedId() !== session.id)
                  e.currentTarget.style.background =
                    "transparent";
              }}
            >
              <span
                class="shrink-0"
                style={{ color: "var(--icon-weak)" }}
              >
                {statusIcon()}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate">
                  {session.title || "Untitled"}
                </span>
                <Show when={renameError()?.id === session.id}>
                  <span class="block text-xs truncate" style={{ color: "var(--text-critical-base)" }}>
                    {renameError()?.msg}
                  </span>
                </Show>
              </span>
            </A>
          }
        >
          <div
            class="flex items-center gap-2 py-1.5 rounded-md"
            style={{
              background: "var(--surface-inset)",
              "padding-left": pinned ? "18px" : "10px",
              "padding-right": "10px",
            }}
          >
            <span
              class="shrink-0"
              style={{ color: "var(--icon-weak)" }}
            >
              {statusIcon()}
            </span>
            <input
              class="flex-1 min-w-0 text-sm bg-transparent outline-none"
              style={{ color: "var(--text-base)" }}
              value={editTitle()}
              aria-label="Session title"
              ref={(el) => queueMicrotask(() => { if (!el?.isConnected) return; el.focus(); el.select() })}
              onInput={(e) => setEditTitle(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.dataset.committed = "true";
                  renameSession(session, editTitle());
                  setRenamingId(null);
                  queueMicrotask(() => { focusPanel("sidebar"); setFocusedId(session.id); });
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  e.currentTarget.dataset.cancelRename = "true";
                  setRenamingId(null);
                  queueMicrotask(() => { focusPanel("sidebar"); setFocusedId(session.id); });
                }
              }}
              onBlur={(e) => {
                if (e.currentTarget.dataset.cancelRename === "true") return;
                if (e.currentTarget.dataset.committed === "true") return;
                renameSession(session, editTitle());
                setRenamingId(null);
              }}
            />
          </div>
        </Show>
        <Show when={renamingId() !== session.id}>
          <div
            class={`absolute right-0 top-0 bottom-0 items-center rounded-r-md ${menuOpenId() === session.id ? "flex" : focusedId() === session.id ? "hidden" : "hidden group-hover:flex group-focus-within:flex"}`}
            style={{ "pointer-events": "none" }}
          >
             <div
              class="w-6 h-full"
              style={{
                background: `linear-gradient(to right, transparent, var(${isActive(session.id) ? "--surface-inset" : "--background-stronger"}))`,
              }}
            />
            <div
              class="flex items-center pr-1.5 relative"
              style={{
                "pointer-events": "auto",
                background: isActive(session.id) ? "var(--surface-inset)" : "var(--background-stronger)",
              }}
              data-sidebar-menu
            >
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const opening = menuOpenId() !== session.id;
                  setMenuOpenId(opening ? session.id : null);
                  setMenuFocusIndex(opening ? 0 : -1);
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
                title="More options"
                aria-label="More session options"
                aria-haspopup="true"
                aria-expanded={menuOpenId() === session.id}
              >
                <MoreHorizontal class="w-3.5 h-3.5" />
              </button>

              {/* Dropdown menu */}
              <Show when={menuOpenId() === session.id}>
                <div
                  class="absolute right-0 top-full mt-1 w-44 rounded-md shadow-lg z-30 py-1"
                  style={{
                    background: "var(--background-base)",
                    border: "1px solid var(--border-base)",
                  }}
                  role="menu"
                  aria-label="Session options"
                  data-sidebar-menu
                  data-sidebar-menu-dropdown
                >
                  {/* Pin / Unpin */}
                  <Show when={showPinItem()}>
                    <button
                      data-menu-item
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                      style={{
                        color: "var(--text-base)",
                        background: menuFocusIndex() === 0 ? "var(--surface-inset)" : "transparent",
                      }}
                      role="menuitem"
                      onMouseEnter={() => setMenuFocusIndex(0)}
                      onFocus={() => setMenuFocusIndex(0)}
                      onMouseLeave={(e) => { if (menuFocusIndex() !== 0) e.currentTarget.style.background = "transparent" }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuOpenId(null);
                        setMenuFocusIndex(-1);
                        if (pinned) unpinSession(session.id);
                        else pinSession(session.id);
                      }}
                    >
                      <Show when={pinned} fallback={<Pin class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />}>
                        <PinOff class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                      </Show>
                      {pinned ? "Unpin" : "Pin to top"}
                    </button>
                  </Show>

                  {/* Rename */}
                  <button
                    data-menu-item
                    class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                    style={{
                      color: "var(--text-base)",
                      background: menuFocusIndex() === idx(1) ? "var(--surface-inset)" : "transparent",
                    }}
                    role="menuitem"
                    onMouseEnter={() => setMenuFocusIndex(idx(1))}
                    onFocus={() => setMenuFocusIndex(idx(1))}
                    onMouseLeave={(e) => { if (menuFocusIndex() !== idx(1)) e.currentTarget.style.background = "transparent" }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuOpenId(null);
                      setMenuFocusIndex(-1);
                      setEditTitle(session.title || "");
                      setRenamingId(session.id);
                    }}
                  >
                    <Pencil class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                    Rename
                  </button>

                  {/* Rename with AI */}
                  <button
                    data-menu-item
                    class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                    disabled={!!aiRenamingId()}
                    style={{
                      color: "var(--text-base)",
                      opacity: aiRenamingId() ? 0.6 : 1,
                      cursor: aiRenamingId() ? "not-allowed" : "pointer",
                      background: menuFocusIndex() === idx(2) ? "var(--surface-inset)" : "transparent",
                    }}
                    role="menuitem"
                    onMouseEnter={() => setMenuFocusIndex(idx(2))}
                    onFocus={() => setMenuFocusIndex(idx(2))}
                    onMouseLeave={(e) => { if (menuFocusIndex() !== idx(2)) e.currentTarget.style.background = "transparent" }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuOpenId(null);
                      setMenuFocusIndex(-1);
                      handleAiRename(session);
                    }}
                    title={aiRenamingId() ? "AI rename in progress" : "Suggests a title based on conversation"}
                  >
                    <Sparkles class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                    Rename with AI
                  </button>

                  {/* Archive */}
                  <button
                    data-menu-item
                    class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                    style={{
                      color: "var(--text-base)",
                      background: menuFocusIndex() === idx(3) ? "var(--surface-inset)" : "transparent",
                    }}
                    role="menuitem"
                    onMouseEnter={() => setMenuFocusIndex(idx(3))}
                    onFocus={() => setMenuFocusIndex(idx(3))}
                    onMouseLeave={(e) => { if (menuFocusIndex() !== idx(3)) e.currentTarget.style.background = "transparent" }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuOpenId(null);
                      setMenuFocusIndex(-1);
                      archiveAndNavigate(session);
                    }}
                  >
                    <Archive class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                    Archive
                  </button>

                  {/* Separator */}
                  <div class="my-1" role="separator" style={{ "border-top": "1px solid var(--border-base)" }} />

                  {/* Delete */}
                  <button
                    data-menu-item
                    class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                    style={{
                      color: "var(--text-critical-base)",
                      background: menuFocusIndex() === idx(4) ? "var(--surface-inset)" : "transparent",
                    }}
                    role="menuitem"
                    onMouseEnter={() => setMenuFocusIndex(idx(4))}
                    onFocus={() => setMenuFocusIndex(idx(4))}
                    onMouseLeave={(e) => { if (menuFocusIndex() !== idx(4)) e.currentTarget.style.background = "transparent" }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuOpenId(null);
                      setMenuFocusIndex(-1);
                      setDeleteError(null);
                      setConfirmDeleteSession(session);
                    }}
                  >
                    <Trash2 class="w-3.5 h-3.5 shrink-0" />
                    Delete
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    );
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

  const pinnedSessions = createMemo(() => {
    const ids = pinnedIds();
    if (!ids.length) return [];
    const all = projectSessions();
    return ids
      .map((id) => all.find((s) => s.id === id))
      .filter((s): s is Session => !!s);
  });

  const unpinnedSessions = createMemo(() => {
    const pins = new Set(pinnedIds());
    return projectSessions().filter((s) => !pins.has(s.id));
  });

  const groupedSessions = createMemo(() =>
    groupSessionsByDate(unpinnedSessions(), now()),
  );

  // Flat ordered list of session IDs for keyboard navigation (skips group headers)
  const flatSessionIds = createMemo(() => [
    ...pinnedSessions().map((s) => s.id),
    ...groupedSessions().flatMap((g) => g.sessions.map((s) => s.id)),
  ]);

  // When focus enters the sidebar from outside, highlight the currently active session
  function handleSidebarFocus(e: FocusEvent) {
    // Ignore focus moves within the sidebar — only act when focus enters from outside
    const container = e.currentTarget as HTMLElement | null;
    if (container && e.relatedTarget instanceof Node && container.contains(e.relatedTarget)) return;
    // Skip if focusedId is already set (e.g. focusPanel already initialized it)
    if (focusedId()) return;
    // During search, don't initialize focusedId from the grouped session list —
    // those DOM elements are unmounted and aria-activedescendant would dangle.
    if (searchQuery().trim()) return;
    const current = currentSessionId();
    const ids = flatSessionIds();
    if (current && ids.includes(current)) {
      setFocusedId(current);
      scrollSessionIntoView(current);
      return;
    }
    // Default to first session if none active
    if (ids.length) {
      setFocusedId(ids[0]);
      scrollSessionIntoView(ids[0]);
    }
  }

  // Keyboard handler for session list navigation
  function handleSessionListKeyDown(e: KeyboardEvent) {
    // Don't hijack keyboard events from actual input controls inside the sidebar
    // (e.g. rename inputs, dropdowns, etc.) — but allow ArrowDown/Enter through
    // when the search input is focused so the user can move focus to the listbox
    // or activate the focused result. Other nav keys (Home/End/ArrowUp) pass
    // through to the input for native text-editing behaviour.
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    const isSearchInput = target === searchInputRef;
    const isSearchNav = searchQuery().trim() && (isSearchInput
      ? (e.key === "ArrowDown" || e.key === "Enter")
      : (e.key === "ArrowDown" || e.key === "ArrowUp" ||
         e.key === "Home" || e.key === "End" || e.key === "Enter"));
    if ((tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) && !isSearchNav) return;

    // When search is active, provide keyboard navigation for search results
    if (searchQuery().trim()) {
      // Only intercept keys when focus is within the search input or sessions list
      const inSearchArea = isSearchInput || !!target.closest('[aria-label="Sessions"]');
      if (!inSearchArea) return;

      const results = searchResults();
      if (!results.length) return;

      // When the search input has focus, only ArrowDown (move focus to listbox)
      // and Enter (activate focused result) are captured. All other keys pass
      // through so Home/End/ArrowUp work for text editing.
      if (isSearchInput) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSearchFocusIdx(0);
          if (results.length) {
            setFocusedId(results[0].id);
            scrollSessionIntoView(results[0].id);
          }
          // Move focus to the listbox so subsequent arrow keys navigate results
          const listbox = (e.currentTarget as HTMLElement).querySelector('[role="listbox"][aria-label="Sessions"]') as HTMLElement | null;
          if (listbox) listbox.focus();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const idx = searchFocusIdx();
          const i = idx >= 0 && idx < results.length ? idx : 0;
          clearSearch(results[i].id);
          navigate(`/${dirSlug()}/session/${results[i].id}`);
          return;
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        clearSearch();
        searchInputRef?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = searchFocusIdx() < results.length - 1 ? searchFocusIdx() + 1 : 0;
        setSearchFocusIdx(next);
        setFocusedId(results[next].id);
        scrollSessionIntoView(results[next].id);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = searchFocusIdx() > 0 ? searchFocusIdx() - 1 : results.length - 1;
        setSearchFocusIdx(prev);
        setFocusedId(results[prev].id);
        scrollSessionIntoView(results[prev].id);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setSearchFocusIdx(0);
        setFocusedId(results[0].id);
        scrollSessionIntoView(results[0].id);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        const last = results.length - 1;
        setSearchFocusIdx(last);
        setFocusedId(results[last].id);
        scrollSessionIntoView(results[last].id);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const idx = searchFocusIdx();
        const i = idx >= 0 && idx < results.length ? idx : 0;
        clearSearch(results[i].id);
        navigate(`/${dirSlug()}/session/${results[i].id}`);
        return;
      }
      return;
    }

    const ids = flatSessionIds();
    if (!ids.length) return;

    // If context menu is open, delegate to menu keyboard handler
    if (menuOpenId()) {
      handleMenuKeyDown(e);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = focusedId() ? ids.indexOf(focusedId()!) : -1;
      const next = idx < ids.length - 1 ? idx + 1 : 0;
      setFocusedId(ids[next]);
      scrollSessionIntoView(ids[next]);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const idx = focusedId() ? ids.indexOf(focusedId()!) : ids.length;
      const prev = idx > 0 ? idx - 1 : ids.length - 1;
      setFocusedId(ids[prev]);
      scrollSessionIntoView(ids[prev]);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      setFocusedId(ids[0]);
      scrollSessionIntoView(ids[0]);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      setFocusedId(ids[ids.length - 1]);
      scrollSessionIntoView(ids[ids.length - 1]);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const focused = focusedId();
      if (focused) navigate(`/${dirSlug()}/session/${focused}`);
      return;
    }

    // Open context menu: Shift+F10, ContextMenu key, or 'm' key
    if (
      (e.key === "F10" && e.shiftKey) ||
      e.key === "ContextMenu" ||
      (e.key === "m" && !e.ctrlKey && !e.metaKey && !e.altKey)
    ) {
      e.preventDefault();
      const focused = focusedId();
      if (focused) {
        setMenuOpenId(focused);
        setMenuFocusIndex(0);
      }
      return;
    }
  }

  // Keyboard handler for context menu navigation
  function handleMenuKeyDown(e: KeyboardEvent) {
    // Dynamically count menu items from the DOM (active sessions have 4, archived have 2)
    const menu = document.querySelector("[data-sidebar-menu-dropdown]") as HTMLElement | null;
    const menuItems = menu ? menu.querySelectorAll("[data-menu-item]") : [];
    const count = menuItems.length || 1;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpenId(null);
      setMenuFocusIndex(-1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMenuFocusIndex((prev) => (prev < count - 1 ? prev + 1 : 0));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setMenuFocusIndex((prev) => (prev > 0 ? prev - 1 : count - 1));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const item = menuItems[menuFocusIndex()] as HTMLButtonElement | undefined;
      if (item) item.click();
      setMenuFocusIndex(-1);
      return;
    }
  }

  // Scroll a session element into view (accepts optional ScrollIntoViewOptions)
  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : ({ matches: false } as MediaQueryList);

  function scrollSessionIntoView(id: string, options: ScrollIntoViewOptions = { block: "nearest" }) {
    queueMicrotask(() => {
      const el = document.getElementById(`session-${id}`);
      if (!el) return;
      const resolved = options.behavior === "smooth" && prefersReducedMotion.matches
        ? { ...options, behavior: "auto" as const }
        : options;
      el.scrollIntoView(resolved);
    });
  }

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

  function handleSearchInput(query: string) {
    const trimmed = query.trim();
    setSearchQuery(query);
    if (searchTimer.id !== undefined) clearTimeout(searchTimer.id);
    if (!trimmed) {
      clearSearch();
      return;
    }
    // Clear grouped-session focusedId so aria-activedescendant doesn't
    // reference DOM elements that are unmounted during search.
    setFocusedId(null);
    setSearchFocusIdx(-1);
    // Clear previous results immediately to avoid showing stale matches
    // while waiting for the debounced search to fire.
    setSearchResults([]);
    setSearching(true);
    searchTimer.id = setTimeout(() => {
      searchTimer.id = undefined;
      client.session.list({ search: trimmed, directory, roots: true })
        .then((res) => {
          // Only update if query hasn't changed while waiting
          if (searchQuery().trim() !== trimmed) return;
          const data = res.data;
          const valid = Array.isArray(data)
            ? data.filter((s): s is Session => s && typeof s === "object" && typeof s.id === "string")
            : [];
          setSearchResults(valid);
        })
        .catch((err: unknown) => {
          console.error("Session search failed:", err);
          if (searchQuery().trim() === trimmed) setSearchResults([]);
        })
        .finally(() => {
          if (searchQuery().trim() === trimmed) setSearching(false);
        });
    }, 300);
  }

  function clearSearch(nextSessionId?: string) {
    if (searchTimer.id !== undefined) clearTimeout(searchTimer.id);
    searchTimer.id = undefined;
    setSearchQuery("");
    setSearchResults([]);
    setSearching(false);
    setSearchFocusIdx(-1);
    setMenuOpenId(null);
    setMenuFocusIndex(-1);
    // Restore focusedId to the destination session (if navigating) or the
    // current session. If the preferred session isn't in the focusable list
    // (e.g. archived), clear focus rather than pointing at an unrelated session.
    const ids = flatSessionIds();
    const preferred = nextSessionId ?? currentSessionId();
    const target = preferred
      ? (ids.includes(preferred) ? preferred : null)
      : (ids[0] ?? null);
    setFocusedId(target);
    if (target) {
      scrollSessionIntoView(target);
    }
  }

  onCleanup(() => {
    if (searchTimer.id !== undefined) clearTimeout(searchTimer.id);
  });

  // Focus a panel by data-panel attribute. Returns true if focus was set.
  function focusPanel(name: string): boolean {
    const el = document.querySelector(`[data-panel="${name}"]`) as HTMLElement | null;
    if (!el) return false;
    // Clear sidebar keyboard focus when switching to another panel
    if (name !== "sidebar") setFocusedId(null);
    // For chat panel, focus the textarea inside it
    if (name === "chat") {
      const textarea = el.querySelector("textarea") as HTMLTextAreaElement | null;
      if (textarea) { textarea.focus(); return true; }
    }
    // For terminal, find and focus the xterm instance
    if (name === "terminal") {
      const xterm = el.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      if (xterm) { xterm.focus(); return true; }
      el.focus();
      return true;
    }
    // For sidebar, focus the inner listbox so aria-activedescendant applies immediately
    if (name === "sidebar") {
      const listbox = el.querySelector('[role="listbox"][aria-label="Sessions"]') as HTMLElement | null;
      if (listbox) {
        listbox.focus();
        // During search, don't initialize focusedId from the grouped session list —
        // those DOM elements are unmounted and aria-activedescendant would dangle.
        if (!searchQuery().trim()) {
          // Initialize focus state so the active session is highlighted
          const ids = flatSessionIds();
          const current = currentSessionId();
          if (current && ids.includes(current)) {
            setFocusedId(current);
            scrollSessionIntoView(current);
          } else if (ids.length) {
            setFocusedId(ids[0]);
            scrollSessionIntoView(ids[0]);
          }
        }
        return true;
      }
    }
    // For review and other panels, focus the container itself
    el.focus();
    return true;
  }

  // Helper: find the current session ID from the URL
  function currentSessionId(): string | undefined {
    const match = location.pathname.match(/\/session\/([^/]+)/);
    return match ? match[1] : undefined;
  }

  // Navigate to session by index in the sidebar list (0-based)
  function navigateToSessionIndex(index: number) {
    const list = projectSessions();
    if (!list.length) return;
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    navigate(`/${dirSlug()}/session/${list[clamped].id}`);
  }

  // Flag: next session scroll should use smooth behavior (set by Alt+Arrow navigation)
  let smoothNextScroll = false;

  // Navigate to next/previous session with wrap-around
  function navigateSessionDelta(delta: number) {
    const list = projectSessions();
    if (!list.length) return;
    const current = currentSessionId();
    const idx = current ? list.findIndex((s) => s.id === current) : -1;
    smoothNextScroll = true;
    // If no current session, go to first
    if (idx === -1) {
      navigate(`/${dirSlug()}/session/${list[0].id}`);
      return;
    }
    const next = (idx + delta + list.length) % list.length;
    navigate(`/${dirSlug()}/session/${list[next].id}`);
  }

  // Archive the current session (with confirmation if busy)
  function archiveCurrentSession() {
    const id = currentSessionId();
    if (!id) return;
    const list = projectSessions();
    const session = list.find((s) => s.id === id);
    if (!session) return;
    const status = events.status[id]?.type;
    if (status === "busy" || status === "retry") {
      // Show confirmation dialog for busy sessions
      setConfirmArchiveSession(session);
      return;
    }
    archiveAndNavigate(session);
  }

  // Register keyboard shortcuts via CommandProvider
  onMount(() => {
    command.register([
      {
        id: "palette.open",
        title: "Command Palette",
        description: "Open the command palette",
        keybind: "mod+k",
        global: true,
        passive: true,
        onSelect: (e) => {
          // Don't open palette from terminal (Cmd+K is used there for clearing)
          if (e?.target instanceof HTMLElement && e.target.closest(".xterm")) return;
          e?.preventDefault();
          command.setPaletteOpen(!command.paletteOpen());
        },
      },
      {
        id: "session.new",
        title: "New Session",
        description: "Create a new chat session",
        onSelect: createNewSession,
      },
      {
        id: "session.archive",
        title: "Archive Session",
        description: "Archive the current session",
        onSelect: archiveCurrentSession,
      },
      {
        id: "session.next",
        title: "Next Session",
        description: "Switch to the next session in the list",
        keybind: "alt+ArrowDown",
        global: true,
        onSelect: () => navigateSessionDelta(1),
      },
      {
        id: "session.prev",
        title: "Previous Session",
        description: "Switch to the previous session in the list",
        keybind: "alt+ArrowUp",
        global: true,
        onSelect: () => navigateSessionDelta(-1),
      },
      // Alt+1 through Alt+9: jump to session by position
      // Handled via custom keydown listener (not tinykeys) because macOS Option+number
      // produces special characters (e.g. ¡, ™) and tinykeys matches on event.key.
      // Only Alt+1 is visible in the cheat sheet as representative; Alt+2-9 are hidden.
      {
        id: "session.jump.1",
        title: "Jump to Session 1–9",
        description: "Switch to a session by its sidebar position",
        keybindDisplay: "alt+1",
        hidden: false,
        onSelect: () => navigateToSessionIndex(0),
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `session.jump.${i + 2}`,
        title: `Go to Session ${i + 2}`,
        hidden: true,
        onSelect: () => navigateToSessionIndex(i + 1),
      })),
      {
        id: "palette.projects",
        title: "Switch Project",
        description: "Open command palette filtered to projects",
        keybind: "mod+shift+k",
        global: true,
        onSelect: () => {
          command.setPaletteFilter("# ");
          command.setPaletteOpen(true);
        },
      },
      {
        id: "settings.open",
        title: "Open Settings",
        description: "Navigate to settings page",
        onSelect: () => navigate(`/${dirSlug()}/settings`),
      },
      {
        id: "terminal.toggle",
        title: "Toggle Terminal",
        keybind: "mod+shift+x",
        global: true,
        onSelect: () => terminal.toggle(directory),
      },
      {
        id: "sidebar.toggle",
        title: "Toggle Sidebar",
        keybind: "ctrl+b",
        global: true,
        onSelect: toggleSidebar,
      },
      {
        id: "review.toggle",
        title: "Toggle Review Panel",
        keybind: "mod+shift+r",
        global: true,
        onSelect: () => layout.review.toggle(),
      },
      {
        id: "info.toggle",
        title: "Toggle Info Panel",
        keybind: "mod+shift+i",
        global: true,
        onSelect: () => layout.info.toggle(),
      },
      // Panel focus shortcuts — passive so we only preventDefault when we actually handle the key
      {
        id: "focus.sidebar",
        title: "Focus Sidebar",
        description: "Jump to session list sidebar",
        keybind: "ctrl+1",
        global: true,
        passive: true,
        onSelect: (e) => {
          if (isDialogOpen() || command.paletteOpen() || command.shortcutRefOpen()) return;
          if (!showSidebar()) return;
          if (focusPanel("sidebar")) e?.preventDefault();
        },
      },
      {
        id: "focus.chat",
        title: "Focus Chat Input",
        description: "Jump to the chat input area",
        keybind: "ctrl+2",
        global: true,
        passive: true,
        onSelect: (e) => {
          if (isDialogOpen() || command.paletteOpen() || command.shortcutRefOpen()) return;
          if (focusPanel("chat")) e?.preventDefault();
        },
      },
      {
        id: "focus.terminal",
        title: "Focus Terminal",
        description: "Jump to the terminal panel (if open)",
        keybind: "ctrl+3",
        global: true,
        passive: true,
        onSelect: (e) => {
          if (isDialogOpen() || command.paletteOpen() || command.shortcutRefOpen()) return;
          if (terminal.opened() && focusPanel("terminal")) e?.preventDefault();
        },
      },
      {
        id: "focus.review",
        title: "Focus Review Panel",
        description: "Jump to the review panel (if open)",
        keybind: "ctrl+4",
        global: true,
        passive: true,
        onSelect: (e) => {
          if (isDialogOpen() || command.paletteOpen() || command.shortcutRefOpen()) return;
          if (layout.review.opened() && focusPanel("review")) e?.preventDefault();
        },
      },
      {
        id: "focus.escape",
        title: "Return to Chat Input",
        description: "Press Escape to return focus to chat input",
        keybind: "Escape",
        global: true,
        passive: true,
        onSelect: (e) => {
          // Don't steal Escape from open dialogs/modals
          if (isDialogOpen()) return;
          // Don't steal Escape from the shortcut reference overlay
          if (command.shortcutRefOpen()) return;
          // Don't steal Escape from the command palette
          if (command.paletteOpen()) return;
          // Don't steal Escape from handlers that already consumed it
          if (e?.defaultPrevented) return;
          // Don't steal Escape from the terminal (Escape is heavily used there)
          const target = e?.target;
          if (target instanceof HTMLElement && target.closest(".xterm")) return;
          // Only preventDefault when we actually move focus (e.g. skip on settings page)
          if (focusPanel("chat")) e?.preventDefault();
        },
      },
    ]);

    // Alt+1-9: custom keydown handler using event.code so it works on macOS
    // (Option+number produces special characters, making tinykeys's event.key matching fail)
    function handleAltDigit(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const match = e.code.match(/^Digit([1-9])$/);
      if (!match) return;
      // Suppress in text inputs, textareas, contenteditable, and terminal
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
        if (target.closest(".xterm")) return;
      }
      if (isDialogOpen()) return;
      e.preventDefault();
      navigateToSessionIndex(Number(match[1]) - 1);
    }
    window.addEventListener("keydown", handleAltDigit);

    onCleanup(() => {
      window.removeEventListener("keydown", handleAltDigit);
      command.unregister([
        "palette.open",
        "session.new",
        "session.archive",
        "session.next",
        "session.prev",
        ...Array.from({ length: 9 }, (_, i) => `session.jump.${i + 1}`),
        "palette.projects",
        "settings.open",
        "terminal.toggle",
        "sidebar.toggle",
        "review.toggle",
        "info.toggle",
        "focus.sidebar",
        "focus.chat",
        "focus.terminal",
        "focus.review",
        "focus.escape",
      ]);
    });
  });

  onMount(() => {
    loadSessions();

    const unsub = events.subscribe((event) => {
      if (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.deleted"
      ) {
        // Guard against child sessions — sidebar only shows root sessions
        const info = (event.properties as { info: { parentID?: string } }).info;
        if (info?.parentID) return;
        loadSessions();
      }
    });

    onCleanup(unsub);
  });

  // When the active session changes (navigation, new session creation, etc.),
  // scroll it into view in the sidebar. Uses `on()` with defer so it only fires
  // on actual changes, not on initial mount or unrelated re-renders.
  // The smoothNextScroll flag is set by Alt+Arrow navigation for smooth scrolling.
  createEffect(
    on(
      () => currentSessionId(),
      (id) => {
        if (!id) return;
        const options: ScrollIntoViewOptions = smoothNextScroll
          ? { block: "nearest", behavior: "smooth" }
          : { block: "nearest" };
        smoothNextScroll = false;
        scrollSessionIntoView(id, options);
      },
      { defer: true },
    ),
  );

  // --- Global alarm monitoring for ALL sessions with bell enabled ---
  // NOTE: Currently scoped to the active directory's SSE stream (EventProvider connects
  // to `/event?directory=...`). Cross-project alarms would require subscribing to
  // multiple directory streams or an unscoped endpoint — left for a future iteration.
  // Track busy state per session so we detect genuine busy→idle transitions
  const busyTracker: Record<string, boolean> = {};
  // Track which individual permission/question requests already fired an alarm (keyed by request ID)
  const firedPermission = new Set<string>();
  const firedQuestion = new Set<string>();

  // Cached notify map — avoids repeated localStorage reads + JSON.parse on every SSE event.
  // Updated via storage events (including synthetic same-tab events dispatched by writeNotifyMap).
  const [notifyCache, setNotifyCache] = createSignal(readNotifyMap());
  const [soundCache, setSoundCache] = createSignal(readSoundSettings());
  onMount(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === NOTIFY_STORAGE_KEY) setNotifyCache(readNotifyMap());
      if (e.key === SOUND_STORAGE_KEY) setSoundCache(readSoundSettings());
    }
    window.addEventListener("storage", handleStorage);
    onCleanup(() => window.removeEventListener("storage", handleStorage));

    // Prime AudioContext on the first user gesture (when sound is enabled)
    // so notification sounds work reliably after page reload. Listeners stay
    // attached until priming succeeds so that enabling sound later still works.
    function primeOnGesture() {
      if (!soundCache().enabled) return;
      primeAudioContext();
      window.removeEventListener("pointerdown", primeOnGesture);
      window.removeEventListener("keydown", primeOnGesture);
    }
    window.addEventListener("pointerdown", primeOnGesture);
    window.addEventListener("keydown", primeOnGesture);
    onCleanup(() => {
      window.removeEventListener("pointerdown", primeOnGesture);
      window.removeEventListener("keydown", primeOnGesture);
    });
  });

  // Tab title flash (works for any alarming session)
  const titleFlash = { original: "", active: false };

  function flashTitle() {
    if (typeof document === "undefined") return;
    if (titleFlash.active) return;
    titleFlash.original = document.title;
    titleFlash.active = true;
    document.title = `* ${titleFlash.original}`;
  }

  function restoreTitle() {
    if (typeof document === "undefined") return;
    if (!titleFlash.active) return;
    document.title = titleFlash.original;
    titleFlash.active = false;
  }

  onMount(() => {
    titleFlash.original = document.title;
    function handleVisibility() {
      if (!document.hidden) restoreTitle();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", handleVisibility);
      restoreTitle();
    });
  });

  function fireNotification(sessionID: string, title: string, body: string, tag: string) {
    // Flash the tab title when the page is in the background, regardless of Notification permission
    if (typeof document !== "undefined" && document.hidden) flashTitle();

    // Play sound if enabled in settings
    const sound = soundCache();
    if (sound.enabled) playSound(sound.sound);

    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    const n = new Notification(title, {
      body,
      requireInteraction: true,
      tag,
      icon: basePath + "favicon.svg",
    });
    n.onclick = () => {
      window.focus();
      n.close();
      // Navigate to the alarming session using its actual directory
      const sess = sync.session.get(sessionID);
      const slug = sess ? base64Encode(sess.directory) : dirSlug();
      navigate(`/${slug}/session/${sessionID}`);
    };
  }

  function getSessionSummary(sessionID: string): string {
    const msgs = sync.messages(sessionID);
    // Iterate from end to find last assistant message without copying/reversing the array
    let last: (typeof msgs)[number] | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === "assistant") { last = msgs[i]; break; }
    }
    if (!last) return "The agent has finished processing.";
    const text = last.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("")
      .trim();
    if (!text) return "The agent has finished processing.";
    const line = text.split("\n")[0];
    return line.length > 120 ? line.slice(0, 120) + "..." : line;
  }

  // Seed busyTracker reactively from already-known statuses so sessions that were busy
  // before we mounted (or before the status fetch resolved) still trigger notifications
  // when they go idle. Only fill entries that aren't already tracked.
  createEffect(() => {
    for (const [sid, s] of Object.entries(events.status)) {
      if ((s.type === "busy" || s.type === "retry") && !(sid in busyTracker)) {
        busyTracker[sid] = true;
      }
    }
  });

  // Subscribe to session status events for all sessions
  onMount(() => {
    const alarmUnsub = events.subscribe((event) => {
      // Track busy→idle transitions for all sessions
      if (event.type === "session.status") {
        const props = event.properties as { sessionID?: string; status?: { type?: string } } | undefined;
        const sid = props?.sessionID;
        const type = props?.status?.type;
        if (!sid || !type) return;

        if (type === "busy" || type === "retry") {
          busyTracker[sid] = true;
          return;
        }

        if (type === "idle" && busyTracker[sid]) {
          busyTracker[sid] = false;

          // Check if bell is enabled for this session
          if (notifyCache()[sid] !== true) return;

          const sess = sync.session.get(sid);
          const title = sess?.title || "Task complete";
          fireNotification(sid, title, getSessionSummary(sid), `session-complete-${sid}`);
        }
        return;
      }

      // Permission request alarms (keyed by request ID so multiple requests per session each fire)
      if (event.type === "permission.asked") {
        const props = event.properties as { id?: string; sessionID?: string };
        const sid = props.sessionID;
        const rid = props.id;
        if (!sid || !rid) return;
        if (notifyCache()[sid] !== true) return;
        if (firedPermission.has(rid)) return;
        firedPermission.add(rid);

        const sess = sync.session.get(sid);
        const title = sess?.title || "Permission needed";
        fireNotification(sid, title, "A tool needs your approval to continue.", `session-permission-${rid}`);
        return;
      }

      // Clear permission dedup on reply
      if (event.type === "permission.replied") {
        const props = event.properties as { requestID?: string };
        if (props.requestID) firedPermission.delete(props.requestID);
        return;
      }

      // Agent question alarms (keyed by request ID).
      // For child/grandchild sessions, walk the parentID chain to find the root
      // ancestor and check its bell state. Browser notifications always fire when
      // the bell is enabled — the in-app question dock handles inline display
      // separately without suppressing OS-level notifications.
      if (event.type === "question.asked") {
        const props = event.properties as { id?: string; sessionID?: string };
        const sid = props.sessionID;
        const rid = props.id;
        if (!sid || !rid) return;
        if (firedQuestion.has(rid)) return;

        // Walk up the parentID chain to find the root ancestor for bell state.
        // If the session is not yet in the sync store (bootstrap still in
        // progress), fall back to checking the child session's own bell entry
        // so notifications are not silently dropped.
        const sess = sync.session.get(sid);
        const nc = notifyCache();
        let bellSid = sid;
        if (sess) {
          let walk = sess;
          while (walk?.parentID) {
            bellSid = walk.parentID;
            walk = sync.session.get(walk.parentID);
          }
        }
        if (nc[bellSid] !== true) return;
        firedQuestion.add(rid);

        const title = sess?.title || "Question from agent";
        fireNotification(sid, title, "The agent has a question and is waiting for your response.", `session-question-${rid}`);
        return;
      }

      // Clear question dedup on reply/reject
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const props = event.properties as { requestID?: string };
        if (props.requestID) firedQuestion.delete(props.requestID);
      }
    });

    onCleanup(alarmUnsub);
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

  async function createSessionWithPrompt(text: string) {
    if (!directory) return;
    setPromptDropdownOpen(false);
    try {
      const res = await client.session.create({});
      if (res.data) {
        setSessions((prev) => [res.data as Session, ...prev]);
        sessionStorage.setItem(
          `opencode.pendingPrompt.${res.data.id}`,
          JSON.stringify({ text, ts: Date.now() }),
        );
        navigate(`/${dirSlug()}/session/${res.data.id}`);
      }
    } catch (e) {
      console.error("Failed to create session for prompt:", e);
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

  function renameSession(session: Session, title: string) {
    const trimmed = title.trim();
    if (!trimmed || trimmed === session.title) return;
    // Optimistic local update
    setSessions((prev) =>
      prev.map((s) => (s.id === session.id ? { ...s, title: trimmed } : s)),
    );
    client.session.update({ sessionID: session.id, title: trimmed })
      .catch((err: unknown) => {
        console.error("Failed to rename session:", err);
        // Revert on failure
        setSessions((prev) =>
          prev.map((s) =>
            s.id === session.id ? { ...s, title: session.title } : s,
          ),
        );
      });
  }

  function archiveAndNavigate(session: Session) {
    const ids = flatSessionIds();
    const index = ids.indexOf(session.id);
    const neighborId = ids[index + 1] ?? ids[index - 1];

    // Optimistic remove from sidebar list
    setSessions((prev) => prev.filter((s) => s.id !== session.id));

    // Clean up notification toggle state
    cleanupNotifyState(session.id);

    client.session.update({
      sessionID: session.id,
      time: { archived: Date.now() },
    })
      .then(() => {
        // Unpin only after successful archive
        unpinSession(session.id);
        // Navigate only after successful archive
        if (isActive(session.id)) {
          navigate(neighborId ? `/${dirSlug()}/session/${neighborId}` : `/${dirSlug()}/session`);
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to archive session:", err);
        // Revert — add session back at original index
        setSessions((prev) => {
          const copy = [...prev];
          copy.splice(index < 0 ? 0 : index, 0, session);
          return copy;
        });
      });
  }

  function deleteAndNavigate(session: Session) {
    if (deleting()) return;
    setDeleteError(null);
    setDeleting(true);

    // Compute neighbor before delete using visual order (flatSessionIds
    // includes pinned sessions at the top, matching sidebar order).
    // Archived sessions live in archivedSessions(), not flatSessionIds(),
    // so guard against indexOf returning -1.
    const isArchived = !!session.time?.archived;
    const neighborId = (() => {
      if (isArchived) return undefined;
      const ids = flatSessionIds();
      const idx = ids.indexOf(session.id);
      if (idx === -1) return ids[0];
      return ids[idx + 1] ?? ids[idx - 1];
    })();

    client.session.delete({ sessionID: session.id })
      .then(() => {
        setConfirmDeleteSession(null);
        cleanupNotifyState(session.id);
        unpinSession(session.id);
        if (isActive(session.id)) {
          navigate(neighborId ? `/${dirSlug()}/session/${neighborId}` : `/${dirSlug()}/session`);
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to delete session:", err);
        setDeleteError("Failed to delete session. Please try again.");
      })
      .finally(() => setDeleting(false));
  }

  function showRenameError(sessionId: string, message = "Rename failed") {
    if (renameErrorTimer.id !== undefined) clearTimeout(renameErrorTimer.id);
    setRenameError({ id: sessionId, msg: message });
    renameErrorTimer.id = setTimeout(() => {
      setRenameError((prev) => prev?.id === sessionId ? null : prev);
      renameErrorTimer.id = undefined;
    }, 3000);
  }

  function handleAiRename(session: Session) {
    if (aiRenamingId()) return;
    setMenuOpenId(null);
    setAiRenamingId(session.id);

    // Sidebar sessions that aren't currently open may not have messages synced.
    // Fetch from the API when the local cache is empty.
    const cached = sync.messages(session.id);
    const pending = cached.length > 0
      ? Promise.resolve(cached)
      : client.session.messages({ sessionID: session.id }).then((res) => res.data ?? []);

    pending
      .then((msgs) => {
        if (!msgs.length) {
          showRenameError(session.id, "No messages to rename");
          setAiRenamingId(null);
          return;
        }
        return suggestSessionTitle(client, session.id, msgs, providers.selectedModel, providers.selectedAgent);
      })
      .then((suggestion) => {
        if (!suggestion) return;
        setEditTitle(suggestion);
        setRenamingId(session.id);
      })
      .catch((err: unknown) => {
        console.error("AI rename failed:", err);
        showRenameError(session.id);
      })
      .finally(() => setAiRenamingId(null));
  }

  // Outside-click handler for session menus
  createEffect(() => {
    if (!menuOpenId()) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("[data-sidebar-menu]")) {
        setMenuOpenId(null);
        setMenuFocusIndex(-1);
      }
    };
    document.addEventListener("click", handler, { capture: true });
    onCleanup(() => document.removeEventListener("click", handler, { capture: true }));
  });

  onCleanup(() => {
    if (renameErrorTimer.id !== undefined) clearTimeout(renameErrorTimer.id);
  });

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
          class="w-full h-12 flex items-center justify-center transition-opacity hover:opacity-80"
          style={{ "border-bottom": "1px solid var(--border-base)" }}
          title="Home"
        >
          <OpenCodeLogo class="w-7 h-8 rounded" />
        </button>

        {/* Project icons */}
        <div class="flex-1 flex flex-col items-center gap-2 overflow-y-auto w-full px-2 py-3">
          <For each={projects()}>
            {(project) => (
              <div
                data-hint-target
                onClick={() => navigateToProject(project.worktree)}
                class="group relative cursor-pointer"
                title={project.name || getFilename(project.worktree)}
              >
                <ProjectAvatar
                  project={project}
                  size="large"
                  selected={project.worktree === directory}
                  badge={project.worktree !== directory ? globalEvents.badge(project.worktree) : undefined}
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
            data-hint-target
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
            data-hint-target
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
            data-hint-target
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
      <nav
        data-panel="sidebar"
        tabIndex={-1}
        aria-label="Session list"
        onFocus={handleSidebarFocus}
        onBlur={(e) => {
          // Clear focus indicator when focus leaves the sidebar entirely
          // relatedTarget is null when focus moves to browser chrome or is lost
          if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
            setFocusedId(null);
            if (menuOpenId()) {
              setMenuOpenId(null);
              setMenuFocusIndex(-1);
            }
          }
        }}
        onKeyDown={handleSessionListKeyDown}
        class={`shrink-0 flex flex-col focus-visible:outline-2 focus-visible:outline-[var(--interactive-base)] focus-visible:outline-offset-[-2px] ${sidebarDragging() ? "" : "transition-all duration-200"}`}
        style={{
          width: showSidebar() ? `${layout.sidebar.width()}px` : "0px",
          overflow: "hidden",
          background: "var(--background-stronger)",
          "border-right": showSidebar()
            ? "1px solid var(--border-base)"
            : "none",
        }}
      >
        <div class="h-full flex flex-col" style={{ "min-width": `${layout.sidebar.width()}px` }}>
          {/* Project Header with collapse toggle */}
          <div
            class="px-3 h-12 flex items-center gap-2"
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

          {/* New Session Button (split button with saved prompts dropdown) */}
          <div class="px-3 py-2 relative">
            <div class="flex w-full">
              <Button
                data-hint-target
                onClick={createNewSession}
                variant="ghost"
                class={`flex-1 justify-start ${savedPrompts.prompts().length > 0 ? "rounded-r-none" : ""}`}
                size="sm"
              >
                <Plus class="w-4 h-4" />
                <span>New Session</span>
              </Button>
              <Show when={savedPrompts.prompts().length > 0}>
                <button
                  on:click={(e) => {
                    e.stopPropagation();
                    setPromptDropdownIndex(0);
                    setPromptDropdownOpen(!promptDropdownOpen());
                  }}
                  class="inline-flex items-center px-1.5 rounded-r-xl border-2 border-l-0 border-transparent bg-transparent text-[var(--text-base)] hover:bg-[var(--surface-inset)] hover:text-[var(--text-interactive-base)] transition-all"
                  title="New session from saved prompt"
                  aria-haspopup="listbox"
                  aria-expanded={promptDropdownOpen()}
                >
                  <ChevronDown class="w-3.5 h-3.5" />
                </button>
              </Show>
            </div>
            <Show when={promptDropdownOpen()}>
              <PromptDropdown
                prompts={savedPrompts.prompts()}
                activeIndex={promptDropdownIndex()}
                onSelect={(text) => createSessionWithPrompt(text)}
                onClose={() => setPromptDropdownOpen(false)}
                onIndexChange={(i) => setPromptDropdownIndex(i)}
              />
            </Show>
          </div>

          {/* Session Search */}
          <div class="px-3 pb-2">
            <div
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm"
              style={{
                background: "var(--surface-inset)",
                border: "1px solid var(--border-base)",
              }}
            >
              <Show
                when={!searching()}
                fallback={
                  <Loader2 class="w-3.5 h-3.5 shrink-0 animate-spin" style={{ color: "var(--icon-weak)" }} />
                }
              >
                <Search class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
              </Show>
              <input
                ref={el => searchInputRef = el}
                type="text"
                placeholder="Search sessions..."
                aria-label="Search sessions"
                value={searchQuery()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    clearSearch();
                  }
                }}
                class="flex-1 min-w-0 bg-transparent outline-none text-sm"
                style={{ color: "var(--text-base)" }}
              />
              <button
                onClick={() => {
                  clearSearch();
                  searchInputRef?.focus();
                }}
                class="p-0.5 rounded transition-colors shrink-0"
                style={{
                  color: "var(--icon-weak)",
                  opacity: searchQuery().trim() ? 1 : 0,
                  "pointer-events": searchQuery().trim() ? "auto" : "none",
                }}
                disabled={!searchQuery().trim()}
                tabIndex={searchQuery().trim() ? 0 : -1}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--icon-base)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--icon-weak)")}
                aria-label="Clear search"
                title="Clear search"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Sessions List */}
          <div
            class="flex-1 overflow-y-auto px-2"
            role="listbox"
            aria-label="Sessions"
            aria-activedescendant={focusedId() ? `session-${focusedId()}` : undefined}
            tabIndex={0}
          >
            <Show when={loading() && !searchQuery().trim()}>
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

            {/* Search Results */}
            <Show when={searchQuery().trim()}>
              <Show
                when={!searching() && searchResults().length === 0}
                fallback={
                  <div class="space-y-0.5">
                    <For each={searchResults()}>
                      {(session, idx) => {
                        const focused = () => searchFocusIdx() === idx();
                        return (
                          <A
                            href={`/${dirSlug()}/session/${session.id}`}
                            onClick={() => clearSearch(session.id)}
                            role="option"
                            id={`session-${session.id}`}
                            aria-selected={isActive(session.id)}
                            tabIndex={-1}
                            class="flex items-center gap-2 px-2.5 py-2 rounded-md text-sm transition-colors"
                            style={{
                              color: isActive(session.id) || focused()
                                ? "var(--text-interactive-base)"
                                : session.time?.archived
                                  ? "var(--text-weak)"
                                  : "var(--text-base)",
                              background: isActive(session.id) || focused()
                                ? "var(--surface-inset)"
                                : "transparent",
                              opacity: session.time?.archived && !isActive(session.id) ? 0.7 : 1,
                              outline: focused() ? "2px solid var(--border-focus, var(--interactive-base))" : "none",
                              "outline-offset": "-2px",
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive(session.id) && !focused()) e.currentTarget.style.background = "var(--surface-inset)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive(session.id) && !focused()) e.currentTarget.style.background = "transparent";
                            }}
                          >
                            <span class="shrink-0" style={{ color: "var(--icon-weak)" }}>
                              <Show
                                when={session.time?.archived}
                                fallback={<MessageCircle class="w-4 h-4" />}
                              >
                                <Archive class="w-4 h-4" />
                              </Show>
                            </span>
                            <span class="min-w-0 flex-1 truncate">
                              {session.title || "Untitled"}
                            </span>
                          </A>
                        );
                      }}
                    </For>
                  </div>
                }
              >
                <div
                  class="py-6 text-center"
                  style={{ color: "var(--text-weak)" }}
                >
                  <p class="text-sm">No results</p>
                  <p class="text-xs mt-1">Try a different search term</p>
                </div>
              </Show>
            </Show>

            {/* Normal Session List */}
            <Show when={!loading() && !searchQuery().trim()}>
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
                {/* Pinned Sessions (drag-and-drop reorderable) */}
                <Show when={pinnedSessions().length > 0}>
                  <div class="pb-2">
                    <h3
                      role="presentation"
                      class="px-2.5 pt-2 pb-1 font-semibold uppercase text-[0.65rem] tracking-[0.06em]"
                      style={{ color: "var(--text-weak)" }}
                    >
                      Pinned
                    </h3>
                    <DragDropProvider
                      onDragStart={handlePinDragStart}
                      onDragEnd={handlePinDragEnd}
                      collisionDetector={closestCenter}
                    >
                      <DragDropSensors />
                      {/* Constrains drag to vertical axis only (zeroes out X transform) */}
                      <ConstrainDragXAxis />
                      <div class="space-y-0.5">
                        <SortableProvider ids={pinnedSessions().map((s) => s.id)}>
                          <For each={pinnedSessions()}>
                            {(session) => (
                              <SortablePinnedSession
                                session={session}
                                render={(s) => renderSessionItem(s, true)}
                              />
                            )}
                          </For>
                        </SortableProvider>
                      </div>
                      <DragOverlay>
                        <Show when={pinDragId()}>
                          {(id) => {
                            const dragged = () => pinnedSessions().find((s) => s.id === id());
                            return (
                              <div
                                class="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm"
                                style={{
                                  background: "var(--surface-inset)",
                                  color: "var(--text-interactive-base)",
                                  "box-shadow": "0 4px 12px rgba(0,0,0,0.15)",
                                  "min-width": "120px",
                                }}
                              >
                                <GripVertical class="w-3 h-3 shrink-0" style={{ color: "var(--icon-weak)" }} />
                                <Pin class="w-4 h-4 shrink-0" style={{ color: "var(--icon-weak)" }} />
                                <span class="truncate">{dragged()?.title || "Untitled"}</span>
                              </div>
                            );
                          }}
                        </Show>
                      </DragOverlay>
                    </DragDropProvider>
                  </div>
                </Show>

                {/* Active Sessions — grouped by date */}
                <For each={groupedSessions()}>
                  {(group) => (
                    <div class="pb-2">
                      <h3
                        role="presentation"
                        class="px-2.5 pt-2 pb-1 font-semibold uppercase text-[0.65rem] tracking-[0.06em]"
                        style={{ color: "var(--text-weak)" }}
                      >
                        {group.label}
                      </h3>
                      <div class="space-y-0.5">
                        <For each={group.sessions}>
                          {(session) => renderSessionItem(session, false)}
                        </For>
                      </div>
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
                              class="flex items-center gap-2 px-2.5 py-2 rounded-md text-sm transition-colors"
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
                              <span class="min-w-0 flex-1 truncate">
                                {session.title || "Untitled"}
                              </span>
                            </A>
                            <div
                              class={`absolute right-0 top-0 bottom-0 items-center rounded-r-md ${menuOpenId() === session.id ? "flex" : "hidden group-hover:flex group-focus-within:flex"}`}
                              style={{ "pointer-events": "none" }}
                            >
                              <div
                                class="w-6 h-full"
                                style={{
                                  background: `linear-gradient(to right, transparent, var(${isActive(session.id) ? "--surface-inset" : "--background-stronger"}))`,
                                }}
                              />
                              <div
                                class="flex items-center pr-1.5 relative"
                                style={{
                                  "pointer-events": "auto",
                                  background: isActive(session.id) ? "var(--surface-inset)" : "var(--background-stronger)",
                                }}
                                data-sidebar-menu
                              >
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const opening = menuOpenId() !== session.id;
                                    setMenuOpenId(opening ? session.id : null);
                                    setMenuFocusIndex(opening ? 0 : -1);
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
                                  title="More options"
                                  aria-label="More session options"
                                  aria-haspopup="true"
                                  aria-expanded={menuOpenId() === session.id}
                                >
                                  <MoreHorizontal class="w-3.5 h-3.5" />
                                </button>

                                {/* Dropdown menu for archived sessions */}
                                <Show when={menuOpenId() === session.id}>
                                  <div
                                    class="absolute right-0 top-full mt-1 w-44 rounded-md shadow-lg z-30 py-1"
                                    style={{
                                      background: "var(--background-base)",
                                      border: "1px solid var(--border-base)",
                                    }}
                                    data-sidebar-menu-dropdown
                                    role="menu"
                                  >
                                    {/* Restore */}
                                    <button
                                      data-menu-item
                                      role="menuitem"
                                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                                      style={{
                                        color: "var(--text-base)",
                                        background: menuFocusIndex() === 0 ? "var(--surface-inset)" : "transparent",
                                      }}
                                      onMouseEnter={() => setMenuFocusIndex(0)}
                                      onFocus={() => setMenuFocusIndex(0)}
                                      onMouseLeave={(e) => { if (menuFocusIndex() !== 0) e.currentTarget.style.background = "transparent" }}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setMenuOpenId(null);
                                        restoreSession(session);
                                      }}
                                    >
                                      <ArchiveRestore class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                                      Restore
                                    </button>

                                    {/* Separator */}
                                    <div class="my-1" role="separator" style={{ "border-top": "1px solid var(--border-base)" }} />

                                    {/* Delete */}
                                    <button
                                      data-menu-item
                                      role="menuitem"
                                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                                      style={{
                                        color: "var(--text-critical-base)",
                                        background: menuFocusIndex() === 1 ? "var(--surface-inset)" : "transparent",
                                      }}
                                      onMouseEnter={() => setMenuFocusIndex(1)}
                                      onFocus={() => setMenuFocusIndex(1)}
                                      onMouseLeave={(e) => { if (menuFocusIndex() !== 1) e.currentTarget.style.background = "transparent" }}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setMenuOpenId(null);
                                        setDeleteError(null);
                                        setConfirmDeleteSession(session);
                                      }}
                                    >
                                      <Trash2 class="w-3.5 h-3.5 shrink-0" />
                                      Delete
                                    </button>
                                  </div>
                                </Show>
                              </div>
                            </div>
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
      </nav>

      {/* Sidebar resize handle */}
      <Show when={showSidebar()}>
        <ResizeHandle
          direction="horizontal"
          edge="end"
          size={layout.sidebar.width()}
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          onResize={(width) => {
            setSidebarDragging(true);
            layout.sidebar.resize(width);
          }}
          onDragEnd={() => {
            setSidebarDragging(false);
          }}
          onCollapse={toggleSidebar}
          collapseThreshold={100}
        />
      </Show>

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
            data-panel="terminal"
            tabIndex={-1}
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
                  class="mx-auto mt-0.5 w-12 h-1 rounded-full transition-colors group-hover:bg-[var(--surface-strong)]"
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

      {/* Delete confirmation dialog for sidebar sessions */}
      <ConfirmDialog
        open={!!confirmDeleteSession()}
        title="Delete session?"
        message={`This will permanently delete "${confirmDeleteSession()?.title || "this session"}". This cannot be undone.`}
        confirmLabel={deleting() ? "Deleting..." : "Delete"}
        confirmDisabled={deleting()}
        cancelDisabled={deleting()}
        cancelLabel="Cancel"
        variant="danger"
        error={deleteError() ?? undefined}
        onConfirm={() => {
          const session = confirmDeleteSession();
          if (session) deleteAndNavigate(session);
        }}
        onCancel={() => {
          if (deleting()) return;
          setDeleteError(null);
          setConfirmDeleteSession(null);
        }}
      />

      {/* Archive confirmation dialog for busy sessions (Cmd+W) */}
      <ConfirmDialog
        open={!!confirmArchiveSession()}
        title="Archive busy session?"
        message={`"${confirmArchiveSession()?.title || "This session"}" is currently running. Archive it anyway?`}
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          const session = confirmArchiveSession();
          setConfirmArchiveSession(null);
          if (session) archiveAndNavigate(session);
        }}
        onCancel={() => setConfirmArchiveSession(null)}
      />

      {/* Keyboard shortcut reference overlay */}
      <ShortcutReference />

      {/* Command palette overlay */}
      <CommandPalette />

      {/* Vimium-style hint mode overlay */}
      <HintMode />
    </div>
  );
}
