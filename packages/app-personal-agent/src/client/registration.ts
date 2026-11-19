import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { personalAgentDefinition } from '../definition.js'
import { personalAgentAssetPrefix, personalAgentAssets } from '../assets.js'
import { createPersonalAgentClientRuntime } from './runtime.js'
import type { PersonalAgentClientRuntimeOptions } from './runtime.js'
import { clientGatewayServiceKey } from './gateway.js'

export function personalAgentClientApplication(options: PersonalAgentClientRuntimeOptions = {}): ApplicationRegistration {
  return {
    capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' }, optional: { 'system.directory-picker': '^1.0.0' } },
    definition: { ...personalAgentDefinition, web: { entry: `${personalAgentAssetPrefix}/web/harness-app.js`, styles: [`${personalAgentAssetPrefix}/style.css`] } },
    createRuntime: (root, context) => createPersonalAgentClientRuntime(root, options, context),
    http: { service: clientGatewayServiceKey },
    assets: personalAgentAssets,
  }
}
