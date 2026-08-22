import {
  createContext,
  useContext,
  createSignal,
  type ParentProps,
} from "solid-js";
import { useSDK } from "./sdk";
import { useServer } from "./server";
import { legacyStorageValue, workspaceStorageKey } from "../utils/storage";

const LAYOUT_STORAGE_KEY = "opencode.layout";

// Default values
const DEFAULT_REVIEW_WIDTH = 320;
const DEFAULT_INFO_WIDTH = 256;
const DEFAULT_SIDEBAR_WIDTH = 256;
const DEFAULT_REVIEW_MODE = "session";
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export type ReviewMode = "session" | "git" | "branch" | "turn";

interface PanelState {
  opened: boolean;
  width?: number;
}

export type FileTab = {
  path: string;
  name: string;
};

interface LayoutState {
  review: PanelState;
  info: PanelState;
  sidebar: { width?: number };
  reviewMode?: ReviewMode;
  tabs?: FileTab[];
  activeTab?: string | null; // null = Review tab, string = file path
}

interface LayoutContextValue {
  // Review panel (diff viewer)
  review: {
    opened: () => boolean;
    width: () => number;
    mode: () => ReviewMode;
    toggle: () => void;
    open: () => void;
    close: () => void;
    resize: (width: number) => void;
    setMode: (mode: ReviewMode) => void;
  };
  // Info panel (todos, context usage)
  info: {
    opened: () => boolean;
    width: () => number;
    toggle: () => void;
    open: () => void;
    close: () => void;
    resize: (width: number) => void;
  };
  // Sidebar panel (sessions list)
  sidebar: {
    width: () => number;
    resize: (width: number) => void;
  };
  // File tabs
  tabs: {
    all: () => FileTab[];
    active: () => string | null;
    open: (path: string) => void;
    close: (path: string) => void;
    setActive: (path: string | null) => void;
  };
}

const LayoutContext = createContext<LayoutContextValue>();

function isReviewMode(value: unknown): value is ReviewMode {
  return value === "session" || value === "git" || value === "branch" || value === "turn";
}

function basename(path: string) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function parseState(stored: string): LayoutState | undefined {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const value = parsed as Record<string, unknown>;
    const rawTabs = Array.isArray(value.tabs) ? value.tabs : [];
    const tabs = rawTabs.flatMap((item): FileTab[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const tab = item as Record<string, unknown>;
      if (typeof tab.path !== "string" || typeof tab.name !== "string") return [];
      return [{ path: tab.path, name: tab.name }];
    });
    const review = value.review && typeof value.review === "object" ? value.review as Record<string, unknown> : {};
    const info = value.info && typeof value.info === "object" ? value.info as Record<string, unknown> : {};
    const sidebar = value.sidebar && typeof value.sidebar === "object" ? value.sidebar as Record<string, unknown> : {};
    const tabPaths = new Set(tabs.map((tab) => tab.path));
    return {
      review: {
        opened: typeof review.opened === "boolean" ? review.opened : false,
        width: typeof review.width === "number" && Number.isFinite(review.width) ? review.width : DEFAULT_REVIEW_WIDTH,
      },
      info: {
        opened: typeof info.opened === "boolean" ? info.opened : false,
        width: typeof info.width === "number" && Number.isFinite(info.width) ? info.width : DEFAULT_INFO_WIDTH,
      },
      sidebar: {
        width: typeof sidebar.width === "number" && Number.isFinite(sidebar.width) ? sidebar.width : DEFAULT_SIDEBAR_WIDTH,
      },
      reviewMode: isReviewMode(value.reviewMode) ? value.reviewMode : DEFAULT_REVIEW_MODE,
      tabs,
      activeTab: typeof value.activeTab === "string" && tabPaths.has(value.activeTab) ? value.activeTab : null,
    };
  } catch {
    return;
  }
}

function defaultState(): LayoutState {
  return {
    review: { opened: false, width: DEFAULT_REVIEW_WIDTH },
    info: { opened: false, width: DEFAULT_INFO_WIDTH },
    sidebar: { width: DEFAULT_SIDEBAR_WIDTH },
    reviewMode: DEFAULT_REVIEW_MODE,
    tabs: [],
    activeTab: null,
  };
}

function loadState(key: string, serverId: string): LayoutState {
  try {
    const current = localStorage.getItem(key);
    const validCurrent = current && parseState(current) ? current : null;
    if (current && !validCurrent) localStorage.removeItem(key);
    const legacy = serverId === "local" ? [localStorage.getItem(LAYOUT_STORAGE_KEY)] : [];
    const result = legacyStorageValue(serverId, validCurrent, legacy, (value) => parseState(value) !== undefined);
    if (result.migrated && result.value) localStorage.setItem(key, result.value);
    return result.value ? parseState(result.value) ?? defaultState() : defaultState();
  } catch (e) {
    console.error("[Layout] Failed to load state:", e);
    return defaultState();
  }
}

export function LayoutProvider(props: ParentProps) {
  const { directory } = useSDK();
  const server = useServer();
  const storageKey = workspaceStorageKey(server.activeServerId(), directory ?? "", "layout");
  const initial = loadState(storageKey, server.activeServerId());

  // Review panel state
  const [reviewOpened, setReviewOpened] = createSignal(initial.review.opened);
  const [reviewWidth, setReviewWidth] = createSignal(
    initial.review.width ?? DEFAULT_REVIEW_WIDTH,
  );
  const [reviewMode, setReviewMode] = createSignal<ReviewMode>(
    initial.reviewMode ?? DEFAULT_REVIEW_MODE,
  );

  // Info panel state
  const [infoOpened, setInfoOpened] = createSignal(initial.info.opened);
  const [infoWidth, setInfoWidth] = createSignal(
    initial.info.width ?? DEFAULT_INFO_WIDTH,
  );

  // Sidebar state (clamp loaded value to valid range)
  const [sidebarWidth, setSidebarWidth] = createSignal(
    Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH,
      initial.sidebar.width ?? DEFAULT_SIDEBAR_WIDTH,
    )),
  );

  // File tabs state
  const [fileTabs, setFileTabs] = createSignal<FileTab[]>(initial.tabs ?? []);
  const [activeTab, setActiveTab] = createSignal<string | null>(
    initial.activeTab ?? null,
  );

  // Persist state on changes
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        review: { opened: reviewOpened(), width: reviewWidth() },
        info: { opened: infoOpened(), width: infoWidth() },
        sidebar: { width: sidebarWidth() },
        reviewMode: reviewMode(),
        tabs: fileTabs(),
        activeTab: activeTab(),
      }));
    } catch (e) {
      console.error("[Layout] Failed to save state:", e);
    }
  }

  const value: LayoutContextValue = {
    review: {
      opened: reviewOpened,
      width: reviewWidth,
      mode: reviewMode,
      toggle: () => {
        setReviewOpened((v) => !v);
        persist();
      },
      open: () => {
        setReviewOpened(true);
        persist();
      },
      close: () => {
        setReviewOpened(false);
        persist();
      },
      resize: (width: number) => {
        setReviewWidth(width);
        persist();
      },
      setMode: (mode: ReviewMode) => {
        if (reviewMode() === mode) return;
        setReviewMode(mode);
        persist();
      },
    },
    info: {
      opened: infoOpened,
      width: infoWidth,
      toggle: () => {
        setInfoOpened((v) => !v);
        persist();
      },
      open: () => {
        setInfoOpened(true);
        persist();
      },
      close: () => {
        setInfoOpened(false);
        persist();
      },
      resize: (width: number) => {
        setInfoWidth(width);
        persist();
      },
    },
    sidebar: {
      width: sidebarWidth,
      resize: (width: number) => {
        setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)));
        persist();
      },
    },
    tabs: {
      all: fileTabs,
      active: activeTab,
      open: (path: string) => {
        const tabs = fileTabs();
        const existing = tabs.find((t) => t.path === path);
        if (!existing) {
          setFileTabs([...tabs, { path, name: basename(path) }]);
        }
        setActiveTab(path);
        persist();
      },
      close: (path: string) => {
        const tabs = fileTabs();
        const idx = tabs.findIndex((t) => t.path === path);
        if (idx === -1) return;

        const newTabs = tabs.filter((t) => t.path !== path);
        setFileTabs(newTabs);

        // If closing active tab, switch to previous tab or Review
        if (activeTab() === path) {
          const nextTab = newTabs[Math.max(0, idx - 1)];
          setActiveTab(nextTab?.path ?? null);
        }
        persist();
      },
      setActive: (path: string | null) => {
        setActiveTab(path);
        persist();
      },
    },
  };

  return (
    <LayoutContext.Provider value={value}>
      {props.children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used within LayoutProvider");
  return ctx;
}
