import { sourceI18n } from './i18n.js';
import type { ClaudeI18n } from './i18n.js';
import type { RunLiveView, QueuedMessageView } from '../core/view.js';
import type { AttachmentUpload } from '../core/attachments.js';
type Request = <T>(path: string, body?: object) => Promise<T>;
interface DraftFile {
    id: string;
    file: File;
    mime: string;
    uploaded?: string;
}
const inputKeys = { queued: 'composer.queued', sent: 'composer.sent', completed: 'composer.completed', failed: 'composer.failed', cancelled: 'composer.cancelled', unknown: 'composer.unknown' } as const;
export function createComposerExtras(options: {
    i18n?: ClaudeI18n;
    key(): string | undefined;
    busy?(): boolean;
    changed(): void;
    report(message: string | (() => string)): void;
    cancel(id: string): Promise<void>;
}) {
    const i18n = options.i18n ?? sourceI18n, { t, element: el } = i18n;
    let uploading: {
        key: string;
        text: () => string;
    } | undefined;
    const drafts = new Map<string, DraftFile[]>(), input = el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.md,.json,.ts,.js,.py,.css,.html', hidden: true });
    const files = el('div', { class: 'ca-attachments', 'aria-label': () => t('composer.attachments') }), progress = el('section', { class: 'ca-execution-tray', 'aria-label': () => t('composer.progress'), hidden: true });
    const add = el('button', { type: 'button', class: 'ca-attach-button', text: () => t('composer.attach'), 'aria-label': () => t('composer.addAttachment') });
    const changed = () => { render(); options.changed(); };
    const render = () => { const key = options.key(), items = key ? drafts.get(key) ?? [] : []; files.replaceChildren(...items.map(item => { const remove = el('button', { type: 'button', text: '×', 'aria-label': () => t('composer.removeAttachment', { name: item.file.name }), title: () => t('composer.removeAttachment', { name: item.file.name }) }); remove.disabled=options.busy?.()??false;
        remove.addEventListener('click', () => {if(options.busy?.())return; drafts.set(key!, items.filter(x => x.id !== item.id)); changed(); }); return el('span', { class: 'ca-attachment-chip' }, el('span', { text: `${item.file.name} · ${item.file.size < 1024 ? item.file.size + ' B' : (item.file.size / 1024).toFixed(0) + ' KB'}` }), remove); })); if (uploading && uploading.key === key)
        files.append(el('small', { role: 'status', text: uploading.text })); };
    const append = (incoming: readonly File[]) => {if(options.busy?.())return; const key = options.key(); if (!key)
        return; const items = drafts.get(key) ?? []; for (const file of incoming) {
        const mime = file.type.startsWith('image/') || file.type === 'application/pdf' ? file.type : /\.(txt|md|json|ts|js|py|css|html|csv|yaml|yml|log)$/i.test(file.name) || file.type.startsWith('text/') ? 'text/plain' : file.type;
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'].includes(mime) || file.size < 1 || file.size > 8 * 1024 * 1024) {
            options.report(() => t('composer.unsupportedFile', { name: file.name }));
            continue;
        }
        if (items.length >= 5 || items.reduce((s, x) => s + x.file.size, 0) + file.size > 16 * 1024 * 1024) {
            options.report(() => t('composer.attachmentLimit'));
            break;
        }
        items.push({ id: crypto.randomUUID(), file, mime });
    } drafts.set(key, items); changed(); };
    add.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { append([...(input.files ?? [])]); input.value = ''; });
    return { add, input, files, progress,
        bind(node: HTMLElement) { node.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files'))
            event.preventDefault(); }); node.addEventListener('drop', event => { if (event.dataTransfer?.files.length) {
            event.preventDefault();
            append([...event.dataTransfer.files]);
        } }); node.addEventListener('paste', event => { const incoming = [...(event.clipboardData?.files ?? [])]; if (incoming.length) {
            event.preventDefault();
            append(incoming);
        } }); },
        move(from: string, to: string) { const items = drafts.get(from); if (items) {
            drafts.set(to, items);
            drafts.delete(from);
        } },
        discardAll() { if(options.busy?.())return;drafts.clear(); changed(); },
        count: () => drafts.get(options.key() ?? '')?.length ?? 0,
        hasDrafts: () => [...drafts.values()].some(items => items.length > 0),
        async prepare(request: Request, key: string) { const selected = [...(drafts.get(key) ?? [])]; try {
            for (const item of selected) {
                if (item.uploaded)
                    continue;
                uploading = { key, text: () => t('composer.preparing', { name: item.file.name }) };
                render();
                let upload = await request<AttachmentUpload>('/apps/claude-agent/attachments', { name: item.file.name, mime: item.mime, size: item.file.size, idempotencyKey: item.id });
                while (!upload.ready) {
                    const bytes = new Uint8Array(await item.file.slice(upload.received, upload.received + 192 * 1024).arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192)
                        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    upload = await request<AttachmentUpload>(`/apps/claude-agent/attachments/${encodeURIComponent(upload.id)}/chunks`, { offset: upload.received, data: btoa(binary) });
                    uploading = { key, text: () => t('composer.uploading', { name: item.file.name, percent: i18n.number(Math.round(upload.received / upload.size * 100)) }) };
                    render();
                }
                item.uploaded = upload.id;
            }
        }
        finally {
            uploading = undefined;
            render();
        } return { ids: selected.map(x => x.uploaded!), clear() { drafts.set(key, (drafts.get(key) ?? []).filter(x => !selected.some(y => y.id === x.id))); render(); } }; },
        update(live?: RunLiveView, messages: readonly QueuedMessageView[] = []) { render(); const inputs = live?.inputs ?? messages, tools = (live?.toolProgress ?? []).filter(p => !p.done); progress.hidden = !inputs.length && !tools.length && !live?.auth?.authenticating && !live?.auth?.failed; const rows: HTMLElement[] = []; if (live?.auth?.authenticating || live?.auth?.failed)
            rows.push(el('p', { role: 'status', text: () => live?.auth?.failed ? t('composer.authFailed') : t('composer.authenticating') })); for (const tool of tools.slice(-4))
            rows.push(el('p', { class: 'ca-progress-row', text: () => t('composer.toolProgress', { parent: tool.parentToolUseId ? t('composer.childAgent') : '', name: tool.name, seconds: i18n.number(Math.floor(tool.elapsedSeconds)) }) })); for (const message of inputs.slice(-10)) {
            const row = el('div', { class: 'ca-queued-message' }, el('span', { text: message.prompt.slice(0, 140) || message.attachments.map(a => a.name).join('、') }), el('small', { text: () => t(inputKeys[message.status]) }));
            if (message.status === 'queued') {
                const cancel = el('button', { type: 'button', text: () => t('composer.dequeue') });
                cancel.addEventListener('click', () => { cancel.disabled = true; void options.cancel(message.id).catch(() => { cancel.disabled = false; }); });
                row.append(cancel);
            }
            rows.push(row);
        } progress.replaceChildren(...rows); },
        dispose() { drafts.clear(); },
    };
}
