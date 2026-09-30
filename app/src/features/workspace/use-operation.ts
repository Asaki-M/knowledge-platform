import type { ApiError } from '@/utils/api'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, requestJson } from '@/utils/api'

export function useOperation<T>() {
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  async function run(path: string, body: unknown) {
    if (controllerRef.current)
      return
    const current = new AbortController()
    controllerRef.current = current
    setPending(true)
    setError(null)
    setResult(null)
    setRequestId(null)
    try {
      const response = await requestJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: current.signal })
      if (!current.signal.aborted) {
        setResult(response.data)
        setRequestId(response.requestId)
        return response.data
      }
    }
    catch (e) {
      if (!current.signal.aborted)
        setError(errorMessage(e))
    }
    finally {
      if (!current.signal.aborted)
        setPending(false)
      controllerRef.current = null
    }
  }
  return { result, error, requestId, pending, run }
}
