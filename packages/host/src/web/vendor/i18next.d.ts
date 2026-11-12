/** Only the bundled browser adapter's surface crosses into shell code. */
interface Instance {
  init(options: object): Promise<unknown>
  t(key: string, options?: object): string
}
export function createInstance(): Instance
