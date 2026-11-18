import {test} from 'node:test';
import {deepEqual, equal, ok, throws} from 'node:assert/strict';
import {splitMessage} from '../src/common/split-message';

const bounded = (parts: string[]): void => {
    ok(parts.length > 1);
    for (const part of parts) {
        ok(part.length <= 4096);
        ok(!/[\uD800-\uDBFF]$/.test(part));
        ok(!/^[\uDC00-\uDFFF]/.test(part));
    }
};

test('the exact limit stays intact and long Unicode text is lossless', () => {
    deepEqual(splitMessage('', 'html'), []);
    const exact = 'a'.repeat(4096);
    deepEqual(splitMessage(exact, 'markdown'), [exact]);
    const text = 'a'.repeat(4095) + '🚀Привет'.repeat(2000);
    const parts = splitMessage(text, 'html');
    bounded(parts);
    equal(parts.join(''), text);
});

test('HTML parts reopen nested tags and never cut entities or quoted attributes', () => {
    const body = '🚀&amp;&#128640;'.repeat(1500);
    const opening = '<b><a href="https://example.org/?q=>">';
    const closing = '</a></b>';
    const parts = splitMessage(opening + body + closing, 'html');
    bounded(parts);
    for (const part of parts) {
        ok(part.startsWith(opening));
        ok(part.endsWith(closing));
        ok(!/&[^;]*$/.test(part.slice(opening.length, -closing.length)));
    }
    equal(parts.map(part => part.slice(opening.length, -closing.length)).join(''), body);
});

for (const [open, close, body] of [
    ['*_', '_*', 'release\\!🚀'.repeat(1500)],
    ['```ts\n', '```', 'const n = `literal`;\n'.replaceAll('`', '\\`').repeat(800)],
    ['`', '`', 'literal_[]*'.repeat(1500)],
    ['[', '](https://example.org/ref\\))', 'long label '.repeat(1500)],
    ['__||', '||__', 'spoiler '.repeat(1500)],
] as const) {
    test(`Markdown parts retain ${JSON.stringify(open)} formatting and all content`, () => {
        const parts = splitMessage(open + body + close, 'markdown');
        bounded(parts);
        for (const part of parts) {
            ok(part.startsWith(open));
            ok(part.endsWith(close));
            const content = part.slice(open.length, -close.length);
            ok(!/(?<!\\)(?:\\\\)*\\$/.test(content));
        }
        equal(parts.map(part => part.slice(open.length, -close.length)).join(''), body);
    });
}

test('oversized indivisible markup fails before producing a partial message', () => {
    throws(() => splitMessage('<a href="' + 'x'.repeat(4100) + '">text</a>', 'html'), /Shorten link targets/);
    throws(() => splitMessage('[text](https://example.org/' + 'x'.repeat(4100) + ')', 'markdown'), /Shorten link targets/);
});

for (const [opening, closing, format] of [
    ['`', '`', 'markdown'], ['*', '*', 'markdown'], ['<b>', '</b>', 'html'],
] as const) {
    test(`a boundary before ${opening} does not generate an empty formatting entity`, () => {
        const prefix = 'a'.repeat(4096 - opening.length - closing.length);
        const parts = splitMessage(prefix + opening + '🚀text' + closing, format);
        deepEqual(parts, [prefix, opening + '🚀text' + closing]);
    });
}

test('invalid long markup is rejected instead of silently repaired', () => {
    throws(() => splitMessage('<b>' + 'x'.repeat(5000), 'html'), /Unbalanced/);
    throws(() => splitMessage('<b>' + 'x'.repeat(5000) + '</i>', 'html'), /Unbalanced/);
    throws(() => splitMessage('*' + 'x'.repeat(5000), 'markdown'), /Unbalanced/);
});
