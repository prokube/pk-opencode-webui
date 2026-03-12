/**
 * Creates mousedown + click handlers that dismiss a dialog only when the
 * user both presses AND releases on the backdrop itself (not on inner content
 * that was dragged outward).
 */
export function createBackdropDismiss(close: () => void) {
  let started = false
  return {
    onMouseDown: (e: MouseEvent) => {
      started = e.target === e.currentTarget
    },
    onClick: (e: MouseEvent) => {
      if (started && e.target === e.currentTarget) close()
      started = false
    },
  }
}
