/** Isolated desktop orchestration tests must never access the operating system Vault. */
const values = new Map()
export class AsyncEntry {
  constructor(namespace, id) { this.key = `${namespace}:${id}` }
  async getPassword() { return values.get(this.key) ?? null }
  async setPassword(value) { values.set(this.key, value) }
  async deleteCredential() { return values.delete(this.key) }
}
