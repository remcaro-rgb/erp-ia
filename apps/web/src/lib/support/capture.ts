"use client";

import { captured, describeError, emptyCapture, withError, withRoute, withSelection, type CapturedContext } from "./capture-model";

// The browser side of the ticket context (design §8). The shell installs it once; it remembers the route the user
// was on, what they had selected and the console errors, so the "Nuevo ticket" form, opened on the support screen,
// can attach the screen the problem is about.

let state = emptyCapture();

/** Starts listening (errors, rejections, console.error, selection); returns the function that stops. */
export function installCapture(): () => void {
  const onError = (event: ErrorEvent) => {
    state = withError(state, event.error instanceof Error ? describeError([event.error]) : event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    state = withError(state, describeError([event.reason]));
  };
  const onSelection = () => {
    state = withSelection(state, window.getSelection()?.toString() ?? "", window.location.pathname);
  };
  const original = console.error;
  console.error = (...args: unknown[]) => {
    state = withError(state, describeError(args));
    original.apply(console, args);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("selectionchange", onSelection);
  return () => {
    console.error = original;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("selectionchange", onSelection);
  };
}

/** The shell reports each route it shows. */
export function noteRoute(pathname: string): void {
  state = withRoute(state, pathname);
}

/** The context to attach to a ticket filed now, from the screen at `pathname`. */
export function captureContext(pathname: string): CapturedContext {
  return captured(state, { pathname, selection: window.getSelection()?.toString() ?? "" });
}
