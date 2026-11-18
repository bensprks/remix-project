import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EnvironmentReplacedError, VMWorkerClient } from '../../apps/remix-ide/src/blockchain/providers/vm-worker-client'

/** Records what a client posts and lets a test answer as the worker would. */
class FakeWorker {
  posted: any[] = []
  terminated = false
  private listener: (event: { data: any }) => void
  addEventListener(_type: string, listener: (event: { data: any }) => void) { this.listener = listener }
  postMessage(message: any) { this.posted.push(message) }
  terminate() { this.terminated = true }
  answer(message: any) { this.listener({ data: structuredClone(message) }) }
}

function connect() {
  const worker = new FakeWorker()
  return { worker, client: new VMWorkerClient(worker as unknown as Worker) }
}

const outcome = (promise: Promise<any>) => Promise.race([
  promise.then(value => ({ resolved: value }), error => ({ rejected: error })),
  new Promise(resolve => setImmediate(() => resolve('pending')))
]) as Promise<any>

test('each request is settled by the answer carrying its stamp', async () => {
  const { worker, client } = connect()
  const first = client.request({ method: 'eth_chainId' })
  const second = client.request({ method: 'eth_blockNumber' })
  assert.deepEqual(worker.posted.map(message => [message.cmd, message.query.method]), [['request', 'eth_chainId'], ['request', 'eth_blockNumber']])
  assert.notEqual(worker.posted[0].stamp, worker.posted[1].stamp)
  worker.answer({ cmd: 'requestResult', stamp: worker.posted[1].stamp, error: null, result: '0x1' })
  assert.deepEqual(await outcome(second), { resolved: '0x1' })
  assert.equal(await outcome(first), 'pending')
  worker.answer({ cmd: 'requestResult', stamp: worker.posted[0].stamp, error: { message: 'revert', code: 3, data: '0x12345678' }, result: null })
  const { rejected } = await outcome(first)
  assert.equal(rejected instanceof Error, true)
  assert.deepEqual([rejected.message, rejected.code, rejected.data], ['revert', 3, '0x12345678'])
})

test('closing a client terminates its worker and rejects what it has not answered', async () => {
  const { worker, client } = connect()
  const init = client.init({ fork: 'monad-ten' })
  const request = client.request({ method: 'eth_getBalance' })
  const callbacks: any[] = []
  client.sendAsync({ method: 'eth_accounts' }, (error, result) => callbacks.push([error, result]))
  client.newAccount((error, address) => callbacks.push([error, address]))
  assert.deepEqual(worker.posted.map(message => message.cmd), ['init', 'request', 'sendAsync', 'newAccount'])
  client.close()
  assert.equal(worker.terminated, true)
  for (const promise of [init, request]) assert.equal((await outcome(promise)).rejected instanceof EnvironmentReplacedError, true)
  assert.equal(callbacks.length, 2)
  for (const [error, result] of callbacks) assert.deepEqual([error instanceof EnvironmentReplacedError, result], [true, undefined])
  // An answer that was already on its way is not delivered twice.
  worker.answer({ cmd: 'requestResult', stamp: worker.posted[1].stamp, error: null, result: '0x0' })
  assert.equal(callbacks.length, 2)
})

test('a closed client rejects new requests without reaching a worker', async () => {
  const { worker, client } = connect()
  client.close()
  assert.equal((await outcome(client.request({ method: 'eth_chainId' }))).rejected instanceof EnvironmentReplacedError, true)
  let reported: any
  await client.sendAsync({ method: 'eth_chainId' }, error => { reported = error })
  assert.equal(reported instanceof EnvironmentReplacedError, true)
  client.addAccount('0x01')
  assert.deepEqual(worker.posted, [])
})

test('requests held by a replaced environment never reach the one that replaces it', async () => {
  const previous = connect()
  const current = connect()
  const stale = previous.client.request({ method: 'eth_getBalance' })
  previous.client.close()
  const fresh = current.client.request({ method: 'eth_getBalance' })
  // Both clients number their requests alike; an answer still belongs to one worker only.
  assert.equal(previous.worker.posted[0].stamp, current.worker.posted[0].stamp)
  current.worker.answer({ cmd: 'requestResult', stamp: current.worker.posted[0].stamp, error: null, result: '0x2' })
  assert.deepEqual(await outcome(fresh), { resolved: '0x2' })
  assert.equal((await outcome(stale)).rejected instanceof EnvironmentReplacedError, true)
  await previous.client.request({ method: 'eth_chainId' }).catch(() => {})
  assert.equal(current.worker.posted.length, 1)
})

test('callback requests report results and errors through the callback', async () => {
  const { worker, client } = connect()
  const reports: any[] = []
  const sent = client.sendAsync({ method: 'eth_chainId' }, (error, result) => reports.push([error, result]))
  worker.answer({ cmd: 'sendAsyncResult', stamp: worker.posted[0].stamp, error: null, result: { id: 1, jsonrpc: '2.0', result: '0x8f' } })
  assert.deepEqual(await outcome(sent), { resolved: undefined })
  assert.deepEqual(reports, [[null, { id: 1, jsonrpc: '2.0', result: '0x8f' }]])
  client.sendAsync({ method: 'eth_call' }, (error, result) => reports.push([error.message, error.code, result]))
  worker.answer({ cmd: 'sendAsyncResult', stamp: worker.posted[1].stamp, error: { message: 'revert', code: 3 } })
  assert.deepEqual(reports[1], ['revert', 3, undefined])
})
