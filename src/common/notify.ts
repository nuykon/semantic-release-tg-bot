import {posix} from 'node:path';
import type {Context, TemplateContext, TGBotConfig, TGBotNotificationConfig} from '../interfaces/config';
import {packageLabel} from './configuration';
import {composeNotification, type ReleaseOutcome} from './compose-notification';
import {renderMessage} from './render-message';
import {sendMessage} from './send-message';
import {notificationError, TelegramNotificationError} from './notification-error';

const enabled = (outcome: ReleaseOutcome, recipient: TGBotNotificationConfig, settings: TGBotConfig): boolean => {
    const option = outcome === 'success' ? 'notifyOnSuccess' : 'notifyOnFail';
    return recipient[option] ?? settings[option] ?? (outcome === 'success');
};

export const notify = async (outcome: ReleaseOutcome, settings: TGBotConfig, runtime: Context): Promise<void> => {
    const values: TemplateContext = {
        packageName: packageLabel(settings, runtime.env),
        branch: runtime.branch,
        lastRelease: runtime.lastRelease,
        nextRelease: runtime.nextRelease,
        commits: runtime.commits,
        errors: runtime.errors,
    };
    const failures: TelegramNotificationError[] = [];
    const record = (failure: TelegramNotificationError): void => {
        failures.push(failure);
        runtime.logger.log(failure.message);
    };
    for (const [notificationIndex, recipient] of (settings.notifications ?? []).entries()) {
        if (!enabled(outcome, recipient, settings)) continue;
        if (recipient.branch && (!runtime.branch || !posix.matchesGlob(runtime.branch.name, recipient.branch))) continue;
        const source = recipient[outcome] ?? settings[outcome] ?? composeNotification(outcome, values.packageName, runtime);
        if (source === undefined) continue;
        const destinations = (Array.isArray(recipient.chatIds) ? recipient.chatIds : [recipient.chatIds])
            .map(destination => typeof destination === 'string' ? runtime.env[destination] || destination : destination);
        let content: ReturnType<typeof renderMessage>;
        try {
            content = renderMessage(source, values);
        } catch (error) {
            for (const address of destinations) record(notificationError(error, {recipient: address, stage: 'template', attempts: 0, notificationIndex}, runtime.env));
            continue;
        }
        if (content.message.length === 0) {
            runtime.logger.log(`Skipped an empty ${outcome} notification.`);
            continue;
        }
        for (const address of destinations) {
            try {
                await sendMessage(content, address, runtime);
            } catch (error) {
                record(notificationError(error, error instanceof TelegramNotificationError ? {...error, notificationIndex} : {recipient: address, stage: 'delivery', attempts: 0, notificationIndex}, runtime.env));
            }
        }
    }
    if (failures.length && settings.failOnError !== false) throw new AggregateError(failures, `Telegram delivery failed for ${failures.length} notification(s).`);
};
