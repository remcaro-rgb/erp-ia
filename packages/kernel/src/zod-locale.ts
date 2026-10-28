import { z } from "zod";

// Rule 24: what a validation reports reaches the user in Spanish. Zod's locale is process-wide, so it is set once,
// when the kernel is first loaded; every schema of every module then reports in Spanish.
z.config(z.locales.es());
