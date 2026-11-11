#!/usr/bin/env bash
# Updates the shared cloud copy WITHOUT touching its data: applies only the migrations the hosted database has not run
# (forward-only, never a reset, never the seed) and deploys the app to the Vercel production alias. The app re-syncs
# the module registry itself when it boots (apps/web/src/lib/server/runtime.ts).
# Usage: scripts/share/update-site.sh [--skip-checks] [--yes]
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKIP=0; YES=0
for a in "$@"; do case "$a" in --skip-checks) SKIP=1;; --yes) YES=1;; esac; done

ENVFILE=apps/web/.env.hosted.local
[ -f "$ENVFILE" ] || { echo "Falta $ENVFILE (URL, llaves y contraseña del proyecto Supabase alojado)."; exit 1; }
for t in pnpm supabase vercel; do command -v "$t" >/dev/null || { echo "Falta la herramienta: $t"; exit 1; }; done
vercel whoami >/dev/null 2>&1 || { echo "Vercel no tiene sesión: ejecute 'vercel login'."; exit 1; }

DBURL=$(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"')
DBHOST=$(echo "$DBURL" | sed -E 's#.*@([^:/]+).*#\1#')
case "$DBHOST" in ""|localhost|127.0.0.1) echo "DATABASE_URL de $ENVFILE no apunta a un proyecto alojado."; exit 1;; esac

echo "Rama: $(git branch --show-current) · commit $(git rev-parse --short HEAD)"
git diff --quiet && git diff --cached --quiet || echo "Aviso: hay cambios sin commit; se suben tal cual están en el disco."

if [ "$SKIP" != 1 ]; then
  echo "== Verificaciones =="; pnpm lint && pnpm typecheck && pnpm check:rules
fi

echo "== Migraciones pendientes en la base alojada (sin borrar datos) =="
supabase db push --db-url "$DBURL" --dry-run
if [ "$YES" != 1 ]; then read -r -p "¿Aplicar esas migraciones y desplegar? Escriba SI: " ok; [ "$ok" = "SI" ] || { echo "Cancelado."; exit 1; }; fi
supabase db push --db-url "$DBURL" --yes

echo "== Vercel: producción =="
vercel deploy --prod --yes 2>&1 | tee /tmp/erpia-deploy.log
URL=$(grep -Eo "https://[a-z0-9.-]+\.vercel\.app" /tmp/erpia-deploy.log | tail -1)
echo "Desplegado: $URL"
echo "== Humo =="
code=$(vercel curl /login --deployment "$URL" -- -s -o /dev/null -w "%{http_code}" 2>/dev/null | tail -1)
[ "$code" = "200" ] && echo "OK: /login responde 200" || { echo "Falló el humo: /login respondió $code"; exit 1; }
echo "Listo. Los datos de la base alojada no se tocaron."
