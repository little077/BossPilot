import { Loader2, Puzzle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sendSkillCommand } from '@/lib/skills/client';
import type { SkillSettingsView } from '@/lib/skills/types';

export function SkillSettings() {
  const [state, setState] = useState<SkillSettingsView | null>(null);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void sendSkillCommand({ type: 'skills:get' }).then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setNotice('技能列表读取失败，请重新打开设置。');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const change = async (name: string, enabled: boolean) => {
    setBusy(name);
    setNotice('');
    try {
      const next = await sendSkillCommand({ type: 'skills:set-enabled', name, enabled });
      setState(next);
      setNotice(enabled ? `已启用 ${name}。` : `已停用 ${name}。`);
    } catch {
      setNotice('技能设置保存失败，请稍后重试。');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="skill-settings" aria-labelledby="skill-settings-title">
      <div className="provider-section-title">
        <h2 id="skill-settings-title">Agent Skills</h2>
        <span>按需加载专业流程</span>
      </div>
      <p className="page-origin-copy">
        只有任务明确匹配时才加载完整 Skill；Skill
        只能组合现有受控工具，不能扩大浏览器权限或绕过确认。
      </p>
      {notice ? (
        <div className="page-origin-notice" role="status">
          {notice}
        </div>
      ) : null}
      {state === null ? (
        <div className="page-origin-empty">
          <Loader2 size={11} className="animate-spin" /> 正在读取技能…
        </div>
      ) : (
        <div className="skill-list">
          {state.skills.map((skill) => (
            <article className="skill-card" key={skill.name} aria-label={`${skill.name} 技能`}>
              <span className="skill-card-icon" aria-hidden>
                <Puzzle size={14} />
              </span>
              <span className="skill-card-copy">
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
                <small>
                  <ShieldCheck size={9} /> v{skill.version} ·{' '}
                  {skill.builtIn ? '内置技能' : '本地技能'}
                </small>
              </span>
              <label className="skill-toggle">
                <span className="sr-only">{`${skill.name} 技能`}</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${skill.name} 技能`}
                  aria-checked={skill.enabled}
                  checked={skill.enabled}
                  disabled={busy === skill.name}
                  onChange={(event) => void change(skill.name, event.target.checked)}
                />
                <span className="chat-history-switch" aria-hidden>
                  {busy === skill.name ? <Loader2 size={9} className="animate-spin" /> : null}
                </span>
              </label>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
