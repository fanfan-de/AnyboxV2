export const definition = { id: 'agent', name: 'Harness', icon: 'agent' }
export function fakeRuntime() {
  return { state: 'disabled', calls: [], failure: undefined,
    async open() { this.calls.push('open'); if (this.failure) { this.state = 'failed'; throw this.failure }; this.state = 'active' },
    async stop() { this.calls.push('stop'); if (this.failure) { this.state = 'failed'; throw this.failure }; this.state = 'disabled' },
    async retry() { await this.open() }, inspect() { return this.state }, closeAdmission() {}, async awaitIdle() {},
  }
}
