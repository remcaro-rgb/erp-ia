import { ForbiddenInShell } from "../_components/forbidden-view";

// The forbidden screen (entity types spec 2026-11-02 §9.2, Task 10): what the proxy answers, at the same address and with status 403,
// for a screen whose menu item the company's rules hide for the caller. Spanish copy inside the shell.
export default function ForbiddenPage() {
  return <ForbiddenInShell />;
}
