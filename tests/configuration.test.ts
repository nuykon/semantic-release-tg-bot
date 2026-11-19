import {test} from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deepEqual, equal, match, throws, doesNotThrow} from 'node:assert/strict';
import type {Context, TGBotConfig} from '../index';
import {verifyConditions} from '../index';
import {packageLabel} from '../src/common/configuration';
import {composeNotification} from '../src/common/compose-notification';
import {renderMessage} from '../src/common/render-message';

const settings: TGBotConfig = {notifications: []};
const runtime = (env: Context['env']): Context => ({env, logger: {log: () => undefined}});

for (const [title, variables, code] of [
    ['absent credential', {}, 'ENOTELEGRAMTOKEN'],
    ['blank credential', {TELEGRAM_BOT_TOKEN: '  '}, 'ENOTELEGRAMTOKEN'],
    ['absent label', {TELEGRAM_BOT_TOKEN: 'credential'}, 'ENOPACKAGENAME'],
    ['blank label', {TELEGRAM_BOT_TOKEN: 'credential', SEMANTIC_RELEASE_PACKAGE: '\t'}, 'ENOPACKAGENAME'],
] as const) {
    test(`configuration diagnosis: ${title}`, () => {
        const messages: string[] = [];
        throws(() => verifyConditions(settings, {...runtime(variables), logger: {log: value => messages.push(value)}}),
            issue => issue instanceof Error && 'code' in issue && issue.code === code &&
                'semanticRelease' in issue && issue.semanticRelease === true &&
                'details' in issue && typeof issue.details === 'string' && issue.details.length > 0);
        equal(messages.length, 1);
    });
}

test('package label priority uses options, explicit environment, then package-manager environment', () => {
    const variables = {SEMANTIC_RELEASE_PACKAGE: 'env-label', npm_package_name: 'manifest-label'};
    equal(packageLabel({...settings, packageName: 'option-label'}, variables), 'option-label');
    equal(packageLabel(settings, variables), 'env-label');
    equal(packageLabel(settings, {...variables, SEMANTIC_RELEASE_PACKAGE: ''}), 'manifest-label');
    doesNotThrow(() => verifyConditions({...settings, packageName: 'option-label'}, runtime({TELEGRAM_BOT_TOKEN: 'credential'})));
});

test('a successful default notification carries the version and release notes', () => {
    const message = composeNotification('success', '@scope/clock', {nextRelease: {version: '4.8.2', notes: '## Improvements\nFaster startup'}});
    deepEqual(renderMessage(message!), {format: 'markdown', message: '*Release completed*\n\nPackage: @scope/clock\n\nVersion: 4\\.8\\.2\n\n*Improvements*\nFaster startup'});
    equal(composeNotification('success', 'clock', {}), undefined);
});

test('failure composition survives an early release failure and errors without a stack', () => {
    const issue = new Error('registry unavailable');
    issue.stack = undefined;
    const result = composeNotification('fail', undefined, {errors: [issue]});
    match(renderMessage(result!).message, /^\*Release failed\*\n\nPackage: unnamed package/);
    match(renderMessage(result!).message, /Error: registry unavailable$/);
    match(renderMessage(composeNotification('fail', 'clock', {})!).message, /Package: clock/);
});

const validEnv = {TELEGRAM_BOT_TOKEN: 'credential', npm_package_name: 'sample'};
for (const [label, options] of [
    ['root', null], ['array root', []], ['missing notifications', {}],
    ['recipient', {notifications: [null]}], ['empty destinations', {notifications: [{chatIds: []}]}],
    ['blank ID', {notifications: [{chatIds: ' '}]}], ['zero ID', {notifications: [{chatIds: 0}]}],
    ['fractional ID', {notifications: [{chatIds: 1.5}]}], ['unsafe ID', {notifications: [{chatIds: Number.MAX_SAFE_INTEGER + 1}]}],
    ['flag', {...settings, notifyOnSuccess: 'true'}], ['recipient flag', {notifications: [{chatIds: 1, notifyOnFail: 1}]}],
    ['branch', {notifications: [{chatIds: 1, branch: ''}]}], ['package', {...settings, packageName: 23}],
    ['format', {...settings, success: {message: 'x', format: 'text'}}],
    ['content', {...settings, fail: 'string'}], ['ambiguous content', {...settings, success: {message: 'x', path: 'x'}}],
    ['callback', {...settings, success: {message: Promise.resolve('x')}}],
    ['customData', {...settings, success: {message: 'x', customData: []}}],
    ['path', {...settings, fail: {path: 42}}], ['directory template', {...settings, fail: {path: '.'}}],
    ['missing file', {...settings, fail: {path: '/no-such-telegram-template/notice.html'}}],
] as const) {
    test(`verification rejects invalid ${label} options without echoing supplied data`, () => {
        throws(() => verifyConditions(options as unknown as TGBotConfig, runtime(validEnv)), error => {
            equal((error as {code: string}).code, 'ENOTELEGRAMCONFIG');
            okDetails(error);
            return true;
        });
    });
}
function okDetails(error: unknown): void {
    match(String((error as {details: string}).details), /expected|provide/);
    equal((error as {semanticRelease: boolean}).semanticRelease, true);
}

for (const proxy of ['socks5://relay:1080', 'not a url', '', 'http://user:%zz@relay', 'http://relay:0']) {
    test('verification rejects invalid proxy configuration without disclosing its value', () => {
        throws(() => verifyConditions(settings, runtime({...validEnv, TELEGRAM_BOT_PROXY: proxy})), error => {
            equal((error as {code: string}).code, 'ENOTELEGRAMCONFIG');
            match((error as {details: string}).details, /^TELEGRAM_BOT_PROXY:/);
            return true;
        });
    });
}

test('verification accepts destination types, callbacks and authenticated proxies without rendering or networking', () => {
    let called = false;
    doesNotThrow(() => verifyConditions({notifications: [{chatIds: [-123, 123, '@channel', 'DESTINATION']}],
        success: {message: () => {called = true; return '';}, format: 'html'},
    }, runtime({...validEnv, DESTINATION: '123', TELEGRAM_BOT_PROXY: 'https://user:s%3Aecret@relay:8443'})));
    equal(called, false);
    throws(() => verifyConditions({notifications: [{chatIds: 'DESTINATION'}]}, runtime({...validEnv, DESTINATION: ' '})), /ENOTELEGRAMCONFIG/);
});


test('verification accepts readable file templates and resolves paths from the working directory', t => {
    const directory = mkdtempSync(join(tmpdir(), 'tg-verify-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const path = join(directory, 'release.html');
    writeFileSync(path, '<b>${nextRelease.version}</b>');
    doesNotThrow(() => verifyConditions({...settings, success: {path}}, runtime(validEnv)));
    // Availability is rechecked, rather than cached between releases.
    rmSync(path);
    throws(() => verifyConditions({...settings, success: {path}}, runtime(validEnv)), /ENOTELEGRAMCONFIG/);
});

test('failOnError only accepts booleans and never suppresses verification failures', () => {
    for (const flag of [true, false]) {
        doesNotThrow(() => verifyConditions({...settings, failOnError: flag}, runtime(validEnv)));
    }
    // @ts-expect-error Exercise JSON/JavaScript input validation.
    throws(() => verifyConditions({...settings, failOnError: 'false'}, runtime(validEnv)), /ENOTELEGRAMCONFIG/);
    throws(() => verifyConditions({...settings, failOnError: false, notifications: [{chatIds: ''}]}, runtime(validEnv)), /ENOTELEGRAMCONFIG/);
    throws(() => verifyConditions({...settings, failOnError: false}, runtime({})), /ENOTELEGRAMTOKEN/);
});
