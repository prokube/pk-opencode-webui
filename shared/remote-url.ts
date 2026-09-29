export function normalizeRemoteUrl(input: string) {
  const value = input.trim()
  if (!value) throw new Error("Enter a server URL")
  if (value.includes("://") && !/^https?:\/\//i.test(value)) throw new Error("Only HTTP(S) servers are supported")
  const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) server URL without credentials, query or fragment")
  }
  return url.href.replace(/\/+$/, "")
}
