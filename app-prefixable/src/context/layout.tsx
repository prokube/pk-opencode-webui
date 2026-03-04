import {
  createContext,
  useContext,
  createSignal,
  type ParentProps,
} from "solid-js";

// Storage keys
const LAYOUT_STORAGE_KEY = "opencode.layout";

// Default values
const DEFAULT_REVIEW_WIDTH = 320;
const DEFAULT_INFO_WIDTH = 256;
const DEFAULT_SIDEBAR_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

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
  tabs?: FileTab[];
  activeTab?: string | null; // null = Review tab, string = file path
}

interface LayoutContextValue {
  // Review panel (diff viewer)
  review: {
    opened: () => boolean;
    width: () => number;
    toggle: () => void;
    open: () => void;
    close: () => void;
    resize: (width: number) => void;
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

function basename(path: string) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function loadState(): LayoutState {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const tabs: FileTab[] = parsed.tabs ?? [];
      const tabPaths = new Set(tabs.map((t) => t.path));
      // Validate activeTab exists in tabs, otherwise reset to null
      const activeTab =
        parsed.activeTab && tabPaths.has(parsed.activeTab)
          ? parsed.activeTab
          : null;
      return {
        review: {
          opened: parsed.review?.opened ?? false,
          width: parsed.review?.width ?? DEFAULT_REVIEW_WIDTH,
        },
        info: {
          opened: parsed.info?.opened ?? false,
          width: parsed.info?.width ?? DEFAULT_INFO_WIDTH,
        },
        sidebar: {
          width: parsed.sidebar?.width ?? DEFAULT_SIDEBAR_WIDTH,
        },
        tabs,
        activeTab,
      };
    }
  } catch (e) {
    console.error("[Layout] Failed to load state:", e);
  }
  return {
    review: { opened: false, width: DEFAULT_REVIEW_WIDTH },
    info: { opened: false, width: DEFAULT_INFO_WIDTH },
    sidebar: { width: DEFAULT_SIDEBAR_WIDTH },
    tabs: [],
    activeTab: null,
  };
}

function saveState(state: LayoutState) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("[Layout] Failed to save state:", e);
  }
}

export function LayoutProvider(props: ParentProps) {
  const initial = loadState();

  // Review panel state
  const [reviewOpened, setReviewOpened] = createSignal(initial.review.opened);
  const [reviewWidth, setReviewWidth] = createSignal(
    initial.review.width ?? DEFAULT_REVIEW_WIDTH,
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
    saveState({
      review: { opened: reviewOpened(), width: reviewWidth() },
      info: { opened: infoOpened(), width: infoWidth() },
      sidebar: { width: sidebarWidth() },
      tabs: fileTabs(),
      activeTab: activeTab(),
    });
  }

  const value: LayoutContextValue = {
    review: {
      opened: reviewOpened,
      width: reviewWidth,
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
