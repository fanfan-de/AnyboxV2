import type { PackageFileInstall } from './port.js'

/** Transport names are host-owned; a submitted filename is never a disk path. */
export function packageSourceFilename(source: Pick<PackageFileInstall, 'sourceFormat'>): string {
  return source.sourceFormat === 'directory' ? 'directory.snapshot' : 'archive.anybox-app'
}
