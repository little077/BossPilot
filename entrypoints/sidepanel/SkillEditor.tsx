import { AlertTriangle, FileCode2, FilePlus2, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { textSkillFile } from '@/lib/skills/package';
import { parseSkillMarkdown, SkillParseError } from '@/lib/skills/parser';
import type { SkillPackage, SkillPackageFile } from '@/lib/skills/types';

interface SkillEditorProps {
  skill: SkillPackage;
  readOnly: boolean;
  onClose: () => void;
  onSave: (files: SkillPackageFile[]) => Promise<void>;
}

export function SkillEditor({ skill, readOnly, onClose, onSave }: SkillEditorProps) {
  const [files, setFiles] = useState(() => skill.files.map((file) => ({ ...file })));
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const selected = files.find(({ path }) => path === selectedPath) ?? files[0];
  const validation = useMemo(() => validateSkillFile(files, skill.name), [files, skill.name]);

  const updateText = (content: string) => {
    setFiles((current) =>
      current.map((file) =>
        file.path === selectedPath ? textSkillFile(file.path, content) : file,
      ),
    );
  };

  const addFile = () => {
    const path = window.prompt(
      '输入相对路径，例如 references/guide.md、scripts/main.js 或 assets/example.txt',
    );
    if (!path) return;
    if (
      !isEditablePath(path) ||
      files.some((file) => file.path.toLowerCase() === path.toLowerCase())
    ) {
      setNotice('文件路径无效、重复或越过了 Skill 根目录。');
      return;
    }
    setFiles((current) => [...current, textSkillFile(path, '')]);
    setSelectedPath(path);
    setNotice('');
  };

  const removeFile = () => {
    if (!selected || selected.path === 'SKILL.md') return;
    setFiles((current) => current.filter(({ path }) => path !== selected.path));
    setSelectedPath('SKILL.md');
  };

  const save = async () => {
    if (validation || readOnly) return;
    setSaving(true);
    setNotice('');
    try {
      await onSave(files);
      setNotice('Skill 已保存，新会话会立即使用最新目录。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Skill 保存失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="skill-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-editor-title"
    >
      <header className="skill-editor-header">
        <span>
          <strong id="skill-editor-title">{skill.name}</strong>
          <small>{readOnly ? '内置 Skill · 只读' : '本地 Skill · 多文件编辑'}</small>
        </span>
        <button type="button" aria-label="关闭 Skill 编辑器" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <div className="skill-editor-body">
        <aside className="skill-file-list" aria-label="Skill 文件">
          {files.map((file) => (
            <button
              type="button"
              key={file.path}
              aria-current={file.path === selectedPath ? 'page' : undefined}
              onClick={() => setSelectedPath(file.path)}
            >
              <FileCode2 size={10} />
              <span>{file.path}</span>
            </button>
          ))}
          {!readOnly ? (
            <button type="button" onClick={addFile}>
              <FilePlus2 size={10} /> 新建文件
            </button>
          ) : null}
        </aside>
        <main className="skill-code-pane">
          {selected?.kind === 'text' ? (
            <CodeMirrorEditor
              key={selected.path}
              value={selected.content}
              path={selected.path}
              expectedName={skill.name}
              readOnly={readOnly}
              onChange={updateText}
            />
          ) : (
            <div className="page-origin-empty">二进制资源只支持保留和导出，不能在线编辑。</div>
          )}
        </main>
      </div>
      {validation ? (
        <div className="skill-editor-error" role="alert">
          <AlertTriangle size={11} /> {validation}
        </div>
      ) : null}
      {notice ? (
        <div className="page-origin-notice" role="status">
          {notice}
        </div>
      ) : null}
      <footer className="skill-editor-actions">
        {!readOnly && selected?.path !== 'SKILL.md' ? (
          <button type="button" className="danger" onClick={removeFile}>
            <Trash2 size={11} /> 删除文件
          </button>
        ) : null}
        <span />
        <button type="button" onClick={onClose}>
          关闭
        </button>
        {!readOnly ? (
          <button
            type="button"
            disabled={saving || Boolean(validation)}
            onClick={() => void save()}
          >
            <Save size={11} /> {saving ? '保存中…' : '保存 Skill'}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

interface CodeMirrorEditorProps {
  value: string;
  path: string;
  expectedName: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}

function CodeMirrorEditor({
  value,
  path,
  expectedName,
  readOnly,
  onChange,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    let active = true;
    let destroy: () => void = () => {};
    void Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/commands'),
      import('@codemirror/lang-markdown'),
      import('@codemirror/lint'),
    ]).then(([stateModule, viewModule, commandModule, markdownModule, lintModule]) => {
      if (!active || !hostRef.current) return;
      const extensions = [
        viewModule.EditorView.lineWrapping,
        commandModule.history(),
        viewModule.keymap.of([...commandModule.defaultKeymap, ...commandModule.historyKeymap]),
        viewModule.EditorView.editable.of(!readOnly),
        stateModule.EditorState.readOnly.of(readOnly),
        viewModule.EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString());
        }),
      ];
      if (path.endsWith('.md')) extensions.push(markdownModule.markdown());
      if (path === 'SKILL.md') {
        extensions.push(
          lintModule.linter((view) => {
            const error = parseError(view.state.doc.toString(), expectedName);
            if (!error) return [];
            const lineNumber = Math.min(Math.max(error.line, 1), view.state.doc.lines);
            const line = view.state.doc.line(lineNumber);
            const from = Math.min(line.to, line.from + Math.max(error.column - 1, 0));
            return [
              {
                from,
                to: Math.min(line.to, from + 1),
                severity: 'error',
                message: error.message,
              },
            ];
          }),
        );
      }
      const editor = new viewModule.EditorView({
        parent: hostRef.current,
        state: stateModule.EditorState.create({ doc: value, extensions }),
      });
      destroy = () => editor.destroy();
    });
    return () => {
      active = false;
      destroy();
    };
  }, [expectedName, path, readOnly, value]);

  return <div className="skill-codemirror" ref={hostRef} />;
}

function parseError(markdown: string, expectedName: string): SkillParseError | null {
  try {
    parseSkillMarkdown(markdown, { expectedName, version: '1.0.0' });
    return null;
  } catch (error) {
    return error instanceof SkillParseError ? error : new SkillParseError('SKILL.md 校验失败。');
  }
}

function validateSkillFile(files: SkillPackageFile[], expectedName: string): string {
  const skill = files.find(({ path }) => path === 'SKILL.md');
  if (skill?.kind !== 'text') return '缺少 SKILL.md。';
  const error = parseError(skill.content, expectedName);
  return error ? `第 ${error.line} 行，第 ${error.column} 列：${error.message}` : '';
}

function isEditablePath(path: string): boolean {
  return (
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..') &&
    /^(?:references|scripts|assets)\/[a-zA-Z0-9._/-]+$/u.test(path)
  );
}
