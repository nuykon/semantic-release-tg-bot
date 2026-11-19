import type {Context, TGBotChatId} from '../interfaces/config';
import {environment} from './configuration';

export type NotificationFailureDetails = {
    recipient: TGBotChatId;
    stage: 'template' | 'split' | 'delivery';
    /** One-based part number, present only after splitting succeeds. */
    part?: number;
    totalParts?: number;
    /** Includes the initial delivery attempt. Zero for template/split failures. */
    attempts: number;
    telegramCode?: number;
    networkCode?: string;
    /** Zero-based index in notifications, supplied by the success/fail hook. */
    notificationIndex?: number;
};

/** Safe structured failure carried by AggregateError.errors in strict mode. */
export class TelegramNotificationError extends Error implements NotificationFailureDetails {
    readonly recipient: TGBotChatId;
    readonly stage: NotificationFailureDetails['stage'];
    readonly part?: number;
    readonly totalParts?: number;
    readonly attempts: number;
    readonly telegramCode?: number;
    readonly networkCode?: string;
    readonly notificationIndex?: number;
    readonly reason: string;
    constructor(reason: string, details: NotificationFailureDetails) {
        const position = details.part === undefined ? '' : `, part ${details.part}/${details.totalParts}`;
        super(`Telegram ${details.stage} failed for ${details.recipient}${position}, attempts ${details.attempts}: ${reason}`);
        this.name = 'TelegramNotificationError';
        this.reason = reason;
        this.recipient = details.recipient;
        this.stage = details.stage;
        this.part = details.part;
        this.totalParts = details.totalParts;
        this.attempts = details.attempts;
        this.telegramCode = details.telegramCode;
        this.networkCode = details.networkCode;
        this.notificationIndex = details.notificationIndex;
    }
}

const redact = (text: string, env: Context['env']): string => {
    const secrets = [env[environment.token], env[environment.proxy]];
    try {
        const proxy = new URL(env[environment.proxy] ?? '');
        secrets.push(proxy.password, decodeURIComponent(proxy.password));
    } catch { /* Invalid proxy URLs are handled by configuration verification. */ }
    for (const secret of secrets.filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[REDACTED]');
    }
    return text;
};

/** Do not retain the original cause/stack, which can contain token-bearing URLs or credentials. */
export const notificationError = (error: unknown, details: NotificationFailureDetails, env: Context['env']): TelegramNotificationError =>
    new TelegramNotificationError(redact(error instanceof TelegramNotificationError ? error.reason : error instanceof Error ? error.message : 'Notification failed.', env), {
        ...details,
        recipient: typeof details.recipient === 'string' ? redact(details.recipient, env) : details.recipient,
        networkCode: details.networkCode === undefined ? undefined : redact(details.networkCode, env),
    });
