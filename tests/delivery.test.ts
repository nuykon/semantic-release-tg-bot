import {test} from 'node:test';
import {equal, deepEqual, ok, rejects, match} from 'node:assert/strict';
import {success, fail, type Context, type TGBotConfig} from '../index';
import {sendMessage} from '../src/common/send-message';
import {ProxyAgent} from '../src/common/proxy-agent';
import {captureTelegram, type Reply} from './support/telegram-double';

const runtime = (changes: Partial<Context> = {}): Context => ({
    logger: {log: () => undefined},
    env: {TELEGRAM_BOT_TOKEN: 'test-token-761', npm_package_name: 'observatory'},
    branch: {name: 'stable/4.x'},
    nextRelease: {version: '4.8.2', notes: '### Operations\n- Improved retry scheduling'},
    ...changes,
});

const settings: TGBotConfig = {notifications: [{chatIds: 456789}]};

test('one successful release delivers the default notification to a private user', async t => {
    const wire = captureTelegram(t);
    await success(settings, runtime());
    equal(wire.length, 1);
    equal(wire[0].payload.chat_id, 456789);
    match(wire[0].payload.text, /Release completed/);
    match(wire[0].payload.text, /observatory/);
    match(wire[0].payload.text, /4\\\.8\\\.2/);
});

test('recipient filtering combines native branch patterns, local opt-in and environment aliases', async t => {
    const wire = captureTelegram(t);
    const context = runtime();
    context.env.PERSON = '555001';
    await success({notifyOnSuccess: false, notifications: [
        {chatIds: 'disabled'},
        {chatIds: 'wrong-branch', notifyOnSuccess: true, branch: 'preview/**'},
        {chatIds: ['PERSON', -100456, '@releases'], notifyOnSuccess: true, branch: '{stable,maintenance}/*.x'},
    ]}, context);
    deepEqual(wire.map(entry => entry.payload.chat_id), ['555001', -100456, '@releases']);
});

test('recipient content wins over global content and preserves HTML mode', async t => {
    const wire = captureTelegram(t);
    await success({...settings, success: {message: 'global'}, notifications: [{
        chatIds: 77,
        success: {message: '<strong>${nextRelease.version}</strong>', format: 'html'},
    }]}, runtime());
    deepEqual(wire[0].payload, {chat_id: 77, text: '<strong>4.8.2</strong>', parse_mode: 'HTML'});
});

test('an explicitly supplied message does not require a prepared nextRelease', async t => {
    const wire = captureTelegram(t);
    await success({...settings, success: {message: 'Ready', format: 'html'}}, runtime({nextRelease: undefined}));
    equal(wire[0].payload.text, 'Ready');
});

test('early failures include the diagnosis only when failure notifications are enabled', async t => {
    const wire = captureTelegram(t);
    const context = runtime({nextRelease: undefined, errors: [new Error('artifact signing failed')]});
    await fail(settings, context);
    equal(wire.length, 0);
    await fail({...settings, notifyOnFail: true}, context);
    equal(wire.length, 1);
    match(wire[0].payload.text, /Release failed/);
    match(wire[0].payload.text, /artifact signing failed/);
});

test('empty templates and missing branch information never send a request', async t => {
    const wire = captureTelegram(t);
    await success({...settings, success: {message: ' \n '}}, runtime());
    await fail({...settings, notifyOnFail: true, fail: {message: ''}}, runtime());
    await success({notifications: [{chatIds: 99, branch: '**'}]}, runtime({branch: undefined}));
    equal(wire.length, 0);
});

test('the transport posts UTF-8 JSON and attaches a bounded request signal', async t => {
    const wire = captureTelegram(t);
    await sendMessage({message: 'Запуск 🚀', format: 'html'}, 'private-recipient', runtime());
    const {payload, options, bytes} = wire[0];
    equal(options.hostname, 'api.telegram.org');
    equal(options.method, 'POST');
    equal(options.path, '/bottest-token-761/sendMessage');
    equal((options.headers as Record<string, unknown>)['content-length'], bytes);
    ok(options.signal instanceof AbortSignal);
    deepEqual(payload, {chat_id: 'private-recipient', text: 'Запуск 🚀', parse_mode: 'HTML'});
});

test('proxy selection is explicit and the dedicated agent is released', async t => {
    const wire = captureTelegram(t);
    const context = runtime();
    context.env.TELEGRAM_BOT_PROXY = 'https://relay.invalid:8443';
    const dispose = t.mock.method(ProxyAgent.prototype, 'destroy', () => undefined);
    await sendMessage({message: 'proxy route', format: 'markdown'}, 12, context);
    const agent = wire[0].options.agent;
    ok(agent instanceof ProxyAgent);
    equal(agent.proxy.origin, 'https://relay.invalid:8443');
    equal(dispose.mock.callCount(), 1);
});

const rejectedResponses: ReadonlyArray<readonly [string, Reply, RegExp]> = [
    ['gateway markup', {raw: '<h1>temporarily unavailable</h1>'}, /Invalid Telegram API response/],
    ['JSON null', {raw: 'null'}, /Invalid Telegram API response/],
    ['HTTP error', {status: 503, value: {ok: false, description: 'try later'}}, /503.*try later/],
    ['API refusal', {status: 200, value: {ok: false, error_code: 403, description: 'bot blocked'}}, /403.*bot blocked/],
    ['missing confirmation', {status: 200, value: {}}, /Telegram API error/],
    ['oversized response', {raw: 'x'.repeat(1_048_577)}, /too large/],
    ['socket failure', {failure: Object.assign(new Error('test-token-761 must stay private'), {code: 'EPIPE'})}, /EPIPE/],
    ['deadline failure', {failure: Object.assign(new Error('timeout'), {code: 'ABORT_ERR'})}, /ABORT_ERR/],
];
for (const [label, reply, expected] of rejectedResponses) {
    test(`delivery rejects ${label}`, async t => {
        captureTelegram(t, reply);
        await rejects(sendMessage({message: 'status', format: 'markdown'}, 12, runtime()), expected);
    });
}

test('a token echoed by Telegram never escapes through the error message', async t => {
    captureTelegram(t, {status: 400, value: {ok: false, description: 'request test-token-761 refused'}});
    await rejects(sendMessage({message: 'status', format: 'html'}, 12, runtime()), issue =>
        issue instanceof Error && issue.message.includes('[REDACTED]') && !issue.message.includes('test-token-761'));
});

test('default notes and failures preserve template-like text without evaluating it', async t => {
    const wire = captureTelegram(t);
    const literal = '${version} {{ missing }} ${value ?? "fallback"} {% raw %}';
    await success(settings, runtime({nextRelease: {version: '1.0.0', notes: literal}}));
    await fail({...settings, notifyOnFail: true}, runtime({errors: [new Error(literal)]}));
    for (const exchange of wire) {
        match(exchange.payload.text, /version/);
        match(exchange.payload.text, /missing/);
        match(exchange.payload.text, /fallback/);
        match(exchange.payload.text, /raw/);
    }
    equal(wire.length, 2);
});

test('a custom template inserts release notes once without evaluating their contents', async t => {
    const wire = captureTelegram(t);
    const notes = '${value ?? "fallback"} {{ missing }} {% raw %}';
    await success({...settings, success: {message: '${nextRelease.notes}', format: 'html'}}, runtime({nextRelease: {version: '1', notes}}));
    equal(wire[0].payload.text, notes);
});

test('long notifications are sent in order and never exceed the conservative limit', async t => {
    const wire = captureTelegram(t);
    const text = '🚀'.repeat(6000);
    await sendMessage({message: text, format: 'html'}, 77, runtime());
    ok(wire.length > 1);
    equal(wire.map(entry => entry.payload.text).join(''), text);
    ok(wire.every(entry => entry.payload.text.length <= 4096 && entry.payload.chat_id === 77));
});

const limited = (retryAfter: unknown): Reply => ({status: 429, value: {
    ok: false, error_code: 429, description: 'Too Many Requests', parameters: {retry_after: retryAfter},
}});
const delivered: Reply = {status: 200, value: {ok: true}};

test('429 waits retry_after seconds and retries only the rejected part', async t => {
    const wire = captureTelegram(t, [delivered, limited(2), delivered, delivered]);
    t.mock.timers.enable({apis: ['setTimeout']});
    const pending = sendMessage({message: 'a'.repeat(9000), format: 'html'}, 77, runtime());
    // HTTP responses run on setImmediate; timers are advanced only after the rejection arrives.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    equal(wire.length, 2);
    t.mock.timers.tick(1999);
    await new Promise<void>(resolve => setImmediate(resolve));
    equal(wire.length, 2);
    t.mock.timers.tick(1);
    await pending;
    equal(wire.length, 4);
    equal(wire[1].payload.text, wire[2].payload.text);
    equal(wire[3].payload.text.length, 808);
});

test('persistent rate limiting stops after three retries', async t => {
    const wire = captureTelegram(t, limited(0));
    await rejects(sendMessage({message: 'text', format: 'html'}, 77, runtime()), /429/);
    equal(wire.length, 4);
});

for (const value of [-1, 0.5, '1', null, undefined, 61, Number.MAX_SAFE_INTEGER]) {
    test(`invalid or excessive retry_after ${String(value)} is not retried`, async t => {
        const wire = captureTelegram(t, limited(value));
        await rejects(sendMessage({message: 'text', format: 'html'}, 77, runtime()), /429/);
        equal(wire.length, 1);
    });
}

test('blocked recipients do not prevent other destinations or notification entries from receiving messages', async t => {
    const wire = captureTelegram(t, [
        {status: 403, value: {ok: false, description: 'bot blocked'}}, delivered, delivered,
    ]);
    await rejects(success({notifications: [{chatIds: [11, 22]}, {chatIds: 33}]}, runtime()), error => {
        ok(error instanceof AggregateError);
        equal(error.errors.length, 1);
        match(error.errors[0].message, /403.*bot blocked/);
        return true;
    });
    deepEqual(wire.map(entry => entry.payload.chat_id), [11, 22, 33]);
});

test('an ambiguous network failure is not retried and remaining parts for that destination are skipped', async t => {
    const wire = captureTelegram(t, [delivered, {failure: Object.assign(new Error('lost response'), {code: 'ECONNRESET'})}, delivered]);
    await rejects(success({success: {message: 'x'.repeat(9000), format: 'html'}, notifications: [{chatIds: [11, 22]}]}, runtime()), AggregateError);
    deepEqual(wire.map(entry => entry.payload.chat_id), [11, 11, 22, 22, 22]);
});

test('retry waiting has a total budget per part, not a fresh budget for each retry', async t => {
    const wire = captureTelegram(t, [limited(40), limited(21), delivered]);
    t.mock.timers.enable({apis: ['setTimeout']});
    const pending = rejects(sendMessage({message: 'text', format: 'html'}, 77, runtime()), /429/);
    await new Promise<void>(resolve => setImmediate(resolve));
    equal(wire.length, 1);
    t.mock.timers.tick(40_000);
    await pending;
    equal(wire.length, 2);
});

test('multiple delivery errors are collected with secrets redacted', async t => {
    const wire = captureTelegram(t, {status: 403, value: {ok: false, description: 'test-token-761 refused'}});
    await rejects(success({notifications: [{chatIds: [11, 22]}]}, runtime()), error => {
        ok(error instanceof AggregateError);
        equal(error.errors.length, 2);
        for (const failure of error.errors as Error[]) {
            ok(!failure.message.includes('test-token-761'));
            match(failure.message, /REDACTED/);
        }
        return true;
    });
    equal(wire.length, 2);
});
