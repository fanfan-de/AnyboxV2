/** Real Electron quit QA with a static dirty page and simulated resources only. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-quit-qa-'))
  const profileDirectory = join(directory, 'user-data')
  try {
    await mkdir(join(profileDirectory, 'session'), { recursive: true })
    const require = createRequire(import.meta.url), env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
    const child = spawn(require('electron'), [fileURLToPath(import.meta.url), `--qa-user-data=${profileDirectory}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_384) })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45_000)
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    }).finally(() => clearTimeout(timeout))
    const report = stdout.trim().split('\n').map(line => {
      try { return JSON.parse(line) } catch { return undefined }
    }).find(item => item?.kind === 'desktop-quit-qa')
    const passed = report?.passed === true && result.exitCode === 0 && !timedOut
    const reportPath = join(directory, 'report.json')
    const finalReport = { ...report, ...result, timedOut, passed, reportPath, ...(!passed ? { stderr, stdout } : {}) }
    await Promise.all([writeFile(reportPath, JSON.stringify(finalReport, null, 2) + '\n'),
      writeFile(join(directory, 'electron.stdout.log'), stdout), writeFile(join(directory, 'electron.stderr.log'), stderr)])
    process.stdout.write(JSON.stringify(finalReport) + '\n')
    process.exitCode = passed ? 0 : 1
  } finally { await rm(profileDirectory, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const { desktopBeforeUnloadProbe, prepareDesktopQuit } = await import('../../dist/desktop/quit.js')
  const directory = process.argv.find(argument => argument.startsWith('--qa-user-data='))?.slice('--qa-user-data='.length)
  assert.ok(directory, 'QA must use an explicitly isolated userData directory')
  app.setName('Anybox Isolated Quit QA')
  app.setPath('userData', directory); app.setPath('sessionData', join(directory, 'session'))
  let window, quitting, quitAllowed = false, acceptDiscard = false, acceptCancellation = false, reportWritten = false
  let resolveRefusal
  const counters = { discardPrompts: 0, activityInspections: 0, activityReleases: 0, cancellationPrompts: 0,
    resourceCloseCalls: 0, nativeUnloadVetoEvents: 0, approvedOverrides: 0, windowHideCalls: 0 }
  const resources = { client: true, execution: true, admission: true, activityFrozen: false }
  const report = { kind: 'desktop-quit-qa', electron: process.versions.electron, counters,
    refusedWithResourcesAlive: false, busyRefusedWithResourcesAlive: false, normalCloseKeptResourcesAlive: false, dirtyAtFinalQuit: false }
  const fail = error => {
    if (reportWritten) return
    reportWritten = true
    process.stdout.write(JSON.stringify({ ...report, passed: false, error: String(error?.stack ?? error) }) + '\n')
    app.exit(1)
  }
  app.on('window-all-closed', () => {})
  app.on('before-quit', event => {
    if (quitAllowed) return
    event.preventDefault()
    if (quitting) return
    quitting = (async () => {
      const accepted = await prepareDesktopQuit({
        canLeave: () => window.webContents.executeJavaScript(desktopBeforeUnloadProbe),
        async confirmDiscard() { counters.discardPrompts++; return acceptDiscard },
        async inspectActivity() { counters.activityInspections++; resources.activityFrozen = true; return { busy: true } },
        async confirmCancelRuns() { counters.cancellationPrompts++; return acceptCancellation },
        async releaseActivity() { counters.activityReleases++; resources.activityFrozen = false },
      })
      if (!accepted) { resolveRefusal(); return }
      assert.equal(resources.activityFrozen, true, 'accepted quit retains the activity freeze')
      report.dirtyAtFinalQuit = await window.webContents.executeJavaScript('window.qaDirty === true')
      assert.equal(report.dirtyAtFinalQuit, true, 'final quit must still encounter the dirty native unload listener')
      resources.admission = false
      for (const resource of ['client', 'execution']) { resources[resource] = false; counters.resourceCloseCalls++ }
      quitAllowed = true
      app.quit()
    })().catch(fail).finally(() => { quitting = undefined })
  })
  app.on('will-quit', event => {
    try {
      assert.equal(report.refusedWithResourcesAlive, true)
      assert.equal(report.busyRefusedWithResourcesAlive, true)
      assert.equal(report.normalCloseKeptResourcesAlive, true)
      assert.equal(report.dirtyAtFinalQuit, true)
      assert.equal(counters.discardPrompts, 3)
      assert.equal(counters.activityInspections, 2)
      assert.equal(counters.activityReleases, 1)
      assert.equal(counters.cancellationPrompts, 2)
      assert.equal(counters.resourceCloseCalls, 2)
      assert.equal(counters.nativeUnloadVetoEvents, 1)
      assert.equal(counters.approvedOverrides, 1)
      assert.equal(window.isDestroyed(), true)
      reportWritten = true
      process.stdout.write(JSON.stringify({ ...report, passed: true }) + '\n')
    } catch (error) { event.preventDefault(); fail(error) }
  })
  void (async () => { try {
    await app.whenReady()
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { partition: 'anybox-isolated-quit-qa', sandbox: true, contextIsolation: true, nodeIntegration: false } })
    window.on('close', event => { if (!quitAllowed) { event.preventDefault(); counters.windowHideCalls++; window.hide() } })
    window.webContents.on('will-prevent-unload', event => {
      counters.nativeUnloadVetoEvents++
      if (!quitAllowed) return
      assert.equal(resources.client, false); assert.equal(resources.execution, false); assert.equal(resources.admission, false)
      counters.approvedOverrides++
      event.preventDefault()
    })
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Isolated quit QA</title><p>Unsaved fixture settings</p><script>
      window.qaDirty = true;
      window.addEventListener('beforeunload', event => {
        if (!window.qaDirty) return;
        event.preventDefault(); event.returnValue = '';
      });
    </script>`))
    window.close()
    assert.equal(window.isDestroyed(), false)
    assert.equal(counters.windowHideCalls, 1)
    assert.equal(resources.client && resources.execution && resources.admission, true)
    report.normalCloseKeptResourcesAlive = true
    const attemptRefusal = async () => {
      const refused = new Promise(resolve => { resolveRefusal = resolve })
      app.quit(); app.quit(); await refused; await quitting
    }
    await attemptRefusal()
    assert.equal(window.isDestroyed(), false)
    assert.equal(resources.client && resources.execution && resources.admission, true)
    assert.equal(counters.activityInspections, 0)
    assert.equal(counters.resourceCloseCalls, 0)
    assert.equal(counters.nativeUnloadVetoEvents, 0)
    report.refusedWithResourcesAlive = true
    acceptDiscard = true
    await attemptRefusal()
    assert.equal(window.isDestroyed(), false)
    assert.equal(resources.client && resources.execution && resources.admission, true)
    assert.equal(resources.activityFrozen, false, 'declining task cancellation must release the activity freeze')
    assert.equal(counters.resourceCloseCalls, 0)
    assert.equal(counters.activityInspections, 1)
    assert.equal(counters.activityReleases, 1)
    assert.equal(counters.discardPrompts, 2, 'repeated quit attempts must not overlap confirmations')
    assert.equal(counters.cancellationPrompts, 1)
    report.busyRefusedWithResourcesAlive = true
    acceptCancellation = true
    app.quit()
  } catch (error) { fail(error) } })()
}
