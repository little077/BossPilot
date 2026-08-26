import {
  Copy,
  Download,
  FilePenLine,
  Loader2,
  PackagePlus,
  Puzzle,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { sendSkillCommand, sendSkillRequest } from '@/lib/skills/client';
import type { SkillPackage, SkillPackageFile, SkillSettingsView } from '@/lib/skills/types';
import { SkillEditor } from './SkillEditor';

export function SkillSettings() {
  const [state, setState] = useState<SkillSettingsView | null>(null);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<SkillPackage | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

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

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice('');
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Skill 操作失败，请稍后重试。');
    } finally {
      setBusy(undefined);
    }
  };

  const change = async (name: string, enabled: boolean) => {
    await run(name, async () => {
      let next: SkillSettingsView;
      try {
        next = await sendSkillCommand({ type: 'skills:set-enabled', name, enabled });
      } catch {
        throw new Error('技能设置保存失败，请稍后重试。');
      }
      setState(next);
      setNotice(enabled ? `已启用 ${name}。` : `已停用 ${name}。`);
    });
  };

  const open = async (name: string) => {
    await run(name, async () => {
      const response = await sendSkillRequest({ type: 'skills:get-package', name });
      if (!response.skill) throw new Error('Skill 文件读取失败。');
      setState(response.state);
      setEditing(response.skill);
    });
  };

  const create = async () => {
    const name = window.prompt('输入 Skill 名称，只能使用小写字母、数字和连字符');
    if (!name) return;
    await run(name, async () => {
      const response = await sendSkillRequest({ type: 'skills:create', name });
      if (!response.skill) throw new Error('Skill 创建失败。');
      setState(response.state);
      setEditing(response.skill);
      setNotice(`已创建 ${name}。`);
    });
  };

  const duplicate = async (name: string) => {
    const nextName = window.prompt('输入复制后的 Skill 名称', `${name}-copy`);
    if (!nextName) return;
    await run(name, async () => {
      const response = await sendSkillRequest({ type: 'skills:duplicate', name, nextName });
      setState(response.state);
      setNotice(`已复制为 ${nextName}。`);
    });
  };

  const remove = async (name: string) => {
    if (!window.confirm(`删除本地 Skill “${name}”？其授权也会同时撤销。`)) return;
    await run(name, async () => {
      const response = await sendSkillRequest({ type: 'skills:delete', name });
      setState(response.state);
      setNotice(`已删除 ${name}。`);
    });
  };

  const exportOne = async (name: string) => {
    await run(name, async () => {
      const response = await sendSkillRequest({ type: 'skills:export', name });
      if (!response.archiveBase64) throw new Error('Skill 导出失败。');
      downloadBase64(response.archiveBase64, `${name}.zip`);
      setNotice(`已导出 ${name}.zip。`);
    });
  };

  const exportAll = async () => {
    await run('export-all', async () => {
      const response = await sendSkillRequest({ type: 'skills:export-all' });
      if (!response.archiveBase64) throw new Error('Skills 批量导出失败。');
      downloadBase64(response.archiveBase64, 'bosspilot-skills.zip');
      setNotice('已导出全部 Skills。');
    });
  };

  const importZip = async (file: File) => {
    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      setNotice('Skill ZIP 为空或超过 5 MB。');
      return;
    }
    await run('import', async () => {
      const archiveBase64 = bufferToBase64(await file.arrayBuffer());
      const response = await sendSkillRequest({ type: 'skills:import', archiveBase64 });
      setState(response.state);
      setNotice(`已安全导入 ${response.skill?.name ?? 'Skill'}。`);
    });
  };

  const save = async (name: string, files: SkillPackageFile[]) => {
    const response = await sendSkillRequest({ type: 'skills:save-package', name, files });
    setState(response.state);
    if (response.skill) setEditing(response.skill);
  };

  const revoke = async (id: string) => {
    await run(id, async () => {
      const response = await sendSkillRequest({ type: 'skills:revoke-grant', id });
      setState(response.state);
      setNotice('已撤销 Skill 持续授权。');
    });
  };

  if (editing) {
    return (
      <SkillEditor
        skill={editing}
        readOnly={editing.definition.builtIn}
        onClose={() => setEditing(null)}
        onSave={(files) => save(editing.name, files)}
      />
    );
  }

  return (
    <section className="skill-settings" aria-labelledby="skill-settings-title">
      <div className="provider-section-title">
        <h2 id="skill-settings-title">Agent Skills</h2>
        <span>官方目录格式 · 渐进加载</span>
      </div>
      <p className="page-origin-copy">
        新会话只看到 Skill 名称和描述；完整 SKILL.md、引用与脚本仅在匹配任务后加载。脚本在无扩展 API
        的隔离页运行，敏感能力必须单独授权。
      </p>
      <div className="skill-toolbar">
        <button type="button" onClick={() => void create()}>
          <PackagePlus size={11} /> 新建
        </button>
        <button type="button" onClick={() => importRef.current?.click()}>
          <Upload size={11} /> 导入 ZIP
        </button>
        <button type="button" disabled={busy === 'export-all'} onClick={() => void exportAll()}>
          <Download size={11} /> 导出全部
        </button>
        <input
          ref={importRef}
          className="sr-only"
          type="file"
          accept=".zip,application/zip"
          aria-label="导入 Skill ZIP"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importZip(file);
            event.target.value = '';
          }}
        />
      </div>
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
                  {skill.builtIn ? '内置技能' : '本地技能'} · {skill.fileCount ?? 1} 个文件
                </small>
                <span className="skill-card-actions">
                  <button
                    type="button"
                    aria-label={`查看或编辑 ${skill.name}`}
                    onClick={() => void open(skill.name)}
                  >
                    <FilePenLine size={9} /> {skill.builtIn ? '查看' : '编辑'}
                  </button>
                  <button
                    type="button"
                    aria-label={`复制 ${skill.name}`}
                    onClick={() => void duplicate(skill.name)}
                  >
                    <Copy size={9} /> 复制
                  </button>
                  <button
                    type="button"
                    aria-label={`导出 ${skill.name}`}
                    onClick={() => void exportOne(skill.name)}
                  >
                    <Download size={9} /> 导出
                  </button>
                  {!skill.builtIn ? (
                    <button
                      type="button"
                      aria-label={`删除 ${skill.name}`}
                      onClick={() => void remove(skill.name)}
                    >
                      <Trash2 size={9} /> 删除
                    </button>
                  ) : null}
                </span>
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
      {state?.grants?.length ? (
        <div className="skill-grants">
          <strong>持续授权</strong>
          {(state.grants ?? []).map((grant) => (
            <div key={grant.id}>
              <span>
                {grant.skillName} · {grant.capability} ·{' '}
                {grant.decision === 'allow' ? '允许' : '拒绝'}
              </span>
              <button
                type="button"
                disabled={busy === grant.id}
                onClick={() => void revoke(grant.id)}
              >
                撤销
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function bufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function downloadBase64(value: string, fileName: string): void {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
