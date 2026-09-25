import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort } from '../storage/port.js'
import { nonEmpty } from '../validation.js'
import { openSqlitePromptStorage } from './sqlite-storage.js'
import {
  createPromptDocument, editPromptDocument, publishPromptDocument,
} from './domain.js'
import type {
  PromptCreateInput, PromptDocument, PromptEditInput, PromptVersion,
} from './domain.js'

export const promptServiceKey = 'harness.prompts'

export interface PromptPort {
  createPrompt(actorId: string, input: PromptCreateInput): Promise<PromptDocument>
  editPrompt(actorId: string, id: string, expectedRevision: number, patch: PromptEditInput): Promise<PromptDocument>
  publishPrompt(actorId: string, id: string): Promise<PromptVersion>
  getPrompt(actorId: string, id: string): PromptDocument | undefined
  listPrompts(actorId: string): readonly PromptDocument[]
  getPromptVersions(actorId: string, id: string): readonly PromptVersion[]
  /** Trusted consumers use this to validate and resolve a published version. */
  getPublishedVersion(id: string): PromptVersion | undefined
}

/** Prompt owns documents, versions, their read projection, and write cleanup. */
export function createPromptComponent(
  inputs: RuntimeInputs, legacyJsonPath?: string,
): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
}> {
  return {
    name: 'harness-prompts',
    inject: [localStorageServiceKey],
    async apply(ctx, _config, deps) {
      const { service: storage, close } = await openSqlitePromptStorage(
        deps[localStorageServiceKey], legacyJsonPath)
      ctx.effect(() => close, 'join prompt storage operations')

      const ownerDocument = (actorId: string, id: string): PromptDocument | undefined => {
        const document = storage.getDocument(id)
        if (document && document.ownerId !== actorId) throw new Error('prompt access denied')
        return document
      }
      const service: PromptPort = {
        async createPrompt(actorId, input) {
          const actor = nonEmpty(actorId, 'actorId')
          const id = inputs.newId()
          const document = createPromptDocument(id, actor, input, inputs.now())
          await storage.createDocument(document)
          return document
        },
        async editPrompt(actorId, id, expectedRevision, patch) {
          const actor = nonEmpty(actorId, 'actorId')
          const prior = ownerDocument(actor, id)
          if (!prior) throw new Error(`unknown prompt ${id}`)
          const next = editPromptDocument(prior, expectedRevision, patch, actor, inputs.now())
          await storage.updateDocument(next)
          return storage.getDocument(id) ?? next
        },
        async publishPrompt(actorId, id) {
          const actor = nonEmpty(actorId, 'actorId')
          const prior = ownerDocument(actor, id)
          if (!prior) throw new Error(`unknown prompt ${id}`)
          const versionId = inputs.newId()
          const result = publishPromptDocument(prior, versionId, actor, inputs.now())
          await storage.publish(result.document, result.version)
          return result.version
        },
        getPrompt(actorId, id) { return ownerDocument(nonEmpty(actorId, 'actorId'), id) },
        listPrompts(actorId) { return storage.listDocuments(nonEmpty(actorId, 'actorId')) },
        getPromptVersions(actorId, id) {
          const actor = nonEmpty(actorId, 'actorId')
          const document = ownerDocument(actor, id)
          if (!document) throw new Error(`unknown prompt ${id}`)
          return storage.getVersions(document.id)
        },
        getPublishedVersion(id) { return storage.getVersion(id) },
      }
      ctx.provide(promptServiceKey, service)
    },
  }
}
