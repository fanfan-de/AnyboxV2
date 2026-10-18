import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AttachmentData } from '../attachments.js';
import type { QueuedMessageView } from '../view.js';
import { claudeAgentError } from '../domain.js';
export function content(prompt: string, attachments: readonly AttachmentData[] = []): SDKUserMessage['message']['content'] {
    if (!attachments.length)
        return prompt;
    return [...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []), ...attachments.map(a => a.mime === 'text/plain' ? { type: 'text' as const, text: `附件：${a.name}\n${Buffer.from(a.data, 'base64').toString('utf8')}` } : a.mime === 'application/pdf' ? { type: 'document' as const, title: a.name, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: a.data } } : { type: 'image' as const, source: { type: 'base64' as const, media_type: a.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: a.data } })];
}
export function createInputQueue(initial: SDKUserMessage, changed: (view: QueuedMessageView) => void) {
    let ended = false, accepting = true, idle = false, ready = false, wake = () => { }, current: QueuedMessageView | undefined;
    const pending: {
        view: QueuedMessageView;
        attachments: readonly AttachmentData[];
    }[] = [];
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        yield initial;
        while (!ended) {
            await new Promise<void>(resolve => { wake = resolve; if (ready || ended)
                resolve(); });
            if (ended)
                break;
            ready = false;
            const next = pending.shift();
            if (!next)
                continue;
            current = { ...next.view, status: 'sent' };
            changed(current);
            yield { type: 'user', uuid: current.id as SDKUserMessage['uuid'], message: { role: 'user', content: content(current.prompt, next.attachments) }, parent_tool_use_id: null, origin: { kind: 'human' } };
        }
    })();
    return { prompt,
        enqueue(view: QueuedMessageView, attachments: readonly AttachmentData[]) { if (ended || !accepting)
            throw claudeAgentError('run-ended', 409); if (pending.length >= 20)
            throw claudeAgentError('input-limit', 409, '每次任务最多排队 20 条消息。'); pending.push({ view, attachments }); changed(view); if (idle) {
            idle = false;
            ready = true;
            wake();
        } },
        cancel(id: string) { const i = pending.findIndex(x => x.view.id === id); if (i < 0)
            return false; changed({ ...pending.splice(i, 1)[0]!.view, status: 'cancelled' }); return true; },
        get idle() { return idle && pending.length === 0; },
        result(holdOpen = false, failed = false) { idle = true; if (current) {
            changed({ ...current, status: failed ? 'failed' : 'completed' });
            current = undefined;
        } if (failed) {
            accepting = false;
            return true;
        } if (pending.length) {
            idle = false;
            ready = true;
            wake();
            return false;
        } if (holdOpen)
            return false; accepting = false; return true; },
        close() { if (ended)
            return; ended = true; for (const p of pending.splice(0))
            changed({ ...p.view, status: 'cancelled' }); if (current) {
            changed({ ...current, status: 'unknown' });
            current = undefined;
        } wake(); },
    };
}
