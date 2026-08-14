import type {
  GenerationToolCall,
  GenerationToolDefinition,
  GenerationToolExecutionOutcome,
} from '@/lib/generation/types';
import { hasExactPageOriginAccess, pageOriginPattern } from '@/lib/page/access';
import { WorkspaceStore } from '@/lib/workspace/storage';

export const WORKSPACE_TOOLS: GenerationToolDefinition[] = [
  tool(
    'workspace_create',
    '创建工作区文件',
    '在当前会话私有工作区创建一个文本文件。写入前必须由用户确认。',
    {
      path: { type: 'string', description: '工作区内路径，例如 /reports/summary.md。' },
      content: { type: 'string', description: '文件正文。' },
      mimeType: { type: 'string', description: '可选 MIME 类型。' },
    },
    ['path', 'content'],
  ),
  tool(
    'workspace_mkdir',
    '创建工作区目录',
    '在当前会话私有工作区创建目录。写入前必须由用户确认。',
    { path: { type: 'string' } },
    ['path'],
  ),
  tool(
    'workspace_read',
    '读取工作区文件',
    '读取当前会话工作区中的文件；不能跨会话访问。',
    {
      path: { type: 'string' },
    },
    ['path'],
  ),
  tool(
    'workspace_edit',
    '编辑工作区文件',
    '替换或追加当前会话文件，并保留覆盖前版本。每次编辑必须由用户确认。',
    {
      path: { type: 'string' },
      content: { type: 'string' },
      mode: { type: 'string', enum: ['replace', 'append'] },
    },
    ['path', 'content'],
  ),
  tool(
    'workspace_rename',
    '重命名工作区文件',
    '重命名当前会话工作区中的文件。执行前必须由用户确认。',
    {
      fromPath: { type: 'string' },
      toPath: { type: 'string' },
    },
    ['fromPath', 'toPath'],
  ),
  tool(
    'workspace_delete',
    '删除工作区文件',
    '删除当前会话工作区中的文件或空目录。执行前必须由用户确认。',
    {
      path: { type: 'string' },
    },
    ['path'],
  ),
  tool('workspace_list', '列出工作区产物', '列出当前会话的文件和目录。', {
    path: { type: 'string', description: '可选目录，默认为 /。' },
  }),
  tool(
    'workspace_search',
    '搜索工作区文本',
    '在当前会话的文本产物中全文搜索。',
    {
      query: { type: 'string' },
    },
    ['query'],
  ),
  tool(
    'workspace_save_url',
    '保存 URL 内容',
    '将已授权 HTTP(S) 来源的内容保存到当前会话工作区。执行前必须由用户确认。',
    {
      url: { type: 'string' },
      path: { type: 'string' },
    },
    ['url', 'path'],
  ),
];

export class WorkspaceToolCoordinator {
  constructor(private readonly store = new WorkspaceStore()) {}

  async execute(
    call: GenerationToolCall,
    conversationId: string,
    approved: boolean,
    signal: AbortSignal,
  ): Promise<GenerationToolExecutionOutcome> {
    if (!conversationId) return failure('工作区不可用', '缺少会话标识，已拒绝文件访问。');
    if (signal.aborted) return failure('已取消工作区操作', '任务已取消。');
    try {
      switch (call.name) {
        case 'workspace_list': {
          const view = await this.store.list(
            conversationId,
            optionalString(call.arguments.path) ?? '/',
          );
          return success('已列出当前会话产物', JSON.stringify(view), undefined, 'read');
        }
        case 'workspace_read': {
          const path = requiredString(call.arguments.path, 'path');
          const file = await this.store.read(conversationId, path);
          const content =
            file.content ??
            (file.dataUrl ? '[图片文件，可在产物页预览]' : '[二进制文件，请在产物页下载]');
          return success(
            '已读取工作区文件',
            JSON.stringify({
              path: file.path,
              mimeType: file.mimeType,
              size: file.size,
              version: file.version,
              content,
            }),
            file.path,
            'read',
          );
        }
        case 'workspace_search': {
          const results = await this.store.search(
            conversationId,
            requiredString(call.arguments.query, 'query'),
          );
          return success('已搜索当前会话产物', JSON.stringify(results), undefined, 'read');
        }
        case 'workspace_create':
        case 'workspace_mkdir':
        case 'workspace_edit':
        case 'workspace_rename':
        case 'workspace_delete':
        case 'workspace_save_url':
          if (!approved) return confirmation(call);
          return await this.executeWrite(call, conversationId, signal);
        default:
          return failure('工作区工具不可用', `未知工具：${call.name}`);
      }
    } catch (error) {
      return failure('工作区操作失败', error instanceof Error ? error.message : String(error));
    }
  }

  private async executeWrite(
    call: GenerationToolCall,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<GenerationToolExecutionOutcome> {
    switch (call.name) {
      case 'workspace_create': {
        const path = requiredString(call.arguments.path, 'path');
        const entry = await this.store.write(
          conversationId,
          path,
          requiredString(call.arguments.content, 'content'),
          {
            mimeType: optionalString(call.arguments.mimeType),
            overwrite: false,
          },
        );
        return success('已创建工作区文件', JSON.stringify(entry), entry.path, 'write');
      }
      case 'workspace_mkdir': {
        const entry = await this.store.createDirectory(
          conversationId,
          requiredString(call.arguments.path, 'path'),
        );
        return success('已创建工作区目录', JSON.stringify(entry), entry.path, 'write');
      }
      case 'workspace_edit': {
        const path = requiredString(call.arguments.path, 'path');
        const content = requiredString(call.arguments.content, 'content');
        const mode = optionalString(call.arguments.mode) ?? 'replace';
        const previous =
          mode === 'append' ? await this.store.read(conversationId, path) : undefined;
        if (mode !== 'append' && mode !== 'replace')
          throw new Error('mode 只能是 replace 或 append。');
        const entry = await this.store.write(
          conversationId,
          path,
          `${previous?.content ?? ''}${content}`,
          {
            mimeType: previous?.mimeType,
            overwrite: true,
          },
        );
        return success('已编辑工作区文件并保留旧版本', JSON.stringify(entry), entry.path, 'write');
      }
      case 'workspace_rename': {
        const entry = await this.store.rename(
          conversationId,
          requiredString(call.arguments.fromPath, 'fromPath'),
          requiredString(call.arguments.toPath, 'toPath'),
        );
        return success('已重命名工作区文件', JSON.stringify(entry), entry.path, 'write');
      }
      case 'workspace_delete': {
        const path = requiredString(call.arguments.path, 'path');
        await this.store.delete(conversationId, path);
        return success(
          '已删除工作区产物',
          JSON.stringify({ path, deleted: true }),
          path,
          'dangerous',
        );
      }
      case 'workspace_save_url': {
        const url = new URL(requiredString(call.arguments.url, 'url'));
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          throw new Error('仅支持 HTTP(S) URL。');
        const pattern = pageOriginPattern(url.origin);
        if (!pattern || !(await hasExactPageOriginAccess(pattern))) {
          throw new Error('该 URL 来源尚未授权。请先在浏览器中打开此来源并授予精确站点权限。');
        }
        const response = await fetch(url, { signal, credentials: 'omit', redirect: 'follow' });
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
        const blob = await response.blob();
        const path = requiredString(call.arguments.path, 'path');
        const entry = await this.store.write(conversationId, path, blob, {
          mimeType: blob.type || undefined,
          overwrite: false,
        });
        return success('已保存 URL 内容', JSON.stringify(entry), entry.path, 'write');
      }
      default:
        return failure('工作区工具不可用', `未知写入工具：${call.name}`);
    }
  }
}

function tool(
  name: GenerationToolDefinition['name'],
  label: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): GenerationToolDefinition {
  return {
    name,
    label,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required ? { required } : {}),
      additionalProperties: false,
    },
  };
}

function confirmation(call: GenerationToolCall): GenerationToolExecutionOutcome {
  return {
    deferred: true,
    kind: 'user_input',
    statusText: '等待确认工作区写入',
    question: `Agent 准备执行“${call.name}”。该操作会写入、覆盖、重命名或删除当前会话的本地文件，是否继续？`,
    options: [
      { id: 'confirm', label: '确认执行' },
      { id: 'cancel', label: '取消' },
    ],
    allowCustom: false,
  };
}

function success(
  statusText: string,
  content: string,
  outputPath?: string,
  riskLevel: 'read' | 'write' | 'dangerous' = 'read',
): GenerationToolExecutionOutcome {
  return {
    isError: false,
    statusText,
    content,
    ...(outputPath ? { outputPath } : {}),
    riskLevel,
    authorizationStatus: riskLevel === 'read' ? 'not_required' : 'granted',
    recoverability: riskLevel === 'read' ? 'safe_retry' : 'user_retry',
  };
}

function failure(statusText: string, detail: string): GenerationToolExecutionOutcome {
  return {
    isError: true,
    statusText,
    detail,
    content: `${statusText}：${detail}`,
    riskLevel: 'read',
    authorizationStatus: 'not_required',
    recoverability: 'safe_retry',
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} 不能为空。`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
