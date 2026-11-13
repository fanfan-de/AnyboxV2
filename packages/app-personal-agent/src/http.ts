import type { Component } from '@nya/core'
import { productActivityServiceKey } from '@anybox/application-api'
import type { ProductActivityPort } from '@anybox/application-api'
import { failure, json, requestObject } from '@anybox/application-api/node'
import type { ApplicationHttpPort, HttpFailure } from '@anybox/application-api/node'
import { isModelsError, modelsServiceKey, modelsSettingsServiceKey } from '@anybox/models'
import type { ModelsService, ModelsSettingsService } from '@anybox/models'
import { personalAgentHttpServiceKey, personalAgentServiceKey } from './contracts.js'
import type { AgentConfiguration, PersonalAgentPort, WorkKind, WorkStatus } from './contracts.js'
import { addPersonalAgentModel, personalAgentModelState } from './model-settings.js'

function httpFailure(error: unknown): HttpFailure {
  if (isModelsError(error)) {
    const status = error.code === 'conflict' || error.code === 'busy' ? 409 : error.code === 'not-found' ? 404
      : error.code === 'invalid-config' || error.code === 'capability-unsupported' ? 400
      : error.code === 'provider-failure' || error.code === 'invalid-response' ? 502 : 503
    return failure(status, error.code)
  }
  if (error instanceof URIError || error instanceof TypeError) return failure(400, 'invalid-input')
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' &&
      'code' in error && typeof error.code === 'string') return failure(error.status, error.code)
  return failure(500, 'internal-error')
}
const agentFields = ['id', 'expectedRevision', 'name', 'description', 'systemPrompt', 'memory', 'skills', 'modelId', 'contextLimit']

/** Owns HTTP request admission and drains requests before business/Models dependencies are withdrawn. */
export function createPersonalAgentHttpComponent(): Component.Object<void, {
  [personalAgentServiceKey]: PersonalAgentPort
  [modelsServiceKey]: ModelsService
  [modelsSettingsServiceKey]: ModelsSettingsService
  [productActivityServiceKey]: ProductActivityPort
}> {
  return {
    name: 'personal-agent-http',
    inject: [personalAgentServiceKey, modelsServiceKey, modelsSettingsServiceKey, productActivityServiceKey],
    apply(ctx, _config, deps) {
      const workspace = deps[personalAgentServiceKey], models = deps[modelsServiceKey], settings = deps[modelsSettingsServiceKey]
      let accepting = true
      const requests = new Map<Promise<void>, () => void>()
      const port: ApplicationHttpPort = {
        handle(request, response, url, context) {
          if (!accepting) return Promise.reject(failure(503, 'product-unavailable'))
          const mutation = request.method === 'POST'
          const abortInput = () => { if (!request.complete) request.destroy() }
          context.signal.addEventListener('abort', abortInput, { once: true })
          const disconnected = () => { if (!response.writableEnded) abortInput() }
          response.once('close', disconnected)
          let task: Promise<void>
          task = Promise.resolve().then(async () => {
            const lease = deps[productActivityServiceKey].enter('personal-agent', { blocking: mutation, cancel: abortInput })
            try {
              if (url.search || context.signal.aborted) throw failure(400, 'invalid-input')
              const method = request.method ?? 'GET', path = url.pathname
              if (method === 'GET' && path === '/state') { json(response, 200, await workspace.state()); return }
              if (method === 'GET' && path === '/models') { json(response, 200, personalAgentModelState(models, settings)); return }
              if (method === 'POST' && path === '/models') {
                const body = await requestObject(request, ['name', 'protocolId', 'baseUrl', 'remoteModelId', 'auth', 'apiKey'])
                await addPersonalAgentModel(settings, body)
                json(response, 200, personalAgentModelState(models, settings)); return
              }
              const key = /^\/models\/connections\/([^/]+)\/key$/.exec(path)
              if (method === 'POST' && key) {
                const body = await requestObject(request, ['expectedRevision', 'apiKey'])
                if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 16_384 ||
                    !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw failure(400, 'invalid-input')
                await settings.setApiKey(decodeURIComponent(key[1]), body.apiKey, body.expectedRevision as number)
                json(response, 200, personalAgentModelState(models, settings)); return
              }
              if (method === 'POST' && path === '/agents') {
                const body = await requestObject(request, agentFields, 524_288)
                json(response, 200, await workspace.saveAgent(body as unknown as AgentConfiguration & { id?: string; expectedRevision?: number })); return
              }
              if (method === 'POST' && path === '/preferences') {
                const body = await requestObject(request, ['agentId'])
                if (typeof body.agentId !== 'string') throw failure(400, 'invalid-input')
                await workspace.preferAgent(body.agentId); json(response, 200, { ok: true }); return
              }
              if (method === 'POST' && path === '/works') {
                const body = await requestObject(request, ['agentId', 'kind', 'title', 'goal'], 262_144)
                json(response, 200, await workspace.createWork(body as { agentId: string; kind: WorkKind; title: string; goal: string })); return
              }
              const work = /^\/works\/([^/]+)$/.exec(path)
              if (work && method === 'GET') { json(response, 200, await workspace.detail(decodeURIComponent(work[1]))); return }
              if (work && method === 'POST') {
                const body = await requestObject(request, ['expectedRevision', 'status', 'waitReason', 'progress'], 262_144)
                json(response, 200, await workspace.updateWork(decodeURIComponent(work[1]), body as { expectedRevision: number; status?: Exclude<WorkStatus, 'running'>; waitReason?: string; progress?: string })); return
              }
              const action = /^\/works\/([^/]+)\/(runs|context|delegate|artifacts)$/.exec(path)
              if (action && method === 'POST') {
                const id = decodeURIComponent(action[1])
                if (action[2] === 'runs') {
                  const body = await requestObject(request, ['input', 'expectedRevision'], 524_288)
                  json(response, 200, await workspace.startRun(id, body as { input: string; expectedRevision: number })); return
                }
                if (action[2] === 'context') {
                  const body = await requestObject(request, ['expectedRevision'])
                  json(response, 200, await workspace.newContext(id, body.expectedRevision as number)); return
                }
                if (action[2] === 'delegate') {
                  const body = await requestObject(request, ['agentId', 'title', 'goal'], 262_144)
                  json(response, 200, await workspace.delegate(id, body as { agentId: string; title: string; goal: string })); return
                }
                const body = await requestObject(request, ['title', 'content', 'runId'], 1_048_576)
                json(response, 200, await workspace.saveArtifact(id, body as { title: string; content: string; runId?: string })); return
              }
              const cancel = /^\/works\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(path)
              if (cancel && method === 'POST') {
                await requestObject(request, [])
                json(response, 200, await workspace.cancelRun(decodeURIComponent(cancel[1]), decodeURIComponent(cancel[2]))); return
              }
              throw failure(404, 'not-found')
            } finally { lease.release() }
          }).catch(error => {
            const problem = httpFailure(error)
            if (!response.destroyed && !response.headersSent) json(response, problem.status, { error: { code: problem.code } })
          }).finally(() => {
            requests.delete(task)
            context.signal.removeEventListener('abort', abortInput)
            response.off('close', disconnected)
          })
          requests.set(task, abortInput)
          return task
        },
      }
      ctx.effect(() => async () => {
        accepting = false
        for (const abort of requests.values()) abort()
        await Promise.all([...requests.keys()])
      }, 'close Personal Agent HTTP admission and join accepted requests')
      ctx.provide(personalAgentHttpServiceKey, port)
    },
  }
}
