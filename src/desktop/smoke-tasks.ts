import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { createDesktopWorker } from './worker.js'
import type { DesktopWorkerReady } from './paths.js'
import { desktopPaths } from './paths.js'
import { createSmokeProvider } from './smoke-provider.js'
import type { DesktopSmokeOptions } from './smoke.js'
import type { FileContent, FileRef } from '../applications/harness/core/project-files/domain.js'
import type { ProtocolViewSnapshot } from '../applications/harness/core/view/types.js'

export type SmokeApi = <T = unknown>(path: string, body?: object, headers?: Record<string, string>) => Promise<T>
interface Entity { readonly id: string; readonly revision: number }
interface RunResult { readonly id: string; readonly status: string; readonly error?: string }
interface Target { readonly api: SmokeApi; readonly model: Entity; readonly modelConnection: Entity; readonly session: Entity }
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function eventually(test: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 15000
  while (!await test()) { if (Date.now() >= end) throw new Error(message); await pause(50) }
}
async function configureTarget(api: SmokeApi, projectPath: string, providerUrl: string): Promise<Target> {
  const hints = { protocolIds: ['chat-completions'] }
  const provider = await api<Entity>('/models/providers', { name: `Desktop smoke ${randomUUID()}`, connectionHints: hints })
  const capabilities = { tools: { support: 'supported' }, streaming: { support: 'unsupported' },
    imageInput: { support: 'supported' }, reasoning: { support: 'unsupported' } }
  const definition = await api<Entity>('/models/definitions', { providerId: provider.id, name: 'Offline desktop fixture',
    remoteModelId: 'desktop-smoke', capabilities, controls: { temperature: 'unknown' },
    modalities: { input: ['text', 'image'], output: ['text'] }, limits: {}, connectionHints: hints })
  const modelConnection = await api<Entity>('/models/connections', { providerDefinitionId: provider.id, name: 'Loopback fixture',
    enabled: true, protocolId: 'chat-completions', baseUrl: providerUrl, auth: 'api-key', timeoutMs: 120000,
    apiKey: 'desktop-smoke-fixture-key' })
  const configurations = await api<readonly (Entity & { modelDefinitionId: string; baseline: boolean })[]>(`/models/configurations?connectionId=${modelConnection.id}`)
  const model = configurations.find(value => value.modelDefinitionId === definition.id && value.baseline)
  check(model, 'Offline fixture did not receive a baseline model')
  const agents = await api<readonly Entity[]>('/agents')
  check(agents.length > 0, 'Smoke execution host has no Agent')
  await mkdir(projectPath, { recursive: true })
  const project = await api<Entity>('/projects', { path: projectPath })
  const session = await api<Entity>('/sessions', { projectId: project.id, agentId: agents[0]!.id, modelId: model!.id })
  return { api, model: model!, modelConnection, session }
}
async function clearFixtureKey(target: Target) {
  const connections = await target.api<readonly Entity[]>('/models/connections')
  const current = connections.find(value => value.id === target.modelConnection.id)
  if (current) await target.api(`/models/connections/${current.id}/key/delete`, { expectedRevision: current.revision })
}

/** Real API, tools, native codec, streaming and shutdown verification against an offline model. */
export async function runDesktopTaskSmoke(options: DesktopSmokeOptions, request: SmokeApi, base: string, binding: Record<string, string>, beforeShutdown: () => void) {
  const stage = (label: string) => console.log(`[desktop smoke] ${label}`)
  const provider = await createSmokeProvider(), paths = desktopPaths(options.userData)
  const remoteHome = await mkdtemp(join(options.userData, 'smoke-remote-'))
  const remotePaths = desktopPaths(remoteHome)
  await mkdir(remotePaths.data, { recursive: true })
  const remote = createDesktopWorker('execution', remotePaths.data, () => {})
  let localTarget: Target | undefined, remoteTarget: Target | undefined
  const api: SmokeApi = (path, body) => request(base + path, body, binding)
  try {
    stage('offline model, binary image, and SSE')
    const projectPath = await mkdtemp(join(options.userData, 'smoke-project-'))
    localTarget = await configureTarget(api, projectPath, provider.url)
    stage('project file snapshot preparation and immutable content')
    const fileText = 'desktop-file-reference-proof 你好 {{input}}\n', changedText = 'desktop-file-reference-changed\n'
    await writeFile(join(projectPath, 'smoke-source.txt'), fileText + 'excluded-current-line\n')
    const fileBase = `/sessions/${localTarget.session.id}/project-files`
    const preparation = { preparationKey: randomUUID(), selections: [{ kind: 'project-file', path: 'smoke-source.txt', range: { start: 1, end: 1 } }] }
    const files = await api<readonly FileRef[]>(fileBase + '/prepare', preparation)
    check(files.length === 1 && files[0]!.snapshotId && files[0]!.path === 'smoke-source.txt' &&
      files[0]!.actualRange?.start === 1 && files[0]!.actualRange.end === 1, 'Project file preparation lost its selection')
    await writeFile(join(projectPath, 'smoke-source.txt'), changedText)
    const replay = await api<readonly FileRef[]>(fileBase + '/prepare', preparation)
    check(replay.length === 1 && replay[0]!.snapshotId === files[0]!.snapshotId, 'Project file preparation recaptured the changed source')
    const snapshot = await api<FileContent>(fileBase + '/snapshots/' + files[0]!.snapshotId)
    check(snapshot.text === fileText, 'Project file snapshot changed after source modification')
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#274060' } }).png().toBuffer()
    const imagePath = `${base}/sessions/${localTarget.session.id}/images`
    const uploaded = await options.window.webContents.executeJavaScript(`(async () => {
      const response = await fetch(${JSON.stringify(imagePath)}, { method: 'POST',
        headers: ${JSON.stringify({ ...binding, 'Content-Type': 'image/png' })}, body: new Uint8Array(${JSON.stringify([...image])}) });
      if (!response.ok) throw new Error('Smoke image upload HTTP ' + response.status); return response.json();
    })()`) as { assetId: string }
    check(uploaded.assetId, 'Binary image upload returned no resource identity')
    const received = await options.window.webContents.executeJavaScript(`(async () => {
      const response = await fetch(${JSON.stringify(imagePath + '/' + uploaded.assetId + '/content')}, { headers: ${JSON.stringify(binding)} });
      if (!response.ok) throw new Error('Smoke image read HTTP ' + response.status); return [...new Uint8Array(await response.arrayBuffer())];
    })()`) as number[]
    check(Buffer.from(received).equals(image), 'Image resource changed original bytes')
    const stream = await options.window.webContents.executeJavaScript(`(async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      let reader;
      try {
        const response = await fetch(${JSON.stringify(base + '/changes?sessionId=' + localTarget.session.id)}, {
          headers: ${JSON.stringify(binding)}, signal: controller.signal });
        if (!response.ok) throw new Error('Smoke SSE HTTP ' + response.status);
        reader = response.body.getReader(); let frame = '';
        while (!frame.includes('event: ready')) { const part = await reader.read(); if (part.done) break; frame += new TextDecoder().decode(part.value); }
        controller.abort(); await reader.cancel().catch(() => {}); return { ready: frame.includes('event: ready'), aborted: controller.signal.aborted };
      } finally { clearTimeout(timer); reader?.releaseLock(); controller.abort(); }
    })()`) as { ready: boolean; aborted: boolean }
    check(stream.ready && stream.aborted, 'SSE readiness or cancellation failed')
    stage('local Bash and Apply Patch Run')
    const toolRun = await api<RunResult>(`/sessions/${localTarget.session.id}/runs`, { input: 'Complete the offline desktop tool smoke',
      images: [{ assetId: uploaded.assetId }], files: [{ snapshotId: files[0]!.snapshotId }], parentNodeId: null, idempotencyKey: randomUUID() })
    const completed = await api<{ done: boolean; run: RunResult }>(`/runs/${toolRun.id}/wait?timeoutMs=25000`)
    check(completed.done && completed.run.status === 'completed', 'Offline Bash/Apply Patch Run did not complete: ' + (completed.run.error ?? completed.run.status))
    check(await readFile(join(projectPath, 'smoke-result.txt'), 'utf8') === 'desktop-patch-proof\n', 'Apply Patch did not commit the expected file')
    const events = await api<readonly { kind: string; name?: string; stdout?: string }[]>(`/runs/${toolRun.id}/events`)
    check(events.some(event => event.kind === 'tool-observed' && event.name === 'bash' && event.stdout === 'desktop-bash-proof'), 'Bash observation did not preserve real output')
    check(events.some(event => event.kind === 'tool-observed' && event.name === 'apply_patch'), 'Apply Patch observation missing')
    const savedRun = await api<{ files: readonly { snapshotId: string }[] }>(`/runs/${toolRun.id}`)
    check(savedRun.files.length === 1 && savedRun.files[0]!.snapshotId === files[0]!.snapshotId, 'Run did not retain its project file reference')
    const view = await api<ProtocolViewSnapshot>(`/runs/${toolRun.id}/view`)
    check(view.status === 'committed', 'Completed Run did not expose a committed native projection')
    const userInputs = view.exchanges.flatMap(exchange => exchange.inputs ?? []).filter(input => input.role === 'user').map(input => input.text).join('\n')
    check(userInputs.includes('desktop-file-reference-proof 你好 {{input}}') && !userInputs.includes(changedText.trim()) &&
      !userInputs.includes('excluded-current-line'), 'Native model input did not preserve the selected project file snapshot')
    const retained = await api<FileContent>(fileBase + '/snapshots/' + files[0]!.snapshotId)
    check(retained.text === fileText && retained.file.expiresAt === undefined, 'Accepted Run did not retain the immutable file snapshot')

    stage('local Run survives hide and cancelled Quit')
    const localHeld = await api<RunResult>(`/sessions/${localTarget.session.id}/runs`, { input: 'SMOKE-HOLD local', parentNodeId: null, idempotencyKey: randomUUID() })
    await eventually(() => provider.held === 1, 'Local held execution never reached the model')
    options.window.close(); check(!options.window.isDestroyed() && !options.window.isVisible(), 'Busy window close did not hide it')
    check((await api<RunResult>(`/runs/${localHeld.id}`)).status === 'running', 'Hiding cancelled the local Run')
    options.reveal()
    if (options.confirmQuit) {
      stage('native busy Quit dialog cancellation')
      check(await options.confirmQuit() === false, 'Native busy Quit dialog did not preserve the application')
    } else {
      check((await options.execution!.rpc.call<{ busy: boolean }>('inspectForQuit')).busy, 'Quit inspection missed the active Run')
      await options.execution!.rpc.call('releaseQuit')
    }
    check((await api<RunResult>(`/runs/${localHeld.id}`)).status === 'running', 'Cancelling Quit affected the local Run')

    stage('remote execution fixture and held Run')
    const remoteReady = await remote.rpc.call<DesktopWorkerReady>('start', { kind: 'execution', userData: remoteHome,
      namespace: `anybox.desktop.smoke.remote.${randomUUID()}` })
    const remoteToken = await remote.rpc.call<string>('issue')
    // Main-only pairing: the access token is never interpolated into renderer JavaScript.
    const response = await fetch(options.clientReady.url + '/api/client/v1/connections', { method: 'POST',
      headers: { Origin: options.clientReady.url, 'Content-Type': 'application/json', 'X-Anybox-Desktop-Transport': options.transportSecret },
      body: JSON.stringify({ name: 'Desktop smoke remote', endpoint: remoteReady.url, token: remoteToken }) })
    check(response.ok, 'Remote fixture pairing failed')
    const remoteConnection = await response.json() as Entity & { instanceId: string }
    check(remoteConnection.instanceId !== options.local!.instanceId, 'Remote smoke reused local identity')
    const remoteBinding = { 'X-Anybox-Product-Id': 'agent', 'X-Anybox-Expected-Instance-Id': remoteConnection.instanceId,
      'X-Anybox-Connection-Revision': String(remoteConnection.revision) }
    const remoteBase = `/api/connections/${remoteConnection.id}/v1`
    const remoteApi: SmokeApi = (path, body) => request(remoteBase + path, body, remoteBinding)
    await remoteApi('/products/agent/open', {})
    remoteTarget = await configureTarget(remoteApi, join(remoteHome, 'project'), provider.url)
    const remoteHeld = await remoteApi<RunResult>(`/sessions/${remoteTarget.session.id}/runs`, { input: 'SMOKE-HOLD remote', parentNodeId: null, idempotencyKey: randomUUID() })
    await eventually(() => provider.held === 2, 'Remote held execution never reached the model')
    // Executions already own their initialized credentials; clear only these QA entries before shutdown.
    await clearFixtureKey(localTarget); localTarget = undefined
    await clearFixtureKey(remoteTarget); remoteTarget = undefined
    await request(`/api/client/v1/connections/${remoteConnection.id}/delete`, { expectedRevision: remoteConnection.revision })
    beforeShutdown()
    stage('desktop shutdown and actual worker exit')
    check(await options.shutdown(), 'Desktop shutdown was cancelled')
    check(options.client.ended && options.execution!.ended, 'Desktop hosts did not actually exit')

    const remoteRead = async <T>(path: string): Promise<T> => {
      const response = await fetch(remoteReady.url + '/api/v1' + path, { headers: { Authorization: `Bearer ${remoteToken}`,
        'X-Anybox-Instance-Id': remoteConnection.instanceId, 'X-Anybox-Product-Id': 'agent' } })
      check(response.ok, 'Remote fixture could not be read after desktop shutdown')
      return response.json() as Promise<T>
    }
    stage('remote Run survives desktop exit and completes')
    check((await remoteRead<RunResult>(`/runs/${remoteHeld.id}`)).status === 'running', 'Desktop shutdown cancelled the remote Run')
    provider.release()
    const remoteResult = await remoteRead<{ done: boolean; run: RunResult }>(`/runs/${remoteHeld.id}/wait?timeoutMs=25000`)
    check(remoteResult.done && remoteResult.run.status === 'completed', 'Remote Run did not complete after client shutdown')
    stage('durable local cancellation and released locks')
    const db = new DatabaseSync(paths.harness, { readOnly: true })
    let localStatus: unknown
    try { localStatus = db.prepare('SELECT status FROM harness_runs WHERE id=?').get(localHeld.id)?.status }
    finally { db.close() }
    check(localStatus === 'cancelled', 'Local Run was not durably cancelled before desktop exit')
    for (const path of [paths.harness, paths.client, paths.catalog, paths.models, paths.images]) {
      try { await access(path + '.lock'); throw new Error('Desktop lock remains after shutdown') }
      catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
    }
    return { binaryImage: true, imageBytesPreserved: true, sseReady: true, sseCancelled: true, bash: true, applyPatch: true,
      projectFileReferences: true, fileSnapshotPreserved: true, fileContextSent: true,
      nativeQuitCancelled: options.confirmQuit ? true : null,
      localRunSurvivesHide: true, localQuitGuard: true, localCancelledOnExit: true, remoteSurvivesExit: true,
      remoteCompletedAfterExit: true, actualHostExit: true, databaseReleased: true, imageDirectoryReleased: true }
  } finally {
    if (localTarget && !options.execution?.ended) await clearFixtureKey(localTarget).catch(() => {})
    if (remoteTarget && !remote.ended && !options.client.ended) await clearFixtureKey(remoteTarget).catch(() => {})
    const errors: unknown[] = []
    try { await remote.close() } catch (error) { errors.push(error) }
    try { await provider.close() } catch (error) { errors.push(error) }
    if (remote.ended) try { await rm(remoteHome, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Desktop smoke fixture cleanup failed')
  }
}
