export interface ApplicationInterfaceLease {
  check(): void
  /** Rechecks every interface immediately before any disposal. */
  disposeForRestart(): Promise<void>
  /** Releases an intact workspace; failed disposal keeps the fence in place. */
  release(): void
}
interface Interface { canClose(): boolean; dispose(): Promise<void> }
interface Options {
  readonly interfaces: () => readonly Interface[]
  readonly settle: () => Promise<void>
  readonly freeze: (frozen: boolean) => void
  readonly save: () => void
}
const failure = (code: string) => Object.assign(new Error(code), { code })
/** Coordinates only interface lifetime; application guards retain all business decisions. */
export function createApplicationInterfaceLifecycle(options: Options) {
  let held = false
  async function prepare(): Promise<ApplicationInterfaceLease> {
    if (held) throw failure('application-interface-busy')
    held = true; options.freeze(true)
    let released = false, disposalStarted = false, disposalSettled = false, releaseRequested = false, disposalFailed = false, disposal: Promise<void> | undefined
    function check() {
      try { if (!options.interfaces().map(view => view.canClose()).every(Boolean)) throw failure('application-interface-blocked') }
      catch (error) { throw error && typeof error === 'object' && 'code' in error ? error : failure('application-interface-blocked') }
    }
    function release() {
      if (released || disposalFailed) return
      if (disposalStarted && !disposalSettled) { releaseRequested = true; return }
      released = true; held = false; options.freeze(false)
    }
    try { await options.settle(); check() } catch (error) { release(); throw error }
    return { release, check, disposeForRestart() {
      if (released) return Promise.reject(failure('application-interface-lease-released'))
      if (disposal) return disposal
      try { check() } catch (error) { release(); return Promise.reject(error) }
      options.save(); disposalStarted = true
      // Wait for every accepted disposal even when another interface fails.
      disposal = Promise.allSettled(options.interfaces().map(view => Promise.resolve().then(() => view.dispose()))).then(results => {
        disposalSettled = true
        if (results.some(result => result.status === 'rejected')) { disposalFailed = true; throw failure('application-interface-cleanup-failed') }
        if (releaseRequested) release()
      })
      return disposal
    } }
  }
  return { prepare, get frozen() { return held } }
}
