import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { homedir } from 'node:os'
import { productActivityServiceKey } from '@anybox/application-api'
import type { ProductActivityPort } from '@anybox/application-api'
import { hostAccessServiceKey } from '@anybox/application-api/node'
import type { HostAccessPort } from '@anybox/application-api/node'
import { directoryPickerCapabilityId, directoryPickerServiceKey } from '@anybox/directory-picker'
import type { DirectoryPickerPort } from '@anybox/directory-picker'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { personalAgentDefinition, personalAgentId } from './definition.js'
import { harnessServerHttpServiceKey } from './http/harness-http.js'
import { createHarnessServerRuntime } from './server-runtime.js'
import type { HarnessServerRuntimeOptions } from './server-runtime.js'
import type { HarnessServerConfig } from './server-config.js'

const ownedServices = [localStorageServiceKey, 'models', 'models.settings', 'models.protocols', 'models.store', 'models.vault',
  'models.source-data', 'models.catalog', 'models.catalog-source', 'models.catalog-cache']
const ownedBindings = Object.freeze(Object.fromEntries(ownedServices.map(key => [key, `personal-agent.${key}`])))

export function personalAgentServerApplication(config: HarnessServerConfig, options: HarnessServerRuntimeOptions = {}): ApplicationRegistration {
  return {
    definition: personalAgentDefinition,
    capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' }, optional: { [directoryPickerCapabilityId]: '^1.0.0' } },
    http: { service: harnessServerHttpServiceKey,
      capabilities: ['personal-agent.v1', 'projects.path', 'images', 'project-files', 'sse', 'units', 'computer-environments'],
      selfAuthenticated: ['/units/unit'] },
    createRuntime(root, context) {
      const serviceBindings = { ...context?.serviceBindings, ...ownedBindings }
      const picker = !!context?.capabilities[directoryPickerCapabilityId]
      return createHarnessServerRuntime(root, config, { ...options, projectDirectoryHome: options.projectDirectoryHome ?? homedir() }, {
        serviceBindings,
        installStorage: installation => installation.install(createLocalSqliteComponent(config.harnessDatabasePath)),
        registerStopGuard: guard => root.get<ProductActivityPort>(serviceBindings[productActivityServiceKey] ?? productActivityServiceKey)!.registerGuard(personalAgentId, guard),
        http: {
          inject: [productActivityServiceKey, ...(options.authenticated === false ? [] : [hostAccessServiceKey]), ...(picker ? [directoryPickerServiceKey] : [])],
          resolve(deps) {
            const access = deps[hostAccessServiceKey] as HostAccessPort | undefined
            return { activity: deps[productActivityServiceKey] as ProductActivityPort,
              directoryPicker: picker ? deps[directoryPickerServiceKey] as DirectoryPickerPort : null,
              instanceId: () => access?.instance.instanceId ?? null,
              ...(access ? { onRevoked: listener => access.onRevoked(listener) } : {}) }
          },
        },
      })
    },
  }
}
