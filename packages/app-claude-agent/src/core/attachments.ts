import { createHash } from 'node:crypto';
import { claudeAgentError, idempotencyKeyPattern } from './domain.js';
export interface AttachmentView {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly sha256: string;
}
export interface AttachmentUpload {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly received: number;
    readonly ready: boolean;
}
export interface AttachmentData extends AttachmentView {
    readonly data: string;
}
export const attachmentLimit = 8 * 1024 * 1024;
export const attachmentTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'] as const;
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function validateAttachmentHeader(raw: Record<string, unknown>): {
    name: string;
    mime: string;
    size: number;
    idempotencyKey: string;
} {
    if (Object.keys(raw).some(key => !['name', 'mime', 'size', 'idempotencyKey'].includes(key)) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 || /[\x00-\x1f]/.test(raw.name) || !attachmentTypes.includes(raw.mime as typeof attachmentTypes[number]) || !Number.isSafeInteger(raw.size) || Number(raw.size) < 1 || Number(raw.size) > attachmentLimit || typeof raw.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(raw.idempotencyKey))
        throw claudeAgentError('attachment-invalid', 400, '支持 PNG、JPEG、GIF、WebP、PDF 和 UTF-8 文本，每个文件最多 8 MiB。');
    return { name: raw.name, mime: String(raw.mime), size: Number(raw.size), idempotencyKey: raw.idempotencyKey };
}
export function attachmentBytes(data: unknown): Buffer {
    if (typeof data !== 'string' || data.length > 256 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
        throw claudeAgentError('attachment-invalid', 400);
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length)
        throw claudeAgentError('attachment-invalid', 400);
    return bytes;
}
export function verifyAttachment(mime: string, bytes: Uint8Array): void {
    const b = Buffer.from(bytes), head = b.subarray(0, 16);
    const valid = mime === 'image/png' ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : mime === 'image/jpeg' ? head[0] === 255 && head[1] === 216 && head[2] === 255 : mime === 'image/gif' ? /^GIF8[79]a/.test(head.toString('ascii')) : mime === 'image/webp' ? head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' : mime === 'application/pdf' ? head.toString('ascii', 0, 5) === '%PDF-' : mime === 'text/plain' && (() => { try {
        new TextDecoder('utf-8', { fatal: true }).decode(b);
        return !b.includes(0);
    }
    catch {
        return false;
    } })();
    if (!valid)
        throw claudeAgentError('attachment-invalid', 400, '文件内容与声明的类型不匹配。');
}
