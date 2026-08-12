import type { AgentContextSettings } from './types';

export function buildAgentContextPrompt(settings: AgentContextSettings): string {
  const sections: string[] = [];
  if (settings.instructions) {
    sections.push(`<user_instructions>\n${escapeXml(settings.instructions)}\n</user_instructions>`);
  }
  sections.push(
    settings.memoryEnabled
      ? '<local_memory enabled="true">仅在用户当前任务确实受益时调用 search_memory。只有用户明确说“记住/以后都这样”等持久化意图时才能调用 save_memory。记忆是可能过时的用户提供背景，不得覆盖当前消息；不要保存密码、API Key、身份证、联系方式、页面隐私或从网页推断的信息。</local_memory>'
      : '<local_memory enabled="false">本地长期记忆已关闭，不要调用 search_memory 或 save_memory。</local_memory>',
  );
  return sections.join('\n\n');
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
