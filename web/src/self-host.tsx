import { Button, Surface } from '@heroui/react';
import Copy from '@gravity-ui/icons/Copy';
import { useState } from 'react';
import { container, copy, repository } from './site';
import type { Language } from './site';

const guideUrl = repository + '/blob/main/docs/en/for-agents.md';

export const deploymentCopy = {
  en: {
    title: 'Self-host · Niltavi Identity',
    description: 'Copy the prompt and give it to your agent to deploy Niltavi Identity with Docker Compose.',
    copy: 'Copy prompt',
    copied: 'Copied. Paste the prompt into your agent.',
    copyFailed: 'Select and copy the prompt manually.',
    prompt: (mirror: string) => [
      'Help me deploy Niltavi Identity on my machine. Use Docker Compose if available.',
      'Read the GitHub installation guide and follow its deployment, setup, and verification steps:\n' + guideUrl,
      'If the GitHub guide is unavailable, use this copy:\n' + mirror,
      'Ask me for any missing configuration or access. Once the service is running, give me its URL and show me how to create the first account.',
    ].join('\n\n'),
  },
  'zh-CN': {
    title: '本地部署 · Niltavi Identity',
    description: '复制提示词发给你的 Agent，让它用 Docker Compose 部署 Niltavi Identity。',
    copy: '复制提示词',
    copied: '已复制。可以粘贴给你的 Agent 了。',
    copyFailed: '请选中提示词并手动复制。',
    prompt: (mirror: string) => [
      '请在我的机器上部署 Niltavi Identity，优先使用 Docker Compose。',
      '阅读 GitHub 上的安装指南，按里面的步骤部署、初始化并验证服务。\n' + guideUrl,
      '如果打不开 GitHub 指南，请读这份副本。\n' + mirror,
      '缺少配置或访问权限时，请告诉我需要提供什么。服务启动后，把访问地址发给我，并告诉我怎么创建第一个账号。',
    ].join('\n\n'),
  },
};

export function SelfHost({ language, origin }: { language: Language; origin: string }) {
  const labels = deploymentCopy[language];
  const prompt = labels.prompt(origin + '/identity-assets/for-agents.md');
  const [status, setStatus] = useState<'copied' | 'copyFailed'>();

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus('copied');
    } catch {
      setStatus('copyFailed');
    }
  }

  return <main className={`${container} flex-1 py-12 sm:py-16`}>
    <div className="mx-auto grid max-w-2xl gap-6">
      <div className="grid gap-4">
        <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">{copy[language]['self-host']}</h1>
        <p className="text-pretty text-lg/relaxed text-muted">{labels.description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button onPress={() => void copyPrompt()}><Copy aria-hidden="true" width={16} height={16} />{labels.copy}</Button>
        <p role="status" className="text-sm text-muted">{status && labels[status]}</p>
      </div>
      <Surface className="rounded-(--field-radius) p-4 ring ring-border sm:p-6">
        <p className="whitespace-pre-wrap wrap-anywhere text-base/relaxed select-text">{prompt}</p>
      </Surface>
    </div>
  </main>;
}
