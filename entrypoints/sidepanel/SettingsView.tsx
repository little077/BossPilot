// ─── 设置页：BYOK 模型配置 + 用户简历档案 ───

import { useEffect, useState } from 'react';
import { Check, Save } from 'lucide-react';
import type { LlmConfig, UserProfile } from '@/lib/domain/types';
import { getLlmConfig, getUserProfile, setLlmConfig, setUserProfile } from '@/lib/storage/config';

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-ink outline-none focus:border-brand';

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-ink-soft">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[10px] text-ink-faint">{props.hint}</span>}
    </label>
  );
}

export function SettingsView() {
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void Promise.all([getLlmConfig(), getUserProfile()]).then(([l, p]) => {
      setLlm(l);
      setProfile(p);
    });
  }, []);

  if (!llm || !profile) {
    return <div className="p-4 text-xs text-ink-faint">加载中…</div>;
  }

  const save = async () => {
    await Promise.all([setLlmConfig(llm), setUserProfile(profile)]);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-bold text-brand-deep">模型（OpenAI 兼容端点 · BYOK）</h2>
        <Field
          label="Base URL"
          hint="如 https://api.deepseek.com/v1 、https://api.openai.com/v1 、http://localhost:11434/v1"
        >
          <input
            className={inputCls}
            value={llm.baseUrl}
            onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value.trim() })}
          />
        </Field>
        <Field label="API Key" hint="仅保存在本机 chrome.storage，不上传任何服务器。">
          <input
            className={inputCls}
            type="password"
            value={llm.apiKey}
            onChange={(e) => setLlm({ ...llm, apiKey: e.target.value.trim() })}
          />
        </Field>
        <Field label="模型名">
          <input
            className={inputCls}
            value={llm.model}
            onChange={(e) => setLlm({ ...llm, model: e.target.value.trim() })}
          />
        </Field>
        <Field label="评估批量大小" hint="一次请求评估几个岗位，默认 10；上下文小的模型可调小。">
          <input
            className={inputCls}
            type="number"
            min={1}
            max={20}
            value={llm.batchSize ?? 10}
            onChange={(e) =>
              setLlm({ ...llm, batchSize: Math.min(Math.max(Number(e.target.value) || 10, 1), 20) })
            }
          />
        </Field>
      </section>

      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-bold text-brand-deep">我的档案（用于匹配打分）</h2>
        <Field
          label="简历要点 / 技能自述"
          hint="例：5 年前端，React/TS/Node，做过中后台与低代码，期望 15-25K。"
        >
          <textarea
            className={`${inputCls} min-h-[100px] resize-y`}
            value={profile.resumeText}
            onChange={(e) => setProfile({ ...profile, resumeText: e.target.value })}
          />
        </Field>
        <Field label="长期偏好" hint="例：只考虑双休；排除外包/驻场；倾向中大厂。">
          <textarea
            className={`${inputCls} min-h-[56px] resize-y`}
            value={profile.preferences}
            onChange={(e) => setProfile({ ...profile, preferences: e.target.value })}
          />
        </Field>
      </section>

      <button
        className="flex items-center justify-center gap-1.5 rounded-xl bg-brand py-2 text-xs font-semibold text-white transition hover:bg-brand-strong"
        onClick={() => void save()}
      >
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? '已保存' : '保存设置'}
      </button>

      <p className="text-[10px] leading-relaxed text-ink-faint">
        隐私说明：所有配置与档案仅存本机。任务执行时，只把结构化的岗位字段与你的档案发给你自己配置的模型端点；
        不采集账号密码，不做自动投递/自动发消息。
      </p>
    </div>
  );
}
