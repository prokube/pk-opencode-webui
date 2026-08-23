const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastValue = 0n

function randomBase62(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => CHARS[byte % CHARS.length]).join("")
}

export function ascendingID(prefix: "msg" | "prt", timestamp = Date.now()) {
  const base = BigInt(timestamp) * 0x1000n
  lastValue = (base > lastValue ? base : lastValue) + 1n
  return `${prefix}_${lastValue.toString(16).padStart(16, "0")}${randomBase62(14)}`
}
