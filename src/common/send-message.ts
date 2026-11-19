import type {Context, TGBotMessageFormat} from '../interfaces/config';
import * as https from 'node:https';
import * as proxyAgent from './proxy-agent';
import {environment} from './configuration';
import {setTimeout as delay} from 'node:timers/promises';
import {splitMessage} from './split-message';
import {notificationError} from './notification-error';

const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;
class TelegramApiError extends Error {
    constructor(message: string, readonly telegramCode?: number) { super(message); }
}
class RateLimitError extends TelegramApiError {
    constructor(message: string, readonly retryAfter: number) { super(message, 429); }
}
class NetworkError extends Error {
    constructor(readonly networkCode: string) { super(`Telegram request failed (${networkCode}).`); }
}
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const sendPart = async (message: {message: string; format: TGBotMessageFormat}, chatId: string | number, { logger, env }: Context): Promise<void> => {
    const token = env[environment.token];
    if (!token)
        throw new Error('Telegram delivery requires a bot token.');
    const proxy = env[environment.proxy];
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const agent = proxy ? new proxyAgent.ProxyAgent(proxy, signal) : undefined;
    const body = JSON.stringify({
        chat_id: chatId,
        text: message.message,
        parse_mode: message.format === 'html' ? 'HTML' : 'MarkdownV2',
    });
    logger.log(`Delivering a release notification to ${chatId}.`);
    try {
        await new Promise<void>((resolve, reject) => {
            const req = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${token}/sendMessage`,
                method: 'POST',
                agent,
                signal,
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
            }, (response) => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on('data', (chunk) => {
                    bytes += chunk.length;
                    if (bytes > MAX_RESPONSE_BYTES) {
                        response.destroy();
                        reject(new Error('Telegram API response is too large.'));
                    }
                    else
                        chunks.push(chunk);
                });
                response.on('error', () => reject(new Error('Unable to read Telegram API response.')));
                response.on('end', () => {
                    let result;
                    try {
                        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (!result || typeof result !== 'object')
                            throw new Error();
                    }
                    catch {
                        reject(new Error(`Invalid Telegram API response (HTTP ${response.statusCode}).`));
                        return;
                    }
                    if (response.statusCode !== 200 || result.ok !== true) {
                        // Do not propagate URLs, proxy credentials or the bot token from external errors.
                        const description = String(result.description ?? 'Request failed').split(token).join('[REDACTED]');
                        const message = `Telegram API error (${result.error_code ?? response.statusCode}): ${description}`;
                        const retryAfter = result.parameters?.retry_after;
                        const code = result.error_code ?? response.statusCode;
                        reject(code === 429 && Number.isSafeInteger(retryAfter) && retryAfter >= 0
                            ? new RateLimitError(message, retryAfter)
                            : new TelegramApiError(message, Number.isInteger(code) ? code : undefined));
                    }
                    else
                        resolve();
                });
            });
            req.on('error', (error) => {
                reject(new NetworkError((error as NodeJS.ErrnoException).code ?? 'NETWORK_ERROR'));
            });
            req.end(body);
        });
    }
    finally {
        agent?.destroy();
    }
};

const sendMessage = async (message: {message: string; format: TGBotMessageFormat}, chatId: string | number, runtime: Context): Promise<void> => {
    // Prepare all parts before any side effects; invalid oversized markup sends nothing.
    let parts: string[];
    try {
        parts = splitMessage(message.message, message.format);
    } catch (error) {
        throw notificationError(error, {recipient: chatId, stage: 'split', attempts: 0}, runtime.env);
    }
    for (const [index, part] of parts.entries()) {
        let waited = 0;
        for (let attempt = 0; ; attempt++) {
            try {
                await sendPart({...message, message: part}, chatId, runtime);
                break;
            } catch (error) {
                if (!(error instanceof RateLimitError) || attempt >= MAX_RETRIES || error.retryAfter * 1000 > MAX_RETRY_WAIT_MS - waited) {
                    throw notificationError(error, {
                        recipient: chatId, stage: 'delivery', part: index + 1, totalParts: parts.length, attempts: attempt + 1,
                        telegramCode: error instanceof TelegramApiError ? error.telegramCode : undefined,
                        networkCode: error instanceof NetworkError ? error.networkCode : undefined,
                    }, runtime.env);
                }
                const milliseconds = error.retryAfter * 1000;
                waited += milliseconds;
                runtime.logger.log(`Telegram rate limit: retrying in ${error.retryAfter}s (${attempt + 1}/${MAX_RETRIES}).`);
                await delay(milliseconds);
            }
        }
    }
};

export {sendMessage};
