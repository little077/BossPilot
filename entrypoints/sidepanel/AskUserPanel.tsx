// ─── Ask User 底部暂停面板 ───
// 职责：在消息流之外收集一次关键澄清答案；提交前不修改对话历史，也不触发新的任务。

import { Check, CircleHelp, Loader2, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { PendingUserQuestion } from '@/lib/domain/types';

interface AskUserPanelProps {
  question: PendingUserQuestion;
  onContinue: (answer: string) => Promise<boolean>;
  onCancel: () => void;
}

export function AskUserPanel({ question, onContinue, onCancel }: AskUserPanelProps) {
  const customInputId = useId();
  const [selectedId, setSelectedId] = useState('');
  const [customAnswer, setCustomAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selectedOption = question.options.find(({ id }) => id === selectedId);
  const answer = customAnswer.trim() || selectedOption?.label || '';

  const selectOption = (id: string) => {
    setSelectedId(id);
    setCustomAnswer('');
    setError('');
  };

  const submit = async () => {
    if (!answer || submitting) return;
    setSubmitting(true);
    setError('');
    const sent = await onContinue(answer);
    if (!sent) {
      setSubmitting(false);
      setError('连接暂不可用，请稍后再试。');
    }
  };

  return (
    <section className="ask-user-panel" aria-labelledby={`${customInputId}-question`}>
      <div className="ask-user-head">
        <span className="ask-user-icon" aria-hidden>
          <CircleHelp size={13} />
        </span>
        <span className="ask-user-kicker">需要你确认一件事</span>
        <span className="ask-user-paused">Agent 已暂停</span>
      </div>

      <p className="ask-user-question" id={`${customInputId}-question`}>
        {question.question}
      </p>
      <p className="ask-user-note">回答后会保留当前进度，从暂停位置继续执行。</p>

      <div className="ask-user-options" role="radiogroup" aria-label="可选回答">
        {question.options.map((option) => {
          const selected = option.id === selectedId && !customAnswer.trim();
          return (
            <label key={option.id} className={`ask-user-option ${selected ? 'is-selected' : ''}`}>
              <input
                className="ask-user-native-radio"
                type="radio"
                name={`${customInputId}-options`}
                value={option.id}
                checked={selected}
                disabled={submitting}
                onChange={() => selectOption(option.id)}
              />
              <span className="ask-user-radio">{selected ? <Check size={9} /> : null}</span>
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>

      {question.allowCustom ? (
        <div className="ask-user-custom">
          <label htmlFor={customInputId}>或者自定义回答</label>
          <input
            id={customInputId}
            type="text"
            value={customAnswer}
            maxLength={2_000}
            disabled={submitting}
            placeholder={question.customPlaceholder ?? '输入你的答案'}
            onChange={(event) => {
              setCustomAnswer(event.target.value);
              if (event.target.value.trim()) setSelectedId('');
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
            }}
          />
        </div>
      ) : null}

      <div className="ask-user-actions">
        <button type="button" className="ask-user-cancel" disabled={submitting} onClick={onCancel}>
          <X size={11} aria-hidden />
          取消任务
        </button>
        <button
          type="button"
          className="ask-user-continue"
          disabled={!answer || submitting}
          onClick={() => void submit()}
        >
          {submitting ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
          继续执行
        </button>
      </div>
      {error ? (
        <p className="ask-user-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
