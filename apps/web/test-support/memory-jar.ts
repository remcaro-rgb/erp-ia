import type { CookieJar, CookieOptions } from "../src/lib/supabase/cookies";

export interface RecordedCookie {
  value: string;
  options: CookieOptions;
}

/**
 * An in-memory cookie store standing in for the browser and for `next/headers`' `cookies()`: it keeps
 * what the app wrote (with the options, so a test can see the Max-Age) and hands it back on the next read.
 */
export class MemoryJar implements CookieJar {
  readonly written = new Map<string, RecordedCookie>();
  private readonly store = new Map<string, string>();

  getAll() {
    return [...this.store].map(([name, value]) => ({ name, value }));
  }

  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options: CookieOptions = {}) {
    this.written.set(name, { value, options });
    // maxAge 0 is a removal, as in a browser.
    if (value === "" || options.maxAge === 0) this.store.delete(name);
    else this.store.set(name, value);
  }

  delete(name: string) {
    this.set(name, "", { maxAge: 0 });
  }
}
