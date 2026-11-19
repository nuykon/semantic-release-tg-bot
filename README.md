# @nuykon/semantic-release-tg-bot

Telegram notifications for semantic-release, implemented in TypeScript with Node.js built-ins. The published CommonJS package includes declarations and has no runtime dependencies.

## Getting started

Requirements: Node.js 22.20+ and an existing semantic-release project.

```sh
pnpm add -D @nuykon/semantic-release-tg-bot
```

Add a notification destination alongside your other release plugins:

```ts
// release.config.ts
export default {
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@nuykon/semantic-release-tg-bot', {
      notifications: [{chatIds: 'RELEASE_DESTINATION'}],
    }],
  ],
};
```

Provide `TELEGRAM_BOT_TOKEN` and, for this example, `RELEASE_DESTINATION` through your CI environment. Recipients may also be literal numeric IDs, numeric strings, or channel usernames. An array sends the notification to each destination in order.

For a personal notification, use the user's numeric private-chat ID. That user must first start a conversation with your bot. A personal `@username` cannot replace the ID. Telegram describes these restrictions in its [bot guide](https://core.telegram.org/bots#how-are-bots-different-from-users) and [sendMessage reference](https://core.telegram.org/bots/api#sendmessage).

## Proxy configuration

Set **`TELEGRAM_BOT_PROXY`** to route Telegram requests through an HTTP or HTTPS CONNECT proxy:

```sh
export TELEGRAM_BOT_PROXY='http://relay.example:3128'
# Alternatively:
export TELEGRAM_BOT_PROXY='https://relay.example:8443'
# Credentials may be included; encode reserved URL characters:
export TELEGRAM_BOT_PROXY='http://operator:s%3Aecret@relay.example:3128'
```

Put authenticated URLs in CI secrets. With the variable absent, requests go directly to Telegram. This setting is read from the release context's `env`; the plugin has no separate proxy field and does not select a proxy from `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY`.

TLS certificate validation stays enabled for both connections. SOCKS is outside the supported transport set. Each HTTP attempt has a 30-second deadline, including tunnel negotiation, and a 1 MiB response limit. Delivery and retry behavior is described below.

## Notification rules

The root options are `notifications`, optional `packageName`, `success`, `fail`, `notifyOnSuccess` and `notifyOnFail`.

Every entry in `notifications` contains `chatIds` and may override either message or either notification flag. It may also specify `branch`, matched with Node.js `path.posix.matchesGlob`. For example, `stable/*.x` accepts `stable/4.x`; `stable/**` also accepts deeper paths. Brace patterns such as `{main,beta}` and extglobs such as `@(main|beta)` are supported by the Node.js matcher.

Success is enabled unless overridden; failure is disabled unless enabled. A recipient's explicit flag overrides the root flag. A branch-filtered entry is skipped when semantic-release has no branch information.

The package label comes from the first nonblank value among `packageName`, `SEMANTIC_RELEASE_PACKAGE` and `npm_package_name`. Verification requires that label and a nonblank bot token. Before publication, `verifyConditions` also checks the options/recipient structure, nonempty destination lists, nonblank string IDs or nonzero safe integer IDs, boolean flags, branch strings, content objects/formats, proxy URL (including credential encoding), and readable regular template files. An empty `notifications` array is allowed and disables delivery. Environment aliases must resolve to nonblank values when present. File paths resolve from the working directory; file contents are read to verify availability, but callbacks are never executed and templates are not rendered during verification. Invalid options report `ENOTELEGRAMCONFIG` with the option path in `details`, without including supplied values or proxy credentials. Verification errors expose `code`, `details` and `semanticRelease: true` for the release tool.

The default success text contains a completion heading, package label, version and optional release notes. The default failure text contains a failure heading, package label and available error descriptions/stacks. Failure messages work even before a next release exists. Empty rendered messages are skipped. Generated default content is never treated as a template: literal `${...}`, `{{...}}` and control-tag examples inside release notes or error messages are preserved.

### Long messages and delivery errors

Messages are split automatically and sent sequentially to each destination. Each part is limited conservatively to **4096 UTF-16 code units including markup**, so a formatted message may split before reaching Telegram's visible-text limit. Visible Unicode graphemes (including combining accents and emoji sequences), MarkdownV2 escapes, HTML entities/tags and link targets stay intact. Splitting prefers paragraph, line and word boundaries in the latter half of each part. Whitespace-only fragments are omitted; whitespace inside other parts is preserved. Active HTML tags and MarkdownV2 emphasis, spoilers, links and code spans/fences are closed and reopened across parts. Splitting does not validate or repair malformed authored markup; use the documented Markdown subset or valid Telegram HTML. Exceptionally large link targets or nested markup that leave no room for text cause an error before any part is sent to that destination.

Only an explicit Telegram rate-limit error (`429`) with a nonnegative integer `parameters.retry_after` is retried. The plugin waits that many seconds and retries the rejected part, with **up to three retries and at most 60 seconds of total retry waiting per part**. A delay exceeding the remaining budget is rejected without waiting. Already delivered parts are not repeated.

Other API errors, invalid responses, timeouts and network failures are not retried: an ambiguous response can mean Telegram already accepted the message. If a part fails, remaining parts for that destination are skipped. Delivery continues to the other destinations and notification entries. A template read, interpolation or callback error skips only that notification entry; subsequent entries are still processed. Each template is rendered once per entry, rather than once per destination. After attempting them all, the hook throws an `AggregateError` containing the delivery errors; semantic-release therefore still sees the failure. Retrying the entire hook manually can repeat earlier successful deliveries.

These limits follow the [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage) and [ResponseParameters](https://core.telegram.org/bots/api#responseparameters) contracts.

## Custom content

An inline content object uses `message`, optional `format` and optional `customData`:

```ts
{
  message: '<b>{{ packageName }}</b>: ${nextRelease.version}',
  format: 'html',
  customData: {team: 'operations'},
}
```

The default format is `markdown`. Placeholders accept dotted property paths, including numeric array segments. Both `${value}` and `{{ value }}` forms are available. Missing/null values produce empty text; substituted values are not evaluated a second time. Prototype-related paths and expression/control-tag syntax are rejected. No JavaScript is evaluated by the placeholder renderer.

The supplied context includes `packageName`, `branch`, `lastRelease`, `nextRelease`, `commits` and `errors`. `customData` overrides matching context entries. HTML values are inserted literally: escape untrusted data when creating HTML notifications.

Use a synchronous callback when you need calculations or iteration:

```ts
import type {TemplateContext} from '@nuykon/semantic-release-tg-bot';

const content = {
  format: 'html' as const,
  message: ({nextRelease}: TemplateContext): string =>
    `<code>${nextRelease?.version ?? 'unavailable'}</code>`,
};
```

Callbacks must return a string. Their result is not interpolated again. Template configuration and callbacks are trusted application code.

A file content object uses `path` plus optional `customData`. Files resolve from the release process's working directory. A `.html` suffix selects HTML, case-insensitively; other suffixes select MarkdownV2. File content receives placeholder substitution and trimming, then is sent as authored Telegram syntax. It does not go through the Markdown converter.

### Template examples

There are three ways to supply custom content. Only configured string/file templates interpret placeholders. Callback results and values inserted into a template are never interpolated again.

**1. A short inline message.** Set both messages at the root, and enable failure notifications explicitly:

```ts
// Options for ['@nuykon/semantic-release-tg-bot', options]
const options = {
  notifications: [{chatIds: 'RELEASE_DESTINATION'}],
  notifyOnFail: true,
  success: {
    message: '✅ ${packageName} ${nextRelease.version}\nBranch: {{ branch.name }}',
  },
  fail: {
    message: '❌ ${packageName}: {{ errors.0.message }}',
  },
};
```

Inline Markdown messages go through the Markdown converter, which escapes literal punctuation. If a value is missing, its placeholder becomes empty. Failure notifications can run before `nextRelease` exists, so avoid relying on its version in a failure template. A recipient can override either message by placing its own `success` or `fail` object next to `chatIds`.

**2. Ready-made TypeScript callbacks for full success/failure messages.** The maintained examples are in [`examples/templates.ts`](https://github.com/nuykon/semantic-release-tg-bot/blob/main/examples/templates.ts), with a complete [`examples/release.config.ts`](https://github.com/nuykon/semantic-release-tg-bot/blob/main/examples/release.config.ts). To use them in your project, create `telegram-templates.ts`:

```ts
import type {TGBotMessage} from '@nuykon/semantic-release-tg-bot';

const html = (text: string): string => text
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export const successTemplate: TGBotMessage = {
  format: 'html',
  message: ({packageName, nextRelease, branch}) => [
    '<b>✅ Release published</b>',
    `<b>Package:</b> ${html(packageName ?? 'unknown')}`,
    `<b>Version:</b> <code>${html(nextRelease?.version ?? 'unknown')}</code>`,
    ...(branch ? [`<b>Branch:</b> ${html(branch.name)}`] : []),
    ...(nextRelease?.notes?.trim()
      ? [`<b>Release notes</b>\n${html(nextRelease.notes)}`] : []),
  ].join('\n\n'),
};

export const failureTemplate: TGBotMessage = {
  format: 'html',
  message: ({packageName, branch, errors}) => [
    '<b>❌ Release failed</b>',
    `<b>Package:</b> ${html(packageName ?? 'unknown')}`,
    ...(branch ? [`<b>Branch:</b> ${html(branch.name)}`] : []),
    ...(errors?.length
      ? errors.map(error => `<b>${html(error.name)}:</b> ${html(error.message)}`)
      : ['No error details available.']),
  ].join('\n\n'),
};
```

Then connect them in `release.config.ts`, after your other release plugins:

```ts
import {successTemplate, failureTemplate} from './telegram-templates';

export default {
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/npm',
    '@semantic-release/github',
    ['@nuykon/semantic-release-tg-bot', {
      notifications: [{chatIds: 'RELEASE_DESTINATION'}],
      notifyOnFail: true,
      success: successTemplate,
      fail: failureTemplate,
    }],
  ],
};
```

The callbacks escape dynamic HTML values. Release notes are intentionally displayed as literal text in this HTML example, including any Markdown and `${...}` examples they contain. Long results are split automatically. The failure callback supports multiple errors and omits stack traces to keep the message short; it also works without a prepared release or branch.

**3. Files for short, authored Telegram HTML/MarkdownV2.** For example, create `templates/release.html`:

```html
<b>Release ready</b>
<code>{{ nextRelease.version }}</code>
```

And `templates/failure.md` (this is already Telegram MarkdownV2, including the escaped dot):

```text
*Release failed*\.
Check the CI job logs\.
```

Select the files using these options:

```ts
{
  notifications: [{chatIds: 'RELEASE_DESTINATION'}],
  notifyOnFail: true,
  success: {path: './templates/release.html'},
  fail: {path: './templates/failure.md'},
}
```

Paths resolve from the release process's working directory. String/file templates insert values literally without escaping for the selected format. Use the callback approach above when release notes, names or errors can contain special characters. Advanced expressions such as `${nextRelease.version ?? "unknown"}` and loops are unsupported in string/file templates; write them in a TypeScript callback instead.

### Markdown scope

The inline converter handles ATX headings, simple unordered lists, emphasis, strikeout, inline code, fenced code and inline links using HTTP(S), `tg` or `mailto`. Literal Telegram MarkdownV2 punctuation is escaped. `<small>` wrappers commonly found in release notes are discarded.

It is a focused release-note formatter, not a CommonMark/GFM implementation. Unsupported tables, reference links, images, quotations and complex nesting may appear as literal text or simplified formatting. Choose authored HTML or MarkdownV2 file templates when exact output is required.

## Working on the project

All maintained code, tests and helper scripts use TypeScript. JSON/YAML files are configuration data. Use the pnpm version pinned in `packageManager`:

```sh
corepack enable
corepack prepare pnpm@11.0.7 --activate
pnpm install --frozen-lockfile
pnpm run lint
pnpm test
pnpm pack --dry-run
```

The production build writes JavaScript/declarations to `lib`. Tests compile into `.test-build` and run with `node:test`. Neither test output nor development dependencies belong in the published package. `pnpm pack` runs the build through `prepack`.

Test suites use generated temporary template files, an HTTP boundary double, and local TLS/CONNECT servers. They do not contact Telegram. The localhost certificate/private key under `tests/fixtures` is a public testing identity.

## GitHub Actions

[CI runs](https://github.com/nuykon/semantic-release-tg-bot/actions/workflows/ci.yml) start on pushes, pull requests and manual requests. No secrets are required for verification. Each run checks Node.js **22.20.0** (the supported minimum) and **24** on Linux, using pnpm from the `packageManager` pin and `pnpm-lock.yaml`:

1. Install with `pnpm install --frozen-lockfile`.
2. Type-check production code, tests, scripts and release configuration.
3. Run the complete test suite, including local TLS/CONNECT servers.
4. Compile JavaScript/declarations and build an installable `.tgz` through `pnpm pack`.
5. Upload the Node.js 24 package as the **npm-package** artifact, retained for seven days.

Third-party actions are pinned to commit SHAs. Pull request checks have read-only repository access. Verification does not send Telegram messages. Pull requests never publish packages; pushes to release branches can publish only after both verification jobs pass.

### Publishing a release

The repository is [nuykon/semantic-release-tg-bot](https://github.com/nuykon/semantic-release-tg-bot). Its `release.config.ts` uses Conventional Commits:

- `main` produces stable versions on npm's `latest` channel.
- `beta` produces prerelease versions on the `beta` channel.
- `fix:` requests a patch; `feat:` requests a minor; `!` or a `BREAKING CHANGE:` footer requests a major.

This new package starts at `1.0.0`. Its history does not need a tag from another package. A release creates its version tag and GitHub release notes, then publishes the package. The job does not commit generated version changes back to the repository.

Publication uses **npm Trusted Publishing (OIDC)**. No `NPM_TOKEN` or separate GitHub PAT is required. Only the release job has `id-token: write` for npm authentication and `contents: write` for Git tags/GitHub Releases. GitHub supplies `GITHUB_TOKEN` automatically.

Configure a GitHub Actions Trusted Publisher in the npm package settings with these exact values:

| Setting | Value |
| --- | --- |
| Organization/user | `nuykon` |
| Repository | `semantic-release-tg-bot` |
| Workflow filename | `ci.yml` |
| Environment | Leave empty (the workflow does not use a GitHub environment) |
| Allowed actions | Direct publishing (`npm publish`) and distribution-tag management (`npm dist-tag`) |

The installed `@semantic-release/npm` uses npm CLI 11.21.2, which supports OIDC publishing and distribution-tag operations. The release runs on GitHub-hosted Linux with Node.js 24. Keep the Trusted Publisher's workflow filename synchronized if `ci.yml` is renamed.

After a push or merge into **main** or **beta**, the release job runs once both Node.js verification jobs succeed. Other branches and pull requests cannot publish. A manual run of **Actions → CI → Run workflow** can also request a release; with the release input disabled, a manual run only verifies the project. Semantic-release publishes only when Conventional Commits indicate a new version.

The first `1.0.0` publication is bootstrapped with an authenticated npm account. Its `v1.0.0` Git tag must point at exactly the source commit used for that package. Subsequent releases are derived from that tag and the commits after it; do not move the tag or create an unrelated version baseline.

The workflow fetches full history/tags and does not cache release dependencies. Public packages published through npm Trusted Publishing receive provenance automatically. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and [semantic-release on GitHub Actions](https://semantic-release.org/recipes/ci-configurations/github-actions/).

`pnpm run release:dry-run` previews a release while still checking credentials. `pnpm run semantic-release` is the publishing command. The repository does not configure itself as a Telegram recipient; notification settings belong to consuming projects.

## Compatibility

Existing consumers of the previous Telegram notification plugin can retain the documented option names and environment variables. Advanced Lodash/Nunjucks expressions and full micromatch behavior are not provided. Use dotted placeholders or callbacks, verify native branch patterns, and review the Markdown scope above. Default wording and verification diagnostics are specific to this implementation.

Maintainer: [Sergey Levchenko](https://github.com/nuykon). Distributed under [MIT](LICENSE).
