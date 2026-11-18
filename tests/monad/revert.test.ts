import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BrowserProvider, Interface } from 'ethers'
import { initSync } from 'monad-evm2js'
import solc from 'solc'
import { serializeRpcError, deserializeRpcError } from '../../apps/remix-ide/src/blockchain/providers/worker-rpc-error'
import { checkError, getRevertData } from '../../libs/remix-lib/src/execution/txExecution'
import { MonadProvider } from '../../libs/remix-monad/src/provider'

initSync({ module: readFileSync('node_modules/monad-evm2js/dist/monad_evm2js_bg.wasm') })

const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'Payable.sol': { content: readFileSync('tests/monad/fixtures/Payable.sol', 'utf8') } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'devdoc', 'userdoc']} } }
})))
const contracts = output.contracts
const reverting = contracts['Payable.sol'].Reverting
const abi = new Interface(reverting.abi)
const revertData = abi.encodeErrorResult('ExpectedRevert', [7])

// The worker posts its errors to the page, so each one is serialized, cloned and restored.
const throughWorker = (error: unknown): any => deserializeRpcError(structuredClone(serializeRpcError(error)))

async function deployReverting() {
  const provider = new MonadProvider({ fork: 'monad-ten' })
  await provider.init()
  const [from] = await provider.request({ method: 'eth_accounts' })
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, data: '0x' + reverting.evm.bytecode.object }]})
  const { contractAddress: to } = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash]})
  return { provider, call: { from, to, data: abi.encodeFunctionData('fail') } }
}

test('JSON-RPC error codes and revert data survive the worker boundary', async () => {
  const { provider, call } = await deployReverting()
  const error = await provider.request({ method: 'eth_call', params: [call, 'latest']}).catch(error => error)
  assert.equal(error.code, 3)
  assert.equal(error.data, revertData)
  // A cloned Error keeps its message only, which is what the worker used to post.
  assert.equal((structuredClone(error) as any).data, undefined)
  const restored = throughWorker(error)
  assert.equal(restored instanceof Error, true)
  assert.deepEqual({ message: restored.message, code: restored.code, data: restored.data }, { message: error.message, code: 3, data: revertData })
  assert.equal(throughWorker('Provider not instantiated'), 'Provider not instantiated')
  assert.equal(throughWorker(null), null)
})

for (const method of ['call', 'estimateGas'] as const) {
  test(`a reverted ${method} is decoded as ExpectedRevert(7) from the provider error`, async () => {
    const { provider, call } = await deployReverting()
    const web3 = new BrowserProvider({ request: (payload: any) => provider.request(payload).catch(error => { throw throughWorker(error) }) })
    const error = await web3[method](call).catch(error => error)
    assert.equal(error.code, 'CALL_EXCEPTION')
    const data = getRevertData(error)
    assert.equal(data, revertData)
    const { message } = checkError({ errorMessage: 'execution reverted', errorData: data }, contracts)
    assert.match(message, /Error provided by the contract:\nExpectedRevert\nParameters:/)
    assert.equal(JSON.parse(message.slice(message.indexOf('{'), message.lastIndexOf('}') + 1)).code.value, '7')
  })
}

test('revert data is found at the depths used by providers and ignored elsewhere', () => {
  assert.equal(getRevertData({ data: revertData }), revertData)
  assert.equal(getRevertData({ info: { error: { error: { code: 3, data: revertData } } } }), revertData)
  assert.equal(getRevertData({ data: { originalError: { data: revertData } } }), revertData)
  for (const error of [null, 'reverted', new Error('reverted'), { data: '0x' }, { data: '0x1234' }, { data: 'not hex' }, { transaction: { data: revertData } }]) {
    assert.equal(getRevertData(error), null)
  }
})
