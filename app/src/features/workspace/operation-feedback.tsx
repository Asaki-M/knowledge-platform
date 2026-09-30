import type { ApiError } from '@/utils/api'
import { AlertCircle, LoaderCircle } from 'lucide-react'

export function OperationFeedback({ pending, error, read = false }: { pending: boolean, error: ApiError | null, read?: boolean }) {
  return (
    <>
      {pending && (
        <div className="notice" role="status">
          <LoaderCircle size={17} className="animate-spin" />
          <div>
            {read ? '正在读取日志…' : '正在处理，请稍候。'}
            {!read && <small>模型调用可能需要较长时间，可切换页面，结果会保留在本次会话中。</small>}
          </div>
        </div>
      )}
      {error && (
        <div className="notice error-notice" role="alert">
          <AlertCircle size={17} />
          <div>
            {error.message}
            <small>
              {error.code}
              {error.requestId && ` · 请求 ID：${error.requestId}`}
            </small>
          </div>
        </div>
      )}
    </>
  )
}
