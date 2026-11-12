/** Narrow declaration for the application's independently bundled translation engine. */
interface Instance {
  init(options: object): Promise<unknown>
  changeLanguage(language: string): Promise<unknown>
  t(key: string, options?: object): string
}
export function createInstance(): Instance
