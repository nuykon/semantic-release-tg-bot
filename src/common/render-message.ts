import type {TGBotMessage, TGBotMessageTemplate, TemplateContext, TGBotMessageFormat} from '../interfaces/config';
import {readFileSync} from 'node:fs';
import {extname, resolve} from 'node:path';
import {renderMarkdown} from './markdown';
import {interpolate} from './template';

const renderMessage = (message: TGBotMessage | TGBotMessageTemplate, context: TemplateContext = {}): {message: string; format: TGBotMessageFormat} => {
 const data = {...context, ...message.customData};
 if ('message' in message) {
  const text = typeof message.message === 'function' ? message.message(data) : interpolate(message.message, data);
  if (typeof text !== 'string') throw new TypeError('A message function must return a string.');
  const format = message.format ?? 'markdown';
  return {message: format === 'html' ? text.trim() : renderMarkdown(text), format};
 }
 // File templates already contain Telegram HTML or MarkdownV2 and are not converted.
 return {
  message: interpolate(readFileSync(resolve(message.path), 'utf8'), data).trim(),
  format: extname(message.path).toLowerCase() === '.html' ? 'html' : 'markdown',
 };
};
export {renderMessage};
