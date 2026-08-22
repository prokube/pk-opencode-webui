export function createEventBuffer<T>(consume: (event: T) => void, limit = 1000) {
  let queue: T[] | undefined

  function push(event: T) {
    if (!queue) {
      consume(event)
      return
    }

    if (queue.length >= limit) queue.shift()
    queue.push(event)
  }

  function release() {
    if (!queue) return
    while (queue.length > 0) consume(queue.shift()!)
    queue = undefined
  }

  async function during<R>(task: () => Promise<R>) {
    if (queue) return task()
    queue = []
    try {
      return await task()
    } finally {
      release()
    }
  }

  return { push, during }
}
