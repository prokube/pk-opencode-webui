import { For, Show, createMemo, createSignal } from "solid-js";
import { ChevronDown } from "lucide-solid";
import { Button } from "./ui/button";

export function FollowupDock(props: {
  items: { id: string; text: string }[];
  sending?: string;
  onSend: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = createSignal(true);
  const count = createMemo(() => props.items.length);
  const preview = createMemo(() => props.items[0]?.text ?? "");
  const label = createMemo(() =>
    count() === 1 ? "1 followup queued" : `${count()} followups queued`,
  );

  function toggle() {
    setCollapsed((v) => !v);
  }

  return (
    <div
      class="rounded-lg border mb-2"
      style={{
        background: "var(--background-base)",
        border: "1px solid var(--border-base)",
      }}
    >
      <button
        type="button"
        class="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={toggle}
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
            transform: collapsed() ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </button>

      <Show when={!collapsed()}>
        <div class="px-3 pb-3 pt-1 flex flex-col gap-2 max-h-44 overflow-y-auto">
          <For each={props.items}>
            {(item) => (
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm truncate flex-1" style={{ color: "var(--text-base)" }}>
                  {item.text}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!!props.sending}
                  onClick={() => props.onSend(item.id)}
                >
                  Send now
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!!props.sending}
                  onClick={() => props.onEdit(item.id)}
                >
                  Edit
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
