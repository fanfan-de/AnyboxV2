import { failure } from '@anybox/application-api/node'
import type { Agent, AgentConfiguration, Run, Work } from '../contracts.js'

export function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) throw failure(400, 'invalid-input')
  return value
}
export function identifier(value: unknown): string { return text(value, 200, true) }
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw failure(400, 'invalid-input')
  return value as number
}
export function sameRevision(actual: number, expected: unknown): void {
  if (actual !== revision(expected)) throw failure(409, 'conflict')
}
export function agentConfiguration(input: AgentConfiguration): AgentConfiguration {
  if (!input || typeof input !== 'object') throw failure(400, 'invalid-input')
  const name = text(input.name, 120, true), description = text(input.description, 2000)
  const systemPrompt = text(input.systemPrompt, 131072), memory = text(input.memory, 131072), skills = text(input.skills, 131072)
  const modelId = input.modelId === null ? null : identifier(input.modelId)
  if (!Number.isSafeInteger(input.contextLimit) || input.contextLimit < 256 || input.contextLimit > 1_000_000) throw failure(400, 'invalid-input')
  return { name, description, systemPrompt, memory, skills, modelId, contextLimit: input.contextLimit }
}

/** Application-owned text context. No partial history or automatic compaction is introduced. */
export function runContext(agent: Agent, work: Work, history: readonly Run[], input: string): { instruction: string; context: string; fits: boolean } {
  const instruction = [
    '你是 Personal Agent，根据用户明确提供的信息进行文本交流和推进任务。当前版本没有外部工具，不能声称已操作文件、联网或执行外部操作。',
    `Agent：${agent.name}`,
    agent.systemPrompt,
    agent.memory.trim() ? `用户明确保存的记忆：\n${agent.memory}` : '',
    agent.skills.trim() ? `用户维护的 Skills：\n${agent.skills}` : '',
  ].filter(Boolean).join('\n\n')
  const preceding = history.filter(run => run.contextSegment === work.contextSegment)
    .map(run => `用户输入：\n${run.input}\n执行状态：${run.status}${run.output ? `\nAgent 回复：\n${run.output}` : ''}${run.error ? `\n执行错误：${run.error}` : ''}`)
  const context = [
    work.kind === 'task' ? `任务：${work.title}\n目标：${work.goal}` : `对话：${work.title}${work.goal ? `\n背景：${work.goal}` : ''}`,
    work.progress ? `用户记录的进展：\n${work.progress}` : '',
    ...preceding,
    `本次输入：\n${input}`,
  ].filter(Boolean).join('\n\n')
  return { instruction, context, fits: instruction.length + context.length <= agent.contextLimit }
}

export function modelFailureCode(error: unknown): string {
  const codes = ['cancelled', 'closed', 'not-found', 'protocol-unavailable', 'credential-unavailable', 'credential-missing', 'invalid-config', 'invalid-response', 'provider-failure', 'network-failure', 'timeout', 'cleanup-failure', 'capability-unsupported', 'refused-response', 'incomplete-response']
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && codes.includes(error.code)) return error.code
  return 'execution-failed'
}
