#!/usr/bin/env bash
# =============================================================================
#  Aplica db/migraciones/*.sql, en orden, a una base que YA existe (la del despliegue al
#  desplegar una versión nueva, o la local). Una base nueva sale de db/reset.sh,
#  que ya trae todo en esquema_notificaciones.sql.
#
#  Uso:  ./db/migrar.sh
#
#  Conexión: DATABASE_URL (del entorno o de ../.env). Con psql en el PATH se conecta
#  directo; si no, usa el psql del contenedor local (CONTENEDOR, quinde_notifier_db).
#  La contraseña no aparece en los argumentos de ningún proceso (va en PGPASSWORD).
#  No borra datos: cada migración agrega columnas y restricciones o rehace índices, y
#  es idempotente, así que no pide confirmación.
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENEDOR="${CONTENEDOR:-quinde_notifier_db}"

leer_de_env() {
    local valor
    valor="$(grep -E "^$1=" "$DIR/../.env" 2>/dev/null | tail -n 1 | cut -d= -f2-)" || true
    valor="${valor%\"}"; valor="${valor#\"}"; valor="${valor%\'}"; valor="${valor#\'}"
    printf '%s' "$valor"
}

URL_BASE="${DATABASE_URL:-$(leer_de_env DATABASE_URL)}"
if [[ -z "$URL_BASE" ]]; then
    echo "Falta DATABASE_URL (en el entorno o en .env)." >&2
    exit 1
fi

# psql no conoce ?schema= (es de Prisma): se quita. La contraseña sale de la URL a PGPASSWORD.
partes="$(URL_ENTRADA="$URL_BASE" node -e '
    const u = new URL(process.env.URL_ENTRADA);
    const clave = decodeURIComponent(u.password);
    u.searchParams.delete("schema"); u.password = "";
    process.stdout.write(clave + "\n" + u.href);
')"
export PGPASSWORD="${partes%%$'\n'*}"
URL_PSQL="${partes#*$'\n'}"

if command -v psql > /dev/null; then
    psql_bd() { psql "$URL_PSQL" -v ON_ERROR_STOP=1 -q "$@"; }
else
    psql_bd() { docker exec -i -e PGPASSWORD "$CONTENEDOR" psql "$URL_PSQL" -v ON_ERROR_STOP=1 -q "$@"; }
fi

for archivo in "$DIR"/migraciones/*.sql; do
    [[ -e "$archivo" ]] || continue
    echo "Migración $(basename "$archivo")..."
    psql_bd < "$archivo"
done
echo "Listo."
