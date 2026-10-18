import { claudeAgentError } from '../domain.js'
import { boundedJson } from '../events.js'
import type { SdkPermissionDecision, SdkPermissionRequest } from '../sdk/port.js'
import type { ApprovalDecision, ApprovalView } from '../view.js'

export const approvalInputLimit = 16 * 1024
const approvalDecisions: readonly ApprovalDecision[] = Object.freeze(['allow', 'allow-session', 'deny'])
/** Whitelisted projection of one agent permission request. */
export function approvalView(input: { id: string; runId: string; threadId: string; now: string; request: SdkPermissionRequest }): ApprovalView {
  const { request } = input, bounded = boundedJson(request.input, approvalInputLimit)
  return Object.freeze({ schemaVersion: 1, id: input.id, runId: input.runId, threadId: input.threadId, toolUseId: request.toolUseId, toolName: request.toolName,
    rememberRules: request.rememberRules, blockedPath: request.blockedPath, rememberUnavailableReason: request.rememberUnavailableReason,
    kind: request.questions ? 'question' : 'permission', title: request.title, description: request.description, reason: request.reason, input: bounded.input, inputTruncated: bounded.truncated,
    questions: request.questions, allowSessionAvailable: request.allowSessionAvailable && !request.questions, defaultToNo: request.defaultToNo, requestedAt: input.now,
    decision: null, answers: null, resolvedAt: null })
}
/** Pure validation of a browser decision against the request it answers. */
export function decisionFor(view: ApprovalView, rawDecision: unknown, rawAnswers: unknown): { decision: ApprovalDecision; answers: Readonly<Record<string, string>> | null; outcome: SdkPermissionDecision } {
  if (typeof rawDecision !== 'string' || !approvalDecisions.includes(rawDecision as ApprovalDecision)) throw claudeAgentError('invalid-input', 400)
  const decision = rawDecision as ApprovalDecision
  if (decision === 'deny') {
    if (rawAnswers !== undefined && rawAnswers !== null) throw claudeAgentError('invalid-input', 400)
    return { decision, answers: null, outcome: { behavior: 'deny', message: 'User declined tool execution.' } }
  }
  if (decision === 'allow-session' && !view.allowSessionAvailable) throw claudeAgentError('invalid-input', 400, 'This request cannot be allowed for the whole session.')
  if (!view.questions) {
    if (rawAnswers !== undefined && rawAnswers !== null) throw claudeAgentError('invalid-input', 400)
    return { decision, answers: null, outcome: { behavior: 'allow', session: decision === 'allow-session' } }
  }
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) throw claudeAgentError('invalid-input', 400, 'Answers are required.')
  const answers: Record<string, string> = {}
  for (const question of view.questions) {
    const answer = (rawAnswers as Record<string, unknown>)[question.question]
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 2000) throw claudeAgentError('invalid-input', 400, `Question "${question.header}" needs an answer.`)
    answers[question.question] = answer.trim()
  }
  if (Object.keys(rawAnswers).some(key => !(key in answers))) throw claudeAgentError('invalid-input', 400)
  return { decision, answers: Object.freeze(answers), outcome: { behavior: 'allow', answers } }
}
interface PendingApproval { view: ApprovalView; resolve(outcome: SdkPermissionDecision): void }
export interface ApprovalRegistry {
  request(input: { id: string; runId: string; threadId: string; now: string; request: SdkPermissionRequest }): { view: ApprovalView; decision: Promise<SdkPermissionDecision> }
  /** Browser decision; throws approval-not-found / approval-resolved / invalid-input. */
  resolve(id: string, decision: unknown, answers: unknown, now: string): ApprovalView
  /** The agent stopped waiting (interrupt or abort); nothing is sent back to it. */
  cancel(id: string, now: string): ApprovalView | undefined
  /** Denies every pending request of one Run, for cancellation and shutdown. */
  denyAll(runId: string, now: string, message: string): readonly ApprovalView[]
  pending(threadId?: string): readonly ApprovalView[]
  get(id: string): ApprovalView | undefined
}
/** In-memory pending requests; durable records are written by the owner through the store. */
export function createApprovalRegistry(): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>()
  const settle = (entry: PendingApproval, decision: ApprovalView['decision'], answers: Readonly<Record<string, string>> | null, now: string): ApprovalView => {
    pending.delete(entry.view.id)
    return Object.freeze({ ...entry.view, decision, answers, resolvedAt: now })
  }
  return {
    request(input) {
      const view = approvalView(input)
      let resolve!: (outcome: SdkPermissionDecision) => void
      const decision = new Promise<SdkPermissionDecision>(done => { resolve = done })
      pending.set(view.id, { view, resolve })
      return { view, decision }
    },
    resolve(id, rawDecision, rawAnswers, now) {
      const entry = pending.get(id)
      if (!entry) throw claudeAgentError('approval-resolved', 409, 'This request has already been answered or is no longer pending.')
      const { decision, answers, outcome } = decisionFor(entry.view, rawDecision, rawAnswers)
      const view = settle(entry, decision, answers, now)
      entry.resolve(outcome)
      return view
    },
    cancel(id, now) {
      const entry = pending.get(id)
      if (!entry) return undefined
      const view = settle(entry, 'cancelled', null, now)
      entry.resolve({ behavior: 'deny', message: 'The request was cancelled.' })
      return view
    },
    denyAll(runId, now, message) {
      const views: ApprovalView[] = []
      for (const entry of [...pending.values()]) {
        if (entry.view.runId !== runId) continue
        views.push(settle(entry, 'deny', null, now))
        entry.resolve({ behavior: 'deny', message })
      }
      return views
    },
    pending: threadId => [...pending.values()].map(entry => entry.view).filter(view => threadId === undefined || view.threadId === threadId),
    get: id => pending.get(id)?.view,
  }
}
