import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { ChevronDown, GripVertical } from "lucide-solid";
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
} from "@thisbeyond/solid-dnd";
import type { DragEvent as SolidDragEvent } from "@thisbeyond/solid-dnd";
import { Button } from "./ui/button";
import { ConstrainDragXAxis } from "../utils/solid-dnd";

export function FollowupDock(props: {
  items: { id: string; text: string }[];
  sending?: string;
  autoSend: boolean;
  processing?: boolean;
  loading?: boolean;
  onToggleAutoSend: () => void;
  onSend: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onReorder: (from: string, to: string) => void;
}) {
  const [collapsed, setCollapsed] = createSignal(true);
  const [dragId, setDragId] = createSignal<string | null>(null);
  const contentId = `followup-dock-${createUniqueId()}`;
  const count = createMemo(() => props.items.length);
  const hasItems = createMemo(() => count() > 0);
  const preview = createMemo(() => props.items[0]?.text ?? "");
  const label = createMemo(() =>
    count() === 0 ? "No followups queued" : count() === 1 ? "1 followup queued" : `${count()} followups queued`,
  );
  const busy = createMemo(() => !!props.sending || !!props.processing || !!props.loading);

  function toggle() {
    setCollapsed((v) => !v);
  }

  function handleDragStart(event: SolidDragEvent) {
    setDragId(event.draggable ? String(event.draggable.id) : null);
  }

  function handleDragEnd(event: SolidDragEvent) {
    setDragId(null);
    const { draggable, droppable } = event;
    if (!draggable || !droppable) return;
    const from = String(draggable.id);
    const to = String(droppable.id);
    if (from === to) return;
    if (props.sending === from) return;
    props.onReorder(from, to);
  }

  return (
    <div
      class="rounded-lg border mb-2"
      style={{
        background: "var(--background-base)",
        border: "1px solid var(--border-base)",
      }}
    >
      <Show
        when={hasItems()}
        fallback={
          <div class="w-full flex items-center gap-2 px-3 py-2 text-left">
            <span class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
              {label()}
            </span>
          </div>
        }
      >
        <button
          type="button"
          class="w-full flex items-center gap-2 px-3 py-2 text-left"
          onClick={toggle}
          aria-expanded={!collapsed()}
          aria-controls={contentId}
        >
          <span class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
            {label()}
          </span>
          <Show when={collapsed() && preview()}>
            <span class="text-xs truncate min-w-0 flex-1" style={{ color: "var(--text-weak)" }}>
              {preview()}
            </span>
          </Show>
          <ChevronDown
            class="w-4 h-4 shrink-0 transition-transform"
            style={{
              color: "var(--text-weak)",
              transform: collapsed() ? "rotate(0deg)" : "rotate(180deg)",
            }}
          />
        </button>
      </Show>

      <div class="px-3 pb-2 flex items-center justify-end">
        <label
          class="text-xs flex items-center gap-2 cursor-pointer select-none"
          style={{ color: "var(--text-weak)" }}
        >
          <input
            type="checkbox"
            checked={props.autoSend}
            onChange={() => props.onToggleAutoSend()}
            class="h-3.5 w-3.5"
          />
          <span>Auto send queued followups</span>
        </label>
      </div>

      <Show when={hasItems() && !collapsed()}>
        <DragDropProvider
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragXAxis />
          <SortableProvider ids={props.items.map((item) => item.id)}>
            <div
              id={contentId}
              class="px-3 pb-3 pt-1 flex flex-col gap-2 max-h-44 overflow-y-auto"
              role="region"
              aria-label="Queued followup messages"
            >
              <For each={props.items}>
                {(item, i) => {
                  const sortable = createSortable(item.id);
                  const sending = () => props.sending === item.id;
                  const first = () => i() === 0;
                  const last = () => i() === props.items.length - 1;
                  return (
                    <div
                      use:sortable={sortable}
                      class="flex items-center gap-2 min-w-0"
                      classList={{
                        "opacity-40": dragId() === item.id,
                      }}
                    >
                      <button
                        type="button"
                        class="shrink-0 flex items-center cursor-grab active:cursor-grabbing p-0 border-0 bg-transparent"
                        aria-label="Drag to reorder followup"
                        title="Drag to reorder followup"
                        disabled={sending()}
                        {...(sending() ? {} : sortable.dragActivators)}
                      >
                        <GripVertical class="w-4 h-4" style={{ color: "var(--icon-weak)" }} />
                      </button>
                      <span class="text-sm truncate flex-1" style={{ color: "var(--text-base)" }}>
                        {item.text}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={sending() || first()}
                        aria-label="Move followup up"
                        title="Move followup up"
                        onClick={() => props.onMoveUp(item.id)}
                      >
                        Up
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={sending() || last()}
                        aria-label="Move followup down"
                        title="Move followup down"
                        onClick={() => props.onMoveDown(item.id)}
                      >
                        Down
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={busy()}
                        onClick={() => props.onSend(item.id)}
                      >
                        Send now
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={sending()}
                        onClick={() => props.onEdit(item.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={sending()}
                        onClick={() => props.onDelete(item.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  );
                }}
              </For>
            </div>
          </SortableProvider>
        </DragDropProvider>
      </Show>
    </div>
  );
}
