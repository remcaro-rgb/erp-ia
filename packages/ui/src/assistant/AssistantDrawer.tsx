"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { useAssistant } from "./use-assistant";
import type { ResultColumn, ScreenContext } from "./model";
import type { GridStateInput } from "../grid/types";

export interface AssistantDrawerProps {
  open: boolean;
  /** No saved choice yet: CSS shows or hides the drawer by the viewport width until the shell resolves it. */
  auto?: boolean;
  /** Bumped by the shell's Ctrl+/ (⌘/): the input takes the caret as soon as it can. */
  focusInput?: number;
  /** The "Cerrar" control and Escape: the shell hides the drawer and returns the focus to its toggle. */
  onClose?: () => void;
  /** What the assistant is looking at: the active tab's title. */
  context: string;
  /** The route and selected record sent with every turn. */
  screen: ScreenContext;
  /** Conversation to restore; the user's latest one when absent. */
  conversationId?: string | null;
  /** A question handed in by the shell (⌘K): sent once per `nonce`. */
  ask?: { text: string; nonce: number };
  /** Opens a route of the app in the shell (links, `ui.navigate`, `ui.open_record`). */
  onNavigate?: (href: string) => void;
  /** Opens the entity's grid with a query's state, when the entity has a grid screen. */
  onOpenGrid?: (entity: string, state: GridStateInput) => void;
  canOpenGrid?: (entity: string) => boolean;
  /** Labels and types of an entity's fields, for the result tables. */
  columnsOf?: (entity: string) => ResultColumn[] | undefined;
  /** The company's time zone, for dates in result tables. */
  timeZone?: string;
  /** `fetch`, injected by tests. */
  fetcher?: typeof fetch;
}

/**
 * The assistant's right drawer, 400 px (design §19a, prototype v5): the conversation with the AI SDK stream, the
 * confirmation and step-up cards, the result tables and the input. It stays mounted while closed, so a running turn and
 * the conversation survive hiding it.
 */
export function AssistantDrawer({ open, auto, focusInput, onClose, context, screen, conversationId, ask, onNavigate, onOpenGrid, canOpenGrid, columnsOf, timeZone, fetcher }: AssistantDrawerProps) {
  const t = useTranslations("nav.shell");
  const tAgent = useTranslations("agent.ui");
  const tErrors = useTranslations();
  const navigate = (href: string) => onNavigate?.(href);
  const assistant = useAssistant({
    screen,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(onNavigate ? { onNavigate } : {}),
    ...(fetcher ? { fetcher } : {}),
  });

  // A question from the shell: sent once, as soon as the stored conversation is in.
  const sentNonce = useRef<number | null>(null);
  const { ready, send } = assistant;
  useEffect(() => {
    if (!ask || !ready || sentNonce.current === ask.nonce) return;
    sentNonce.current = ask.nonce;
    void send(ask.text);
  }, [ask, ready, send]);

  // Under 768 px the drawer is a full-screen sheet: its height follows the visual viewport, so the on-screen keyboard never covers the composer.
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    const node = sheet.current;
    if (!open || !viewport || !node) return;
    const fit = () => {
      if (window.innerWidth < 768) node.style.height = `${viewport.height}px`;
      else node.style.removeProperty("height");
    };
    fit();
    viewport.addEventListener("resize", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      node.style.removeProperty("height");
    };
  }, [open]);

  // As a sheet (under 768 px) it is modal: the page behind is inert, so focus and the reader stay inside it.
  const [asSheet, setAsSheet] = useState(false);
  useEffect(() => {
    if (!open) return setAsSheet(false);
    const narrow = window.matchMedia?.("(max-width: 767px)");
    const apply = () => setAsSheet(narrow ? narrow.matches : false);
    apply();
    narrow?.addEventListener?.("change", apply);
    return () => narrow?.removeEventListener?.("change", apply);
  }, [open]);
  useEffect(() => {
    if (!asSheet) return;
    const behind = [...document.querySelectorAll<HTMLElement>("[data-bar], [data-tabs-row], #erp-main")];
    behind.forEach((el) => el.setAttribute("inert", ""));
    return () => {
      behind.forEach((el) => el.removeAttribute("inert"));
      // Released: the toggle that opened the sheet takes the focus back.
      document.getElementById("erp-assistant-toggle")?.focus({ preventScroll: true });
    };
  }, [asSheet]);

  const empty = assistant.messages.length === 0;
  const errorText = assistant.errorKey && tErrors.has(assistant.errorKey) ? tErrors(assistant.errorKey) : assistant.errorKey ? tErrors("errors.unknown") : null;

  return (
    <aside
      ref={sheet}
      id="erp-assistant"
      aria-label={t("assistant")}
      hidden={!open}
      {...(asSheet ? { role: "dialog", "aria-modal": true } : {})}
      {...(auto ? { "data-assistant": "auto" } : {})}
      onKeyDown={(event) => {
        // Escape hides the drawer unless something above it (a dialog, a menu) already took the key.
        if (event.key === "Escape" && !event.defaultPrevented && onClose) {
          event.stopPropagation();
          onClose();
        }
      }}
      className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-2 px-4 py-3">
        <div className="flex items-center gap-2 font-bold">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-primary" />
          {t("assistant")}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-xs text-text-muted">{t("drawer.context", { context })}</div>
          {!empty && (
            <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" onClick={assistant.newConversation}>
              {tAgent("new_conversation")}
            </button>
          )}
          {onClose && (
            <button type="button" className="erp-btn erp-btn--sm max-md:min-h-11 [@media(pointer:coarse)]:min-h-11" aria-label={t("drawer.close")} onClick={onClose}>
              {t("drawer.close_short")}
            </button>
          )}
        </div>
      </div>
      {!assistant.ready ? (
        <div className="erp-chat__log erp-small erp-muted">{tAgent("loading")}</div>
      ) : empty ? (
        <div className="erp-chat__log">
          <div className="erp-msg erp-msg--assistant">{t("drawer.placeholder")}</div>
        </div>
      ) : (
        <MessageList
          messages={assistant.messages}
          cards={assistant.cards}
          onDecide={assistant.decide}
          onEdit={assistant.editCard}
          onNavigate={navigate}
          working={assistant.working}
          {...(onOpenGrid ? { onOpenGrid } : {})}
          {...(canOpenGrid ? { canOpenGrid } : {})}
          {...(columnsOf ? { columnsOf } : {})}
          {...(timeZone ? { timeZone } : {})}
          {...(fetcher ? { fetcher } : {})}
        />
      )}
      {errorText && (
        <div role="alert" className="erp-chat__error">
          {errorText}
        </div>
      )}
      <Composer onSend={(text) => void assistant.send(text)} working={assistant.working} onStop={() => void assistant.stop()} disabled={!assistant.ready} {...(focusInput ? { focusNonce: focusInput } : {})} />
    </aside>
  );
}
