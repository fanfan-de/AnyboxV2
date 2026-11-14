import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateToolArguments, validateToolDescriptor, validateToolDescriptors } from '../dist/index.js'

const descriptor = parameters => ({ toolId: 'example.lookup', version: '1', definition: { name: 'lookup', parameters } })

test('registration rejects unsupported constraints instead of weakening admission', () => {
  for (const parameters of [
    { type: 'object', properties: { address: { type: 'string', format: 'email' } } },
    { type: 'object', properties: { choice: { $ref: '#/$defs/choice' } } },
    { type: 'object', properties: { text: { type: 'string', pattern: '[' } } },
  ]) assert.throws(() => validateToolDescriptor(descriptor(parameters)))
  assert.throws(() => validateToolDescriptors([descriptor({ type: 'object' }), descriptor({ type: 'object' })]), /duplicate/)
})

test('declared string, numeric and composition constraints all participate in validation', () => {
  const { definition } = validateToolDescriptor(descriptor({
    type: 'object', additionalProperties: false, required: ['code', 'amount', 'choice'],
    properties: {
      code: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[A-Z]+$' },
      amount: { type: 'number', exclusiveMinimum: 0, maximum: 10, multipleOf: 0.5 },
      choice: { oneOf: [{ const: 'first' }, { type: 'integer', minimum: 1 }] },
    },
  }))
  assert.deepEqual(validateToolArguments(definition, { code: 'AB', amount: 1.5, choice: 'first' }), { code: 'AB', amount: 1.5, choice: 'first' })
  for (const input of [
    { code: 'A', amount: 1.5, choice: 'first' },
    { code: 'ab', amount: 1.5, choice: 'first' },
    { code: 'AB', amount: 0, choice: 'first' },
    { code: 'AB', amount: 1.1, choice: 'first' },
    { code: 'AB', amount: 1.5, choice: false },
    { code: 'AB', amount: 1.5, choice: 1, extra: true },
  ]) assert.throws(() => validateToolArguments(definition, input))
})

test('tool arguments reject non-JSON, cyclic, sparse and NUL inputs', () => {
  const definition = descriptor({ type: 'object' }).definition
  const cyclic = {}; cyclic.self = cyclic
  for (const input of [{ value: undefined }, { value: NaN }, { value: new Date() }, cyclic, { value: 'a\0b' }, { value: new Array(1) }]) {
    assert.throws(() => validateToolArguments(definition, input))
  }
})
