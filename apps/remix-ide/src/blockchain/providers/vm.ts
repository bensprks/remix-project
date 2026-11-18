import { privateToAddress, bytesToHex } from '@ethereumjs/util'
import { extendProvider, JSONRPCRequestPayload, JSONRPCResponseCallback } from '@remix-project/remix-simulator'
import { ExecutionContext } from '../execution-context'
import { BrowserProvider, formatUnits, ethers, hashMessage, toUtf8Bytes, keccak256 } from 'ethers'
import { EnvironmentReplacedError, VMWorkerClient } from './vm-worker-client'

export class VMProvider {
  executionContext: ExecutionContext
  web3: BrowserProvider
  provider: {
    sendAsync: (query: JSONRPCRequestPayload, callback: JSONRPCResponseCallback) => void
    request: (query: JSONRPCRequestPayload) => Promise<any>
  }
  private client: VMWorkerClient
  constructor (executionContext: ExecutionContext) {
    this.executionContext = executionContext
    this.client = null
    this.provider = null
  }

  getAccounts (cb) {
    this.web3.send("eth_requestAccounts", [])
      .then(accounts => cb(null, accounts))
      .catch(err => {
        cb('No accounts?')
      })
  }

  async resetEnvironment (stringifiedState?: string) {
    // The current VM is discarded with its state, so the requests it has not answered fail here.
    if (this.client) this.client.close()
    const provider = this.executionContext.getProviderObject()
    const options: Record<string, any> = {
      fork: this.executionContext.getCurrentFork(),
      nodeUrl: provider?.options['nodeUrl'],
      blockNumber: provider?.options['blockNumber']
    }
    if (stringifiedState) {
      const blockchainState = JSON.parse(stringifiedState)
      options.nodeUrl = blockchainState.nodeUrl || options.nodeUrl
      options.blockNumber = parseInt(blockchainState.latestBlockNumber, 16)
      options.stateDb = blockchainState.db
      options.baseBlockNumer = blockchainState.baseBlockNumber
      options.blocks = blockchainState.blocks
    }
    const client = this.client = new VMWorkerClient(new Worker(new URL('./worker-vm', import.meta.url)))
    try {
      await client.init(options)
    } catch (error) {
      client.close()
      throw error instanceof Error ? error : new Error(error)
    }
    // A reset started while this VM was initializing has closed it and publishes its own.
    if (this.client !== client) throw new EnvironmentReplacedError()
    this.provider = {
      sendAsync: (query, callback) => client.sendAsync(query, callback),
      request: (query) => client.request(query)
    }
    this.web3 = new ethers.BrowserProvider(this.provider)
    extendProvider(this.web3)
    this.executionContext.setWeb3(this.executionContext.getProvider(), this.web3)
    return {}
  }

  // TODO: is still here because of the plugin API
  // can be removed later when we update the API
  createVMAccount (newAccount) {
    const { privateKey, balance } = newAccount
    this.client.addAccount(privateKey, balance)
    const privKey: any = Buffer.from(privateKey, 'hex')
    return bytesToHex(privateToAddress(privKey))
  }

  newAccount (_passwordPromptCb, cb) {
    this.client.newAccount(cb)
  }

  async getBalanceInEther (address) {
    const balance = await this.web3.getBalance(address)
    const balInString = BigInt(balance).toString(10)
    return balInString === '0' ? balInString : formatUnits(balInString, 'ether')
  }

  getGasPrice (cb) {
    this.web3.getFeeData().then((result => cb(null, result.gasPrice)))
  }

  signMessage (message, account, _passphrase, cb) {
    const messageHash = hashMessage(message)
    this.web3.getSigner(account).then((signer) => {
      signer._legacySignMessage(toUtf8Bytes(message))
        .then(signedData => cb(null, messageHash, signedData))
        .catch(error => cb(error))
    })
  }
}
