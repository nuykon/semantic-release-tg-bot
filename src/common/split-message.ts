import type {TGBotMessageFormat} from '../interfaces/config';

type Span = {open: string; close: string};
type Token = {text: string; open?: Span; close?: boolean};

/** Tokenize authored markup without cutting escapes, entities, tags or link targets. */
function* tokens(text: string, format: TGBotMessageFormat): Generator<Token> {
    const stack: Span[] = [];
    for (let i = 0; i < text.length;) {
        const rest = text.slice(i);
        let token: Token;
        if (format === 'html') {
            const tag = /^<\/?[a-z](?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(rest)?.[0];
            const entity = /^&(?:#\d+|#x[\da-f]+|[a-z]+);/i.exec(rest)?.[0];
            if (tag) {
                const closing = tag.startsWith('</');
                const name = /^<\/?([a-z][\w-]*)/i.exec(tag)![1];
                token = closing ? {text: tag, close: true} : {text: tag, open: {open: tag, close: `</${name}>`}};
            } else token = {text: entity ?? String.fromCodePoint(text.codePointAt(i)!)};
        } else if (rest.startsWith('\\') && rest.length > 1) {
            token = {text: rest.slice(0, 1) + String.fromCodePoint(rest.codePointAt(1)!)};
        } else {
            const active = stack.at(-1);
            if (active && rest.startsWith(active.close)) {
                token = {text: active.close, close: true};
            } else if (active?.open.startsWith('`')) {
                token = {text: String.fromCodePoint(text.codePointAt(i)!)};
            } else if (rest.startsWith('```')) {
                const fence = /^```[^\n]*\n/.exec(rest)?.[0] ?? '```';
                token = {text: fence, open: {open: fence, close: '```'}};
            } else if (rest[0] === '`') {
                token = {text: '`', open: {open: '`', close: '`'}};
            } else if (rest[0] === '[' || rest.startsWith('![')) {
                const opening = rest.startsWith('![') ? '![' : '[';
                const ending = /\]\((?:\\.|[^)\\])*\)/.exec(rest);
                token = ending ? {text: opening, open: {open: opening, close: ending[0]}} : {text: opening};
            } else {
                const marker = /^(?:__|\|\||[*_~])/.exec(rest)?.[0];
                token = marker ? {text: marker, open: {open: marker, close: marker}} : {text: String.fromCodePoint(text.codePointAt(i)!)};
            }
        }
        if (format === 'html' && token.close && stack.at(-1)?.close.toLowerCase() !== token.text.toLowerCase()) {
            throw new Error('Unbalanced Telegram HTML tags.');
        }
        if (token.close) stack.pop();
        if (token.open) stack.push(token.open);
        i += token.text.length;
        yield token;
    }
}

/** Conservatively bound serialized UTF-16 length (including markup) to 4096. */
export const splitMessage = (message: string, format: TGBotMessageFormat): string[] => {
    if (!message) return [];
    if (message.length <= 4096) return [message];
    const parts: string[] = [];
    let spans: Span[] = [];
    let current = '';
    let hasContent = false;
    const closing = (items: Span[]): string => items.map(span => span.close).reverse().join('');
    let pending: Token[] = [];
    for (const token of tokens(message, format)) {
        pending.push(token);
        // Keep opening markup with its first text token, so boundaries cannot create empty entities.
        if (token.open) continue;
        const next = [...spans];
        for (const item of pending) {
            if (item.close) next.pop();
            if (item.open) next.push(item.open);
        }
        const text = pending.map(item => item.text).join('');
        pending = [];
        if (current.length + text.length + closing(next).length > 4096) {
            if (!hasContent) throw new Error('Telegram markup leaves no room for message text. Shorten link targets or nested markup.');
            parts.push(current + closing(spans));
            current = spans.map(span => span.open).join('');
            hasContent = false;
        }
        if (current.length + text.length + closing(next).length > 4096) {
            throw new Error('Telegram markup leaves no room for message text. Shorten link targets or nested markup.');
        }
        current += text;
        if (!token.open && !token.close) hasContent = true;
        spans = next;
    }
    if (pending.length || spans.length) throw new Error('Unbalanced Telegram message formatting.');
    if (hasContent) parts.push(current);
    return parts;
};
