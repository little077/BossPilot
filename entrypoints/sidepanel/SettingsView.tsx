// ─── 设置页：BYOK 模型配置 + 用户简历档案 ───

import { Check, Loader2, Plug, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LlmConfig, UserProfile } from '@/lib/domain/types';
import { chat } from '@/lib/llm/client';
import { getLlmConfig, getUserProfile, setLlmConfig, setUserProfile } from '@/lib/storage/config';

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-ink outline-none focus:border-brand';

function Field(props: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-[11px] font-medium text-ink-soft">
        {props.label}
      </label>
      {props.children}
      {props.hint && <span className="text-[10px] text-ink-faint">{props.hint}</span>}
    </div>
  );
}

export function SettingsView() {
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; msg?: string }>({
    state: 'idle',
  });

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

  // 测试连通性：用当前（未保存的）配置发一次最小请求，验证 Key/端点/模型可用。
  const testConnection = async () => {
    setTest({ state: 'testing' });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 20000);
    try {
      const reply = await chat(llm, [{ role: 'user', content: '连通性测试，请只回复：ok' }], {
        temperature: 0,
        signal: timeout.signal,
      });
      setTest({
        state: 'ok',
        msg: `连接成功，模型已响应（${reply.trim().slice(0, 20) || 'ok'}）。`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTest({
        state: 'fail',
        msg: timeout.signal.aborted ? '请求超时（20s），请检查端点是否可达。' : msg,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-bold text-brand-deep">模型（OpenAI 兼容端点 · BYOK）</h2>
        <Field
          id="llm-base-url"
          label="Base URL"
          hint="如 https://api.deepseek.com/v1 、https://api.openai.com/v1 、http://localhost:11434/v1"
        >
          <input
            id="llm-base-url"
            className={inputCls}
            value={llm.baseUrl}
            onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value.trim() })}
          />
        </Field>
        <Field
          id="llm-api-key"
          label="API Key"
          hint="仅保存在本机 chrome.storage，不上传任何服务器。"
        >
          <input
            id="llm-api-key"
            className={inputCls}
            type="password"
            value={llm.apiKey}
            onChange={(e) => setLlm({ ...llm, apiKey: e.target.value.trim() })}
          />
        </Field>
        <Field id="llm-model" label="模型名">
          <input
            id="llm-model"
            className={inputCls}
            value={llm.model}
            onChange={(e) => setLlm({ ...llm, model: e.target.value.trim() })}
          />
        </Field>
        <Field
          id="llm-batch-size"
          label="评估批量大小"
          hint="一次请求评估几个岗位，默认 10；上下文小的模型可调小。"
        >
          <input
            id="llm-batch-size"
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
          id="profile-resume"
          label="简历要点 / 技能自述"
          hint="例：5 年前端，React/TS/Node，做过中后台与低代码，期望 15-25K。"
        >
          <textarea
            id="profile-resume"
            className={`${inputCls} min-h-[100px] resize-y`}
            value={profile.resumeText}
            onChange={(e) => setProfile({ ...profile, resumeText: e.target.value })}
          />
        </Field>
        <Field
          id="profile-preferences"
          label="长期偏好"
          hint="例：只考虑双休；排除外包/驻场；倾向中大厂。"
        >
          <textarea
            id="profile-preferences"
            className={`${inputCls} min-h-[56px] resize-y`}
            value={profile.preferences}
            onChange={(e) => setProfile({ ...profile, preferences: e.target.value })}
          />
        </Field>
      </section>

      <button
        type="button"
        className="flex items-center justify-center gap-1.5 rounded-xl bg-brand py-2 text-xs font-semibold text-white transition hover:bg-brand-strong"
        onClick={() => void save()}
      >
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? '已保存' : '保存设置'}
      </button>

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          className="flex items-center justify-center gap-1.5 rounded-xl border border-line bg-surface py-2 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand-strong disabled:opacity-50"
          onClick={() => void testConnection()}
          disabled={test.state === 'testing'}
        >
          {test.state === 'testing' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : test.state === 'ok' ? (
            <Check size={13} className="text-brand-strong" />
          ) : test.state === 'fail' ? (
            <X size={13} className="text-danger" />
          ) : (
            <Plug size={13} />
          )}
          {test.state === 'testing' ? '测试中…' : '测试连通性'}
        </button>
        {test.msg && (
          <p
            className={`text-[10px] leading-relaxed ${
              test.state === 'ok' ? 'text-brand-strong' : 'text-danger'
            }`}
          >
            {test.msg}
          </p>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-ink-faint">
        隐私说明：所有配置与档案仅存本机。任务执行时，只把结构化的岗位字段与你的档案发给你自己配置的模型端点；
        不采集账号密码，不做自动投递/自动发消息。
      </p>
    </div>
  );
}
