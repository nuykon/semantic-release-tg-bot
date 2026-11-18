// When copying this file into a consuming project, import from '@nuykon/semantic-release-tg-bot'.
import type {TGBotMessage} from '../index';

const html = (value: string): string => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

/** Release notes stay readable as literal text, including Markdown and template expressions. */
export const successTemplate: TGBotMessage = {
    format: 'html',
    message: ({packageName, nextRelease, branch}) => [
        '<b>✅ Release published</b>',
        `<b>Package:</b> ${html(packageName ?? 'unknown')}`,
        `<b>Version:</b> <code>${html(nextRelease?.version ?? 'unknown')}</code>`,
        ...(branch ? [`<b>Branch:</b> ${html(branch.name)}`] : []),
        ...(nextRelease?.notes?.trim() ? [`<b>Release notes</b>\n${html(nextRelease.notes)}`] : []),
    ].join('\n\n'),
};

/** Works when semantic-release fails before preparing nextRelease. Stacks are intentionally omitted. */
export const failureTemplate: TGBotMessage = {
    format: 'html',
    message: ({packageName, branch, errors}) => [
        '<b>❌ Release failed</b>',
        `<b>Package:</b> ${html(packageName ?? 'unknown')}`,
        ...(branch ? [`<b>Branch:</b> ${html(branch.name)}`] : []),
        ...(errors?.length ? errors.map(error => `<b>${html(error.name)}:</b> ${html(error.message)}`) : ['No error details available.']),
    ].join('\n\n'),
};
