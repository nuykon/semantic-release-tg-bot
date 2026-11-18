import {successTemplate, failureTemplate} from './templates';
import type {TGBotConfig} from '../index';

const telegram: TGBotConfig = {
    notifications: [{chatIds: 'RELEASE_DESTINATION'}],
    notifyOnFail: true,
    success: successTemplate,
    fail: failureTemplate,
};

export default {
    branches: ['main'],
    plugins: [
        '@semantic-release/commit-analyzer',
        '@semantic-release/release-notes-generator',
        '@semantic-release/npm',
        '@semantic-release/github',
        ['@nuykon/semantic-release-tg-bot', telegram],
    ],
};
