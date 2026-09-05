type EventBufferOptions<T> = {
  limit?: number
  byteLimit?: number
  size?: (event: T) => number
  coalesce?: (previous: T, event: T) => T | undefined
  overflow?: (event: T) => void
  released?: (overflowed: boolean) => void
}

type ScheduledEventBufferOptions<T> = {
  delay?: number
  batchSize?: number
  limit?: number
  byteLimit?: number
  size?: (event: T) => number
  resetOnOverflow?: boolean
  coalesce?: (previous: T, event: T) => T | undefined
  overflow?: (event: T) => void
  run?: (task: () => void) => void
}

export function createScheduledEventBuffer<T>(
  consume: (event: T) => void,
  options: ScheduledEventBufferOptions<T> = {},
) {
  const queue: T[] = []
  const sizes: number[] = []
  const delay = Math.max(0, options.delay ?? 16)
  const batchSize = Math.max(1, options.batchSize ?? 100)
  const limit = Math.max(batchSize, options.limit ?? Number.POSITIVE_INFINITY)
  const byteLimit = Math.max(1, options.byteLimit ?? Number.POSITIVE_INFINITY)
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let overflowed = false

  function schedule() {
    if (timer !== undefined || disposed) return
    timer = setTimeout(flush, delay)
  }

  function flush() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (disposed) return
    const pending = queue.splice(0, batchSize)
    const removed = sizes.splice(0, batchSize)
    bytes -= removed.reduce((total, size) => total + size, 0)
    const run = () => {
      for (const event of pending) consume(event)
    }
    if (options.run) options.run(run)
    if (!options.run) run()
    if (queue.length) schedule()
    if (!queue.length) overflowed = false
  }

  function push(event: T) {
    if (disposed) return
    const previous = queue.at(-1)
    const merged = previous === undefined ? undefined : options.coalesce?.(previous, event)
    if (merged !== undefined) {
      const previousSize = sizes.at(-1) ?? 0
      const mergedSize = options.size?.(merged) ?? 0
      if (bytes - previousSize + mergedSize <= byteLimit) {
        queue[queue.length - 1] = merged
        sizes[sizes.length - 1] = mergedSize
        bytes += mergedSize - previousSize
        schedule()
        return
      }
      if (!overflowed) {
        overflowed = true
        if (options.resetOnOverflow) {
          queue.length = 0
          sizes.length = 0
          bytes = 0
        }
        options.overflow?.(event)
        if (options.resetOnOverflow) {
          overflowed = false
          const size = options.size?.(event) ?? 0
          if (size <= byteLimit) {
            queue.push(event)
            sizes.push(size)
            bytes = size
          }
        }
      }
      schedule()
      return
    }
    if (merged === undefined) {
      const size = options.size?.(event) ?? 0
      if ((queue.length >= limit || bytes + size > byteLimit) && !overflowed) {
        overflowed = true
        if (options.resetOnOverflow) {
          queue.length = 0
          sizes.length = 0
          bytes = 0
        }
        options.overflow?.(event)
        if (options.resetOnOverflow) {
          overflowed = false
          if (size <= byteLimit) {
            queue.push(event)
            sizes.push(size)
            bytes = size
          }
          schedule()
          return
        }
      }
      if (!overflowed && queue.length < limit && bytes + size <= byteLimit) {
        queue.push(event)
        sizes.push(size)
        bytes += size
      }
    }
    schedule()
  }

  function dispose() {
    disposed = true
    queue.length = 0
    sizes.length = 0
    bytes = 0
    overflowed = false
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return { push, flush, dispose }
}

export function createEventBuffer<T>(consume: (event: T) => void, options: EventBufferOptions<T> = {}) {
  let queue: T[] | undefined
  let sizes: number[] | undefined
  let bytes = 0
  let overflowed = false
  let disposed = false
  let holds = 0
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
    for (let index = 0; index < queue.length; index += 1) consume(queue[index])
    queue = undefined
    sizes = undefined
    bytes = 0
    const dropped = overflowed
    overflowed = false
    options.released?.(dropped)
  }

  async function during<R>(task: () => Promise<R>) {
    if (disposed) return task()
    if (!queue) {
      queue = []
      sizes = []
    }
    holds += 1
    try {
      return await task()
    } finally {
      holds = Math.max(0, holds - 1)
      if (!disposed && holds === 0) release()
    }
  }

  function dispose() {
    disposed = true
    queue = undefined
    sizes = undefined
    bytes = 0
    overflowed = false
    holds = 0
  }

  return { push, during, dispose }
}
