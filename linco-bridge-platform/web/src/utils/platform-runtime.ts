export interface CancelToken {
  readonly aborted: boolean
  abort(): void
  onAbort(listener: () => void): void
}

export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

export function isH5Runtime(): boolean {
  // #ifdef H5
  return true
  // #endif
  // #ifdef MP-WEIXIN || MP-ALIPAY || MP-BAIDU || MP-TOUTIAO || MP-QQ || MP-KUAISHOU || MP-JD || MP-HARMONY || MP-XHS || MP-LARK || MP
  return false
  // #endif
  // #ifdef APP-PLUS || APP-HARMONY
  return false
  // #endif
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export function isMiniProgramRuntime(): boolean {
  return !isH5Runtime()
}

export function supportsFetchStream(): boolean {
  return (
    isH5Runtime() &&
    typeof fetch === 'function' &&
    typeof ReadableStream !== 'undefined' &&
    typeof AbortController !== 'undefined'
  )
}

function resolveRequestAnimationFrame(): ((callback: () => void) => number) | null {
  const globalAny = globalThis as Record<string, unknown>

  const candidates: unknown[] = [
    globalAny.requestAnimationFrame,
    (globalAny.wx as { requestAnimationFrame?: unknown } | undefined)?.requestAnimationFrame,
    (globalAny.uni as { requestAnimationFrame?: unknown } | undefined)?.requestAnimationFrame,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      return candidate as (callback: () => void) => number
    }
  }

  return null
}

export function scheduleNextFrame(callback: () => void): void {
  // #ifdef MP-WEIXIN || MP-ALIPAY || MP-BAIDU || MP-TOUTIAO || MP-QQ || MP-KUAISHOU || MP-JD || MP-HARMONY || MP-XHS || MP-LARK || MP
  setTimeout(callback, 16)
  return
  // #endif

  const raf = resolveRequestAnimationFrame()
  if (typeof raf === 'function') {
    const schedule = raf as (callback: () => void) => number
    schedule(callback)
    return
  }
  setTimeout(callback, 16)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function createCancelToken(): CancelToken {
  let aborted = false
  const listeners = new Set<() => void>()

  return {
    get aborted() {
      return aborted
    },
    abort() {
      if (aborted) return
      aborted = true
      listeners.forEach((listener) => listener())
    },
    onAbort(listener) {
      if (aborted) {
        listener()
        return
      }
      listeners.add(listener)
    },
  }
}

export function throwIfCancelled(cancel?: CancelToken): void {
  if (cancel?.aborted) {
    throw new AbortError()
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}
