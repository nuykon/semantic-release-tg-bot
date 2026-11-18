import {test} from 'node:test';
import {equal, match, doesNotMatch, ok} from 'node:assert/strict';
import {successTemplate, failureTemplate} from '../examples/templates';
import example from '../examples/release.config';
import {renderMessage} from '../src/common/render-message';
import {splitMessage} from '../src/common/split-message';

test('ready-to-copy success template escapes data and keeps notes literal', () => {
    const notes = '<b>not markup</b> & ${version} {{ missing }} {% raw %}\n' + 'notes '.repeat(1500);
    const content = renderMessage(successTemplate, {
        packageName: '<package>', branch: {name: 'main&next'}, nextRelease: {version: '1.2.3', notes},
    });
    equal(content.format, 'html');
    match(content.message, /&lt;package&gt;/);
    match(content.message, /main&amp;next/);
    match(content.message, /&lt;b&gt;not markup&lt;\/b&gt; &amp; \$\{version\} {{ missing }} {% raw %}/);
    const parts = splitMessage(content.message, content.format);
    ok(parts.length > 1);
    equal(parts.join(''), content.message);
});

test('failure template handles early failures, multiple errors and HTML injection', () => {
    const content = renderMessage(failureTemplate, {packageName: 'sample', errors: [new Error('<failed>&'), new TypeError('${literal}')]});
    match(content.message, /&lt;failed&gt;&amp;/);
    match(content.message, /TypeError/);
    match(content.message, /\$\{literal\}/);
    doesNotMatch(content.message, /at TestContext/);
    match(renderMessage(failureTemplate).message, /No error details available/);
    doesNotMatch(renderMessage(successTemplate).message, /undefined/);
});

test('example release configuration explicitly enables failure delivery', () => {
    const plugin = example.plugins.at(-1);
    ok(Array.isArray(plugin));
    const config = plugin[1];
    ok(typeof config === 'object');
    equal(config.notifyOnFail, true);
    equal(config.success, successTemplate);
    equal(config.fail, failureTemplate);
});
