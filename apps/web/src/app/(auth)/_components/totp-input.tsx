"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

const LENGTH = 6;

/**
 * Six boxes for a TOTP code (prototype): typing moves on, backspace moves back, a pasted or auto-filled code is
 * spread over the boxes from the one it landed in, and the sixth digit calls `onComplete`. The code is also
 * posted by the form as the hidden field `code`. Remount it (change `key`) to clear it after a failed try.
 */
export function TotpInput({ onComplete }: { onComplete: (code: string) => void }) {
  const t = useTranslations("auth");
  const [digits, setDigits] = useState<string[]>(() => Array<string>(LENGTH).fill(""));
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const submitted = useRef(false);

  useEffect(() => {
    if (digits.every(Boolean) && !submitted.current) {
      submitted.current = true;
      onComplete(digits.join(""));
    }
  }, [digits, onComplete]);

  function fill(index: number, raw: string) {
    const typed = raw.replace(/\D/g, "").slice(0, LENGTH - index);
    if (typed === "") return;
    setDigits((current) => {
      const next = [...current];
      [...typed].forEach((digit, offset) => (next[index + offset] = digit));
      return next;
    });
    boxes.current[Math.min(index + typed.length, LENGTH - 1)]?.focus();
  }

  return (
    <div className="flex justify-between gap-2">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element;
          }}
          value={digit}
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          autoFocus={index === 0}
          aria-label={t("verify.digit", { n: index + 1 })}
          className="h-[52px] w-12 rounded-md border border-slate-300 bg-white text-center font-mono text-[22px] text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-300 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          onFocus={(event) => event.target.select()}
          onChange={(event) => {
            const value = event.target.value;
            // Clearing a box (select + delete) empties it; typing or auto-fill spreads digits from here.
            if (value === "") setDigits((current) => current.map((d, i) => (i === index ? "" : d)));
            else fill(index, value);
          }}
          onPaste={(event) => {
            event.preventDefault();
            fill(index, event.clipboardData.getData("text"));
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && digit === "" && index > 0) boxes.current[index - 1]?.focus();
          }}
        />
      ))}
      <input type="hidden" name="code" value={digits.join("")} />
    </div>
  );
}
