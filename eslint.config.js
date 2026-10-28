import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

// Rule 6 (docs/project-rules.md): portable by construction, no Vercel-only runtime APIs in business code.
const vercelOnlyPackages = ["@vercel/blob", "@vercel/kv", "@vercel/edge-config"];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/.turbo/**", "**/coverage/**", "**/next-env.d.ts", "supabase/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Next.js rules apply to the web app only.
  ...nextVitals.map((config) => ({ ...config, files: ["apps/web/**/*.{js,jsx,ts,tsx}"] })),
  // App Router only: there is no pages/ directory for this rule to check.
  { files: ["apps/web/**"], rules: { "@next/next/no-html-link-for-pages": "off" } },
  {
    files: ["apps/**/*.{js,jsx,ts,tsx}", "packages/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: vercelOnlyPackages.map((name) => ({
            name,
            message: "Vercel-only storage APIs are banned (rule 6); use the @erp/infra interfaces.",
          })),
          patterns: vercelOnlyPackages.map((name) => ({
            group: [`${name}/*`],
            message: "Vercel-only storage APIs are banned (rule 6); use the @erp/infra interfaces.",
          })),
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name='runtime'][init.value='edge']",
          message: "The Edge runtime is banned (rule 6); business code must run on Node.js.",
        },
      ],
    },
  },
);
