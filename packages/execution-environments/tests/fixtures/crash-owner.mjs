import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { openExecutionEnvironmentManager } from '../../dist/index.js'

const [file,point,operationId = 'call',kind = 'provider'] = process.argv.slice(2)
const root = new Context()
await root.installComponent(createLocalSqliteComponent(file))
const storage = root.get('local-storage')
const hang = () => new Promise(() => {})
// Captures the precise gap AFTER each durable transaction and BEFORE its caller resumes.
const manager = await openExecutionEnvironmentManager({...storage, async transaction(work,signal) {
  let marker
  const result = await storage.transaction(tx => work({...tx, execute(sql,values) {
    if (sql.includes('INSERT INTO environment_admissions(')) marker='reserved'
    if (sql.includes("UPDATE environment_admissions SET state='sent' WHERE")) marker='sent'
    return tx.execute(sql,values)
  }}),signal)
  if (marker===point) { process.send(point); await hang() }
  return result
}})
const tool = kind === 'hosted' ? { environmentId:'model-search', targetId:'provider-1', toolId:'web_search', version:'1' } :
  {environmentId:'computer',targetId:'attachment-a:epoch-1',toolId:'files.read',version:'1'}
await manager.set({agentId:'agent',expectedRevision:0,requestId:'grant',tools:[tool]})
let entered
const started = new Promise(yes => { entered=yes })
const dispatch = kind === 'scope' ? manager.runScope : kind === 'provider' ? manager.run : manager.runModel
void dispatch('agent',(await manager.get('agent')).grants,operationId,() => {
  if (point==='started') process.send(point)
  entered()
  return {result:hang(),done:hang()}
})
if (point==='revoked') {
  await started
  await manager.set({agentId:'agent',expectedRevision:1,requestId:'withdraw',tools:[]})
  process.send(point)
}
// Keep the process alive even when all promises await test-controlled proof.
setInterval(() => {},60000)
