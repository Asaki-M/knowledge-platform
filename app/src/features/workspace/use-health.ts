import { useCallback, useEffect, useRef, useState } from 'react'

export function useHealth() {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>(
    'checking',
  )
  const controllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    controllerRef.current?.abort()
    const request = new AbortController()
    controllerRef.current = request
    setStatus('checking')
    const timeout = window.setTimeout(() => request.abort(), 5000)
    try {
      const response = await fetch('/api/health', { signal: request.signal })
      const data: unknown = await response.json()
      const healthy
        = response.ok
          && typeof data === 'object'
          && data !== null
          && 'status' in data
          && data.status === 'ok'
      if (controllerRef.current === request)
        setStatus(healthy ? 'online' : 'offline')
    }
    catch {
      if (controllerRef.current === request)
        setStatus('offline')
    }
    finally {
      window.clearTimeout(timeout)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 30000)
    return () => {
      window.clearInterval(interval)
      const previous = controllerRef.current
      controllerRef.current = null
      previous?.abort()
    }
  }, [refresh])

  return { status, refresh }
}
