import type {TGBotMessageFormat} from '../interfaces/config';

type Span = {open: string; close: string};
type Token = {text: string; open?: Span; close?: boolean};

/** Tokenize authored markup without cutting escapes, entities, tags or link targets. */
function* tokens(text: string, format: TGBotMessageFormat): Generator<Token> {
    const stack: Span[] = [];
    const graphemes = new Map(Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text), part => [part.index, part.segment]));
    const character = (index: number): string => graphemes.get(index) ?? String.fromCodePoint(text.codePointAt(index)!);
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
            } else token = {text: entity ?? character(i)};
        } else if (rest.startsWith('\\') && rest.length > 1) {
            token = {text: rest.slice(0, 1) + character(i + 1)};
        } else {
            const active = stack.at(-1);
            if (active && rest.startsWith(active.close)) {
                token = {text: active.close, close: true};
            } else if (active?.open.startsWith('`')) {
                token = {text: character(i)};
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
                token = marker ? {text: marker, open: {open: marker, close: marker}} : {text: character(i)};
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

type Unit = {text: string; visible: string; before: Span[]; after: Span[]};
const closeSpans = (spans: Span[]): string => spans.map(span => span.close).reverse().join('');

/** Conservatively bound serialized UTF-16 length (including markup) to 4096. */
export const splitMessage = (message: string, format: TGBotMessageFormat): string[] => {
    if (!message.trim()) return [];
    if (message.length <= 4096) return [message];
    const units: Unit[] = [];
    let spans: Span[] = [];
    let pending = '';
    let before: Span[] = [];
    for (const token of tokens(message, format)) {
        if (!pending) before = [...spans];
        pending += token.text;
        if (token.open) { spans.push(token.open); continue; }
        if (token.close) {
            spans.pop();
            // Attach closers to preceding text so a boundary cannot produce empty entities.
            const previous = units.at(-1);
            if (previous) {
                previous.text += pending;
                previous.after = [...spans];
                pending = '';
                continue;
            }
        }
        units.push({text: pending, visible: token.close ? '' : token.text, before, after: [...spans]});
        pending = '';
    }
    if (pending || spans.length) throw new Error('Unbalanced Telegram message formatting.');

    const parts: string[] = [];
    for (let start = 0; start < units.length;) {
        const opening = units[start].before.map(span => span.open).join('');
        let length = opening.length;
        let end = start;
        const boundaries: Partial<Record<'paragraph' | 'line' | 'word', number>> = {};
        for (; end < units.length; end++) {
            const unit = units[end];
            if (length + unit.text.length + closeSpans(unit.after).length > 4096) break;
            length += unit.text.length;
            // Prefer natural boundaries in the latter half of the available message.
            if (length >= 2048 && /\s$/u.test(unit.visible)) {
                boundaries.word = end + 1;
                if (unit.visible.includes('\n')) {
                    boundaries.line = end + 1;
                    if (units[end - 1]?.visible.endsWith('\n')) boundaries.paragraph = end + 1;
                }
            }
        }
        if (end === start) throw new Error('Telegram markup or a grapheme leaves no room for message text. Shorten link targets or nested markup.');
        if (end < units.length) end = boundaries.paragraph ?? boundaries.line ?? boundaries.word ?? end;
        const selected = units.slice(start, end);
        // Huge whitespace runs cannot form useful standalone Telegram messages.
        if (selected.some(unit => unit.visible.trim())) {
            parts.push(opening + selected.map(unit => unit.text).join('') + closeSpans(units[end - 1].after));
        }
        start = end;
    }
    return parts;
};
