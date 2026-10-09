import { MakerDMG } from '@electron-forge/maker-dmg'
import { MakerZIP } from '@electron-forge/maker-zip'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execute = promisify(execFile)

export default {
  packagerConfig: {
    name: 'Anybox',
    executableName: 'Anybox',
    appBundleId: 'com.anybox.desktop',
    appCategoryType: 'public.app-category.productivity',
    asar: { unpack: '{**/node_modules/{sharp,@img,@napi-rs,@vscode}/**/*,**/dist/desktop/native/mac-dialog.node}' },
    ignore: [/^\/vendor(?:\/|$)/, /^\/deploy(?:\/|$)/, /^\/package-lock\.json$/, /^\/README\.md$/],
    osxSign: false,
    osxNotarize: false,
  },
  // The installed native packages use Node-API prebuilds; keep these matching
  // target binaries instead of rebuilding with machine-global libvips.
  rebuildConfig: { ignoreModules: ['sharp', '@napi-rs/keyring'] },
  hooks: {
    async postPackage(_config, { platform, outputPaths }) {
      if (platform !== 'darwin') return
      // Renaming Electron changes helper Info.plists. Repair their local
      // signatures after all ASAR/fuse modifications so Keychain accepts them.
      for (const output of outputPaths) {
        const app = join(output, 'Anybox.app')
        await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-',
          '--preserve-metadata=entitlements,requirements,flags,runtime', app])
        await execute('/usr/bin/codesign', ['--verify', '--strict',
          join(app, 'Contents/Resources/app.asar.unpacked/dist/desktop/native/mac-dialog.node')])
        await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
      }
    },
  },
  makers: [new MakerDMG({ format: 'ULFO' }), new MakerZIP({}, ['darwin'])],
  plugins: [new FusesPlugin({ version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  })],
}
