import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'
import { personalAgentApplication } from '../registration.js'
import type { PersonalAgentOptions } from '../registration.js'

/** Pure declaration; Models and business storage open only when the product is opened. */
export function createRegistration(_context?: ApplicationPackageRuntimeContext, config: PersonalAgentOptions = {}) {
  return personalAgentApplication(config)
}
