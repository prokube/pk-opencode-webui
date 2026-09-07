export function selectsSlashCommand(key: string, composing: boolean) {
  return !composing && (key === "Enter" || key === "Tab")
}
