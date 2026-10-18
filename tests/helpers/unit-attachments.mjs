import { createUnitAttachmentsComponent } from '../../packages/app-harness/dist/core/unit/component.js'
import { localComputerUnitId, localModelsUnitId } from '../../packages/app-harness/dist/core/unit/domain.js'
import { unitAttachmentsServiceKey } from '../../packages/app-harness/dist/core/unit/port.js'

/** Direct component fixtures attach the same local units as the trusted composition root. */
export async function installUnitAttachments(root, inputs) {
  if (root.get(unitAttachmentsServiceKey)) return
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits: [
    { unitKind: 'models', unitId: localModelsUnitId }, { unitKind: 'computer', unitId: localComputerUnitId }] }))
}
