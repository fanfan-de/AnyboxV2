import type { RunnableModelSummary } from '@anybox/models'
import type { StorageReader, StorageRow, StorageTransaction } from '@anybox/storage-sqlite/port'
import { treeError } from './domain.js'

export interface HistoryTurn {
  readonly nodeId: string
  readonly user: string
  readonly assistant: string
}

export interface ContinuousContext {
  readonly rootId: string
  readonly recent: readonly HistoryTurn[]
  readonly memory: readonly HistoryTurn[]
}

export interface ContinuousContextSelection {
  readonly rootId: string
  readonly recentNodeIds: readonly string[]
  readonly memoryNodeIds: readonly string[]
}

interface ContinuationRoot {
  readonly id: string
  readonly parentId: string | null
  readonly anchorNodeId: string | null
  readonly cutoff: number
  readonly evicted: readonly ArchivedTurn[]
}

interface ArchivedTurn extends HistoryTurn {
  readonly sequence: number
  readonly projectId: string
}

export interface ContinuousRunPlan {
  readonly context: ContinuousContext
  readonly expectedRootId: string | null
  readonly root?: ContinuationRoot
}

export interface ContinuousRunQuery {
  readonly sessionId: string
  readonly projectId: string
  readonly parentNodeId: string | null
  readonly query: string
  readonly remainingTokens: number
}

const maxRecent = 32
const rolloverRecent = 24
const maxRecentTokens = 3_000
const maxRetrievedTokens = 1_000
const maxRetrieved = 3

export function projectedTokens(text: string): number {
  // Provider tokenizers differ. Estimate the size of the encoded input from its UTF-8 bytes.
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

export function continuousBudget(model: RunnableModelSummary, currentInputTokens: number): number {
  const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  const parameters = model.parameters.value
  const generation = parameters.generation_config
  const configuredOutput = positive(parameters.max_output_tokens) ?? positive(parameters.max_completion_tokens) ?? positive(parameters.max_tokens) ??
    (generation && typeof generation === 'object' && 'max_output_tokens' in generation ? positive(generation.max_output_tokens) : undefined)
  const context = positive(model.limits?.context) ?? 8_192
  const output = Math.min(configuredOutput ?? Math.min(2_048, Math.floor(context / 4)), positive(model.limits?.output) ?? Infinity)
  const capacity = Math.min(positive(model.limits?.input) ?? Infinity, context - output)
  const remaining = Math.floor(capacity - currentInputTokens - 256)
  if (remaining < 0) throw Object.assign(new RangeError('The current input exceeds the selected model context budget'), { code: 'context-too-large' })
  return remaining
}

function text(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw treeError('invalid-history')
  return value
}

function sequence(row: StorageRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw treeError('invalid-history')
  return value
}

function archivedTurn(row: StorageRow): ArchivedTurn {
  return { nodeId: text(row, 'id'), user: text(row, 'input'), assistant: text(row, 'output'),
    sequence: sequence(row, 'seq'), projectId: text(row, 'project_id') }
}

const commonWords = new Set(['the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'what', 'please', 'write', 'continue',
  '刚才', '之前', '前面', '前文', '先前', '上次', '继续', '按照', '照旧', '同样', '如下'])

function keywords(value: string): readonly string[] {
  const words = new Set<string>()
  const chunks = value.slice(0, 24_000).toLowerCase().match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? []
  for (const word of chunks) {
    if (/^\p{Script=Han}/u.test(word)) {
      const characters = [...word]
      for (let i = 0; i + 1 < characters.length; i++) {
        const pair = characters[i]! + characters[i + 1]!
        if (!commonWords.has(pair)) words.add(pair)
      }
    } else if (word.length >= 3 && word.length <= 60 && !commonWords.has(word)) {
      words.add(word)
    }
    if (words.size >= 2_000) break
  }
  return [...words]
}

function snippet(value: string, terms: readonly string[], limit: number): string {
  if (value.length <= limit) return value
  const lower = value.toLowerCase()
  const match = terms.find(term => lower.includes(term))
  const start = Math.max(0, match ? lower.indexOf(match) - Math.floor(limit / 3) : 0)
  const excerpt = value.slice(start, start + limit).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
  return `${start ? '…' : ''}${excerpt}${start + limit < value.length ? '…' : ''}`
}

function currentRoot(reader: StorageReader, sessionId: string): StorageRow | undefined {
  return reader.get('SELECT id, cutoff_seq, evicted_node_ids_json FROM harness_continuous_roots WHERE session_id = ? ORDER BY seq DESC LIMIT 1', [sessionId])
}

export function planContinuousRun(reader: StorageReader, input: ContinuousRunQuery, newId: () => string): ContinuousRunPlan {
  const root = currentRoot(reader, input.sessionId)
  const anchor = input.parentNodeId && reader.get('SELECT seq FROM harness_nodes WHERE id = ? AND session_id = ?', [input.parentNodeId, input.sessionId])
  if (input.parentNodeId && !anchor) throw treeError('node-not-found')
  const cutoff = root ? sequence(root, 'cutoff_seq') : 0
  const expectedRootId = root ? text(root, 'id') : null
  const turns = reader.all(`SELECT n.id, n.seq, n.input, n.output, COALESCE(r.project_id, s.project_id) AS project_id
    FROM harness_nodes n JOIN harness_runs r ON r.id = n.source_run_id JOIN harness_sessions s ON s.id = n.session_id
    WHERE n.session_id = ? AND n.seq > ? AND n.seq <= ? ORDER BY n.seq DESC LIMIT ?`,
  [input.sessionId, cutoff, anchor ? sequence(anchor, 'seq') : 0, maxRecent + 1]).map(archivedTurn).reverse()
  const costs = turns.map(({ nodeId, user, assistant }) => projectedTokens(JSON.stringify({ nodeId, user, assistant })) + 16)
  const budget = Math.min(maxRecentTokens, input.remainingTokens)
  let used = costs.reduce((sum, cost) => sum + cost, 0)
  let remove = 0
  if (turns.length > maxRecent || used > budget) {
    // Leave headroom, but retain the newest full turn whenever it fits.
    while (turns.length - remove > rolloverRecent || (used > Math.floor(budget * 0.8) && turns.length - remove > 1) || used > budget) {
      used -= costs[remove++]!
    }
  }
  const evicted = turns.slice(0, remove)
  const rollover: ContinuationRoot | undefined = expectedRootId === null || evicted.length
    ? { id: newId(), parentId: expectedRootId, anchorNodeId: input.parentNodeId, cutoff: evicted.at(-1)?.sequence ?? cutoff, evicted }
    : undefined
  const memory = retrieveMemory(reader, input, root, evicted, Math.min(maxRetrievedTokens, input.remainingTokens - used))
  const recent = turns.slice(remove).map(({ nodeId, user, assistant }) => ({ nodeId, user, assistant }))
  return { context: { rootId: rollover?.id ?? expectedRootId!, recent, memory }, expectedRootId, ...(rollover ? { root: rollover } : {}) }
}

function retrieveMemory(reader: StorageReader, input: ContinuousRunQuery, root: StorageRow | undefined,
  evicted: readonly ArchivedTurn[], budget: number): readonly HistoryTurn[] {
  if (!input.query || budget <= 0) return []
  const explicitReferences = /\[历史:([^\]\r\n]{1,128})\]|\b([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\b/giu
  const directIds = new Set([...input.query.matchAll(explicitReferences)].slice(0, 12).map(match => (match[1] ?? match[2]!).trim()))
  const terms = keywords(input.query.replace(explicitReferences, '')).slice(0, 20)
  const matches = terms.length ? reader.all(`SELECT n.id, n.seq, n.input, n.output, m.project_id
    FROM harness_continuous_search m JOIN harness_nodes n ON n.seq = m.rowid
    WHERE harness_continuous_search MATCH ? AND m.session_id = ? AND m.project_id = ?
    ORDER BY bm25(harness_continuous_search), n.seq DESC LIMIT 16`,
  [terms.map(term => `"${term}"`).join(' OR '), input.sessionId, input.projectId]).map(archivedTurn) : []
  const relevant = evicted.filter(turn => turn.projectId === input.projectId)
  const byId = (ids: readonly string[]) => ids.length ? reader.all(`SELECT n.id, n.seq, n.input, n.output, m.project_id FROM harness_nodes n
    JOIN harness_continuous_search m ON m.rowid = n.seq WHERE n.id IN (SELECT value FROM json_each(?))
    AND m.session_id = ? AND m.project_id = ? ORDER BY n.seq DESC`,
  [JSON.stringify(ids), input.sessionId, input.projectId]).map(archivedTurn) : []
  const direct = [...byId([...directIds]), ...relevant.filter(turn => directIds.has(turn.nodeId))]
  const scored = [...matches, ...relevant].map(turn => {
    const tokens = new Set(keywords(`${turn.user}\n${turn.assistant}`))
    return { turn, score: terms.filter(term => tokens.has(term)).length }
  }).filter(candidate => candidate.score > 0).sort((left, right) => right.score - left.score || right.turn.sequence - left.turn.sequence)
  const adjacent = /刚才|前面|前文|先前|上次|之前|照旧|按约定|原来的|as (?:discussed|agreed|before)|earlier|last time/iu.test(input.query)
  let nearby = adjacent && !directIds.size ? relevant.at(-1) : undefined
  if (adjacent && !directIds.size && !nearby && !evicted.length && root) {
    const ids = JSON.parse(text(root, 'evicted_node_ids_json')) as readonly string[]
    nearby = byId(ids)[0]
  }
  const candidates = [...direct, ...scored.map(candidate => candidate.turn), ...(nearby ? [nearby] : [])]
  const hits: HistoryTurn[] = []
  for (const turn of candidates) {
    if (hits.some(hit => hit.nodeId === turn.nodeId)) continue
    const extract = (limit: number) => ({ nodeId: turn.nodeId, user: snippet(turn.user, terms, limit), assistant: snippet(turn.assistant, terms, limit) })
    let hit = extract(700)
    let cost = projectedTokens(JSON.stringify(hit)) + 24
    const shorterLimit = Math.floor((budget - 56) / 2)
    if (cost > budget && shorterLimit >= 64 && shorterLimit < 700) {
      hit = extract(shorterLimit)
      cost = projectedTokens(JSON.stringify(hit)) + 24
    }
    if (cost > budget) continue
    hits.push(hit)
    budget -= cost
    if (hits.length === maxRetrieved) break
  }
  return hits
}

export function commitContinuousRoot(tx: StorageTransaction, sessionId: string, plan: ContinuousRunPlan): void {
  const prior = currentRoot(tx, sessionId)
  if ((prior ? text(prior, 'id') : null) !== plan.expectedRootId) throw treeError('history-position-changed')
  if (plan.context.rootId !== (plan.root?.id ?? plan.expectedRootId)) throw treeError('invalid-history')
  if (!plan.root) return
  const root = plan.root
  tx.execute(`INSERT INTO harness_continuous_roots (id, session_id, parent_id, anchor_node_id, cutoff_seq, evicted_node_ids_json)
    VALUES (?, ?, ?, ?, ?, ?)`, [root.id, sessionId, root.parentId, root.anchorNodeId, root.cutoff, JSON.stringify(root.evicted.map(turn => turn.nodeId))])
  for (const turn of root.evicted) {
    tx.execute('INSERT INTO harness_continuous_search (rowid, terms, session_id, project_id) VALUES (?, ?, ?, ?)',
      [turn.sequence, keywords(`${turn.user}\n${turn.assistant}`).join(' '), sessionId, turn.projectId])
  }
}
