import { fileURLToPath } from 'node:url'
import { createApplication } from '@anybox/application'

const application = createApplication({
  configPath: fileURLToPath(new URL('./application/config.json', import.meta.url)),
})
const errors = []

try {
  await application.start()
} catch (error) {
  errors.push(error)
}

try { await application.close() } catch (error) {
  if (!errors.some(previous => Object.is(previous, error))) errors.push(error)
}
if (errors.length === 1) throw errors[0]
if (errors.length > 1) throw new AggregateError(errors, 'demo and cleanup failed')
