export interface DesktopQuitPreflight {
  canLeave(): Promise<boolean>
  confirmDiscard(): Promise<boolean>
  inspectActivity(): Promise<{ readonly busy: boolean }>
  confirmCancelRuns(): Promise<boolean>
  releaseActivity(): Promise<void>
}

/** Ask the page through its public event contract, without reading application state. */
export const desktopBeforeUnloadProbe = `(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return !event.defaultPrevented;
})()`

/** Page consent precedes the activity freeze; accepted quit retains that freeze. */
export async function prepareDesktopQuit(preflight: DesktopQuitPreflight): Promise<boolean> {
  if (!await preflight.canLeave() && !await preflight.confirmDiscard()) return false
  const activity = await preflight.inspectActivity()
  if (!activity.busy) return true
  let confirmed: boolean
  try { confirmed = await preflight.confirmCancelRuns() }
  catch (error) {
    try { await preflight.releaseActivity() }
    catch (releaseError) { throw new AggregateError([error, releaseError], 'Desktop quit confirmation failed and activity could not be released') }
    throw error
  }
  if (!confirmed) await preflight.releaseActivity()
  return confirmed
}
