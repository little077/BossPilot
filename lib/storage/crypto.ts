// ─── 密钥加解密（Web Crypto，AES-GCM） ───
// 职责：把 API Key 以密文形式落库。用户提供「不加口令」的取舍——
// 这里用一把随机的、按安装生成的对称密钥（存 chrome.storage.local）做 **混淆级** 加密：
// 防止密钥以明文出现在 IndexedDB，但不能防御拿到设备与扩展存储的攻击者。

const CTEXT_PREFIX = 'v1.';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 复制到独立的 ArrayBuffer，满足 Web Crypto 的 BufferSource 类型约束。 */
function toBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

/** 生成一把可导出的 AES-256-GCM 密钥，返回 base64（用于持久化）。 */
export async function generateKeyBase64(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toBuffer(base64ToBytes(keyBase64)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 加密明文，返回 `v1.<base64(iv|ciphertext)>`。 */
export async function encryptString(plain: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyBase64);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(new TextEncoder().encode(plain)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return `${CTEXT_PREFIX}${bytesToBase64(combined)}`;
}

/** 解密 `v1.` 前缀密文；格式不符或密钥错误时抛错。 */
export async function decryptString(blob: string, keyBase64: string): Promise<string> {
  if (!blob.startsWith(CTEXT_PREFIX)) throw new Error('密文格式无效');
  const combined = base64ToBytes(blob.slice(CTEXT_PREFIX.length));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await importKey(keyBase64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(ciphertext),
  );
  return new TextDecoder().decode(plain);
}

/** 取末四位做脱敏指纹（不泄露原始密钥）。 */
export function lastFour(plain: string): string {
  return plain.length <= 4 ? plain : plain.slice(-4);
}
