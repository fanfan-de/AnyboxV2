import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { createSystemKeyringStore } from '@anybox/api-key-manager'

/** Runs inside the shipped utility runtime, including its ASAR/native loading paths. */
export async function nativeDesktopSmoke(keyring: boolean) {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES (\'utility\')')
    if (db.prepare('SELECT value FROM probe').get()?.value !== 'utility') throw new Error('SQLite probe failed')
  } finally { db.close() }
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const input = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#274060' } }).toFormat(format).toBuffer()
    const metadata = await sharp(input).metadata()
    if (metadata.format !== format || metadata.width !== 2 || metadata.height !== 3) throw new Error('Image probe failed')
  }
  if (keyring) {
    const store = createSystemKeyringStore({ namespace: `anybox-desktop-smoke-${randomUUID()}` })
    try {
      await store.write('probe', 'temporary-desktop-smoke')
      if (await store.read('probe') !== 'temporary-desktop-smoke') throw new Error('Vault probe failed')
      await store.delete('probe')
      if (await store.read('probe') !== undefined) throw new Error('Vault delete failed')
    } finally { try { await store.delete('probe') } finally { await store.close() } }
  }
  return { sqlite: true, images: ['png', 'jpeg', 'webp'], keyring: keyring ? 'passed' : 'not-requested', node: process.versions.node }
}
