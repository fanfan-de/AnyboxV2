// Credentials stay in the test parent's memory across real role-process restarts.
export class AsyncEntry {
  constructor(namespace, id) { this.namespace = namespace; this.id = id }
  async call(method, value) {
    const response = await fetch(process.env.ANYBOX_TEST_VAULT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: this.namespace, id: this.id, method, value }) })
    if (!response.ok) throw new Error('Injected Vault unavailable')
    return (await response.json()).value
  }
  getPassword() { return this.call('read') }
  setPassword(value) { return this.call('write', value) }
  deleteCredential() { return this.call('delete') }
}
