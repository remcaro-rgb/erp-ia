#!/usr/bin/env bash
# Uploads the current dev environment to the shared cloud copy (decisions of 2026-11-04):
#   code and schema with the demo seed; the hosted database is WIPED; the app goes to the Vercel production alias.
# Usage: scripts/share/upload-dev.sh [--skip-checks] [--yes]
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKIP=0; YES=0
for a in "$@"; do case "$a" in --skip-checks) SKIP=1;; --yes) YES=1;; esac; done

ENVFILE=apps/web/.env.hosted.local
[ -f "$ENVFILE" ] || { echo "Falta $ENVFILE (URL, llaves y contraseña del proyecto Supabase alojado)."; exit 1; }
for t in pnpm supabase vercel; do command -v "$t" >/dev/null || { echo "Falta la herramienta: $t"; exit 1; }; done
vercel whoami >/dev/null 2>&1 || { echo "Vercel no tiene sesión: ejecute 'vercel login'."; exit 1; }

DBHOST=$(grep -E '^DATABASE_URL=' "$ENVFILE" | sed -E 's#.*@([^:/]+).*#\1#' | tr -d '"' || true)
case "$DBHOST" in ""|localhost|127.0.0.1) echo "DATABASE_URL de $ENVFILE no apunta a un proyecto alojado."; exit 1;; esac

echo "Rama: $(git branch --show-current) · commit $(git rev-parse --short HEAD)"
git diff --quiet && git diff --cached --quiet || echo "Aviso: hay cambios sin commit; se suben tal cual están en el disco."
echo "Se BORRARÁ la base alojada ($DBHOST) y se publicará en producción (proyecto erpia)."
if [ "$YES" != 1 ]; then read -r -p "Escriba SI para continuar: " ok; [ "$ok" = "SI" ] || { echo "Cancelado."; exit 1; }; fi

if [ "$SKIP" != 1 ]; then
  echo "== Verificaciones =="; pnpm lint && pnpm typecheck && pnpm check:rules
fi
echo "== Base alojada: reset + semilla demo =="
pnpm hosted pnpm db:reset
DEMO_SEED=1 DEMO_SEED_REMOTE=1 pnpm hosted pnpm db:seed
echo "== Vercel: producción =="
vercel deploy --prod --yes 2>&1 | tee /tmp/erpia-deploy.log
URL=$(grep -Eo "https://[a-z0-9.-]+\.vercel\.app" /tmp/erpia-deploy.log | tail -1)
echo "Desplegado: $URL"
echo "== Humo =="
code=$(vercel curl /login --deployment "$URL" -- -s -o /dev/null -w "%{http_code}" 2>/dev/null | tail -1)
[ "$code" = "200" ] && echo "OK: /login responde 200" || { echo "Falló el humo: /login respondió $code"; exit 1; }
echo "Listo. Recuerde: el hook de token (Authentication › Hooks) se activa una sola vez en el panel de Supabase."
