import { createUnitAttachmentsComponent } from '../../dist/applications/harness/core/unit/component.js'
import { localComputerUnitId, localModelsUnitId } from '../../dist/applications/harness/core/unit/domain.js'
import { unitAttachmentsServiceKey } from '../../dist/applications/harness/core/unit/port.js'

/** Direct component fixtures attach the same local units as the trusted composition root. */
export async function installUnitAttachments(root, inputs) {
  if (root.get(unitAttachmentsServiceKey)) return
  await root.installComponent(createUnitAttachmentsComponent(inputs, { localUnits: [
    { unitKind: 'models', unitId: localModelsUnitId }, { unitKind: 'computer', unitId: localComputerUnitId }] }))
}
