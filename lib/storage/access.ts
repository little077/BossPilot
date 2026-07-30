const STORAGE_ACCESS_ERROR_MESSAGE =
  '无法启用模型密钥隔离，已停止模型配置与调用。请升级 Chrome 后重试。';

interface StorageAccessOptions {
  accessLevel: 'TRUSTED_CONTEXTS';
}

type SetAccessLevel = (options: StorageAccessOptions) => Promise<void>;

/**
 * Starts the storage restriction immediately and returns a reusable gate.
 *
 * The settled result is retained instead of leaving a rejected promise
 * unhandled while the service worker waits for its first provider request.
 */
export function createTrustedStorageGate(
  setAccessLevel: SetAccessLevel = (options) => chrome.storage.local.setAccessLevel(options),
): () => Promise<void> {
  const result = setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(
    () => null,
    () => new Error(STORAGE_ACCESS_ERROR_MESSAGE),
  );

  return async () => {
    const error = await result;
    if (error) throw error;
  };
}
