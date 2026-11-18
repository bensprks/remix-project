import { expect } from '@playwright/test'
import { test, selectEnvironment, deploy, openContract, contractFunction } from './helpers'

for (const fork of ['monad-ten', 'osaka'] as const) {
  test(`${fork}: a reverted call reports its decoded custom error`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'Reverting')
    await openContract(page)
    await contractFunction(page, 'fail').getByRole('button', { name: 'Call', exact: true }).click()
    const journal = page.locator('[data-id="terminalJournal"]')
    await expect(journal).toContainText('Error provided by the contract:')
    await expect(journal).toContainText('ExpectedRevert')
    await expect(journal).toContainText(/"code": \{\s*"value": "7"\s*\}/)
  })
}
