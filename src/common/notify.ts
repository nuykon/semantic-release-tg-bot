import {posix} from 'node:path';
import type {Context, TemplateContext, TGBotConfig, TGBotNotificationConfig} from '../interfaces/config';
import {packageLabel} from './configuration';
import {composeNotification, type ReleaseOutcome} from './compose-notification';
import {renderMessage} from './render-message';
import {sendMessage} from './send-message';

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
    const failures: Error[] = [];
    for (const recipient of settings.notifications ?? []) {
        if (!enabled(outcome, recipient, settings)) continue;
        if (recipient.branch && (!runtime.branch || !posix.matchesGlob(runtime.branch.name, recipient.branch))) continue;
        const source = recipient[outcome] ?? settings[outcome] ?? composeNotification(outcome, values.packageName, runtime);
        if (source === undefined) continue;
        let content: ReturnType<typeof renderMessage>;
        try {
            content = renderMessage(source, values);
        } catch (error) {
            const failure = error instanceof Error ? error : new Error('Telegram template rendering failed.');
            failures.push(failure);
            runtime.logger.log(`Telegram template rendering failed: ${failure.message}`);
            continue;
        }
        if (content.message.length === 0) {
            runtime.logger.log(`Skipped an empty ${outcome} notification.`);
            continue;
        }
        const destinations = Array.isArray(recipient.chatIds) ? recipient.chatIds : [recipient.chatIds];
        for (const destination of destinations) {
            const address = typeof destination === 'string' ? runtime.env[destination] || destination : destination;
            try {
                await sendMessage(content, address, runtime);
            } catch (error) {
                const failure = error instanceof Error ? error : new Error('Telegram delivery failed.');
                failures.push(failure);
                runtime.logger.log(`Telegram delivery failed for ${address}: ${failure.message}`);
            }
        }
    }
    if (failures.length && settings.failOnError !== false) throw new AggregateError(failures, `Telegram delivery failed for ${failures.length} notification(s).`);
};
