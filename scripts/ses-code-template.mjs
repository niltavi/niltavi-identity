import { messages } from '../dist/mail-templates.js';

const variable = process.argv[2] ?? 'code';
if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(variable)) throw new Error('Invalid SES code variable name.');
const { html, text } = messages.code(`{{${variable}}}`);
process.stdout.write(JSON.stringify({
  TemplateName: 'NiltaviIdentityVerificationCode',
  TemplateContent: { Html: Buffer.from(html).toString('base64'), Text: Buffer.from(text).toString('base64') },
}, null, 2) + '\n');
