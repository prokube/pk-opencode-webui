type EventBufferOptions<T> = {
  limit?: number
  byteLimit?: number
  size?: (event: T) => number
  coalesce?: (previous: T, event: T) => T | undefined
  overflow?: (event: T) => void
  released?: (overflowed: boolean) => void
}

export function createEventBuffer<T>(consume: (event: T) => void, options: EventBufferOptions<T> = {}) {
  let queue: T[] | undefined
  let sizes: number[] | undefined
  let bytes = 0
  let overflowed = false
  let disposed = false
  const limit = Math.max(1, options.limit ?? 1000)
  const byteLimit = Math.max(1, options.byteLimit ?? Number.POSITIVE_INFINITY)

  function overflow(event: T) {
    overflowed = true
    options.overflow?.(event)
  }

  function push(event: T) {
    if (disposed) return
    if (!queue) {
      consume(event)
      return
    }

    const previous = queue.at(-1)
    const merged = previous === undefined ? undefined : options.coalesce?.(previous, event)
    if (merged !== undefined) {
      const previousSize = sizes!.at(-1) ?? 0
      const mergedSize = options.size?.(merged) ?? 0
      if (bytes - previousSize + mergedSize > byteLimit) {
        overflow(event)
        return
      }
      queue[queue.length - 1] = merged
      sizes![sizes!.length - 1] = mergedSize
      bytes += mergedSize - previousSize
      return
    }

    const size = options.size?.(event) ?? 0
    if (queue.length >= limit || bytes + size > byteLimit) {
      overflow(event)
      return
    }
    queue.push(event)
    sizes!.push(size)
    bytes += size
  }

  function release() {
    if (!queue) return
    while (queue.length > 0) consume(queue.shift()!)
    queue = undefined
    sizes = undefined
    bytes = 0
    const dropped = overflowed
    overflowed = false
    options.released?.(dropped)
  }

  async function during<R>(task: () => Promise<R>) {
    if (disposed) return task()
    if (queue) return task()
    queue = []
    sizes = []
    try {
      return await task()
    } finally {
      release()
    }
  }

  function dispose() {
    disposed = true
    queue = undefined
    sizes = undefined
    bytes = 0
    overflowed = false
  }

  return { push, during, dispose }
}
