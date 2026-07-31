import type { ApiResponse } from '@/bridge/types'
import { clearVisitorSessionToken } from '@/utils/visitor-session'
import { buildApiRequestHeaders, buildApiUrl, getApiBaseUrl, requestJson } from './http-transport'
import { bootstrapVisitorSession, ensureVisitorSession } from './visitor-bootstrap'

export { buildApiRequestHeaders, getApiBaseUrl }

async function requestWithSession<T>(options: {
  path: string
  method?: 'GET' | 'POST'
  data?: unknown
  skipSession?: boolean
  retryOnUnauthorized?: boolean
  timeout?: number
}): Promise<ApiResponse<T>> {
  if (!options.skipSession) {
    await ensureVisitorSession()
  }

  try {
    return await requestJson<T>({
      url: buildApiUrl(options.path),
      method: options.method,
      data: options.data,
      timeout: options.timeout,
    })
  } catch (err) {
    const statusCode = (err as Error & { statusCode?: number }).statusCode
    if (statusCode === 401 && options.retryOnUnauthorized !== false && !options.skipSession) {
      clearVisitorSessionToken()
      await bootstrapVisitorSession()
      return requestWithSession<T>({
        ...options,
        retryOnUnauthorized: false,
      })
    }
    throw err
  }
}

export async function apiGet<T>(
  path: string,
  options?: { skipSession?: boolean },
): Promise<ApiResponse<T>> {
  return requestWithSession<T>({ path, method: 'GET', skipSession: options?.skipSession })
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  options?: { skipSession?: boolean; timeout?: number },
): Promise<ApiResponse<T>> {
  return requestWithSession<T>({
    path,
    method: 'POST',
    data: body,
    skipSession: options?.skipSession,
    timeout: options?.timeout,
  })
}
