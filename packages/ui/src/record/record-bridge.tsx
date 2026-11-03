"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// The link between a record's Datos form and the frame's action bar (Task 15): the form tells whether it holds unsaved edits and
// whether they can be saved, and hands over its save; the bar's Guardar runs it (then the lifecycle step), and the form's own save
// button steps aside. Outside a bridge (records without the lifecycle) the forms keep their own buttons.

export interface RecordFormState {
  dirty: boolean;
  /** The form's data can be saved now (no client errors, nothing missing). */
  ready: boolean;
}

export interface RecordBridge {
  state: RecordFormState;
  /** Runs the form's save; true when the record was saved. Absent until a form registered. */
  save: () => Promise<boolean>;
  /** The form registered (the Datos tab shows a form). */
  registered: boolean;
  /** Called by the form on ⌘S / Ctrl+S: the bar runs its Guardar. */
  shortcut: () => void;
  /** @internal */
  publish: (state: RecordFormState, save: () => Promise<boolean>) => void;
  /** @internal */
  withdraw: () => void;
}

const BridgeContext = createContext<RecordBridge | null>(null);

/** The bridge of the frame around this form, or null. */
export const useRecordBridge = () => useContext(BridgeContext);

/** Provides the bridge; `onShortcut` is what ⌘S does in the form (the bar's Guardar). */
export function RecordBridgeProvider({ children, onShortcut }: { children: (bridge: RecordBridge) => ReactNode; onShortcut?: () => void }) {
  const [state, setState] = useState<RecordFormState>({ dirty: false, ready: false });
  const [registered, setRegistered] = useState(false);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const shortcutRef = useRef(onShortcut);
  shortcutRef.current = onShortcut;
  // Stable for the provider's life: a form's effects depend on them, and a new identity would withdraw and publish again in a loop.
  const [stable] = useState(() => ({
    save: () => saveRef.current(),
    shortcut: () => shortcutRef.current?.(),
    publish: (next: RecordFormState, save: () => Promise<boolean>) => {
      saveRef.current = save;
      setRegistered(true);
      setState((prev) => (prev.dirty === next.dirty && prev.ready === next.ready ? prev : next));
    },
    withdraw: () => {
      setRegistered(false);
      saveRef.current = async () => false;
    },
  }));
  const bridge = useMemo<RecordBridge>(() => ({ ...stable, state, registered }), [stable, state, registered]);
  return <BridgeContext.Provider value={bridge}>{children(bridge)}</BridgeContext.Provider>;
}

/** Registers a form with the bridge (no-op without one). */
export function useRegisterRecordForm(dirty: boolean, ready: boolean, save: (() => Promise<boolean>) | undefined): RecordBridge | null {
  const bridge = useRecordBridge();
  const latest = useRef(save);
  latest.current = save;
  const publish = bridge?.publish;
  const withdraw = bridge?.withdraw;
  useEffect(() => {
    publish?.({ dirty, ready }, async () => (latest.current ? latest.current() : false));
  }, [publish, dirty, ready]);
  useEffect(() => () => withdraw?.(), [withdraw]);
  return bridge;
}
