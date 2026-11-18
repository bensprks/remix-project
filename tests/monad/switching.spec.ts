import { expect, Page } from '@playwright/test'
import { test, selectEnvironment, deploy, openContract, contractFunction } from './helpers'

const account = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'

/** Report how a request on a page provider settles; one stranded by its worker stays pending. */
const outcome = (page: Page, provider: string, method: string) => page.evaluate(({ provider, method }) => Promise.race([
  (window as any)[provider].send(method, []).then(value => 'resolved ' + value, error => 'rejected ' + error.message),
  new Promise(resolve => setTimeout(() => resolve('pending'), 5000))
]), { provider, method })

test('a provider kept from a replaced VM is rejected instead of reaching its successor', async ({ page }) => {
  await selectEnvironment(page, 'osaka')
  await page.evaluate(() => { (window as any).__replacedVM = (window as any).__remixVM_web3 })
  await selectEnvironment(page, 'monad-ten')
  expect(await outcome(page, '__replacedVM', 'eth_chainId')).toMatch(/^rejected .*reset or replaced/)
  expect(await outcome(page, '__remixVM_web3', 'eth_chainId')).toBe('resolved 0x8f')
})

test('accounts follow a switch made while their balances are refreshing', async ({ page }) => {
  await selectEnvironment(page, 'monad-ten')
  await deploy(page)
  await openContract(page)
  // The menu stays open so that its Remix VM entry can be selected from inside the page.
  await page.locator('[data-id="settingsSelectEnvOptions"]').click()
  await expect(page.locator('[data-id="dropdown-item-Remix_VM"]')).toBeVisible()
  await page.evaluate(() => {
    const postMessage = window.Worker.prototype.postMessage
    // Leave Monad at the first balance request of a refresh, while the other accounts are still to come.
    window.Worker.prototype.postMessage = function (message: any, ...rest: any[]) {
      postMessage.call(this, message, ...rest)
      if ((window as any).__switched || message?.query?.method !== 'eth_getBalance') return
      ;(window as any).__switched = true
      ;(document.querySelector('[data-id="dropdown-item-Remix_VM"]') as HTMLElement).click()
    }
  })
  // A deposit refreshes balances through the blockchain plugin queue. ethers reuses a balance fetched
  // in the last 250ms, so deposit until a refresh reaches the VM. A pointer click would close the menu.
  const deposit = contractFunction(page, 'deposit').getByRole('button', { name: 'Transact', exact: true })
  const switched = () => page.evaluate(() => !!(window as any).__switched)
  await expect(async () => {
    if (!await switched()) await deposit.dispatchEvent('click')
    expect(await switched()).toBe(true)
  }).toPass()
  await expect(page.locator('[data-id="settingsSelectEnvOptions"]')).toHaveText('Remix VM')
  await expect(page.locator('[data-id="runTabSelectAccount"]')).toContainText('ETH')
  await expect(page.locator('[data-id="runTabSelectAccount"]')).not.toContainText('MON')
})

test('back-to-back switches settle on the last environment selected', async ({ page }) => {
  await selectEnvironment(page, 'monad-eight')
  for (const fork of ['monad-nine', 'monad-ten', 'monad-next', 'monad-eight', 'monad-ten']) {
    await page.locator('[data-id="settingsSelectEnvCategoryOptions"]').click()
    await page.locator(`[data-id="dropdown-item-vm-${fork}"]`).click()
  }
  await expect(page.locator('[data-id="selected-provider-vm-monad-ten"]')).toBeVisible()
  await expect(page.locator('[data-id="runTabSelectAccount"]')).toContainText('MON')
  await page.getByRole('tab', { name: 'Deploy', exact: true }).click()
  await expect(page.locator('[data-id="deploy-widget-header"] .badge')).toHaveText('Monad VM (Ten)')
  await expect.poll(() => outcome(page, '__remixVM_web3', 'eth_chainId')).toBe('resolved 0x8f')
  // The VM that answers must be the fork that is shown.
  const trace = await page.evaluate(async account => {
    const web3 = (window as any).__remixVM_web3
    const hash = await web3.send('eth_sendTransaction', [{ from: account, to: account }])
    return web3.send('debug_traceTransaction', [hash])
  }, account)
  expect(trace.fork).toBe('monad-ten')
})
