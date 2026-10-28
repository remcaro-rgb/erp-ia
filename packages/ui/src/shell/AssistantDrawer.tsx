"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

export interface AssistantDrawerProps {
  open: boolean;
  /** What the assistant is looking at: the active tab's title. */
  context: string;
  /** Questions sent from ⌘K or the input, newest last (shown until the real assistant, Task 17, answers them). */
  questions: string[];
  onAsk: (text: string) => void;
  /** The real assistant, when the app provides one; replaces the placeholder conversation. */
  children?: ReactNode;
}

/** The assistant's right drawer, 400 px (design §19a). Placeholder conversation until Task 17. */
export function AssistantDrawer({ open, context, questions, onAsk, children }: AssistantDrawerProps) {
  const t = useTranslations("nav.shell");
  const [draft, setDraft] = useState("");
  if (!open) return null;

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onAsk(text);
    setDraft("");
  };

  return (
    <aside aria-label={t("assistant")} className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line-2 px-4 py-3">
        <div className="flex items-center gap-2 font-bold">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-primary" />
          {t("assistant")}
        </div>
        <div className="text-xs text-text-muted">{t("drawer.context", { context })}</div>
      </div>
      {children ?? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 text-sm leading-normal">
            <div className="max-w-[96%] rounded-[10px_10px_10px_2px] bg-head px-3 py-2.5">{t("drawer.placeholder")}</div>
            {questions.map((question, i) => (
              <div key={i} className="max-w-[88%] self-end rounded-[10px_10px_2px_10px] bg-primary px-3 py-2.5 text-white">
                {question}
              </div>
            ))}
          </div>
          <div className="flex gap-2 border-t border-line-2 p-3">
            <label htmlFor="erp-assistant-input" className="sr-only">
              {t("drawer.input_label")}
            </label>
            <input
              id="erp-assistant-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") send();
              }}
              placeholder={t("drawer.input")}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2.5 text-[13px] text-text outline-none focus:outline-2 focus:outline-focus"
            />
            <button
              type="button"
              aria-label={t("drawer.send")}
              onClick={send}
              className="grid w-10 place-items-center rounded-md border border-primary bg-primary text-base font-semibold text-white hover:bg-primary-h"
            >
              ↑
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
