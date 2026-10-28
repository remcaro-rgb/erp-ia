import { register } from "tsx/esm/api";

// The workflow test bundles import the workspace packages (the kernel, the modules) with Node's own ESM loader, which
// cannot load their TypeScript sources (extensionless relative imports). tsx's loader can; register it in each test
// worker before the first workflow runs. Test-only: the app's bundler compiles these packages itself.
register();
