import type {TemplateContext} from '../interfaces/config';

type Part = {text: string} | {path: string[]};

/** Shared grammar for verification and interpolation; never evaluates application data. */
const parse = (source: string): Part[] => {
    const parts: Part[] = [];
    const opening = /\$\{|{{|{%|{#|<%/g;
    let cursor = 0;
    for (let match = opening.exec(source); match; match = opening.exec(source)) {
        const offset = match.index;
        parts.push({text: source.slice(cursor, offset)});
        const marker = match[0];
        if (marker !== '${' && marker !== '{{') {
            throw new SyntaxError(`Template control tags are unsupported at offset ${offset}. Use a message function.`);
        }
        const end = source.indexOf(marker === '${' ? '}' : '}}', offset + 2);
        if (end === -1) throw new SyntaxError(`Unclosed template placeholder at offset ${offset}.`);
        const expression = source.slice(offset + 2, end).trim();
        if (!/^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/.test(expression)) {
            throw new SyntaxError(`Unsupported template expression at offset ${offset}. Use dotted paths or a message function.`);
        }
        const path = expression.split('.');
        if (path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) {
            throw new SyntaxError(`Unsafe template path at offset ${offset}.`);
        }
        parts.push({path});
        cursor = end + (marker === '${' ? 1 : 2);
        opening.lastIndex = cursor;
    }
    parts.push({text: source.slice(cursor)});
    return parts;
};

export const validateTemplate = (source: string): void => { parse(source); };

export const interpolate = (source: string, context: TemplateContext): string => parse(source).map(part => {
    if ('text' in part) return part.text;
    let value: unknown = context;
    for (const key of part.path) {
        if (value == null || !Object.hasOwn(Object(value), key)) return '';
        value = (value as Record<string, unknown>)[key];
    }
    return value == null ? '' : String(value);
}).join('');
