// ─── 工件仓库（Artifact 底座的「档案柜」） ───
// 工具的全量结果落地到本地 IndexedDB，对话历史里只保留引用卡（编号+摘要+预览），
// 一举解决三件事：多轮下发的大结果不再重复计 token、重放安全、后台被杀不丢数据。
// 心法2「副作用有界」在这里的体现：总量上限硬编码在本文件，超限按 createdAt 淘最旧，
// 模型与调用方都无法突破；被淘汰的工件由读取方以稳定错误码 artifact_not_found 如实转述。

import { db } from '@/lib/storage/db';

/** 工件总量上限：档案柜的淘汰线（风控类参数，放宽需先开 Issue 讨论）。 */
export const MAX_ARTIFACTS = 50;

/** 单条工件：面向模型的全文 + 溯源元信息。 */
export interface ArtifactRecord {
  /** 主键（crypto.randomUUID），模型取回时使用的唯一编号。 */
  id: string;
  /** 产出工具名（如 read_current_page），供引用卡与 UI 展示。 */
  tool: string;
  /** 一句话摘要（与工具卡片一致）。 */
  summary: string;
  /** 完整正文（已受产出工具自身硬上限约束，如页面抽取的 10 万字符天花板）。 */
  text: string;
  /** 毫秒时间戳，排序与淘汰依据。 */
  createdAt: number;
}

/** 写入工件的输入（id/createdAt 由仓库生成，调用方不传）。 */
export interface PutArtifactInput {
  tool: string;
  summary: string;
  text: string;
}

/** 落地一条工件并立即执行超限淘汰，返回完整记录（引用卡需要其 id 与正文）。 */
export async function putArtifact(input: PutArtifactInput): Promise<ArtifactRecord> {
  const record: ArtifactRecord = {
    id: crypto.randomUUID(),
    tool: input.tool,
    summary: input.summary,
    text: input.text,
    createdAt: Date.now(),
  };
  await db.artifacts.put(record);
  await evictOverflow();
  return record;
}

/** 精确主键查询；未命中返回 null（可能已被淘汰），由调用方映射为稳定错误码。 */
export async function getArtifact(id: string): Promise<ArtifactRecord | null> {
  const record = await db.artifacts.get(id);
  return record ?? null;
}

/** 全量清空：「新对话」清消息时同步调用，避免档案柜留下无主孤本。 */
export async function clearArtifacts(): Promise<void> {
  await db.artifacts.clear();
}

/** 超出总量上限时删除最旧的溢出部分，保证档案柜有界增长。 */
async function evictOverflow(): Promise<void> {
  const all = await db.artifacts.orderBy('createdAt').toArray();
  const excess = all.length - MAX_ARTIFACTS;
  if (excess > 0) {
    await db.artifacts.bulkDelete(all.slice(0, excess).map((row) => row.id));
  }
}
