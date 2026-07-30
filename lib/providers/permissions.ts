// ─── 模型端点权限工具 ───
// 职责：把用户配置的 Base URL 收敛为安全 URL，并只申请对应主机的可选权限。

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeProviderBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('请先填写 Base URL。');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL 格式不正确。');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Base URL 只支持 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('Base URL 不能包含用户名或密码。');
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('远程模型端点必须使用 HTTPS；HTTP 仅允许本机服务。');
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

export function getProviderHostPermission(baseUrl: string): string {
  const url = new URL(normalizeProviderBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
}

export async function requestProviderHostPermission(baseUrl: string): Promise<boolean> {
  const origin = getProviderHostPermission(baseUrl);
  return chrome.permissions.request({ origins: [origin] });
}

export async function containsProviderHostPermission(baseUrl: string): Promise<boolean> {
  const origin = getProviderHostPermission(baseUrl);
  return chrome.permissions.contains({ origins: [origin] });
}
