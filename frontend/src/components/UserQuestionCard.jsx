import { memo, useState } from 'react';
import { useChatStore } from '../store/chatStore';

// ── 问题类型元数据 ──────────────────────────────────────────
const TYPE_META = {
  single_choice: { icon: '☝️', label: '请选择' },
  multi_choice: { icon: '☑️', label: '请选择（可多选）' },
  text_input: { icon: '✏️', label: '请补充信息' },
};

function UserQuestionCard({ questionLog }) {
  const submitUserAnswer = useChatStore((state) => state.submitUserAnswer);
  const isTyping = useChatStore((state) => state.isTyping);

  const {
    questionId,
    question,
    questionType,
    options,
    isSubmitted,
    submittedAnswer,
  } = questionLog;

  const meta = TYPE_META[questionType] || TYPE_META.text_input;

  // 多选状态
  const [selectedOptions, setSelectedOptions] = useState(() => new Set());
  // 文本输入状态
  const [textValue, setTextValue] = useState('');

  // ── 已提交态 ──────────────────────────────────────────
  if (isSubmitted) {
    const displayAnswer = questionType === 'multi_choice'
      ? (Array.isArray(submittedAnswer) ? submittedAnswer.join('、') : String(submittedAnswer || ''))
      : String(submittedAnswer ?? '');

    return (
      <div className="animate-tool-fade-in border-l-4 border-l-emerald-500 bg-[var(--status-success-soft)] rounded-r-md px-3 py-2.5 my-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[var(--status-success)]">{meta.icon}</span>
          <span className="text-[var(--status-success)] font-medium">{question}</span>
          <span className="status-badge-success ml-auto">
            已提交
          </span>
        </div>
        {displayAnswer && (
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            回答: {displayAnswer}
          </p>
        )}
      </div>
    );
  }

  // ── 待回答态 ──────────────────────────────────────────

  const handleSubmitSingle = (option) => {
    if (isSubmitted || !isTyping) return;
    submitUserAnswer(questionId, option);
  };

  const handleToggleMulti = (option) => {
    if (isSubmitted || !isTyping) return;
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(option)) {
        next.delete(option);
      } else {
        next.add(option);
      }
      return next;
    });
  };

  const handleSubmitMulti = () => {
    if (isSubmitted || !isTyping || selectedOptions.size === 0) return;
    submitUserAnswer(questionId, Array.from(selectedOptions));
  };

  const handleSubmitText = () => {
    const trimmed = textValue.trim();
    if (isSubmitted || !isTyping || !trimmed) return;
    submitUserAnswer(questionId, trimmed);
  };

  // ── 渲染不同问题类型 ─────────────────────────────────

  const renderContent = () => {
    switch (questionType) {
      case 'single_choice':
        return (
          <div className="mt-2 space-y-1">
            {options.map((option, idx) => (
              <button
                key={`${questionId}-opt-${idx}`}
                type="button"
                onClick={() => handleSubmitSingle(option)}
                disabled={!isTyping}
                className="ui-button-secondary block w-full text-left px-3 py-1.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {option}
              </button>
            ))}
          </div>
        );

      case 'multi_choice':
        return (
          <div className="mt-2 space-y-1">
            {options.map((option, idx) => (
              <label
                key={`${questionId}-opt-${idx}`}
                className="flex items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-1.5 text-xs text-[var(--text-main)] hover:bg-[var(--panel-soft)] transition cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedOptions.has(option)}
                  onChange={() => handleToggleMulti(option)}
                  disabled={!isTyping}
                  className="rounded accent-[var(--brand-start)]"
                />
                {option}
              </label>
            ))}
            <button
              type="button"
              onClick={handleSubmitMulti}
              disabled={!isTyping || selectedOptions.size === 0}
              className="ui-button-primary mt-2 px-4 py-1.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              提交 ({selectedOptions.size} 项)
            </button>
          </div>
        );

      case 'text_input':
        return (
          <div className="mt-2 space-y-2">
            <input
              type="text"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmitText();
              }}
              disabled={!isTyping}
              placeholder="输入你的回答..."
              className="ui-input w-full px-3 py-1.5 text-xs transition disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSubmitText}
              disabled={!isTyping || !textValue.trim()}
              className="ui-button-primary px-4 py-1.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              提交
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="animate-tool-fade-in border-l-4 border-l-amber-500 bg-[var(--status-warning-soft)] rounded-r-md px-3 py-2.5 my-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--status-warning)]">{meta.icon}</span>
        <span className="text-[var(--status-warning)] font-medium">{question}</span>
        <span className="status-badge-warning ml-auto">
          {meta.label}
        </span>
      </div>
      {renderContent()}
    </div>
  );
}

export default memo(
  UserQuestionCard,
  (prevProps, nextProps) =>
    prevProps.questionLog.questionId === nextProps.questionLog.questionId &&
    prevProps.questionLog.isSubmitted === nextProps.questionLog.isSubmitted &&
    prevProps.questionLog.submittedAnswer === nextProps.questionLog.submittedAnswer &&
    prevProps.questionLog.status === nextProps.questionLog.status
);
