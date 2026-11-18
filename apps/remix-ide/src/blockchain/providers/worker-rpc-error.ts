/**
 * postMessage clones an Error without its own properties, which drops the JSON-RPC
 * `code` and the revert `data`. Errors therefore cross the VM worker boundary as plain fields.
 */
export function serializeRpcError (error: any) {
  if (!(error instanceof Error)) return error
  const { message, code, data } = error as any
  return { message, code, data }
}

export function deserializeRpcError (error: any) {
  if (error === null || typeof error !== 'object' || error instanceof Error || typeof error.message !== 'string') return error
  return Object.assign(new Error(error.message), error)
}
