const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

function randomBase62(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => CHARS[byte % CHARS.length]).join("")
}

export function ascendingID(prefix: "msg" | "prt", timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter += 1
  const value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  return `${prefix}_${value.toString(16).padStart(12, "0")}${randomBase62(14)}`
}
