import { deserializeRpcError } from './worker-rpc-error'

type PendingRequest = {
  resolve: (result?: any) => void
  reject: (error: any) => void
  callback?: (error: any, result?: any) => void
}

/** Rejects what was still waiting on an environment when it was reset or replaced by another one. */
export class EnvironmentReplacedError extends Error {
  constructor () {
    super('The environment was reset or replaced before this request completed.')
    this.name = 'EnvironmentReplacedError'
  }
}

/**
 * One VM worker and the requests sent to it. A request is answered by the worker that
 * received it or rejected when that worker is closed, so it can neither stay pending
 * nor be answered by the environment that replaces it.
 */
export class VMWorkerClient {
  private pending = new Map<number, PendingRequest>()
  private lastStamp = 0
  private closed: Error = null

  constructor (private worker: Worker) {
    worker.addEventListener('message', ({ data }) => {
      const request = this.pending.get(data.stamp)
      if (!request) return
      this.pending.delete(data.stamp)
      settle(request, deserializeRpcError(data.error), data.result)
    })
  }

  init (options: Record<string, any>): Promise<void> {
    return this.post({ cmd: 'init', ...options })
  }

  request (query: Record<string, any>): Promise<any> {
    return this.post({ cmd: 'request', query })
  }

  sendAsync (query: Record<string, any>, callback?: PendingRequest['callback']): Promise<any> {
    return this.post({ cmd: 'sendAsync', query }, callback)
  }

  newAccount (callback: PendingRequest['callback']): Promise<any> {
    return this.post({ cmd: 'newAccount' }, callback)
  }

  addAccount (privateKey: string, balance?: string) {
    if (!this.closed) this.worker.postMessage({ cmd: 'addAccount', privateKey, balance })
  }

  /** Terminate the worker and fail every request it has not answered. */
  close (reason: Error = new EnvironmentReplacedError()) {
    if (this.closed) return
    this.closed = reason
    this.worker.terminate()
    const unanswered = [...this.pending.values()]
    this.pending.clear()
    for (const request of unanswered) settle(request, reason)
  }

  private post (message: Record<string, any>, callback?: PendingRequest['callback']): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, callback }
      if (this.closed) return settle(request, this.closed)
      const stamp = ++this.lastStamp
      this.pending.set(stamp, request)
      this.worker.postMessage({ ...message, stamp })
    })
  }
}

function settle ({ resolve, reject, callback }: PendingRequest, error: any, result?: any) {
  if (callback) {
    // Callback requests report through the callback alone, as web3 providers do.
    resolve()
    callback(error || null, result)
  } else if (error) reject(error)
  else resolve(result)
}
