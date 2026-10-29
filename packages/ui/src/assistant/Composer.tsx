"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export interface ComposerProps {
  onSend: (text: string) => void;
  /** The assistant is answering: the button stops it. */
  working?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  /** A change asks for the caret (the shell's Ctrl+/); applied once the input is enabled. */
  focusNonce?: number;
}

/** The input of the drawer (prototype v5 `.a-in`). Enter sends. */
export function Composer({ onSend, working, onStop, disabled, focusNonce }: ComposerProps) {
  const t = useTranslations("nav.shell");
  const tAgent = useTranslations("agent.ui");
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const focused = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusNonce === undefined || focused.current === focusNonce || disabled) return;
    focused.current = focusNonce;
    input.current?.focus();
  }, [focusNonce, disabled]);
  const send = () => {
    const text = draft.trim();
    if (!text || disabled || working) return;
    onSend(text);
    setDraft("");
  };
  return (
    <div className="erp-chat__input">
      <label htmlFor="erp-assistant-input" className="sr-only">
        {t("drawer.input_label")}
      </label>
      <input
        id="erp-assistant-input"
        ref={input}
        value={draft}
        disabled={disabled}
        maxLength={4000}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
        }}
        placeholder={t("drawer.input")}
        className="min-w-0 flex-1 rounded-md border border-line-input bg-surface px-3 py-2.5 text-[13px] text-text outline-none focus:outline-2 focus:outline-focus-ring disabled:opacity-60"
      />
      {working ? (
        <button type="button" aria-label={tAgent("stop")} onClick={onStop} className="grid w-10 place-items-center rounded-md border border-line bg-surface text-base">
          ■
        </button>
      ) : (
        <button
          type="button"
          aria-label={t("drawer.send")}
          disabled={disabled || draft.trim() === ""}
          onClick={send}
          className="grid w-10 place-items-center rounded-md border border-primary bg-primary text-base font-semibold text-white hover:bg-primary-h disabled:opacity-50"
        >
          ↑
        </button>
      )}
    </div>
  );
}
