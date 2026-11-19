import {test} from 'node:test';
import {doesNotThrow, equal, match, ok, throws} from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyConditions, type TGBotConfig} from '../index';
import {renderMessage} from '../src/common/render-message';

const context = {env: {TELEGRAM_BOT_TOKEN: 'test-credential', npm_package_name: 'sample'}, logger: {log: (_text: string) => undefined}};
const invalid = [
    '${value ?? "sensitive_literal"}', '${value.toUpperCase()}', '{{ value | safe }}',
    '{% if value %}x{% endif %}', '{# comment #}', '<% process.exit() %>',
    '${}', '{{ }}', '${value', '{{ value }', '${outer${inner}}', '{{ outer {{ inner }} }}',
    '${missing.constructor}', '{{ absent.__proto__.key }}', '${absent.prototype.key}',
] as const;

for (const [index, source] of invalid.entries()) {
    test(`verification and rendering reject invalid syntax case ${index + 1} in strings and files`, t => {
        const directory = mkdtempSync(join(tmpdir(), 'tg-syntax-'));
        t.after(() => rmSync(directory, {recursive: true, force: true}));
        for (const extension of ['html', 'md']) {
            const path = join(directory, `template.${extension}`);
            writeFileSync(path, source);
            for (const [content, suffix] of [[{message: source}, 'message'], [{path}, 'path']] as const) {
                for (const outcome of ['success', 'fail'] as const) {
                    for (const local of [false, true]) {
                        const options: TGBotConfig = local
                            ? {notifications: [{chatIds: 123, [outcome]: content}]}
                            : {notifications: [], [outcome]: content};
                        const expected = `${local ? 'notifications[0]' : 'options'}.${outcome}.${suffix}:`;
                        const logs: string[] = [];
                        throws(() => verifyConditions(options, {...context, logger: {log: text => logs.push(text)}}), error => {
                            ok(error instanceof Error && 'code' in error && 'details' in error);
                            equal(error.code, 'ENOTELEGRAMCONFIG');
                            ok(String(error.details).startsWith(expected));
                            match(String(error.details), /offset 0/);
                            ok(!`${error.message} ${error.details} ${error.stack}`.includes(source));
                            ok(!String(error.details).includes('sensitive_literal'));
                            return true;
                        });
                        ok(logs.every(log => !log.includes(source) && !log.includes('sensitive_literal')));
                    }
                }
                throws(() => renderMessage(content), SyntaxError);
            }
        }
    });
}

test('valid placeholders, missing future values, arrays and ordinary braces pass verification without evaluating data', t => {
    const directory = mkdtempSync(join(tmpdir(), 'tg-syntax-valid-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const source = 'Release ${nextRelease.version}: {{ commits.0.message }} / {{ missing }} / ${custom.value} / ${$name} / {literal} / {"nested":{}}';
    let accessed = false;
    const customData = Object.defineProperty({}, 'custom', {enumerable: true, get() {accessed = true; throw new Error('must not read data');}});
    for (const extension of ['html', 'md']) {
        const path = join(directory, `valid.${extension}`);
        writeFileSync(path, source);
        doesNotThrow(() => verifyConditions({notifications: [{chatIds: 123, fail: {path}}], success: {message: source, customData}}, context));
    }
    equal(accessed, false);
    equal(renderMessage({message: '${nextRelease.version} / {{ commits.0.message }} / ${missing}', format: 'html'}, {
        nextRelease: {version: '2.0.0'}, commits: [{message: 'fix: ready'}],
    }).message, '2.0.0 / fix: ready /');
});

test('disabled templates and failOnError false still fail syntax verification', () => {
    throws(() => verifyConditions({failOnError: false, notifyOnSuccess: false, notifications: [{chatIds: 123, fail: {message: '${bad('}}]}, context), /ENOTELEGRAMCONFIG/);
});

test('callbacks are never invoked during verification and their output remains literal', () => {
    let calls = 0;
    const source = '${value ?? "fallback"} {{}} {% raw %}';
    const content = {format: 'html' as const, message: () => {calls++; return source;}};
    doesNotThrow(() => verifyConditions({notifications: [{chatIds: 123}], success: content, fail: content}, context));
    equal(calls, 0);
    equal(renderMessage(content).message, source);
    equal(renderMessage({format: 'html', message: '${notes}', customData: {notes: source}}).message, source);
});

test('file syntax is rechecked after verification if the file changes before delivery', t => {
    const directory = mkdtempSync(join(tmpdir(), 'tg-syntax-change-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const path = join(directory, 'notice.html');
    writeFileSync(path, '${nextRelease.version}');
    const options = {notifications: [], success: {path}};
    doesNotThrow(() => verifyConditions(options, context));
    writeFileSync(path, '${broken');
    throws(() => renderMessage({path}), SyntaxError);
    throws(() => verifyConditions(options, context), /ENOTELEGRAMCONFIG/);
});
