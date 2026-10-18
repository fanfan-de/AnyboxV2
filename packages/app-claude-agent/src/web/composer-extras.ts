import { el } from './view.js';
import type { RunLiveView, QueuedMessageView } from '../core/view.js';
import type { AttachmentUpload } from '../core/attachments.js';
type Request = <T>(path: string, body?: object) => Promise<T>;
interface DraftFile {
    id: string;
    file: File;
    mime: string;
    uploaded?: string;
}
const inputLabels = { queued: '等待本轮完成', sent: '已发送，正在处理', completed: '已完成', failed: '处理失败，请查看任务错误', cancelled: '已移除', unknown: '结果未知，请核对历史' };
export function createComposerExtras(options: {
    key(): string | undefined;
    busy?(): boolean;
    changed(): void;
    report(message: string): void;
    cancel(id: string): Promise<void>;
}) {
    let uploading: {
        key: string;
        text: string;
    } | undefined;
    const drafts = new Map<string, DraftFile[]>(), input = el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.md,.json,.ts,.js,.py,.css,.html', hidden: true });
    const files = el('div', { class: 'ca-attachments', 'aria-label': '待发送附件' }), progress = el('section', { class: 'ca-execution-tray', 'aria-label': '执行进度与消息队列', hidden: true });
    const add = el('button', { type: 'button', class: 'ca-attach-button', text: '附件', 'aria-label': '添加图片或文件' });
    const changed = () => { render(); options.changed(); };
    const render = () => { const key = options.key(), items = key ? drafts.get(key) ?? [] : []; files.replaceChildren(...items.map(item => { const remove = el('button', { type: 'button', text: '×', 'aria-label': `移除 ${item.file.name}` }); remove.disabled=options.busy?.()??false;
        remove.addEventListener('click', () => {if(options.busy?.())return; drafts.set(key!, items.filter(x => x.id !== item.id)); changed(); }); return el('span', { class: 'ca-attachment-chip' }, el('span', { text: `${item.file.name} · ${item.file.size < 1024 ? item.file.size + ' B' : (item.file.size / 1024).toFixed(0) + ' KB'}` }), remove); })); if (uploading && uploading.key === key)
        files.append(el('small', { role: 'status', text: uploading.text })); };
    const append = (incoming: readonly File[]) => {if(options.busy?.())return; const key = options.key(); if (!key)
        return; const items = drafts.get(key) ?? []; for (const file of incoming) {
        const mime = file.type.startsWith('image/') || file.type === 'application/pdf' ? file.type : /\.(txt|md|json|ts|js|py|css|html|csv|yaml|yml|log)$/i.test(file.name) || file.type.startsWith('text/') ? 'text/plain' : file.type;
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'].includes(mime) || file.size < 1 || file.size > 8 * 1024 * 1024) {
            options.report(`${file.name}：支持图片、PDF 和 UTF-8 文本，每个文件最多 8 MiB。`);
            continue;
        }
        if (items.length >= 5 || items.reduce((s, x) => s + x.file.size, 0) + file.size > 16 * 1024 * 1024) {
            options.report('每条消息最多 5 个附件，总计 16 MiB。');
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
                uploading = { key, text: `正在准备 ${item.file.name}…` };
                render();
                let upload = await request<AttachmentUpload>('/apps/claude-agent/attachments', { name: item.file.name, mime: item.mime, size: item.file.size, idempotencyKey: item.id });
                while (!upload.ready) {
                    const bytes = new Uint8Array(await item.file.slice(upload.received, upload.received + 192 * 1024).arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192)
                        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    upload = await request<AttachmentUpload>(`/apps/claude-agent/attachments/${encodeURIComponent(upload.id)}/chunks`, { offset: upload.received, data: btoa(binary) });
                    uploading = { key, text: `正在上传 ${item.file.name} · ${Math.round(upload.received / upload.size * 100)}%` };
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
            rows.push(el('p', { role: 'status', text: live.auth.failed ? '认证未完成，请检查执行设备的 Claude 环境与 MCP 连接。' : 'Claude 正在认证，请留意服务请求。' })); for (const tool of tools.slice(-4))
            rows.push(el('p', { class: 'ca-progress-row', text: `${tool.parentToolUseId ? '子 Agent · ' : ''}${tool.name} · 已运行 ${Math.floor(tool.elapsedSeconds)} 秒` })); for (const message of inputs.slice(-10)) {
            const row = el('div', { class: 'ca-queued-message' }, el('span', { text: message.prompt.slice(0, 140) || message.attachments.map(a => a.name).join('、') }), el('small', { text: inputLabels[message.status] }));
            if (message.status === 'queued') {
                const cancel = el('button', { type: 'button', text: '移出队列' });
                cancel.addEventListener('click', () => { cancel.disabled = true; void options.cancel(message.id).catch(() => { cancel.disabled = false; }); });
                row.append(cancel);
            }
            rows.push(row);
        } progress.replaceChildren(...rows); },
        dispose() { drafts.clear(); },
    };
}
