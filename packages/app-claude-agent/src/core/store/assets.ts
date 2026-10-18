import type { LocalStoragePort, StorageRow, StorageTransaction } from '@anybox/storage-sqlite/port';
import { randomUUID } from 'node:crypto';
import { claudeAgentError } from '../domain.js';
import { attachmentBytes, digest, validateAttachmentHeader, verifyAttachment } from '../attachments.js';
import type { AttachmentData, AttachmentUpload } from '../attachments.js';
const view = (r: StorageRow): AttachmentUpload => ({ id: String(r.id), name: String(r.name), mime: String(r.mime), size: Number(r.size), received: Number(r.received), ready: r.sha256 !== null });
export function migrateAssets(tx: StorageTransaction): void {
    tx.execute('CREATE TABLE claude_agent_assets (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, data BLOB NOT NULL, sha256 TEXT, created_at TEXT NOT NULL)');
    tx.execute("ALTER TABLE claude_agent_runs ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
    tx.execute('ALTER TABLE claude_agent_threads ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
    tx.execute('CREATE TABLE claude_agent_inputs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES claude_agent_runs(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, view_json TEXT NOT NULL, UNIQUE(run_id,request_key))');
}
export function assetOperations(db: LocalStoragePort) {
    return {
        async beginAttachment(raw: Record<string, unknown>): Promise<AttachmentUpload> {
            const input = validateAttachmentHeader(raw);
            return db.transaction(tx => {
                const prior = tx.get('SELECT * FROM claude_agent_assets WHERE request_key=?', [input.idempotencyKey]);
                if (prior) {
                    if (prior.name !== input.name || prior.mime !== input.mime || prior.size !== input.size)
                        throw claudeAgentError('idempotency-conflict', 409);
                    return view(prior);
                }
                const used = tx.get('SELECT SUM(size) AS total FROM claude_agent_assets');
                if (Number(used?.total ?? 0) + input.size > 256 * 1024 * 1024)
                    throw claudeAgentError('attachment-quota', 409, '附件存储已达 256 MiB 上限，请移除不再使用的附件。');
                const row = { id: randomUUID(), ...input, received: 0, sha256: null };
                tx.execute('INSERT INTO claude_agent_assets (id,request_key,name,mime,size,data,created_at) VALUES (?,?,?,?,?,?,?)', [row.id, input.idempotencyKey, input.name, input.mime, input.size, Buffer.alloc(0), new Date().toISOString()]);
                return view(row);
            });
        },
        async appendAttachment(id: string, raw: Record<string, unknown>): Promise<AttachmentUpload> {
            if (Object.keys(raw).some(k => !['offset', 'data'].includes(k)) || !Number.isSafeInteger(raw.offset) || Number(raw.offset) < 0)
                throw claudeAgentError('invalid-input', 400);
            const chunk = attachmentBytes(raw.data), offset = Number(raw.offset);
            return db.transaction(tx => {
                const row = tx.get('SELECT * FROM claude_agent_assets WHERE id=?', [id]);
                if (!row)
                    throw claudeAgentError('attachment-not-found', 404);
                const prior = Buffer.from(row.data as Uint8Array);
                if (offset < prior.length && prior.subarray(offset, offset + chunk.length).equals(chunk))
                    return view(row);
                if (offset !== prior.length || prior.length + chunk.length > Number(row.size) || row.sha256)
                    throw claudeAgentError('attachment-offset', 409, '上传位置已改变，请核对原上传状态。');
                const bytes = Buffer.concat([prior, chunk]), ready = bytes.length === row.size;
                if (ready)
                    verifyAttachment(String(row.mime), bytes);
                const sha256 = ready ? digest(bytes) : null;
                tx.execute('UPDATE claude_agent_assets SET data=?,received=?,sha256=? WHERE id=?', [bytes, bytes.length, sha256, id]);
                return view({ ...row, received: bytes.length, sha256 });
            });
        },
        async readAttachments(ids: readonly string[]): Promise<readonly AttachmentData[]> {
            if (ids.length > 5 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))
                throw claudeAgentError('attachment-invalid', 400);
            return db.read(reader => {
                const assets = ids.map(id => { const row = reader.get('SELECT * FROM claude_agent_assets WHERE id=?', [id]); if (!row?.sha256)
                    throw claudeAgentError('attachment-not-ready', 409); return { id: String(row.id), name: String(row.name), mime: String(row.mime), size: Number(row.size), sha256: String(row.sha256), data: Buffer.from(row.data as Uint8Array).toString('base64') }; });
                if (assets.reduce((sum, a) => sum + a.size, 0) > 16 * 1024 * 1024)
                    throw claudeAgentError('attachment-invalid', 400, '每条消息的附件总计最多 16 MiB。');
                return assets;
            });
        },
        async discardAttachment(id: string): Promise<void> {
            await db.transaction(tx => {
                const referenced = tx.all('SELECT attachments_json FROM claude_agent_runs').some(r => String(r.attachments_json).includes(id)) || tx.all('SELECT view_json FROM claude_agent_inputs').some(r => String(r.view_json).includes(id));
                if (referenced)
                    throw claudeAgentError('attachment-in-use', 409);
                tx.execute('DELETE FROM claude_agent_assets WHERE id=?', [id]);
            });
        },
    };
}
