import {
  createSignal,
  createResource,
  Show,
  For,
  onMount,
  createEffect,
  onCleanup,
  createMemo,
} from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useSDK } from "../context/sdk";
import { useEvents } from "../context/events";
import { useSync } from "../context/sync";
import { useProviders } from "../context/providers";
import { useMCP } from "../context/mcp";
import { usePermission } from "../context/permission";
import { useLayout } from "../context/layout";
import { useBranding } from "../context/branding";
import { useSavedPrompts } from "../context/saved-prompts";
import { useTerminal } from "../context/terminal";
import { useConfig } from "../context/config";
import { MessageTimeline } from "../components/message-timeline";
import { MCPDialog } from "../components/mcp-dialog";
import { MCPAddDialog } from "../components/mcp-add-dialog";
import { PickerDialog } from "../components/picker-dialog";
import { QuestionPrompt } from "../components/question-prompt";
import { PermissionPrompt } from "../components/permission-prompt";
import { SessionInfo } from "../components/session-info";
import { SessionSidebar } from "../components/session-sidebar";
import { ReviewPanel } from "../components/review-panel";
import { SessionHeader } from "../components/session-header";
import { ResizeHandle } from "../components/resize-handle";
import { base64Encode, base64Decode } from "../utils/path";
import type { Part, QuestionRequest, TextPart } from "../sdk/client";
import { Plus, Settings, Paperclip, Upload, Bookmark, BookOpen } from "lucide-solid";
import { Portal } from "solid-js/web";
import { ContextItems, type FileContext } from "../components/context-items";
import { FilePickerDialog } from "../components/file-picker-dialog";
import {
  ImageAttachments,
  type ImageAttachment,
} from "../components/image-attachments";
import { readNotifyMap, writeNotifyMap } from "../utils/notify";
import { sessionQuestionRequest } from "../utils/session-tree-request";

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

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  error?: { name: string; data?: { message?: string } };
}

export function Session() {
  const params = useParams<{ dir: string; id?: string }>();
  const navigate = useNavigate();
  const { client, directory } = useSDK();
  const events = useEvents();
  const sync = useSync();
  const providers = useProviders();
  const mcp = useMCP();
  const permission = usePermission();
  const layout = useLayout();
  const branding = useBranding();
  const savedPrompts = useSavedPrompts();
  const terminal = useTerminal();
  const appConfig = useConfig();

  // Unified toast system — only one toast visible at a time
  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [toastVariant, setToastVariant] = createSignal<"default" | "hint">("default");
  const toastMsgTimer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
  onCleanup(() => { if (toastMsgTimer.id !== null) clearTimeout(toastMsgTimer.id); });

  function hideToast() {
    if (toastMsgTimer.id !== null) clearTimeout(toastMsgTimer.id);
    toastMsgTimer.id = null;
    setToastMessage(null);
  }

  function showToast(msg: string, duration = 2500, variant: "default" | "hint" = "default") {
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

  // Saved prompt picker items for /prompt command
  const promptPickerItems = createMemo(() =>
    savedPrompts.prompts().map((p) => ({
      id: p.id,
      title: p.title,
      description: p.text.length > 80 ? p.text.slice(0, 80) + "..." : p.text,
    })),
  );

  const [input, setInput] = createSignal("");
  const [optimisticMessage, setOptimisticMessage] =
    createSignal<DisplayMessage | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [processing, setProcessing] = createSignal(false);
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  const [sessionId, setSessionId] = createSignal(params.id);

  // Extract text content from message parts with optional separator and truncation
  function textFromParts(parts: Part[], separator = " ", maxLen?: number) {
    const text = parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join(separator);
    if (maxLen && text.length > maxLen) return text.slice(0, maxLen) + "...";
    return text;
  }

  // Set textarea value, trigger auto-grow, and focus — bypasses input handler
  // to avoid slash-command detection when restored text starts with "/"
  function applyInputAndAutogrow(el: HTMLTextAreaElement, text: string) {
    setInput(text);
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    nativeSet?.call(el, text);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    requestAnimationFrame(() => el.focus());
  }

  // Fork picker items: user messages in reverse chronological order
  const forkPickerItems = createMemo(() => {
    const id = sessionId();
    if (!id) return [];
    const msgs = sync.messages(id);
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
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [showPromptPicker, setShowPromptPicker] = createSignal(false);
  const [promptPickerFilter, setPromptPickerFilter] = createSignal("");
  const [showFilePicker, setShowFilePicker] = createSignal(false);
  const [showForkPicker, setShowForkPicker] = createSignal(false);
  const [showSavePrompt, setShowSavePrompt] = createSignal(false);
  const [savePromptTitle, setSavePromptTitle] = createSignal("");
  const [savePromptBody, setSavePromptBody] = createSignal("");

  const [fileContext, setFileContext] = createSignal<FileContext[]>([]);
  const [imageAttachments, setImageAttachments] = createSignal<
    ImageAttachment[]
  >([]);
  const [error, setError] = createSignal<string | null>(null);
  // Use session tree walk to find pending questions from this session or any descendant.
  // This surfaces child/grandchild session questions in the parent session view.
  const pendingQuestion = createMemo(() =>
    sessionQuestionRequest(sync.data.session, events.pendingQuestions, sessionId()) ?? null,
  );
  const [pendingUserMessageText, setPendingUserMessageText] = createSignal<
    string | null
  >(null);

  const pendingPermissions = createMemo(() => permission.pendingForSession(sessionId() ?? ""));
  const inputBlocked = createMemo(() => !!pendingQuestion() || pendingPermissions().length > 0);

  // Double-Escape to abort: track last Escape press timestamp
  const lastEsc = { ts: 0 };

  // --- Notification toggle (per-session, persisted in localStorage) ---
  const [notifyEnabled, setNotifyEnabled] = createSignal(
    (() => {
      const id = params.id;
      if (!id) return false;
      return readNotifyMap()[id] === true;
    })(),
  );
  const [notifyDenied, setNotifyDenied] = createSignal(false);
  const deniedTimer = { id: null as ReturnType<typeof setTimeout> | null };
  onCleanup(() => { if (deniedTimer.id !== null) clearTimeout(deniedTimer.id) });

  // Re-read notification state when session changes
  createEffect(() => {
    const id = params.id;
    setNotifyEnabled(id ? readNotifyMap()[id] === true : false);
    setNotifyDenied(false);
  });

  function toggleNotify() {
    const id = sessionId();
    if (!id) return;

    // Turning off
    if (notifyEnabled()) {
      const map = readNotifyMap();
      delete map[id];
      writeNotifyMap(map);
      setNotifyEnabled(false);
      setNotifyDenied(false);
      return;
    }

    // Turning on — check permission
    if (typeof window === "undefined" || !("Notification" in window)) return;

    const perm = Notification.permission;
    if (perm === "granted") {
      const map = readNotifyMap();
      map[id] = true;
      writeNotifyMap(map);
      setNotifyEnabled(true);
      return;
    }
    if (perm === "denied") {
      setNotifyDenied(true);
      if (deniedTimer.id !== null) clearTimeout(deniedTimer.id);
      deniedTimer.id = setTimeout(() => setNotifyDenied(false), 4000);
      return;
    }
    // permission === "default" — request
    Notification.requestPermission().then((result) => {
      if (result === "granted") {
        const map = readNotifyMap();
        map[id] = true;
        writeNotifyMap(map);
        setNotifyEnabled(true);
        return;
      }
      if (result === "denied") {
        setNotifyDenied(true);
        if (deniedTimer.id !== null) clearTimeout(deniedTimer.id);
        deniedTimer.id = setTimeout(() => setNotifyDenied(false), 4000);
      }
    });
  }

  // Track whether the agent was genuinely processing (not initial load)
  const wasProcessing = { value: false };

  // Keep sessionId in sync with URL params and sync session data
  createEffect(() => {
    const id = params.id;
    console.log("[Session] URL param changed:", id);
    setSessionId(id);
    setPendingUserMessageText(null); // Clear pending text on session change
    setFileContext([]); // Clear file context on session change
    setImageAttachments([]); // Clear image attachments on session change
    setPromptSent(false); // Reset so pending prompts fire in the new session
    wasProcessing.value = false; // Reset to avoid false notifications
    if (id) {
      // Use sync context to load session data - no local state needed
      setLoadingHistory(true);
      setProcessing(false); // Reset processing state for new session
      sync.session.sync(id).then(() => {
        setLoadingHistory(false);
      });

      // Check if this session is actually busy
      client.session
        .status({})
        .then((res: { data?: Record<string, { type: string }> }) => {
          const statuses = res.data;
          if (!statuses) return;
          if (statuses[id]) {
            const isBusy =
              statuses[id].type === "busy" || statuses[id].type === "retry";
            console.log(
              "[Session] Initial status for",
              id,
              ":",
              statuses[id].type,
              "isBusy:",
              isBusy,
            );
            if (isBusy) wasProcessing.value = true;
            setProcessing(isBusy);
          }
        });
    } else {
      setLoadingHistory(false);
      setProcessing(false);
    }
  });

  // Auto-send saved prompt stored in sessionStorage by layout's createSessionWithPrompt.
  // We read from sessionStorage instead of URL params to avoid browser URL length limits.
  // The stored value is JSON: { text: string, ts: number }.
  // Guard: the effect may re-run when reactive deps (e.g. providers.connected) update
  // after the prompt has already been sent. A local signal prevents double sends.
  const [promptSent, setPromptSent] = createSignal(false);
  createEffect(() => {
    if (promptSent()) return;
    const id = params.id;
    if (!id) return;
    const key = `opencode.pendingPrompt.${id}`;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    const EXPIRY_MS = 60_000; // 60 seconds
    const parsed = (() => {
      try { return JSON.parse(raw) as { text: string; ts: number }; }
      catch { return null; }
    })();
    // Remove malformed or expired entries immediately
    if (!parsed || !parsed.text || Date.now() - parsed.ts > EXPIRY_MS) {
      sessionStorage.removeItem(key);
      return;
    }
    const text = parsed.text;
    // Provider data may not be available yet — the resource fetch is async and
    // selectedModel is populated from localStorage in an onMount callback that
    // runs after createEffect. Skip without removing the sessionStorage item so
    // the effect re-runs once providers finish loading.
    if (providers.loading || providers.providers.length === 0) return;
    if (!providers.selectedModel) {
      sessionStorage.removeItem(key);
      setError("Please select a model before sending messages. Click the model button in the header.");
      return;
    }
    if (!providers.connected.includes(providers.selectedModel.providerID)) {
      sessionStorage.removeItem(key);
      setError(`Provider "${providers.selectedModel.providerID}" is not connected. Please configure it in Settings.`);
      return;
    }
    // All validation passed — mark as sent, clear storage, and send
    setPromptSent(true);
    sessionStorage.removeItem(key);
    setError(null);
    startProcessing();
    client.session.promptAsync({
      sessionID: id,
      parts: [{ type: "text", text }],
      agent: providers.selectedAgent || "build",
      model: providers.selectedModel,
    }).catch((err: unknown) => {
      setError(`Failed to send saved prompt: ${err instanceof Error ? err.message : String(err)}`);
      setProcessing(false);
    });
  });

  // Get messages from sync context - reactive, automatically updated via SSE
  // Cache the base messages array to avoid recreating on every call
  const syncMessages = createMemo(() => {
    const id = sessionId();
    if (!id) return [];
    return sync.messages(id).map((msg) => ({
      id: msg.info.id,
      role: msg.info.role as "user" | "assistant",
      parts: msg.parts,
      error: (msg.info as { error?: DisplayMessage["error"] }).error,
    }));
  });

  // Includes optimistic message if present and not yet in sync
  const messages = createMemo(() => {
    const syncMsgs = syncMessages();
    if (syncMsgs.length === 0 && !optimisticMessage()) return syncMsgs;

    // Add optimistic message if it exists and isn't already in sync
    const opt = optimisticMessage();
    if (opt) {
      // Check if the pending user message text matches any message in sync
      const pendingText = pendingUserMessageText();
      if (pendingText) {
        const alreadyInSync = syncMsgs.some((m) => {
          if (m.role !== "user") return false;
          // Check all text parts for a match
          return m.parts
            .filter((p) => p.type === "text")
            .some(
              (p) =>
                (p as { text?: string }).text?.trim() === pendingText.trim(),
            );
        });
        if (!alreadyInSync) {
          return [...syncMsgs, opt];
        }
      }
    }
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
    const lastUserMsg = (() => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") return msgs[i];
      }
      return undefined;
    })();

    const commands: Command[] = [
      {
        id: "session.new",
        title: "New Session",
        description: "Create a new chat session",
        slash: "new",
        onSelect: async () => {
          console.log("[Command] New session - creating...");
          try {
            const res = await client.session.create({});
            if (res.data) {
              console.log("[Command] Created session:", res.data.id);
              navigate(`/${dirSlug()}/session/${res.data.id}`);
            }
          } catch (err) {
            showToast(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
          }
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
        id: "prompt.pick",
        title: "Insert Saved Prompt",
        description: "Insert a saved prompt into the input",
        slash: "prompt",
        onSelect: () => {
          setPromptPickerFilter("");
          setShowPromptPicker(true);
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

    // /compact — requires a session with messages and a selected model
    if (id && hasMessages && !isProcessing && providers.selectedModel) {
      commands.push({
        id: "session.compact",
        title: "Compact Session",
        description: "Summarize conversation to free up context space",
        slash: "compact",
        onSelect: async () => {
          if (!id) return;
          const model = providers.selectedModel;
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
            showToast(`Failed to compact session: ${err instanceof Error ? err.message : String(err)}`);
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
          try {
            const res = await client.session.share({ sessionID: id });
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
            refetchSession();
          } catch (err) {
            showToast(`Failed to share session: ${err instanceof Error ? err.message : String(err)}`);
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
          try {
            await client.session.unshare({ sessionID: id });
            showToast("Session unshared");
            refetchSession();
          } catch (err) {
            showToast(`Failed to unshare session: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
    }

    // /undo — requires a session with at least one user message
    // Allowed during processing so abort-then-revert flow works
    if (id && lastUserMsg) {
      commands.push({
        id: "session.undo",
        title: "Undo Last Message",
        description: "Revert the last user message and restore its text",
        slash: "undo",
        onSelect: async () => {
          if (!id || !lastUserMsg) return;
          try {
            // If processing, abort first (clears pendingQuestion too)
            if (processing()) {
              await handleAbort();
            }
            await client.session.revert({
              sessionID: id,
              messageID: lastUserMsg.id,
            });
            // Restore the reverted message text into the input field
            const textPart = lastUserMsg.parts.find((p) => p.type === "text") as
              | { type: "text"; text?: string }
              | undefined;
            if (textPart?.text) {
              setInput(textPart.text);
              requestAnimationFrame(() => {
                if (inputRef) {
                  inputRef.style.height = "auto";
                  inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + "px";
                  inputRef.focus();
                }
              });
            }
            showToast("Message undone");
            refetchSession();
          } catch (err) {
            showToast(`Failed to undo message: ${err instanceof Error ? err.message : String(err)}`);
          }
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
          try {
            await client.session.unrevert({ sessionID: id });
            setInput("");
            showToast("Messages restored");
            refetchSession();
          } catch (err) {
            showToast(`Failed to redo messages: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
    }

    return commands;
  });

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

    // Detect `/prompt <search>` — auto-open prompt picker with filter
    const promptMatch = value.match(/^\/prompt\s+(.*)$/i);
    if (promptMatch) {
      setInput("");
      setShowSlashPopover(false);
      setSlashQuery("");
      setPromptPickerFilter(promptMatch[1].trim());
      setShowPromptPicker(true);
      return;
    }

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
      showAgentPicker() ||
      showPromptPicker() ||
      showFilePicker() ||
      showForkPicker() ||
      showSavePrompt()
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

  // Refetch is now just re-syncing
  const refetchSession = async () => {
    const id = params.id;
    if (id) await sync.session.sync(id);
  };

  // Clear stale localStorage key when sessions are loaded and ID is not found
  createEffect(() => {
    const id = params.id;
    if (!id) return;
    // loadingHistory() stays true when sync.session.sync() rejects,
    // so this effect only fires after a successful sync — not on transient failures.
    if (loadingHistory()) return;
    const found = sync.session.get(id);
    // Non-archived session exists — keep it
    if (found && !found.time?.archived) return;
    // For archived sessions: only treat as stale when it matches the stored last-session
    // (allows direct navigation to archived sessions from the sidebar)
    if (found?.time?.archived) {
      try {
        const dir = directory || base64Decode(params.dir);
        if (dir && typeof window !== "undefined") {
          const key = `opencode.lastSession.${dir}`;
          const stored = window.localStorage.getItem(key);
          if (stored === id) {
            window.localStorage.removeItem(key);
            navigate(`/${dirSlug()}/session`, { replace: true });
          }
        }
      } catch (err) {
        console.warn("[Session] localStorage error:", err);
      }
      return;
    }
    // Session not found at all: clear and redirect
    try {
      const dir = directory || base64Decode(params.dir);
      if (dir && typeof window !== "undefined") {
        const key = `opencode.lastSession.${dir}`;
        const stored = window.localStorage.getItem(key);
        if (stored === id) window.localStorage.removeItem(key);
      }
    } catch (err) {
      console.warn("[Session] localStorage error:", err);
    }
    navigate(`/${dirSlug()}/session`, { replace: true });
  });

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
        window.localStorage.setItem(`opencode.lastSession.${dir}`, id);
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
    const unsub = events.subscribe(
      (event: { type: string; properties: Record<string, unknown> }) => {
        const id = sessionId();
        if (!id) return;

        // Handle message part updates - clear optimistic message when user message is echoed
        if (event.type === "message.part.updated") {
          const part = event.properties.part as {
            sessionID: string;
            type: string;
            text?: string;
          };
          if (part.sessionID !== id) return;

          // Check if this is the backend echo of the user message we just sent
          const pendingText = pendingUserMessageText();
          if (
            pendingText &&
            part.type === "text" &&
            part.text?.trim() === pendingText.trim()
          ) {
            console.log(
              "[Session] User message echoed from server, clearing optimistic message",
            );
            setPendingUserMessageText(null);
            setOptimisticMessage(null);
          }
        }

        // Handle status changes
        if (event.type === "session.status") {
          const props = event.properties as {
            sessionID: string;
            status: { type: string };
          };
          if (props.sessionID === id && props.status.type === "idle") {
            console.log("[Session] Status idle");
            // Only clear optimistic message if no pending text or it was already matched
            if (!pendingUserMessageText()) {
              setOptimisticMessage(null);
            }
            setPendingUserMessageText(null);

            // Reset local processing tracker (notifications now handled globally in Layout)
            wasProcessing.value = false;
            setProcessing(false);
          } else if (props.sessionID === id) {
            wasProcessing.value = true;
            setProcessing(true);
          }
        }

        // Handle session updates
        if (event.type === "session.updated") {
          refetchSession();
        }
      },
    );

    return unsub;
  });

  // Question tracking is now handled via the global events.pendingQuestions store
  // (seeded via HTTP and updated via SSE in EventProvider) combined with the
  // sessionQuestionRequest tree-walk memo defined above. This surfaces questions
  // from child/grandchild sessions automatically without per-session SSE subscriptions.

  async function handleQuestionReply(answers: string[][]) {
    const q = pendingQuestion();
    if (!q) return;

    try {
      // Use the question's own requestID — may belong to a child session
      await client.question.reply({ requestID: q.id, answers, directory });
      // Optimistically clear so the UI unblocks without waiting for SSE
      events.dismissQuestion(q.sessionID);
    } catch (e) {
      console.error("[Session] Failed to reply to question:", e);
    }
  }

  async function handleQuestionReject() {
    const q = pendingQuestion();
    if (!q) return;

    try {
      await client.question.reject({ requestID: q.id, directory });
      events.dismissQuestion(q.sessionID);
    } catch (e) {
      console.error("[Session] Failed to reject question:", e);
    }
  }

  async function handleAbort() {
    const id = sessionId();
    if (!id) return;

    try {
      console.log("[Session] Aborting session:", id);
      await client.session.abort({ sessionID: id, directory });
      setProcessing(false);
      // Optimistically dismiss any pending question (own or descendant) so the
      // composer unblocks immediately without waiting for SSE confirmation.
      const q = pendingQuestion();
      if (q) events.dismissQuestion(q.sessionID);
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

  async function sendMessage(e: SubmitEvent) {
    e.preventDefault();
    const text = input().trim();
    const files = fileContext();
    const images = imageAttachments();
    if ((!text && files.length === 0 && images.length === 0) || loading() || inputBlocked())
      return;

    // Require explicit model selection to avoid OpenCode auto-selecting a broken provider
    if (!providers.selectedModel) {
      setError(
        "Please select a model before sending messages. Click the model button in the header.",
      );
      return;
    }

    // Check if the selected model's provider is connected
    if (!providers.connected.includes(providers.selectedModel.providerID)) {
      setError(
        `Provider "${providers.selectedModel.providerID}" is not connected. Please configure it in Settings.`,
      );
      return;
    }

    setError(null);
    setLoading(true);
    setInput("");
    setFileContext([]); // Clear file context after sending
    setImageAttachments([]); // Clear image attachments after sending

    // Track pending user message text to match backend echoes
    setPendingUserMessageText(text);

    // Optimistic update - show user message immediately while waiting for server
    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: sessionId() || "",
          messageID: "",
          type: "text",
          text: text || "(files attached)",
        },
      ] as Part[],
    };
    setOptimisticMessage(userMessage);

    try {
      let id = sessionId();

      if (!id) {
        console.log("[Session] Creating new session...");
        const createRes = await client.session.create({});
        console.log("[Session] Create response:", createRes);
        if (!createRes.data) throw new Error("Failed to create session");

        id = createRes.data.id;
        setSessionId(id);
        navigate(`/${dirSlug()}/session/${id}`, { replace: true });
      }

      // Build parts array with text and file attachments
      // Always include a text part (even if empty) to ensure SSE reconciliation works
      const parts: (
        | { type: "text"; text: string }
        | { type: "file"; mime: string; url: string; filename: string }
      )[] = [{ type: "text", text: text || "" }];

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
          type: "file",
          mime: "text/plain",
          url: `file://${encoded}`,
          filename,
        });
      }

      // Add image/PDF attachments from device uploads
      for (const img of images) {
        parts.push({
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
        parts: typeof parts;
        agent: string;
        model?: { providerID: string; modelID: string };
      } = {
        sessionID: id,
        parts,
        agent: providers.selectedAgent || "build",
      };

      if (providers.selectedModel) {
        promptPayload.model = providers.selectedModel;
      }

      const promptRes = await client.session.promptAsync(promptPayload);
      console.log("[Session] Prompt response:", promptRes);

      // Start processing - SSE events will handle updates and completion
      startProcessing();
    } catch (err) {
      console.error("[Session] Error sending message:", err);
      setError(
        `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function createSessionAndSendPrompt(text: string) {
    if (!providers.selectedModel) {
      setError("Please select a model before sending messages. Click the model button in the header.");
      return;
    }
    if (!providers.connected.includes(providers.selectedModel.providerID)) {
      setError(`Provider "${providers.selectedModel.providerID}" is not connected. Please configure it in Settings.`);
      return;
    }
    setError(null);
    try {
      const res = await client.session.create({});
      if (!res.data) return;
      const sid = res.data.id;
      setSessionId(sid);
      navigate(`/${dirSlug()}/session/${sid}`, { replace: true });
      await client.session.promptAsync({
        sessionID: sid,
        parts: [{ type: "text", text }],
        agent: providers.selectedAgent || "build",
        model: providers.selectedModel,
      });
    } catch (err) {
      setError(`Failed to send saved prompt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Welcome screen component for when no session is selected
  function WelcomeScreen() {
    const savedPrompts = useSavedPrompts();

    return (
      <div
        class="flex flex-col h-full"
        style={{ background: "var(--background-stronger)" }}
      >
        <div class="flex flex-col items-center justify-center flex-1 text-center px-6">
          {/* OpenCode Logo */}
          <div class="mb-8">
            <svg
              class="w-80 mx-auto opacity-60"
              style={{ color: "var(--text-strong)" }}
              viewBox="0 0 640 115"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g clip-path="url(#clip0_welcome)">
                <mask
                  id="mask0_welcome"
                  style="mask-type:luminance"
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width="640"
                  height="115"
                >
                  <path d="M640 0H0V115H640V0Z" fill="white" />
                </mask>
                <g mask="url(#mask0_welcome)">
                  <path
                    d="M49.2346 82.1433H16.4141V49.2861H49.2346V82.1433Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M49.2308 32.8573H16.4103V82.143H49.2308V32.8573ZM65.641 98.5716H0V16.4287H65.641V98.5716Z"
                    fill="var(--text-weak)"
                  />
                  <path
                    d="M131.281 82.1433H98.4609V49.2861H131.281V82.1433Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M98.4649 82.143H131.285V32.8573H98.4649V82.143ZM147.696 98.5716H98.4649V115H82.0547V16.4287H147.696V98.5716Z"
                    fill="var(--text-weak)"
                  />
                  <path
                    d="M229.746 65.7139V82.1424H180.516V65.7139H229.746Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M229.743 65.7144H180.512V82.143H229.743V98.5716H164.102V16.4287H229.743V65.7144ZM180.512 49.2859H213.332V32.8573H180.512V49.2859Z"
                    fill="var(--text-weak)"
                  />
                  <path
                    d="M295.383 98.5718H262.562V49.2861H295.383V98.5718Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M295.387 32.8573H262.567V98.5716H246.156V16.4287H295.387V32.8573ZM311.797 98.5716H295.387V32.8573H311.797V98.5716Z"
                    fill="var(--text-weak)"
                  />
                  <path
                    d="M393.848 82.1433H344.617V49.2861H393.848V82.1433Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M393.844 32.8573H344.613V82.143H393.844V98.5716H328.203V16.4287H393.844V32.8573Z"
                    fill="currentColor"
                  />
                  <path
                    d="M459.485 82.1433H426.664V49.2861H459.485V82.1433Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M459.489 32.8573H426.668V82.143H459.489V32.8573ZM475.899 98.5716H410.258V16.4287H475.899V98.5716Z"
                    fill="currentColor"
                  />
                  <path
                    d="M541.539 82.1433H508.719V49.2861H541.539V82.1433Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M541.535 32.8571H508.715V82.1428H541.535V32.8571ZM557.946 98.5714H492.305V16.4286H541.535V0H557.946V98.5714Z"
                    fill="currentColor"
                  />
                  <path
                    d="M639.996 65.7139V82.1424H590.766V65.7139H639.996Z"
                    fill="var(--icon-weak)"
                  />
                  <path
                    d="M590.77 32.8573V49.2859H623.59V32.8573H590.77ZM640 65.7144H590.77V82.143H640V98.5716H574.359V16.4287H640V65.7144Z"
                    fill="currentColor"
                  />
                </g>
              </g>
              <defs>
                <clipPath id="clip0_welcome">
                  <rect width="640" height="115" fill="white" />
                </clipPath>
              </defs>
            </svg>
          </div>

          <Show when={branding.enabled}>
            <div
              class="flex items-center justify-center gap-2 mb-8"
              style={{ color: "var(--text-weak)" }}
            >
              <span>Powered by</span>
              <Show
                when={branding.url}
                fallback={
                  <span class="font-medium" style={{ color: "var(--text-strong)" }}>
                    {branding.name}
                  </span>
                }
              >
                <a
                  href={branding.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-medium transition-opacity hover:opacity-80"
                  style={{ color: "var(--text-interactive-base)" }}
                >
                  {branding.name}
                </a>
              </Show>
            </div>
          </Show>

          {/* Action buttons */}
          <div class="flex flex-col gap-3 w-full max-w-xs">
            <Button
              onClick={async () => {
                console.log(
                  "[Welcome] New Session clicked, directory:",
                  directory,
                  "dirSlug:",
                  dirSlug(),
                );
                if (!directory) {
                  console.error("[Welcome] No directory available");
                  return;
                }
                try {
                  console.log("[Welcome] Creating session...");
                  const res = await client.session.create({});
                  console.log("[Welcome] Create response:", res);
                  if (res.data) {
                    const url = `/${dirSlug()}/session/${res.data.id}`;
                    console.log("[Welcome] Navigating to:", url);
                    navigate(url);
                  }
                } catch (e) {
                  console.error("[Welcome] Failed to create session:", e);
                }
              }}
              variant="ghost"
              class="w-full"
              size="sm"
            >
              <Plus class="w-4 h-4" />
              <span>New Session</span>
            </Button>

            <Button
              onClick={() => navigate(`/${dirSlug()}/settings`)}
              variant="ghost"
              class="w-full"
              size="sm"
            >
              <Settings class="w-4 h-4" />
              <span>Settings</span>
            </Button>
          </div>

          {/* Instructions active indicator */}
          <Show when={instructionsActive()}>
            <button
              type="button"
              onClick={() => navigate(`/${dirSlug()}/settings#instructions`)}
              class="mt-4 flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors mx-auto"
              style={{
                border: "1px solid var(--border-base)",
                color: "var(--text-base)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--surface-inset)";
                e.currentTarget.style.borderColor = "var(--interactive-base)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "var(--border-base)";
              }}
            >
              <BookOpen class="w-4 h-4" style={{ color: "var(--icon-success-base)" }} />
              <span>Project instructions active</span>
            </button>
          </Show>

          {/* Saved Prompts */}
          <Show when={savedPrompts.prompts().length > 0}>
            <div class="mt-8 w-full max-w-2xl">
              <h3
                class="text-sm font-medium mb-3 text-left"
                style={{ color: "var(--text-weak)" }}
              >
                Saved Prompts
              </h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <For each={savedPrompts.prompts()}>
                  {(prompt) => (
                    <button
                      type="button"
                      onClick={() => createSessionAndSendPrompt(prompt.text)}
                      class="p-3 rounded-lg text-left transition-colors"
                      style={{
                        background: "var(--background-base)",
                        border: "1px solid var(--border-base)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--interactive-base)";
                        e.currentTarget.style.background = "var(--surface-inset)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border-base)";
                        e.currentTarget.style.background = "var(--background-base)";
                      }}
                    >
                      <div
                        class="text-sm font-medium truncate"
                        style={{ color: "var(--text-strong)" }}
                      >
                        {prompt.title}
                      </div>
                      <div
                        class="text-xs mt-1 line-clamp-2"
                        style={{ color: "var(--text-weak)" }}
                      >
                        {prompt.text.length > 100
                          ? prompt.text.slice(0, 100) + "..."
                          : prompt.text}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <p
            class="mt-10 text-sm"
            style={{ color: "var(--text-weak)", opacity: 0.7 }}
          >
            Select a session from the sidebar or start a new one
          </p>
        </div>
      </div>
    );
  }

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
          processing={processing()}
          onOpenMCPDialog={() => setShowMCPDialog(true)}
          notifyEnabled={notifyEnabled()}
          notifyDenied={notifyDenied()}
          onToggleNotify={toggleNotify}
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
          <Show when={pendingQuestion()}>
            {(q) => (
              <div
                class="px-6 pb-4"
                style={{ background: "var(--background-stronger)" }}
              >
                <Show when={q().sessionID !== sessionId()}>
                  <div
                    class="text-xs mb-2 px-1"
                    style={{ color: "var(--text-dimmed)" }}
                  >
                    Question from sub-agent
                  </div>
                </Show>
                <QuestionPrompt
                  request={q()}
                  onReply={handleQuestionReply}
                  onReject={handleQuestionReject}
                />
              </div>
            )}
          </Show>

          {/* Permission Prompt - rendered outside timeline for proper focus */}
          <Show when={pendingPermissions().length > 0}>
            <div
              class="px-6 pb-4"
              style={{ background: "var(--background-stronger)" }}
            >
              <PermissionPrompt
                requests={pendingPermissions()}
                onRespond={permission.respond}
                onAutoAccept={permission.enableAutoAccept}
                autoAcceptEnabled={permission.autoAcceptEnabled()}
              />
            </div>
          </Show>
        </div>

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

                <textarea
                  ref={inputRef}
                  value={input()}
                  disabled={inputBlocked()}
                  onPaste={handlePaste}
                  onInput={(e) => {
                    handleInputChange(e.currentTarget.value);
                    // Auto-grow: reset height then set to scrollHeight
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height =
                      Math.min(e.currentTarget.scrollHeight, 200) + "px";
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
                    "max-height": "200px",
                    "overflow-y": "auto",
                  }}
                />

                {/* Bottom bar: attach buttons + session info */}
                <div class="flex items-center px-2 py-1">
                  {/* Attach buttons */}
                  <div class="flex items-center gap-1 shrink-0">
                    {/* Save as prompt button */}
                    <Show when={input().trim()}>
                      <button
                        type="button"
                        onClick={() => {
                          const text = input().trim();
                          if (!text) return;
                          setSavePromptTitle(text.slice(0, 30));
                          setSavePromptBody(text);
                          setShowSavePrompt(true);
                        }}
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
                        title="Save as prompt"
                        aria-label="Save as prompt"
                      >
                        <Bookmark class="w-4 h-4" />
                      </button>
                    </Show>
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
            items={providers.providers
              .filter((p) => providers.connected.includes(p.id))
              .flatMap((p) =>
                Object.values(p.models).map((m) => ({
                  id: `${p.id}:${m.id}`,
                  title: m.name || m.id,
                  description: `${p.id}/${m.id}`,
                  group: p.name,
                })),
              )}
            onSelect={(item) => {
              const parts = item.id.split(":");
              const providerID = parts[0];
              const modelID = parts.slice(1).join(":");
              providers.setSelectedModel({ providerID, modelID });
            }}
            onClose={() => setShowModelPicker(false)}
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

        {/* Saved Prompt Picker Dialog */}
        <Show when={showPromptPicker()}>
          <PickerDialog
            title="Insert Saved Prompt"
            placeholder="Filter prompts..."
            emptyMessage="No saved prompts. Add them in Settings."
            initialFilter={promptPickerFilter()}
            items={promptPickerItems()}
            onSelect={(item) => {
              const found = savedPrompts.prompts().find((p) => p.id === item.id);
              if (!found) return;
              if (inputRef) applyInputAndAutogrow(inputRef, found.text);
            }}
            onClose={() => setShowPromptPicker(false)}
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
              setError(null);
              client.session
                .fork({ sessionID: id, messageID: item.id })
                .then((res) => {
                  if (!res.data) {
                    setError("Failed to fork session");
                    return;
                  }
                  setError(null);
                  const forkedId = res.data.id;
                  // Find the selected message text to restore in the new session's input
                  const msgs = sync.messages(id);
                  const selected = msgs.find((m) => m.info.id === item.id);
                  const restoredText = selected
                    ? textFromParts(selected.parts, "\n")
                    : "";
                  navigate(`/${dirSlug()}/session/${forkedId}`);
                  // Restore the message text into the new session's input after navigation
                  if (inputRef) {
                    requestAnimationFrame(() => {
                      applyInputAndAutogrow(inputRef!, restoredText);
                    });
                  }
                })
                .catch((err: unknown) => {
                  setError(
                    `Failed to fork session: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
            }}
            onClose={() => setShowForkPicker(false)}
          />
        </Show>

        {/* Save Prompt Dialog */}
        <Show when={showSavePrompt()}>
          <SavePromptDialog
            title={savePromptTitle}
            setTitle={setSavePromptTitle}
            onSave={() => {
              const title = savePromptTitle().trim();
              const body = savePromptBody();
              if (!title || !body) return;
              savedPrompts.add(title, body);
              setShowSavePrompt(false);
              showToast("Prompt saved");
            }}
            onClose={() => setShowSavePrompt(false)}
          />
        </Show>

        {/* Unified toast — only one visible at a time */}
        <Show when={toastMessage()}>
          <div
            class="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg shadow-lg text-sm font-medium"
            style={toastVariant() === "hint"
              ? {
                  background: "var(--surface-inset)",
                  color: "var(--text-strong)",
                  border: "1px solid var(--border-base)",
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
    <Show when={sessionId()} fallback={<WelcomeScreen />}>
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
    </Show>
  );
}

function SavePromptDialog(props: {
  title: () => string
  setTitle: (v: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const [container, setContainer] = createSignal<HTMLDivElement>();
  let titleRef: HTMLInputElement | undefined;

  createEffect(() => {
    const el = container();
    if (!el) return;

    // Focus title input on open
    titleRef?.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = el!.querySelectorAll<HTMLElement>(
        'input, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKey);
    onCleanup(() => document.removeEventListener("keydown", handleKey));
  });

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.5)" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
        role="presentation"
      >
        <div
          ref={setContainer}
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-prompt-dialog-title"
          class="w-full max-w-sm rounded-lg shadow-xl overflow-hidden"
          style={{
            background: "var(--background-base)",
            border: "1px solid var(--border-base)",
          }}
        >
          <div
            class="px-4 py-3"
            style={{
              "border-bottom": "1px solid var(--border-base)",
            }}
          >
            <h2
              id="save-prompt-dialog-title"
              class="text-base font-medium"
              style={{ color: "var(--text-strong)" }}
            >
              Save as Prompt
            </h2>
          </div>
          <div class="p-4 space-y-3">
            <div>
              <label
                class="block text-sm font-medium mb-1"
                style={{ color: "var(--text-base)" }}
              >
                Title
              </label>
              <input
                ref={titleRef}
                type="text"
                value={props.title()}
                onInput={(e) =>
                  props.setTitle(e.currentTarget.value)
                }
                placeholder="Prompt title"
                class="w-full px-3 py-2 rounded-md text-sm"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                  color: "var(--text-base)",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    props.onSave();
                  }
                }}
              />
            </div>
            <p class="text-xs" style={{ color: "var(--text-weak)" }}>
              The current input text will be saved as the prompt body.
            </p>
          </div>
          <div
            class="px-4 py-3 flex justify-end gap-2"
            style={{
              "border-top": "1px solid var(--border-base)",
            }}
          >
            <button
              type="button"
              onClick={props.onClose}
              class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
              style={{
                background: "var(--surface-inset)",
                color: "var(--text-base)",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!props.title().trim()}
              onClick={props.onSave}
              class="px-4 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              style={{
                background: "var(--interactive-base)",
                color: "white",
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

