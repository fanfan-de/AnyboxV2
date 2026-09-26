import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepSeekCredentialId } from '../dist/llm/deepseek-chat-completions/component.js'
import { openAIResponsesCredentialId } from '../dist/llm/openai-responses/component.js'
import { createWebLLMComponent, parseWebStartupConfig } from '../dist/web/startup-config.js'

test('Web startup keeps the existing DeepSeek defaults and registers its credential', () => {
  const config = parseWebStartupConfig({})
  assert.deepEqual(config, {
    port: 0,
    llm: {
      api: 'deepseek-chat-completions',
      profile: { id: 'default', model: 'deepseek-flash', temperature: 0.7, timeoutMs: 30_000 },
      credential: { id: deepSeekCredentialId, label: 'DeepSeek Chat', category: '大语言模型' },
    },
  })
  assert.equal(createWebLLMComponent(config.llm).name, 'deepseek-chat-completions')
})

test('Web Responses configuration requires a model and omits optional API parameters by default', () => {
  const config = parseWebStartupConfig({ ANYBOX_LLM_API: 'openai-responses', ANYBOX_LLM_MODEL: 'test-responses-model' })
  assert.deepEqual(config, {
    port: 0,
    llm: {
      api: 'openai-responses',
      profile: { id: 'default', model: 'test-responses-model', timeoutMs: 30_000 },
      credential: { id: openAIResponsesCredentialId, label: 'OpenAI Responses', category: '大语言模型' },
    },
  })
  assert.equal(createWebLLMComponent(config.llm).name, 'openai-responses')
  assert.throws(() => parseWebStartupConfig({ ANYBOX_LLM_API: 'openai-responses' }), /ANYBOX_LLM_MODEL/)
})

test('Web startup accepts explicit model, base URL, timing and generation settings for either API', () => {
  for (const api of ['deepseek-chat-completions', 'openai-responses']) {
    const env = Object.freeze({
      ANYBOX_LLM_API: api, ANYBOX_LLM_MODEL: ' compatible-model ',
      ANYBOX_LLM_BASE_URL: ' https://models.example/v1/ ', ANYBOX_LLM_TIMEOUT_MS: '60000',
      ANYBOX_LLM_MAX_OUTPUT_TOKENS: '8192', ANYBOX_LLM_TEMPERATURE: '0', ANYBOX_WEB_PORT: '8080',
    })
    const config = parseWebStartupConfig(env)
    assert.equal(config.port, 8080)
    assert.equal(config.llm.baseUrl, 'https://models.example/v1/')
    assert.deepEqual(config.llm.profile, {
      id: 'default', model: 'compatible-model', timeoutMs: 60000, maxOutputTokens: 8192, temperature: 0,
    })
    assert.equal(createWebLLMComponent(config.llm).name, api)
    assert.equal(env.ANYBOX_LLM_MODEL, ' compatible-model ')
  }
})

test('Web startup rejects invalid environment settings before component installation', () => {
  const invalid = {
    ANYBOX_LLM_API: ['', ' ', 'chat-completions', 'responses'],
    ANYBOX_LLM_MODEL: ['', ' '],
    ANYBOX_LLM_BASE_URL: ['', 'invalid', 'file:///tmp/model', 'https://models.example/v1?token=secret',
      'https://models.example/v1#responses', 'https://user:secret@models.example/v1'],
    ANYBOX_LLM_TIMEOUT_MS: ['', '0', '-1', '1.5', 'Infinity', 'NaN', '2147483648'],
    ANYBOX_LLM_MAX_OUTPUT_TOKENS: ['', '0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992'],
    ANYBOX_LLM_TEMPERATURE: ['', '-0.1', '2.1', 'Infinity', 'NaN'],
    ANYBOX_WEB_PORT: ['', '-1', '65536', '1.5', 'NaN'],
  }
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => parseWebStartupConfig({ [name]: value }), new RegExp(name), `${name}=${value}`)
    }
  }
  assert.equal(parseWebStartupConfig({ ANYBOX_LLM_TIMEOUT_MS: '2147483647' }).llm.profile.timeoutMs, 2147483647)
  assert.equal(parseWebStartupConfig({ ANYBOX_LLM_TEMPERATURE: '2', ANYBOX_WEB_PORT: '65535' }).port, 65535)
})
