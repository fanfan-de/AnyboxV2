import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createApplicationArchive, verifyApplicationArchive } from '../dist/package-management/archive.js'
import { prepareApplicationArchive } from '../dist/package-management/preparation.js'
import { startManagedApplicationHost } from '../dist/package-management/managed-process.js'
import { captureApplicationChannelPayload } from '../dist/package-management/channel-payload.js'

const supported = process.platform !== 'win32' && (Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 15)
const invalidPayload = error => error.code === 'application-channel-invalid-payload'

test('private channel captures bounded JSON without evaluating application accessors', () => {
  const input = { text: 'hello', nested: [null, true, 2] }, captured = captureApplicationChannelPayload(input)
  input.nested.push(false)
  assert.deepEqual(captured, { text: 'hello', nested: [null, true, 2] })
  let accessed = false
  const accessor = { get secret() { accessed = true; return 'must not read' } }
  const array = []; Object.defineProperty(array, '0', { enumerable: true, get() { accessed = true; return 1 } })
  const cycle = {}; cycle.self = cycle
  let deep = null; for (let i = 0; i < 34; i++) deep = { child: deep }
  for (const value of [undefined, () => {}, new Date(), NaN, Infinity, accessor, array, cycle, deep, 'x'.repeat(1024 * 1024)]) assert.throws(() => captureApplicationChannelPayload(value), invalidPayload)
  assert.equal(accessed, false)
})

test('managed same-package channel reaches a closed execution declaration, freezes admission and joins cancellation', { skip: !supported }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-application-channel-'))
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), trustPolicyPath = join(directory, 'trust.json')
  const entered = join(directory, 'entered'), exited = join(directory, 'exited'), opened = join(directory, 'business-opened')
  await writeFile(trustPolicyPath, JSON.stringify({ schemaVersion: 1, publishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey, appIds: ['fixture'] }] }))
  const code = `import {writeFileSync} from 'node:fs';
    import {createApplicationRuntime} from '@anybox/application-api/nya';
    import {productsServiceKey} from '@anybox/application-api';
    import {json,requestObject} from '@anybox/application-api/node';
    export function createRegistration(context){
      if(context.phase==='prepare'&&context.channel)throw Error('prepare channel forbidden');
      const definition={id:'fixture',name:'Fixture',icon:'fixture'};
      if(context.role==='client')return {definition,http:{service:'fixture.http'},createRuntime:root=>createApplicationRuntime(root,installation=>{
        installation.install({name:'fixture-client',apply(ctx){ctx.provide('fixture.http',{async handle(request,response){
          const payload=await requestObject(request,['op','data']);
          const controller=new AbortController(),abort=()=>controller.abort();response.once('close',abort);
          try{const value=await context.channel.request(payload,controller.signal);if(!response.destroyed)json(response,200,value)}catch(error){if(!response.destroyed)json(response,503,{error:{code:error.code}})}finally{response.off('close',abort)}
        }})}})
      })};
      return {definition,channel:{async handle(root,payload,request){
        if(context.channel||request.appId!=='fixture'||request.sourceRole!=='client')throw Error('wrong channel binding');
        const products=root.get(productsServiceKey);
        if(payload.op==='status')return {state:products.get('fixture').state};
        if(payload.op==='open'){await products.open('fixture');return {state:products.get('fixture').state}};
        if(payload.op==='pull'){writeFileSync(${JSON.stringify(entered)},'entered');await new Promise(resolve=>{if(request.signal.aborted)resolve();else request.signal.addEventListener('abort',resolve,{once:true})});await new Promise(resolve=>setTimeout(resolve,100));writeFileSync(${JSON.stringify(exited)},'exited');throw Object.assign(Error('cancelled'),{code:'cancelled'})};
        if(payload.op==='invalid-result')return new Date();
        return {appId:request.appId,sourceRole:request.sourceRole,data:payload.data};
      }},createRuntime:root=>createApplicationRuntime(root,()=>{writeFileSync(${JSON.stringify(opened)},'opened')})};
    }`
  const manifest = { schemaVersion: 1, lifecycleVersion: 1, appId: 'fixture', version: '1.0.0', publisher: 'fixture', displayName: 'Fixture', applicationApi: '^0.1.0', target: { os: process.platform, arch: process.arch }, entries: { client: 'payload/registration.js', execution: 'payload/registration.js' }, runtimeRequirements: Object.fromEntries(['client', 'execution'].map(role => [role, { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }])) }
  const bytes = Buffer.from(createApplicationArchive({ keyId: 'fixture', privateKey: keys.privateKey, manifest, files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') }, { path: 'payload/registration.js', bytes: Buffer.from(code) }] }))
  const verified = verifyApplicationArchive(bytes, { target: manifest.target, applicationApiVersion: '0.1.0', trustedPublishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey, appIds: ['fixture'] }], runtimeProfiles: Object.fromEntries(['client', 'execution'].map(role => [role, { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: process.versions.node }])) })
  const prepared = await prepareApplicationArchive(verified)
  assert.equal(prepared.roles.execution.registration.hasChannel, true)
  assert.equal(prepared.roles.client.registration.hasChannel, undefined)
  await assert.rejects(readFile(opened), error => error.code === 'ENOENT')
  const host = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), executionPath: join(directory, 'execution.sqlite'), trustPolicyPath, port: 0, clientEntry: new URL('./helpers/channel-client-entry.mjs', import.meta.url) })
  t.after(async () => { await host.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const call = async (path, method = 'GET', payload, raw = false) => {
    const response = await fetch(host.url + path, { method, headers: { ...(method === 'GET' ? {} : { Origin: host.url }), ...(payload === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) }, ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) })
    return { status: response.status, value: await response.json() }
  }
  const success = async (...args) => { const result = await call(...args); assert.ok(result.status < 300, JSON.stringify(result)); return result.value }
  const intent = await success('/api/client/v1/app-packages/operations', 'POST', { requestId: randomUUID(), filename: 'fixture.anybox-app', archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length })
  await success('/api/client/v1/app-packages/operations/' + intent.id + '/archive', 'PUT', bytes, true)
  const before = await success('/api/client/v1/app-packages'), activation = await success('/api/client/v1/app-packages/activations', 'POST', { requestId: randomUUID(), expectedRegistryRevision: before.registryRevision })
  await call('/api/client/v1/app-packages/activations/' + activation.id + '/commit', 'POST', {}).catch(() => {})
  for (let i = 0; i < 500; i++) { if (host.state.phase === 'ready' && host.state.roles.length === 2) break; await delay(10) }
  assert.equal(host.state.phase, 'ready'); assert.equal(host.state.roles.length, 2)
  await success('/api/client/v1/products/fixture/open', 'POST', {})
  const channel = payload => call('/api/client/v1/apps/fixture', 'POST', payload)
  assert.deepEqual((await channel({ op: 'status' })).value, { state: 'disabled' })
  await assert.rejects(readFile(opened), error => error.code === 'ENOENT')
  assert.deepEqual((await channel({ op: 'echo', data: { nested: ['hello', 1] } })).value, { appId: 'fixture', sourceRole: 'client', data: { nested: ['hello', 1] } })
  assert.equal((await channel({ op: 'wrong-package' })).value.error.code, 'application-channel-identity-mismatch')
  assert.equal((await channel({ op: 'wrong-source' })).value.error.code, 'application-channel-unavailable')
  const invalid = await channel({ op: 'invalid-result' }); assert.equal(invalid.value.error.code, 'application-channel-invalid-payload')
  assert.equal((await host.inspectForQuit()).busy, false)
  assert.equal((await channel({ op: 'status' })).value.error.code, 'product-unavailable')
  await host.releaseQuit()
  assert.deepEqual((await channel({ op: 'open' })).value, { state: 'running' })
  assert.equal(await readFile(opened, 'utf8'), 'opened')
  const controller = new AbortController()
  const pulling = fetch(host.url + '/api/client/v1/apps/fixture', { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'pull' }), signal: controller.signal }).catch(() => {})
  for (let i = 0; i < 500; i++) { if (await readFile(entered).then(() => true, () => false)) break; await delay(10) }
  assert.equal(await readFile(entered, 'utf8'), 'entered')
  controller.abort(); await pulling
  await host.close()
  assert.equal(await readFile(exited, 'utf8'), 'exited')
  assert.equal(host.state.phase, 'closed')
})
