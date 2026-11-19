import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Context} from '../interfaces/config';
import {configurationIssue, environment} from './configuration';

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(path: string, requirement: string): never {
    throw configurationIssue('ENOTELEGRAMCONFIG', `${path}: ${requirement}`);
}
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const chatId = (value: unknown, path: string, env: Context['env']): void => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) return;
    if (nonblank(value)) {
        if (Object.hasOwn(env, value) && !nonblank(env[value])) invalid(path, 'the destination environment variable must be nonblank.');
        return;
    }
    invalid(path, 'expected a nonblank string or a nonzero safe integer.');
};
const content = (value: unknown, path: string): void => {
    if (!object(value)) invalid(path, 'expected a message or file-template object.');
    const hasMessage = Object.hasOwn(value, 'message');
    const hasPath = Object.hasOwn(value, 'path');
    if (hasMessage === hasPath) invalid(path, 'provide exactly one of message or path.');
    if (value.customData !== undefined && !object(value.customData)) invalid(`${path}.customData`, 'expected an object.');
    if (hasMessage) {
        if (typeof value.message !== 'string' && typeof value.message !== 'function') invalid(`${path}.message`, 'expected a string or synchronous function.');
        if (value.format !== undefined && value.format !== 'html' && value.format !== 'markdown') invalid(`${path}.format`, 'expected html or markdown.');
    } else {
        if (!nonblank(value.path)) invalid(`${path}.path`, 'expected a nonblank file path.');
        if (value.format !== undefined) invalid(`${path}.format`, 'file format is selected by its extension.');
        try {
            const filename = resolve(value.path);
            if (!statSync(filename).isFile()) throw new Error();
            readFileSync(filename, 'utf8');
        } catch { invalid(`${path}.path`, 'expected a readable regular file relative to the working directory.'); }
    }
};
const notification = (value: Record<string, unknown>, path: string): void => {
    for (const flag of ['notifyOnSuccess', 'notifyOnFail']) {
        if (value[flag] !== undefined && typeof value[flag] !== 'boolean') invalid(`${path}.${flag}`, 'expected a boolean.');
    }
    for (const outcome of ['success', 'fail']) {
        if (value[outcome] !== undefined) content(value[outcome], `${path}.${outcome}`);
    }
};

/** Checks configuration without executing user callbacks or making network requests. */
export const validateConfiguration = (settings: unknown, env: Context['env']): void => {
    if (!object(settings)) invalid('options', 'expected an object.');
    if (!Array.isArray(settings.notifications)) invalid('notifications', 'expected an array (an empty array disables delivery).');
    if (settings.packageName !== undefined && !nonblank(settings.packageName)) invalid('packageName', 'expected a nonblank string.');
    notification(settings, 'options');
    for (const [index, recipient] of settings.notifications.entries()) {
        const path = `notifications[${index}]`;
        if (!object(recipient)) invalid(path, 'expected an object.');
        notification(recipient, path);
        if (recipient.branch !== undefined && !nonblank(recipient.branch)) invalid(`${path}.branch`, 'expected a nonblank glob string.');
        const destinations = Array.isArray(recipient.chatIds) ? recipient.chatIds : [recipient.chatIds];
        if (!destinations.length) invalid(`${path}.chatIds`, 'expected at least one destination.');
        destinations.forEach((destination, index) => chatId(destination, `${path}.chatIds[${index}]`, env));
    }
    const proxy = env[environment.proxy];
    if (proxy !== undefined) {
        try {
            const url = new URL(proxy);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || (url.port && Number(url.port) === 0)) throw new Error();
            decodeURIComponent(url.username);
            decodeURIComponent(url.password);
        } catch { invalid(environment.proxy, 'expected a valid HTTP or HTTPS proxy URL with valid percent-encoded credentials.'); }
    }
};
