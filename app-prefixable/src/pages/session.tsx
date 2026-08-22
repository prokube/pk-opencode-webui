import {
  createSignal,
  Show,
  For,
  onMount,
  createEffect,
  onCleanup,
  createMemo,
  on,
  untrack,
} from "solid-js";
import { useLocation, useParams, useNavigate } from "@solidjs/router";
import { Button } from "../components/ui/button";
import { useSDK } from "../context/sdk";
import { sessionStatusEvent, useEvents } from "../context/events";
import { useSync } from "../context/sync";
import { useProviders } from "../context/providers";
import { usePermission } from "../context/permission";
import { useLayout } from "../context/layout";
import { useTerminal } from "../context/terminal";
import { useConfig } from "../context/config";
import { useCommand } from "../context/command";
import { MessageTimeline } from "../components/message-timeline";
import { MCPDialog } from "../components/mcp-dialog";
import { MCPAddDialog } from "../components/mcp-add-dialog";
import { PickerDialog } from "../components/picker-dialog";
import { QuestionPrompt } from "../components/question-prompt";
import { FollowupDock } from "../components/followup-dock";
import { PermissionPrompt } from "../components/permission-prompt";
import { SessionInfo } from "../components/session-info";
import { SessionSidebar } from "../components/session-sidebar";
import { ReviewPanel } from "../components/review-panel";
import { SessionHeader } from "../components/session-header";
import { ResizeHandle } from "../components/resize-handle";
import { base64Encode, base64Decode } from "../utils/path";
import type { Part, TextPart } from "../sdk/client";
import type { DisplayMessage } from "../types/message";
import { Paperclip, Upload } from "lucide-solid";
import { ContextItems, type FileContext } from "../components/context-items";
import { FilePickerDialog } from "../components/file-picker-dialog";
import {
  ImageAttachments,
  type ImageAttachment,
} from "../components/image-attachments";
import { sessionQuestionRequest } from "../utils/session-tree-request";
import { ascendingID } from "../utils/id";
import { createRootSession } from "../utils/root-session";
import { formatStartError } from "../utils/session-start";
import { LOCAL_SERVER_ID } from "../context/server";
import { workspaceStorageKey } from "../utils/storage";
import {
  archivedLastSession,
  requestSession,
  sessionDraftKey,
  sessionRouteKey,
} from "../utils/session-load";
import { canDispatchFollowup, followupStorageKey, parseFollowups, parseLegacyFollowupMap, type FollowupItem } from "../utils/followups";

const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

interface Command {
  id: string;
  title: string;
  description?: string;
  slash?: string;
  onSelect: () => void;
}

// Per-session draft storage — module-level because SolidJS Router reuses
// the component instance when only the :id param changes.
interface SessionDraft {
  text: string;
  files: FileContext[];
  images: ImageAttachment[];
  height: string;
  drag: number;
}
const drafts = new Map<string, SessionDraft>();
const DRAFT_LIMIT = 40;

function storeDraft(key: string, draft: SessionDraft) {
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > DRAFT_LIMIT) drafts.delete(drafts.keys().next().value!);
}

// Draft keys include server, directory, and session. "__new__" represents a new-session draft.
export function Session() {
  const params = useParams<{ dir: string; id?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { client, directory } = useSDK();
  const events = useEvents();
  const sync = useSync();
  const providers = useProviders();
  const permission = usePermission();
  const layout = useLayout();
  const terminal = useTerminal();
  const appConfig = useConfig();
  const command = useCommand();

  const [sessionId, setSessionId] = createSignal(params.id);

  // Per-session model: reads from providers.sessionModels, falls back to global default
  const sessionModel = createMemo(() => {
    const id = sessionId();
    if (!id) return providers.selectedModel;
    return providers.getSessionModel(id) ?? providers.selectedModel;
  });

  const modelDetails = createMemo(() => {
    const model = sessionModel();
    if (!model) return;
    const provider = providers.providers.find((p) => p.id === model.providerID);
    if (!provider) return;
    const item = provider.models[model.modelID];
    if (!item) return;
    return { provider, model: item };
  });
  const modelLabel = createMemo(() => {
    const item = modelDetails();
    if (!item) return null;
    return item.model.name || item.model.id;
  });
  const configuredVariant = createMemo(() =>
    providers.variant.configured(sessionModel(), providers.selectedAgent),
  );
  const variantItems = createMemo(() => providers.variant.list(sessionModel()));
  const currentVariant = createMemo(() =>
    providers.variant.current(sessionId(), sessionModel(), providers.selectedAgent),
  );

  // Unified toast system — only one toast visible at a time
  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [toastVariant, setToastVariant] = createSignal<"default" | "hint" | "error">("default");
  const toastMsgTimer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
  onCleanup(() => { if (toastMsgTimer.id !== null) clearTimeout(toastMsgTimer.id); });

  function hideToast() {
    if (toastMsgTimer.id !== null) clearTimeout(toastMsgTimer.id);
    toastMsgTimer.id = null;
    setToastMessage(null);
  }

  function showToast(msg: string, duration = 2500, variant: "default" | "hint" | "error" = "default") {
    if (toastMsgTimer.id !== null) clearTimeout(toastMsgTimer.id);
    setToastMessage(msg);
    setToastVariant(variant);
    toastMsgTimer.id = setTimeout(() => hideToast(), duration);
  }

  // Instructions active state
  const [instructionsActive, setInstructionsActive] = createSignal(false);
  onMount(() => {
    client.config
      .get()
      .then((res) => {
        const cfg = res.data as { instructions?: string[] } | undefined;
        setInstructionsActive((cfg?.instructions ?? []).length > 0);
      })
      .catch(() => {});
  });

  // Helper to get the current directory slug
  const dirSlug = createMemo(() =>
    directory ? base64Encode(directory) : params.dir,
  );
  const draftID = createMemo(() => {
    if (params.id) return params.id;
    const token = new URLSearchParams(location.search).get("new");
    return token ? `__new__:${token}` : undefined;
  });

  const [input, setInput] = createSignal("");
  const [dragHeight, setDragHeight] = createSignal(0); // 0 = no manual drag, positive = user-set minimum
  const [optimisticMessage, setOptimisticMessage] =
    createSignal<DisplayMessage | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [processing, setProcessing] = createSignal(false);
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  const [reverting, setReverting] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [followups, setFollowups] = createSignal<FollowupItem[]>([]);
  const [dispatchingFollowup, setDispatchingFollowup] = createSignal(false);
  const [pausedFollowups, setPausedFollowups] = createSignal<Set<string>>(new Set());
  const lifetime = { active: true, load: 0, create: 0, submit: 0 };
  onCleanup(() => {
    lifetime.active = false;
    lifetime.load += 1;
    lifetime.create += 1;
    lifetime.submit += 1;
  });

  function saveFollowups(items: FollowupItem[], id = sessionId(), updateView = id === sessionId()) {
    if (!id) return false;
    try {
      localStorage.setItem(followupStorageKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), id), JSON.stringify(items));
      if (updateView) setFollowups(items);
      if (!items.length) setFollowupPaused(false, id);
      return true;
    } catch {
      setError("Could not persist the follow-up queue.");
      return false;
    }
  }

  function followupPaused(id = sessionId()) {
    return !!id && pausedFollowups().has(id);
  }

  function setFollowupPaused(paused: boolean, id = sessionId()) {
    if (!id) return;
    setPausedFollowups((current) => {
      const next = new Set(current);
      if (paused) next.add(id);
      if (!paused) next.delete(id);
      return next;
    });
  }

  createEffect(on(() => `${directory ?? params.dir}:${sessionId() ?? ""}:${sessionModel()?.providerID ?? ""}/${sessionModel()?.modelID ?? ""}`, () => {
    const id = sessionId();
    const model = sessionModel();
    if (!id || !model) {
      setFollowups([]);
      return;
    }
    try {
      const key = followupStorageKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), id);
      const defaults = {
        agent: providers.selectedAgent || "build",
        model,
        variant: providers.variant.current(id, model, providers.selectedAgent),
      };
      const current = localStorage.getItem(key);
      const legacyKey = `opencode.followup.${params.dir}`;
      const legacyRaw = current ? null : localStorage.getItem(legacyKey);
      const legacy = parseLegacyFollowupMap(legacyRaw, id, defaults);
      const items = current ? parseFollowups(current, defaults) : legacy.items;
      setFollowups(items);
      localStorage.setItem(key, JSON.stringify(items));
      if (legacyRaw && legacy.items.length) {
        if (legacy.remaining) localStorage.setItem(legacyKey, legacy.remaining);
        else localStorage.removeItem(legacyKey);
      }
    } catch {
      setFollowups([]);
    }
  }));

  // Find the Nth-from-last user message (1-indexed: 1 = last, 2 = second-to-last)
  function getNthLastUserMsg(msgs: DisplayMessage[], n: number) {
    let count = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      count++;
      if (count === n) return msgs[i];
    }
    return undefined;
  }

  // Extract text content from message parts with optional separator and truncation
  function textFromParts(parts: Part[], separator = " ", maxLen?: number) {
    const text = parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join(separator);
    if (maxLen && text.length > maxLen) return text.slice(0, maxLen) + "...";
    return text;
  }

  function visibleSyncMessages(id: string) {
    const msgs = sync.messages(id);
    const revertID = sync.session.get(id)?.revert?.messageID;
    if (!revertID) return msgs;
    const revertIndex = msgs.findIndex((msg) => msg.info.id === revertID);
    if (revertIndex === -1) return msgs;
    return msgs.slice(0, revertIndex);
  }

  function assistantFinished(id: string) {
    const msgs = visibleSyncMessages(id);
    const last = msgs[msgs.length - 1]?.info;
    if (last?.role !== "assistant") return false;
    return last.time.completed != null || !!last.error || !!last.finish;
  }

  // Viewport-aware maximum matching the CSS max-height on the textarea
  function maxInputHeight() {
    return Math.max(200, window.innerHeight - 200);
  }

  // Clamp height to at least the drag floor but no more than viewport max
  function clampInputHeight(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    const desired = Math.max(dragHeight(), el.scrollHeight);
    el.style.height = `${Math.min(maxInputHeight(), desired)}px`;
  }

  // Set textarea value, trigger auto-grow, and focus — bypasses input handler
  // to avoid slash-command detection when restored text starts with "/"
  function applyInputAndAutogrow(el: HTMLTextAreaElement, text: string) {
    setInput(text);
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    nativeSet?.call(el, text);
    clampInputHeight(el);
    requestAnimationFrame(() => el.focus());
  }

  // Fork picker items: user messages in reverse chronological order
  const forkPickerItems = createMemo(() => {
    const id = sessionId();
    if (!id) return [];
    const msgs = visibleSyncMessages(id);
    return msgs
      .filter((m) => m.info.role === "user")
      .sort((a, b) => b.info.time.created - a.info.time.created)
      .map((m) => {
        const preview = textFromParts(m.parts, " ", 80);
        const date = new Date(m.info.time.created);
        const timestamp = date.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return {
          id: m.info.id,
          title: preview || (m.parts && m.parts.length > 0 ? "(attachments)" : "(empty message)"),
          description: timestamp,
        };
      });
  });
  const [showSlashPopover, setShowSlashPopover] = createSignal(false);
  const [slashQuery, setSlashQuery] = createSignal("");
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [showMCPDialog, setShowMCPDialog] = createSignal(false);
  const [showMCPAddDialog, setShowMCPAddDialog] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const [showVariantPicker, setShowVariantPicker] = createSignal(false);
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [showFilePicker, setShowFilePicker] = createSignal(false);
  const [showForkPicker, setShowForkPicker] = createSignal(false);

  const [fileContext, setFileContext] = createSignal<FileContext[]>([]);
  const [imageAttachments, setImageAttachments] = createSignal<
    ImageAttachment[]
  >([]);
  const [error, setError] = createSignal<string | null>(null);
  // Use session tree walk to find pending questions from this session or any descendant.
  // This surfaces child/grandchild session questions in the parent session view.
  const pendingQuestion = createMemo(() =>
    sessionQuestionRequest(sync.sessions(), events.pendingQuestions, sessionId()) ?? null,
  );
  const pendingPermissions = createMemo(() => permission.pendingForSession(sessionId() ?? ""));
  const inputBlocked = createMemo(() =>
    !!pendingQuestion() || pendingPermissions().length > 0 || loadingHistory() || !!loadError() ||
    !!sync.session.get(sessionId() ?? "")?.parentID,
  );

  // Double-Escape to abort: track last Escape press timestamp
  const lastEsc = { ts: 0 };

  function cycleVariant() {
    if (variantItems().length === 0) return;
    providers.variant.cycle(sessionId(), sessionModel(), providers.selectedAgent);
  }

  // Track whether the agent was genuinely processing (not initial load)
  const wasProcessing = { value: false };

  function finishProcessing() {
    setOptimisticMessage(null);
    wasProcessing.value = false;
    setProcessing(false);
  }

  async function loadSession(id: string, route: string) {
    const token = ++lifetime.load;
    const current = () => lifetime.active && token === lifetime.load &&
      route === sessionDraftKey(LOCAL_SERVER_ID, params.dir, params.id);
    try {
      const loaded = await requestSession(
        (params, options) => client.session.get(params, options),
        id,
      );
      if (!current()) return;
      const res = loaded.response;
      const result = loaded.result;
      if (result === "not-found") {
        setLoadingHistory(false);
        clearLastSession(id);
        navigate(`/${dirSlug()}/session`, { replace: true });
        return;
      }
      if (result === "error" || !res?.data) {
        if ("error" in loaded) console.error("[Session] Failed to load session:", loaded.error);
        setLoadingHistory(false);
        setLoadError("Failed to load this session. Check your connection and try again.");
        return;
      }
      if (isArchivedLastSession(res.data)) {
        clearLastSession(id);
        setLoadingHistory(false);
        navigate(`/${dirSlug()}/session`, { replace: true });
        return;
      }
      sync.session.upsert(res.data);
      const synced = await sync.session.sync(id);
      if (!current()) return;
      setLoadingHistory(false);
      if (!synced) {
        setLoadError("Failed to load this session. Check your connection and try again.");
        return;
      }
      if (providers.getSessionModel(id)) return;
      const msgs = visibleSyncMessages(id);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i].info;
        if (info.role !== "assistant" || !info.providerID || !info.modelID) continue;
        providers.setSessionModel(id, { providerID: info.providerID, modelID: info.modelID });
        break;
      }
    } catch (err) {
      if (!current()) return;
      console.error("[Session] Failed to load session:", err);
      setLoadingHistory(false);
      setLoadError("Failed to load this session. Check your connection and try again.");
    }
  }

  // Keep sessionId in sync with URL params and sync session data.
  // Track the composite dir+id key so the effect fires on directory changes too,
  // preventing drafts from leaking across projects when id stays undefined.
  createEffect(on(() => sessionDraftKey(LOCAL_SERVER_ID, params.dir, draftID()), (key, prevKey) => {
    const id = params.id;
    const preservesSubmission = !!id && untrack(sessionId) === id && untrack(loading);
    console.log("[Session] URL param changed:", key);

    // Save draft from the previous session before switching.
    // Read signals via untrack() so they aren't tracked dependencies.
    if (prevKey && prevKey !== key) {
      const text = untrack(input);
      const files = untrack(fileContext);
      const images = untrack(imageAttachments);
      const meaningful =
        text.trim().length > 0 ||
        (files && files.length > 0) ||
        (images && images.length > 0);

      if (meaningful) {
        storeDraft(prevKey, { text, files, images, height: inputRef?.style.height ?? "", drag: untrack(dragHeight) });
      } else {
        drafts.delete(prevKey);
      }
    }

    setSessionId(id);
    if (!preservesSubmission) setOptimisticMessage(null);
    // Restore draft for the new session (or clear if none saved)
    const saved = drafts.get(key);
    setInput(saved?.text ?? "");
    setFileContext(saved?.files ?? []);
    setImageAttachments(saved?.images ?? []);
    setDragHeight(saved?.drag ?? 0);
    if (inputRef) inputRef.style.height = saved?.height ?? "";
    setShowSlashPopover(false);
    setSlashQuery("");
    setSlashIndex(0);
    wasProcessing.value = false;
    if (!preservesSubmission) setLoading(false);
    if (id) {
      setLoadingHistory(true);
      setLoadError(null);
      setProcessing(false); // Reset processing state for new session
      void loadSession(id, key);
    } else {
      lifetime.load += 1;
      setLoadingHistory(false);
      setLoadError(null);
      setProcessing(false);
    }
  }));

  createEffect(() => {
    const id = sessionId();
    if (!id) return;
    onCleanup(sync.session.retain(id));
  });

  // Mirror processing state from the global status store so status emitted
  // before this page mounts still initializes the busy indicator correctly.
  createEffect(() => {
    const id = sessionId();
    if (!id) return;
    const type = events.status[id]?.type;
    if (type === "busy" || type === "retry") {
      wasProcessing.value = true;
      setProcessing(true);
      return;
    }
    // Any non-busy status (including idle or unknown) means not processing
    if (type) {
      setProcessing(false);
    }
  });

  createEffect(() => {
    const id = sessionId();
    if (!id || !processing()) return;

    const dir = directory || base64Decode(params.dir);
    const state = { pending: false, stopped: false, interval: undefined as ReturnType<typeof setInterval> | undefined };
    const poll = () => {
      if (state.pending || state.stopped) return;
      state.pending = true;
      if (sync.sseUnhealthy()) void sync.session.sync(id);
      client.session.status({ directory: dir })
        .then((res) => {
          if (state.stopped || sessionId() !== id) return;
          const polled = res.data?.[id];
          const status = polled?.type;
          if (polled) events.setSessionStatus(id, polled);
          if (status !== "busy" && status !== "retry") {
            if (polled) {
              finishProcessing();
              return;
            }
            sync.session.sync(id).then((synced) => {
              if (state.stopped || sessionId() !== id || !synced) return;
              if (assistantFinished(id)) finishProcessing();
            });
          }
        })
        .catch((err) => console.warn("[Session] Status poll failed:", err))
        .finally(() => {
          state.pending = false;
        });
    };

    const timer = setTimeout(() => {
      poll();
      state.interval = setInterval(poll, 5000);
    }, 5000);
    onCleanup(() => {
      state.stopped = true;
      clearTimeout(timer);
      if (state.interval) clearInterval(state.interval);
    });
  });

  // Watchdog: if processing stays true for 60s without resolution, re-fetch status
  createEffect(() => {
    const id = sessionId();
    if (!id || !processing()) return;
    const timer = setTimeout(() => {
      if (!processing() || sessionId() !== id) return;
      const dir = directory || base64Decode(params.dir);
      client.session.status({ directory: dir })
        .then((res) => {
          const polled = (res.data ?? {})[id];
          if (sessionId() !== id) return;
          if (polled) events.setSessionStatus(id, polled);
          if (polled && polled.type !== "busy" && polled.type !== "retry") {
            finishProcessing();
            return;
          }
          if (polled) return;
          sync.session.sync(id).then((synced) => {
            if (sessionId() !== id || !synced) return;
            if (assistantFinished(id)) finishProcessing();
          });
        })
        .catch((err) => console.warn("[Session] Watchdog poll failed:", err));
    }, 60_000);
    onCleanup(() => clearTimeout(timer));
  });

  // Get messages from sync context - reactive, automatically updated via SSE
  // Cache the base messages array to avoid recreating on every call
  const syncMessages = createMemo(() => {
    const id = sessionId();
    if (!id) return [];
    return visibleSyncMessages(id).map((msg) => {
      const info = msg.info;
      if (info.role === "assistant") {
        return {
          id: info.id,
          role: info.role,
          parts: msg.parts,
          error: info.error,
          time: { created: info.time.created, completed: info.time.completed },
          modelID: info.modelID,
          providerID: info.providerID,
          tokens: info.tokens,
        };
      }
      return {
        id: info.id,
        role: info.role,
        parts: msg.parts,
        time: { created: info.time.created },
      };
    });
  });

  // Includes optimistic message if present and not yet in sync
  const messages = createMemo(() => {
    const syncMsgs = syncMessages();
    if (syncMsgs.length === 0 && !optimisticMessage()) return syncMsgs;

    // Add optimistic message if it exists and isn't already in sync
    const opt = optimisticMessage();
    if (opt && !syncMsgs.some((message) => message.id === opt.id)) return [...syncMsgs, opt];
    return syncMsgs;
  });
  let inputRef: HTMLTextAreaElement | undefined;
  let slashPopoverRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  // Get session from sync context - reactive, automatically updated via SSE
  const session = createMemo(() => {
    const id = params.id;
    if (!id) return null;
    return sync.session.get(id) ?? null;
  });

  // Slash commands — computed so state-dependent commands update reactively
  const baseSlashCommands = createMemo<Command[]>(() => {
    const id = sessionId();
    const sess = session();
    const msgs = syncMessages();
    const hasMessages = msgs.length > 0;
    const isProcessing = processing();
    const lastUserMsg = getNthLastUserMsg(msgs, 1);

    const commands: Command[] = [
      {
        id: "session.new",
        title: "New Session",
        description: "Create a new chat session",
        slash: "new",
        onSelect: async () => {
          navigate(`/${dirSlug()}/session?new=${crypto.randomUUID()}`);
        },
      },
      {
        id: "settings.open",
        title: "Settings",
        description: "Open settings page",
        slash: "settings",
        onSelect: () => {
          console.log("[Command] Settings");
          navigate(`/${dirSlug()}/settings`);
        },
      },
      {
        id: "provider.connect",
        title: "Connect Provider",
        description: "Add an AI provider",
        slash: "connect",
        onSelect: () => {
          console.log("[Command] Connect");
          navigate(`/${dirSlug()}/settings`);
        },
      },
      {
        id: "model.choose",
        title: "Choose Model",
        description: "Select the AI model to use",
        slash: "model",
        onSelect: () => {
          setShowModelPicker(true);
        },
      },
      {
        id: "agent.choose",
        title: "Choose Agent",
        description: "Select the agent to use",
        slash: "agent",
        onSelect: () => {
          setShowAgentPicker(true);
        },
      },
      {
        id: "mcp.manage",
        title: "MCP Servers",
        description: "Manage MCP server connections",
        slash: "mcp",
        onSelect: () => {
          console.log("[Command] MCP dialog");
          setShowMCPDialog(true);
        },
      },
      {
        id: "terminal.toggle",
        title: "Toggle Terminal",
        description: "Open or close the terminal panel",
        slash: "terminal",
        onSelect: () => {
          terminal.toggle(directory);
        },
      },
      {
        id: "session.fork",
        title: "Fork Session",
        description: "Branch from a previous message",
        slash: "fork",
        onSelect: () => {
          if (!sessionId() || forkPickerItems().length === 0) return;
          setShowForkPicker(true);
        },
      },
    ];

    if (variantItems().length > 0) {
      commands.push({
        id: "model.variant",
        title: "Choose Model Variant",
        description: "Select a model variant (for example fast mode)",
        slash: "variant",
        onSelect: () => {
          setShowVariantPicker(true);
        },
      });
    }

    // /compact — requires a session with messages and a selected model
    if (id && hasMessages && !isProcessing && sessionModel()) {
      commands.push({
        id: "session.compact",
        title: "Compact Session",
        description: "Summarize conversation to free up context space",
        slash: "compact",
        onSelect: async () => {
          if (!id) return;
          const model = sessionModel();
          if (!model) {
            showToast("Select a model before compacting");
            return;
          }
          showToast("Compacting session...", 10000);
          try {
            await client.session.summarize({
              sessionID: id,
              providerID: model.providerID,
              modelID: model.modelID,
            });
            showToast("Session compacted");
          } catch (err) {
            showToast(`Failed to compact session: ${formatStartError(err)}`);
          }
        },
      });
    }

    // /share — requires an active session, not already shared, and sharing not disabled.
    // Project config overrides global for conflicting keys (merge semantics).
    // Default to disabled while config is loading or errored to avoid showing commands prematurely.
    const effectiveShare = appConfig.project.share ?? appConfig.global.share
    const shareDisabled = appConfig.loading() || !!appConfig.error() || effectiveShare === "disabled"
    if (id && !sess?.share?.url && !shareDisabled) {
      commands.push({
        id: "session.share",
        title: "Share Session",
        description: "Generate a shareable link and copy to clipboard",
        slash: "share",
        onSelect: async () => {
          if (!id) return;
          const route = sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id);
          try {
            const res = await client.session.share({ sessionID: id });
            void sync.session.sync(id);
            if (route !== sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) return;
            const url = res.data?.share?.url;
            if (!url) {
              showToast("Failed to share session: no URL returned");
              return;
            }
            try {
              await navigator.clipboard.writeText(url);
              showToast("Share link copied to clipboard");
            } catch {
              showToast(`Share link: ${url}`, 8000);
            }
          } catch (err) {
            showToast(`Failed to share session: ${formatStartError(err)}`);
          }
        },
      });
    }

    // /share — already shared: copy existing link
    if (id && sess?.share?.url && !shareDisabled) {
      commands.push({
        id: "session.share",
        title: "Copy Share Link",
        description: "Copy the existing share link to clipboard",
        slash: "share",
        onSelect: async () => {
          const url = sess!.share!.url;
          try {
            await navigator.clipboard.writeText(url);
            showToast("Share link copied to clipboard");
          } catch {
            showToast(`Share link: ${url}`, 8000);
          }
        },
      });
    }

    // /unshare — only when session is already shared
    if (id && sess?.share?.url && !shareDisabled) {
      commands.push({
        id: "session.unshare",
        title: "Unshare Session",
        description: "Remove the shared link and make session private",
        slash: "unshare",
        onSelect: async () => {
          if (!id) return;
          const route = sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id);
          try {
            await client.session.unshare({ sessionID: id });
            void sync.session.sync(id);
            if (route !== sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) return;
            showToast("Session unshared");
          } catch (err) {
            showToast(`Failed to unshare session: ${formatStartError(err)}`);
          }
        },
      });
    }

    // /undo — requires a session with at least one user message
    // Allowed during processing so abort-then-revert flow works
    // Supports `/undo` (last turn) and `/undo N` (Nth-from-last turn)
    if (id && lastUserMsg) {
      commands.push({
        id: "session.undo",
        title: "Undo Message",
        description: "Revert the last user message (use /undo N for multiple turns)",
        slash: "undo",
        onSelect: async () => {
          await undoTurns(1);
        },
      });
    }

    // /redo — only when session is in a reverted state
    if (id && sess?.revert?.messageID) {
      commands.push({
        id: "session.redo",
        title: "Redo Message",
        description: "Restore previously reverted messages",
        slash: "redo",
        onSelect: async () => {
          if (!id) return;
          if (reverting()) return;
          const route = sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id);
          setFollowupPaused(true);
          setReverting(true);
          try {
            await client.session.unrevert({ sessionID: id });
            if (route === sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) setInput("");
            showToast("Messages restored");
            await sync.session.sync(id);
          } catch (err) {
            showToast(`Failed to redo messages: ${formatStartError(err)}`);
          } finally {
            setReverting(false);
          }
        },
      });
    }

    return commands;
  });

  // Undo N user turns — finds the Nth-from-last user message and reverts to it.
  // The backend accepts any messageID, so reverting to an earlier message
  // implicitly removes everything after it.
  async function undoTurns(count: number) {
    if (reverting()) return;
    const id = sessionId();
    if (!id) {
      showToast("No active session to undo");
      return;
    }
    const msgs = syncMessages();
    const target = getNthLastUserMsg(msgs, count);
    if (!target) {
      const total = msgs.filter((m) => m.role === "user").length;
      showToast(count === 1 ? "No user message to undo" : `Only ${total} user message${total === 1 ? "" : "s"} to undo`);
      return;
    }
    const route = sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id);
    const draftKey = sessionDraftKey(LOCAL_SERVER_ID, params.dir, id);
    const textPart = target.parts.find((p) => p.type === "text") as
      | { type: "text"; text?: string }
      | undefined;
    setFollowupPaused(true);
    setReverting(true);
    try {
      // If processing, abort first (clears pendingQuestion too)
      if (processing()) {
        await handleAbort();
        if (route !== sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) return;
      }
      await client.session.revert({
        sessionID: id,
        messageID: target.id,
      });
      if (textPart?.text) {
        if (route === sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) {
          setInput(textPart.text);
          if (inputRef) applyInputAndAutogrow(inputRef, textPart.text);
        } else {
          storeDraft(draftKey, { text: textPart.text, files: [], images: [], height: "", drag: 0 });
        }
      }
      showToast(count === 1 ? "Undone 1 turn" : `Undone ${count} turns`);
      await sync.session.sync(id);
    } catch (err) {
      showToast(`Failed to undo: ${formatStartError(err)}`);
    } finally {
      setReverting(false);
    }
  }

  // Filtered slash commands based on query
  const filteredSlashCommands = createMemo(() => {
    const cmds = baseSlashCommands();
    const q = slashQuery().toLowerCase();
    if (!q) return cmds;

    return cmds.filter(
      (c) =>
        c.slash?.toLowerCase().startsWith(q) ||
        c.title.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q),
    );
  });

  // Close slash popover on click outside
  function handleClickOutside(e: MouseEvent) {
    const target = e.target as Node;
    if (inputRef?.contains(target)) return;
    if (slashPopoverRef && !slashPopoverRef.contains(target)) {
      setShowSlashPopover(false);
    }
  }

  // Handle slash command selection
  function selectSlashCommand(cmd: Command) {
    console.log("[Session] Selecting command:", cmd.id);
    setInput("");
    setShowSlashPopover(false);
    setSlashQuery("");

    // Use setTimeout to ensure state updates before command runs
    setTimeout(() => {
      console.log("[Session] Executing command:", cmd.id);
      cmd.onSelect();
    }, 0);
  }

  // Handle input changes to detect slash commands
  function handleInputChange(value: string) {
    setInput(value);

    // Detect slash command pattern: /command (no spaces — popover only for partial commands)
    const slashMatch = value.match(/^\/(\S*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setShowSlashPopover(true);
      setSlashIndex(0);
    } else {
      setShowSlashPopover(false);
      setSlashQuery("");
    }
  }

  // Handle keyboard navigation in slash popover
  function handleInputKeyDown(e: KeyboardEvent) {
    if (!showSlashPopover()) return;

    const cmds = filteredSlashCommands();
    if (cmds.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSlashIndex((i) => (i + 1) % cmds.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSlashIndex((i) => (i - 1 + cmds.length) % cmds.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const cmd = cmds[slashIndex()];
      if (cmd) {
        selectSlashCommand(cmd);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setShowSlashPopover(false);
      setSlashQuery("");
    }
  }

  onMount(() => {
    document.addEventListener("click", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleClickOutside);
  });

  // Reset escape state when processing stops (prevents stale timestamps across processing windows)
  createEffect(() => {
    if (!processing()) {
      lastEsc.ts = 0;
    }
  });

  // Global keydown listener for double-Escape to abort
  function handleGlobalKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (e.repeat) return; // Ignore held-key auto-repeat
    if (e.defaultPrevented) return; // Already handled by another component
    // Let dialogs/popovers handle their own Escape
    if (
      showSlashPopover() ||
      showMCPDialog() ||
      showMCPAddDialog() ||
      showModelPicker() ||
      showVariantPicker() ||
      showAgentPicker() ||
      showFilePicker() ||
      showForkPicker()
    ) return;
    if (!processing()) return;

    const now = Date.now();
    if (now - lastEsc.ts < 500) {
      e.preventDefault();
      lastEsc.ts = 0;
      hideToast();
      handleAbort();
      return;
    }
    lastEsc.ts = now;
    showToast("Press Esc again to stop", 1500, "hint");
  }

  onMount(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown);
  });

  onMount(() => {
    command.register([
      {
        id: "model.variant.cycle",
        title: "Cycle Model Variant",
        description: "Switch to the next available model variant",
        keybind: "alt+v",
        global: true,
        onSelect: cycleVariant,
      },
    ]);

    onCleanup(() => {
      command.unregister(["model.variant.cycle"]);
    });
  });

  // Refetch is now just re-syncing
  const refetchSession = async () => {
    const id = params.id;
    if (id) await sync.session.sync(id);
  };

  function clearLastSession(id: string) {
    try {
      const dir = directory || base64Decode(params.dir);
      if (dir && typeof window !== "undefined") {
        const key = workspaceStorageKey(LOCAL_SERVER_ID, dir, "lastSession");
        const stored = window.localStorage.getItem(key);
        if (stored === id) window.localStorage.removeItem(key);
      }
    } catch (err) {
      console.warn("[Session] localStorage error:", err);
    }
  }

  function isArchivedLastSession(session: { id: string; time?: { archived?: number } }) {
    try {
      const dir = directory || base64Decode(params.dir);
      if (!dir || typeof window === "undefined") return false;
      const key = workspaceStorageKey(LOCAL_SERVER_ID, dir, "lastSession");
      return archivedLastSession(window.localStorage.getItem(key), session);
    } catch (err) {
      console.warn("[Session] localStorage error:", err);
      return false;
    }
  }

  // Persist lastSession only after the session is confirmed to exist in sync
  createEffect(() => {
    const id = params.id;
    if (!id) return;
    if (loadingHistory()) return;
    const found = sync.session.get(id);
    if (!found || found.time?.archived) return;
    try {
      const dir = directory || base64Decode(params.dir);
      if (dir && typeof window !== "undefined") {
        window.localStorage.setItem(workspaceStorageKey(LOCAL_SERVER_ID, dir, "lastSession"), id);
      }
    } catch (err) {
      console.warn("[Session] Failed to persist last session:", err);
    }
  });

  // Start processing state - SSE events will handle updates and completion
  function startProcessing() {
    console.log("[Session] Starting processing, relying on SSE events");
    wasProcessing.value = true;
    setProcessing(true);
  }

  // Subscribe to events for status changes and session updates
  // Note: Message updates are handled by sync context, no need to manage here
  onMount(() => {
    const unsub = events.subscribe((event) => {
        const id = sessionId();
        if (!id) return;

        if (event.type === "message.updated") {
          const info = event.properties.info as { id?: string; sessionID?: string } | undefined;
          if (info?.sessionID === id && info.id === optimisticMessage()?.id) setOptimisticMessage(null);
        }

        // Handle status changes
        const statusEvent = sessionStatusEvent(event);
        if (statusEvent) {
          if (statusEvent.sessionID === id && statusEvent.status.type === "idle") {
            console.log("[Session] Status idle");
            setOptimisticMessage(null);

            // Reset local processing tracker after the session becomes idle.
            wasProcessing.value = false;
            setProcessing(false);
          } else if (statusEvent.sessionID === id) {
            wasProcessing.value = true;
            setProcessing(true);
          }
        }

        // Handle session updates
        if (event.type === "session.updated") {
          const info = event.properties.info as { id?: string } | undefined;
          if (info?.id === id) refetchSession();
        }
    });

    return unsub;
  });

  // Question tracking is now handled via the global events.pendingQuestions store
  // (seeded via HTTP and updated via SSE in SyncProvider) combined with the
  // sessionQuestionRequest tree-walk memo defined above. This surfaces questions
  // from child/grandchild sessions automatically without per-session SSE subscriptions.

  async function handleQuestionReply(answers: string[][]) {
    const q = pendingQuestion();
    if (!q) return;

    try {
      // Use the question's own requestID — may belong to a child session
      await client.question.reply({ requestID: q.id, answers, directory });
      // Optimistically clear so the UI unblocks without waiting for SSE
      events.dismissQuestion(q.sessionID, q.id);
    } catch (e) {
      console.error("[Session] Failed to reply to question:", e);
    }
  }

  async function handleQuestionReject() {
    const q = pendingQuestion();
    if (!q) return;

    try {
      await client.question.reject({ requestID: q.id, directory });
      events.dismissQuestion(q.sessionID, q.id);
    } catch (e) {
      console.error("[Session] Failed to reject question:", e);
    }
  }

  async function handleAbort() {
    const id = sessionId();
    if (!id) return;
    const route = sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id);
    const q = pendingQuestion();

    setFollowupPaused(true, id);
    try {
      console.log("[Session] Aborting session:", id);
      await client.session.abort({ sessionID: id, directory });
      if (route !== sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) return;
      setProcessing(false);
      // Only dismiss the question if it belongs to this session — aborting is
      // scoped to the current session and does not affect descendant sessions.
      if (q && q.sessionID === id) events.dismissQuestion(q.sessionID, q.id);
    } catch (e) {
      console.error("[Session] Failed to abort session:", e);
    }
  }

  // Focus input on mount
  onMount(() => {
    inputRef?.focus();
  });

  function addFileToContext(path: string) {
    const key = `file:${path}`;
    const existing = fileContext().find((f) => f.key === key);
    if (existing) return;
    setFileContext((prev) => [...prev, { path, key }]);
  }

  function removeFileFromContext(key: string) {
    setFileContext((prev) => prev.filter((f) => f.key !== key));
  }

  function addUpload(file: File) {
    setError(null); // Clear previous errors
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(
        `Unsupported file type: ${file.type}. Accepted: images and PDFs.`,
      );
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(
        `File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size: 10MB.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const attachment: ImageAttachment = {
        id: crypto.randomUUID(),
        name: file.name,
        mime: file.type,
        dataUrl,
      };
      setImageAttachments((prev) => [...prev, attachment]);
    };
    reader.readAsDataURL(file);
  }

  function removeUpload(id: string) {
    setImageAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handleFileInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    if (!files) return;
    for (const file of files) {
      addUpload(file);
    }
    target.value = ""; // Reset to allow re-selecting same file
  }

  // Handle paste events (Ctrl+V) to extract files from clipboard
  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault(); // Prevent default paste behavior for files
          addUpload(file);
        }
      }
    }
  }

  // Drag & Drop state and handlers
  const [isDragging, setIsDragging] = createSignal(false);
  let dragCounter = 0; // Track nested drag events

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (inputBlocked()) return;
    // Only track drag events that include files
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragCounter++;
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Only track drag events that include files (consistent with handleDragEnter)
    if (!e.dataTransfer?.types.includes("Files")) return;
    // Only decrement if counter is positive to prevent negative values
    if (dragCounter > 0) {
      dragCounter--;
    }
    if (dragCounter === 0) {
      setIsDragging(false);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (inputBlocked()) return;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    setIsDragging(false);

    if (inputBlocked()) return;

    const files = e.dataTransfer?.files;
    if (!files) return;

    for (const file of files) {
      addUpload(file);
    }
  }

  function optimisticUserMessage(text: string, sid: string, messageID: string, partID: string) {
    return {
      id: messageID,
      role: "user",
      parts: [
        {
          id: partID,
          sessionID: sid,
          messageID,
          type: "text",
          text,
        },
      ] as Part[],
    } satisfies DisplayMessage;
  }

  async function sendMessage(e?: SubmitEvent, queued?: FollowupItem) {
    e?.preventDefault();
    const text = queued?.text ?? input().trim();

    // Intercept `/undo N` — revert N user turns at once (explicit submit only)
    const undoMatch = queued ? null : text.match(/^\/undo\s+(\d+)$/i);
    if (undoMatch) {
      const n = parseInt(undoMatch[1], 10);
      if (n > 0) {
        setInput("");
        undoTurns(n);
        return;
      }
    }

    const files = queued ? [] : fileContext();
    const images = queued ? [] : imageAttachments();
    if (!text && files.length === 0 && images.length === 0) return;
    if (loading()) return;
    if (loadingHistory() || loadError()) {
      setError("Wait for this session to finish loading before sending a message.");
      return;
    }
    if (sync.session.get(sessionId() ?? "")?.parentID) {
      setError("Sub-agent sessions are read-only. Continue the conversation in the parent session.");
      return;
    }
    if (inputBlocked()) {
      setError(
        pendingQuestion()
          ? "Reply to the pending question above before sending another message."
          : "Resolve the pending permission request above before sending another message.",
      );
      return;
    }

    // Require explicit model selection to avoid OpenCode auto-selecting a broken provider
    const model = queued?.model ?? sessionModel();
    if (!model) {
      setError(
        "Please select a model before sending messages. Click the model button in the header.",
      );
      return;
    }

    // Check if the selected model's provider is connected
    if (!providers.connected.includes(model.providerID)) {
      setError(
        `Provider "${model.providerID}" is not connected. Please configure it in Settings.`,
      );
      return;
    }

    const currentID = sessionId();
    const status = currentID ? events.status[currentID]?.type : undefined;
    if (!queued && currentID && (processing() || status === "busy" || status === "retry")) {
      if (files.length || images.length) {
        setError("Attachments cannot be queued while the session is running. They remain in the composer.");
        return;
      }
      const item: FollowupItem = {
        id: crypto.randomUUID(),
        messageID: ascendingID("msg"),
        text,
        agent: providers.selectedAgent || "build",
        model,
        variant: providers.variant.current(currentID, model, providers.selectedAgent),
        createdAt: Date.now(),
      };
      if (!saveFollowups([...followups(), item], currentID)) return;
      setInput("");
      setDragHeight(0);
      if (inputRef) inputRef.style.height = "";
      drafts.delete(sessionDraftKey(LOCAL_SERVER_ID, params.dir, currentID));
      setError(null);
      return;
    }

    const submitDirectory = directory ?? base64Decode(params.dir);
    const submitDirSlug = params.dir;
    const originalID = sessionId();
    const queuedItems = queued ? followups() : [];
    const originalDraftID = originalID ?? draftID();
    const originalDraft = sessionDraftKey(LOCAL_SERVER_ID, submitDirSlug, originalDraftID);
    const scope = {
      token: ++lifetime.submit,
      route: sessionRouteKey(LOCAL_SERVER_ID, submitDirectory, params.id),
      sessionID: originalID,
    };
    const current = () => lifetime.active && scope.token === lifetime.submit &&
      scope.route === sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id) &&
      scope.sessionID === sessionId();

    setError(null);
    setLoading(true);
    setInput("");
    setDragHeight(0); // Reset manual resize after sending
    if (inputRef) inputRef.style.height = ""; // Reset textarea to default height
    setFileContext([]); // Clear file context after sending
    setImageAttachments([]); // Clear image attachments after sending

    // Clear saved draft for this session since the message was sent
    drafts.delete(originalDraft);

    // Optimistic update - show user message immediately while waiting for server
    const messageID = queued?.messageID ?? ascendingID("msg");
    const textPartID = ascendingID("prt");
    const userMessage = optimisticUserMessage(text || "(files attached)", sessionId() || "", messageID, textPartID);
    setOptimisticMessage(userMessage);

    const needsSession = !originalID;
    const createToken = needsSession ? ++lifetime.create : 0;
    const createScope = {
      serverId: LOCAL_SERVER_ID,
      directory: submitDirectory,
    };
    const saveDraft = (id = originalDraftID) => {
      storeDraft(sessionDraftKey(LOCAL_SERVER_ID, submitDirSlug, id), {
        text,
        files,
        images,
        height: "",
        drag: 0,
      });
    };
    const restoreComposer = (id = originalID) => {
      saveDraft(id);
      if (!current()) return;
      setOptimisticMessage(null);
      setInput(text);
      setFileContext(files);
      setImageAttachments(images);
      if (inputRef) applyInputAndAutogrow(inputRef, text);
    };
    let createdID: string | undefined;
    try {
      let id = originalID;

      if (!id) {
        console.log("[Session] Creating new session...");
        const res = await createRootSession(client, {
          source: "session.send.createIfMissing",
          scope: createScope,
        });
        if (!current() || createToken !== lifetime.create) {
          saveDraft();
          if (res.isLeader && res.data) await client.session.delete({ sessionID: res.data.id }).catch(() => undefined);
          return;
        }
        const data = res.data;
        console.log("[Session] Create response:", data);
        if (!data) {
          restoreComposer();
          setError("Failed to create session: no session data returned.");
          return;
        }

        id = data.id;
        createdID = id;
        scope.sessionID = id;
        scope.route = sessionRouteKey(LOCAL_SERVER_ID, submitDirectory, id);
        setSessionId(id);
        navigate(`/${dirSlug()}/session/${id}`, { replace: true });
        // Store the model for the new session
        providers.setSessionModel(id, model);
      }

      // Build parts array with text and file attachments
      // Always include a text part (even if empty) to ensure SSE reconciliation works
      const parts: (
        | { id: string; type: "text"; text: string }
        | { id: string; type: "file"; mime: string; url: string; filename: string }
      )[] = [{ id: textPartID, type: "text", text: text || "" }];

      // Add file parts from file context
      for (const file of files) {
        // Construct absolute path, avoiding double slashes
        const dir = directory || "";
        const absolute = file.path.startsWith("/")
          ? file.path
          : `${dir.replace(/\/$/, "")}/${file.path.replace(/^\//, "")}`;
        const filename = file.path.split("/").pop() || file.path;
        // Encode path segments individually to match SDK behavior
        const encoded = absolute
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/");
        parts.push({
          id: ascendingID("prt"),
          type: "file",
          mime: "text/plain",
          url: `file://${encoded}`,
          filename,
        });
      }

      // Add image/PDF attachments from device uploads
      for (const img of images) {
        parts.push({
          id: ascendingID("prt"),
          type: "file",
          mime: img.mime,
          url: img.dataUrl,
          filename: img.name,
        });
      }

      // Send message with agent and model
      console.log("[Session] Sending message to session:", id);
      const promptPayload: {
        sessionID: string;
        messageID: string;
        parts: typeof parts;
        agent: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
      } = {
        sessionID: id,
        messageID,
        parts,
        agent: (queued?.agent ?? providers.selectedAgent) || "build",
      };

      if (model) {
        promptPayload.model = model;
      }

      promptPayload.variant = queued?.variant ?? providers.variant.current(id, model, providers.selectedAgent);

      const promptRes = await client.session.promptAsync(promptPayload);
      if ("error" in promptRes && promptRes.error) {
        throw new Error(formatStartError(promptRes.error));
      }
      if (queued) saveFollowups(queuedItems.filter((item) => item.id !== queued.id), id, current());
      if (!current()) return;
      console.log("[Session] Prompt response:", promptRes);

      // Start processing - SSE events will handle updates and completion
      startProcessing();
    } catch (err) {
      if (queued) {
        saveFollowups(queuedItems.map((item) => item.id === queued.id ? { ...item, failed: true } : item), originalID, current());
        if (current()) {
          setOptimisticMessage(null);
          setError(`Failed to send queued follow-up: ${formatStartError(err)}`);
        }
        return;
      }
      if (scope.token === lifetime.submit) saveDraft(createdID ?? originalID);
      if (createdID) void sync.session.sync(createdID);
      if (!current()) return;
      restoreComposer(createdID ?? originalID);
      console.error("[Session] Error sending message:", err);
      const msg = needsSession
        ? "Failed to send the first message"
        : "Failed to send message";
      setError(
        `${msg}: ${formatStartError(err)}`,
      );
    } finally {
      if (current()) setLoading(false);
    }
  }

  function retryFollowup(id: string) {
    if (dispatchingFollowup()) return;
    setFollowupPaused(false);
    saveFollowups(followups().map((item) => item.id === id ? { ...item, failed: false } : item));
  }

  function deleteFollowup(id: string) {
    if (dispatchingFollowup()) return;
    saveFollowups(followups().filter((item) => item.id !== id));
  }

  function editFollowup(id: string) {
    if (dispatchingFollowup()) return;
    const item = followups().find((candidate) => candidate.id === id);
    if (!item) return;
    if (input().trim() || fileContext().length || imageAttachments().length) {
      setError("Clear or send the current composer draft before editing a queued follow-up.");
      return;
    }
    setInput(item.text);
    if (inputRef) applyInputAndAutogrow(inputRef, item.text);
    deleteFollowup(id);
    inputRef?.focus();
  }

  createEffect(() => {
    const id = sessionId();
    const item = followups()[0];
    const status = id ? events.status[id]?.type : undefined;
    const eligible = canDispatchFollowup({
      ready: events.statusReady(),
      working: status === "busy" || status === "retry",
      processing: processing(),
      loading: loading(),
      blocked: inputBlocked(),
      historyLoading: loadingHistory(),
      loadError: !!loadError(),
      child: !!sync.session.get(id ?? "")?.parentID,
      composerEmpty: !input().trim() && fileContext().length === 0 && imageAttachments().length === 0,
      dispatching: dispatchingFollowup(),
      paused: followupPaused(),
      reverting: reverting(),
      providerConnected: !!item && providers.connected.includes(item.model.providerID),
      item,
    });
    if (!eligible) return;
    setDispatchingFollowup(true);
    queueMicrotask(() => void sendMessage(undefined, item).finally(() => setDispatchingFollowup(false)));
  });

  // Chat view component
  function ChatView() {
    // Re-focus main input when prompts are resolved
    let wasBlocked = false;
    createEffect(() => {
      const blocked = inputBlocked();
      if (wasBlocked && !blocked) {
        requestAnimationFrame(() => inputRef?.focus());
      }
      wasBlocked = blocked;
    });

    return (
      <div class="flex flex-col h-full">
        {/* Header with panel toggle buttons */}
        <SessionHeader
          session={session()}
          modelLabel={modelLabel()}
          variantLabel={currentVariant()}
          canPickVariant={variantItems().length > 0}
          processing={processing()}
          onOpenMCPDialog={() => setShowMCPDialog(true)}
          onOpenVariantPicker={() => setShowVariantPicker(true)}
          instructionsActive={instructionsActive()}
          onOpenInstructions={() => navigate(`/${dirSlug()}/settings#instructions`)}
        />

        {/* Messages - using rich message timeline with lazy rendering */}
        <div class="flex-1 flex flex-col overflow-hidden">
          <MessageTimeline
            messages={messages()}
            processing={
              processing() &&
              !pendingQuestion() &&
              pendingPermissions().length === 0
            }
            loadingHistory={loadingHistory()}
          />

          {/* Question Prompt - rendered outside timeline for proper focus.
              Uses session tree walk so child/grandchild questions are surfaced here. */}
          <Show when={pendingQuestion()} keyed>
            {(q) => (
              <div
                class="px-6 pb-4 shrink-0 min-h-0 overflow-y-auto"
                style={{ background: "var(--background-stronger)" }}
              >
                <QuestionPrompt
                  request={q}
                  onReply={handleQuestionReply}
                  onReject={handleQuestionReject}
                  fromSubAgent={q.sessionID !== sessionId()}
                />
              </div>
            )}
          </Show>

          {/* Permission Prompt - rendered outside timeline for proper focus.
              Uses session tree walk so child/grandchild permissions are surfaced here. */}
          <Show when={pendingPermissions().length > 0}>
            <div
              class="px-6 pb-4"
              style={{ background: "var(--background-stronger)" }}
            >
              <Show when={pendingPermissions().some((p) => p.sessionID !== sessionId())}>
                <div
                  class="text-xs mb-2 px-1"
                  style={{ color: "var(--text-dimmed)" }}
                >
                  Permission request from sub-agent
                </div>
              </Show>
              <PermissionPrompt
                requests={pendingPermissions()}
                onRespond={permission.respond}
                onAutoAccept={permission.enableAutoAccept}
                autoAcceptEnabled={permission.autoAcceptEnabled()}
                currentSessionID={sessionId()}
              />
            </div>
          </Show>
        </div>

        <FollowupDock
          items={followups()}
          sending={dispatchingFollowup()}
          paused={followupPaused()}
          onResume={() => setFollowupPaused(false)}
          onRetry={retryFollowup}
          onEdit={editFollowup}
          onDelete={deleteFollowup}
        />

        {/* Input */}
        <div
          data-panel="chat"
          class="p-4"
          style={{
            background: "var(--background-base)",
            "border-top": "1px solid var(--border-base)",
          }}
        >
          <div class="relative w-full">
            {/* Slash Command Popover */}
            <Show
              when={showSlashPopover() && filteredSlashCommands().length > 0}
            >
              <div
                ref={slashPopoverRef}
                class="absolute bottom-full left-0 mb-2 w-80 max-h-96 rounded-lg shadow-lg z-20 flex flex-col"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                {/* Header */}
                <div
                  class="px-3 py-2 text-xs font-medium sticky top-0"
                  style={{
                    color: "var(--text-weak)",
                    background: "var(--surface-inset)",
                    "border-bottom": "1px solid var(--border-base)",
                  }}
                >
                  <span>Commands</span>
                </div>

                {/* List */}
                <div
                  class="overflow-y-auto flex-1"
                  ref={(el) => {
                    createEffect(() => {
                      const idx = slashIndex();
                      const selected = el.querySelector(
                        `[data-index="${idx}"]`,
                      );
                      if (selected) {
                        selected.scrollIntoView({ block: "nearest" });
                      }
                    });
                  }}
                >
                  <For each={filteredSlashCommands()}>
                    {(cmd, idx) => {
                      const isSelected = () => idx() === slashIndex();
                      return (
                        <button
                          type="button"
                          data-index={idx()}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            selectSlashCommand(cmd);
                          }}
                          class="w-full px-3 py-2 text-left text-sm flex items-start gap-3 transition-colors"
                          style={{
                            background: isSelected()
                              ? "rgba(147, 112, 219, 0.15)"
                              : "transparent",
                            "border-left": isSelected()
                              ? "2px solid rgb(147, 112, 219)"
                              : "2px solid transparent",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected())
                              e.currentTarget.style.background =
                                "var(--surface-inset)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected())
                              e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <Show when={cmd.slash}>
                            <span
                              class="font-mono"
                              style={{ color: "var(--text-interactive-base)" }}
                            >
                              /{cmd.slash}
                            </span>
                          </Show>
                          <div class="flex-1">
                            <div
                              class="font-medium"
                              style={{ color: "var(--text-strong)" }}
                            >
                              {cmd.title}
                            </div>
                            <Show when={cmd.description}>
                              <div
                                class="text-xs"
                                style={{ color: "var(--text-weak)" }}
                              >
                                {cmd.description}
                              </div>
                            </Show>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>

            {/* Error message */}
            <Show when={error()}>
              <div
                class="px-4 py-2 rounded-lg text-sm mb-2"
                style={{
                  background: "var(--status-danger-dim)",
                  color: "var(--status-danger-text)",
                }}
              >
                {error()}
              </div>
            </Show>

            <form
              onSubmit={sendMessage}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              style={{ cursor: inputBlocked() ? "not-allowed" : "auto" }}
            >
              <div
                class="relative flex flex-col rounded-lg focus-within:ring-2 transition-all"
                inert={inputBlocked() || undefined}
                style={
                  {
                    background: "var(--background-base)",
                    border: isDragging()
                      ? "2px dashed var(--interactive-base)"
                      : "1px solid var(--border-base)",
                    "--tw-ring-color": "var(--interactive-base)",
                    opacity: inputBlocked() ? "0.5" : "1",
                  } as any
                }
              >
                {/* File context items */}
                <ContextItems
                  items={fileContext()}
                  onRemove={removeFileFromContext}
                />

                {/* Device uploads (images/PDFs) */}
                <ImageAttachments
                  attachments={imageAttachments()}
                  onRemove={removeUpload}
                />

                {/* Hidden file input for device uploads */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_TYPES.join(",")}
                  multiple
                  class="hidden"
                  onChange={handleFileInputChange}
                />

                {/* Drag overlay */}
                <Show when={isDragging()}>
                  <div
                    class="absolute inset-0 flex items-center justify-center rounded-lg z-10 pointer-events-none"
                    style={{
                      background: "color-mix(in srgb, var(--interactive-base) 10%, transparent)",
                    }}
                  >
                    <span
                      class="text-sm font-medium"
                      style={{ color: "var(--text-interactive-base)" }}
                    >
                      Drop files here
                    </span>
                  </div>
                </Show>

                {/* Drag-to-resize handle */}
                <ResizeHandle
                  direction="vertical"
                  edge="start"
                  size={dragHeight() || (inputRef?.offsetHeight ?? 48)}
                  min={48}
                  max={maxInputHeight()}
                  onResize={(h) => {
                    setDragHeight(h);
                    if (inputRef) inputRef.style.height = `${h}px`;
                  }}
                />

                <textarea
                  ref={inputRef}
                  value={input()}
                  disabled={inputBlocked()}
                  onPaste={handlePaste}
                  onInput={(e) => {
                    handleInputChange(e.currentTarget.value);
                    clampInputHeight(e.currentTarget);
                  }}
                  onKeyDown={(e) => {
                    // Handle slash command navigation first
                    if (showSlashPopover()) {
                      handleInputKeyDown(e);
                      return;
                    }
                    // Tab to cycle agents (when input is empty)
                    if (e.key === "Tab" && !input().trim()) {
                      e.preventDefault();
                      const agents = providers.agents;
                      if (agents.length > 1) {
                        const currentIdx = agents.findIndex(
                          (a) => a.name === providers.selectedAgent,
                        );
                        const nextIdx = e.shiftKey
                          ? (currentIdx - 1 + agents.length) % agents.length
                          : (currentIdx + 1) % agents.length;
                        providers.setSelectedAgent(agents[nextIdx].name);
                      }
                      return;
                    }
                    // Enter to submit (without shift), Shift+Enter for newline
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const form = e.currentTarget.closest("form");
                      if (form) form.requestSubmit();
                    }
                  }}
                  placeholder={inputBlocked() ? "Respond to the prompt above to continue..." : "Type a message... (Tab to switch agent, / for commands)"}
                  rows={1}
                  class="w-full px-4 pt-3 pb-2 focus:outline-none resize-none bg-transparent"
                  style={{
                    color: "var(--text-base)",
                    "min-height": "48px",
                    "max-height": "max(200px, calc(100dvh - 200px))",
                    "overflow-y": "auto",
                  }}
                />

                {/* Bottom bar: attach buttons + session info */}
                <div class="flex items-center px-2 py-1">
                  {/* Attach buttons */}
                  <div class="flex items-center gap-1 shrink-0">
                    {/* Upload from device button */}
                    <button
                      type="button"
                      onClick={() => fileInputRef?.click()}
                      class="p-1.5 rounded transition-colors"
                      style={{ color: "var(--text-weak)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "var(--surface-inset)";
                        e.currentTarget.style.color = "var(--text-strong)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--text-weak)";
                      }}
                      title="Upload image or PDF"
                      aria-label="Upload image or PDF"
                    >
                      <Upload class="w-4 h-4" />
                    </button>
                    {/* Attach file from project button */}
                    <button
                      type="button"
                      onClick={() => setShowFilePicker(true)}
                      class="p-1.5 rounded transition-colors"
                      style={{ color: "var(--text-weak)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "var(--surface-inset)";
                        e.currentTarget.style.color = "var(--text-strong)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--text-weak)";
                      }}
                      title="Attach file from project"
                      aria-label="Attach file from project"
                    >
                      <Paperclip class="w-4 h-4" />
                    </button>
                  </div>

                  {/* Session info: Agent, Model, Token usage */}
                  <div class="flex-1 min-w-0">
                    <SessionInfo
                      input={input}
                      loading={loading}
                      processing={processing}
                      sessionModel={sessionModel}
                      onAbort={handleAbort}
                      onAgentClick={() => setShowAgentPicker(true)}
                      onModelClick={() => setShowModelPicker(true)}
                    />
                  </div>
                </div>
              </div>
            </form>

          </div>
        </div>

        {/* MCP Dialogs */}
        <Show when={showMCPDialog()}>
          <MCPDialog
            onClose={() => setShowMCPDialog(false)}
            onAddServer={() => {
              setShowMCPDialog(false);
              setShowMCPAddDialog(true);
            }}
          />
        </Show>

        <Show when={showMCPAddDialog()}>
          <MCPAddDialog
            onClose={() => setShowMCPAddDialog(false)}
            onBack={() => {
              setShowMCPAddDialog(false);
              setShowMCPDialog(true);
            }}
          />
        </Show>

        {/* Model Picker Dialog */}
        <Show when={showModelPicker()}>
          <PickerDialog
            title="Select Model"
            placeholder="Filter models..."
            emptyMessage="No models found. Connect a provider in settings."
            collapsibleGroups
            items={providers.providers
              .filter((p) => providers.connected.includes(p.id))
              .flatMap((p) =>
                Object.values(p.models).map((m) => ({
                  id: `${p.id}:${m.id}`,
                  title: m.name || m.id,
                  description: `${p.id}/${m.id}`,
                  group: p.name || p.id,
                  groupKey: p.id,
                })),
              )}
            onSelect={(item) => {
              const parts = item.id.split(":");
              const providerID = parts[0];
              const modelID = parts.slice(1).join(":");
              const model = { providerID, modelID };
              // Store per-session and update global default
              const id = sessionId();
              if (id) providers.setSessionModel(id, model);
              providers.setSelectedModel(model);
            }}
            onClose={() => setShowModelPicker(false)}
          />
        </Show>

        <Show when={showVariantPicker() && variantItems().length > 0}>
          <PickerDialog
            title="Select Variant"
            placeholder="Filter variants..."
            emptyMessage="No variants available for this model."
            items={[
              {
                id: "__default__",
                title: "Default",
                description: configuredVariant()
                  ? `Inherit agent default (${configuredVariant()})`
                  : "Inherit agent default",
              },
              ...variantItems().map((name) => ({
                id: name,
                title: name,
                description: configuredVariant() === name ? "Agent default" : undefined,
              })),
            ]}
            onSelect={(item) => {
              if (item.id === "__default__") {
                providers.variant.set(sessionId(), undefined);
                return;
              }
              providers.variant.set(sessionId(), item.id);
            }}
            onClose={() => setShowVariantPicker(false)}
          />
        </Show>

        {/* Agent Picker Dialog */}
        <Show when={showAgentPicker()}>
          <PickerDialog
            title="Select Agent"
            placeholder="Filter agents..."
            emptyMessage="No agents available."
            items={providers.agents.map((a) => ({
              id: a.name,
              title: a.name,
              description: `${a.mode} mode`,
            }))}
            onSelect={(item) => {
              providers.setSelectedAgent(item.id);
            }}
            onClose={() => setShowAgentPicker(false)}
          />
        </Show>

        {/* File Picker Dialog */}
        <Show when={showFilePicker()}>
          <FilePickerDialog
            title="Attach File"
            placeholder="Search files..."
            onSelect={addFileToContext}
            onClose={() => setShowFilePicker(false)}
          />
        </Show>

        {/* Fork Picker Dialog */}
        <Show when={showForkPicker()}>
          <PickerDialog
            title="Fork from Message"
            placeholder="Search messages..."
            emptyMessage="No user messages in this session."
            items={forkPickerItems()}
            onSelect={(item) => {
              const id = sessionId();
              if (!id) return;
              const route = sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id);
              const selected = sync.messages(id).find((message) => message.info.id === item.id);
              const restoredText = selected ? textFromParts(selected.parts, "\n") : "";
              setError(null);
              client.session
                .fork({ sessionID: id, messageID: item.id })
                .then(async (res) => {
                  if (!res.data) {
                    if (route === sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) {
                      setError("Failed to fork session");
                    }
                    return;
                  }
                  if (route !== sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) {
                    await client.session.delete({ sessionID: res.data.id }).catch(() => undefined);
                    return;
                  }
                  setError(null);
                  const forkedId = res.data.id;
                  storeDraft(sessionDraftKey(LOCAL_SERVER_ID, params.dir, forkedId), {
                    text: restoredText,
                    files: [],
                    images: [],
                    height: "",
                    drag: 0,
                  });
                  navigate(`/${dirSlug()}/session/${forkedId}`);
                })
                .catch((err: unknown) => {
                  if (route !== sessionRouteKey(LOCAL_SERVER_ID, directory ?? base64Decode(params.dir), params.id)) return;
                  setError(
                    `Failed to fork session: ${formatStartError(err)}`,
                  );
                });
            }}
            onClose={() => setShowForkPicker(false)}
          />
        </Show>

        {/* Unified toast — only one visible at a time */}
        <Show when={toastMessage()}>
          <div
            class="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg shadow-lg text-sm font-medium"
            role={toastVariant() === "error" ? "alert" : "status"}
            aria-live={toastVariant() === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            style={toastVariant() === "hint"
              ? {
                  background: "var(--surface-inset)",
                  color: "var(--text-strong)",
                  border: "1px solid var(--border-base)",
                }
              : toastVariant() === "error"
                ? {
                    background: "var(--status-danger-dim)",
                    color: "var(--status-danger-text)",
                    border: "1px solid var(--status-danger-text)",
                  }
                : {
                    background: "var(--interactive-base)",
                    color: "white",
                  }}
          >
            {toastMessage()}
          </div>
        </Show>
      </div>
    );
  }

  // Use Show to reactively switch between welcome and chat views
  return (
      <Show when={loadError()} fallback={
        <div class="flex h-full overflow-hidden">
          {/* Main chat area */}
          <div class="flex-1 min-w-0 flex flex-col">
            <ChatView />
          </div>

          {/* Review Panel - collapsible with resize handle */}
          <Show when={layout.review.opened()}>
            <aside class="flex shrink-0" aria-label="Review panel">
              <ResizeHandle
                direction="horizontal"
                edge="start"
                size={layout.review.width()}
                min={200}
                // Computed from viewport width at render time; clamped to never fall below min
                max={Math.max(200, typeof window !== "undefined" ? Math.round(window.innerWidth * 0.8) : 800)}
                onResize={layout.review.resize}
                onCollapse={layout.review.close}
                collapseThreshold={100}
              />
              <div
                data-panel="review"
                tabIndex={-1}
                class="shrink-0 overflow-hidden focus-visible:outline-2 focus-visible:outline-[var(--interactive-base)] focus-visible:outline-offset-[-2px]"
                style={{ width: `${layout.review.width()}px` }}
              >
                <ReviewPanel sessionId={sessionId()!} />
              </div>
            </aside>
          </Show>

          {/* Info Panel (Session Sidebar) - collapsible with resize handle */}
          <Show when={layout.info.opened()}>
            <aside class="flex shrink-0" aria-label="Session info">
              <ResizeHandle
                direction="horizontal"
                edge="start"
                size={layout.info.width()}
                min={180}
                max={400}
                onResize={layout.info.resize}
                onCollapse={layout.info.close}
                collapseThreshold={80}
              />
              <div
                class="shrink-0 overflow-hidden"
                style={{ width: `${layout.info.width()}px` }}
              >
                <SessionSidebar sessionId={sessionId()} />
              </div>
            </aside>
          </Show>
        </div>
      }>
      {(message) => (
        <div class="flex h-full items-center justify-center px-6" style={{ background: "var(--background-stronger)" }}>
          <div class="max-w-md text-center">
            <p class="text-sm mb-4" role="alert" style={{ color: "var(--status-danger-text)" }}>{message()}</p>
            <Button variant="ghost" size="sm" onClick={() => {
              const id = params.id;
              if (!id) return;
              setLoadError(null);
              setLoadingHistory(true);
              void loadSession(id, sessionDraftKey(LOCAL_SERVER_ID, params.dir, id));
            }}>Retry</Button>
          </div>
        </div>
      )}
    </Show>
  );
}
