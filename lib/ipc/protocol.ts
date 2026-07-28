// ─── Port 通信协议：Sidepanel（Client） ↔ Background（Server） ───
// 单一事实源：所有跨侧边栏/后台的消息类型都定义在这里。
// 采用长连接 Port（chrome.runtime.connect），后台以流式方式广播任务快照。

import type { SearchTaskParams, TaskSnapshot } from '@/lib/domain/types';

export const AGENT_PORT_NAME = 'bosspilot-agent';

// ─── Client → Background ───

export type ClientMessage =
  /** 侧边栏连接后先声明订阅，后台回放当前任务快照（若有）。 */
  | { type: 'subscribe' }
  /** 直接用自然语言发起一次任务（后台先做意图解析再执行）。 */
  | { type: 'run_nl'; text: string }
  /** 用已确认的结构化参数发起任务（任务卡片/编辑后确认走这条）。 */
  | { type: 'run_params'; params: SearchTaskParams }
  /** 取消当前任务。 */
  | { type: 'cancel' }
  /** 验证码已手动通过，请求继续。 */
  | { type: 'resume_captcha' }
  /** 下载当前报告（后台经 chrome.downloads 落盘）。 */
  | { type: 'download_report' }
  /** 仅解析自然语言、不执行，用于「先确认参数再跑」。 */
  | { type: 'parse_only'; text: string };

// ─── Background → Client ───

export type ServerMessage =
  | { type: 'connected' }
  /** 任务快照增量广播（phase/进度/已采集岗位/报告）。 */
  | { type: 'snapshot'; snapshot: TaskSnapshot }
  /** parse_only 的结果：解析出的参数，交 UI 渲染成可编辑任务卡片。 */
  | { type: 'parsed'; params: SearchTaskParams }
  /** 一条面向用户的日志/提示（追加到对话流）。 */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  /** 出错。 */
  | { type: 'error'; text: string };
