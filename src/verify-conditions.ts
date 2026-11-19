import type {Context, TGBotConfig} from './interfaces/config';
import {validateConfiguration} from './common/validate-configuration';
import {configurationIssue, environment, packageLabel} from './common/configuration';

/** Validate configuration before semantic-release starts publishing. */
export const verifyConditions = (settings: TGBotConfig, runtime: Context): void => {
    try {
        validateConfiguration(settings, runtime.env);
    } catch (error) {
        if (error instanceof Error && 'details' in error) runtime.logger.log(String(error.details));
        throw error;
    }
    const requirements = [
        {
            satisfied: Boolean(runtime.env[environment.token]?.trim()),
            code: 'ENOTELEGRAMTOKEN' as const,
            help: `Provide a BotFather token through ${environment.token} in the release environment.`,
        },
        {
            satisfied: packageLabel(settings, runtime.env) !== undefined,
            code: 'ENOPACKAGENAME' as const,
            help: `Set packageName in the plugin options, ${environment.label}, or npm_package_name.`,
        },
    ];
    const missing = requirements.find(requirement => !requirement.satisfied);
    if (missing) {
        runtime.logger.log(missing.help);
        throw configurationIssue(missing.code, missing.help);
    }
};
