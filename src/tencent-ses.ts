import { readFile } from 'node:fs/promises';
import tencent from 'tencentcloud-sdk-nodejs-ses';
import { mailSupport, verificationSubject } from './mail-templates.js';

export type VerificationDelivery = (email: string, code: string) => Promise<void>;
type SesRequest = Parameters<InstanceType<typeof tencent.ses.v20201002.Client>['SendEmail']>[0];
type SesSender = (request: SesRequest) => Promise<{ MessageId?: string }>;

function parseConfig(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tencent SES configuration.');
  const data = value as Record<string, unknown>;
  const { secretId, secretKey, token, region, fromEmail, templateId } = data;
  const codeVariable = data.codeVariable ?? 'code';
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/\s/.test(value);
  const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!text(secretId) || !text(secretKey) || (token !== undefined && !text(token)) ||
    (region !== 'ap-guangzhou' && region !== 'ap-hongkong') ||
    typeof fromEmail !== 'string' || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(fromEmail) ||
    !validId(templateId) ||
    typeof codeVariable !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(codeVariable)) {
    throw new Error('Invalid Tencent SES configuration.');
  }
  return { credential: { secretId, secretKey, ...(token ? { token } : {}) }, region, fromEmail, templateId, codeVariable };
}

type SesCredentials = Pick<ReturnType<typeof parseConfig>, 'credential' | 'region'>;

function sdkSender({ credential, region }: SesCredentials): SesSender {
  const client = new tencent.ses.v20201002.Client({
    credential, region, profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: { endpoint: 'ses.tencentcloudapi.com', protocol: 'https://', reqTimeout: 10 },
    },
  });
  return request => client.SendEmail(request);
}

export function tencentSesDelivery(value: unknown, useSender = sdkSender): VerificationDelivery {
  const { credential, region, fromEmail, templateId, codeVariable } = parseConfig(value);
  const send = useSender({ credential, region });
  return async (email, code) => {
    let response;
    try {
      response = await send({
        FromEmailAddress: fromEmail,
        Destination: [email],
        ReplyToAddresses: mailSupport,
        Subject: verificationSubject,
        Template: { TemplateID: templateId, TemplateData: JSON.stringify({ [codeVariable]: code }) },
        TriggerType: 1,
      });
    } catch {
      throw new Error('Tencent SES did not accept the verification message.');
    }
    if (!response.MessageId) throw new Error('Tencent SES did not return a message identifier.');
  };
}

export async function loadTencentSes(file: string) {
  let configuration: unknown;
  try { configuration = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Could not read the Tencent SES configuration file.'); }
  return tencentSesDelivery(configuration);
}
