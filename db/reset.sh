#!/usr/bin/env bash
# =============================================================================
#  Reinicia el esquema "notificaciones": lo borra con todo lo que tiene y lo
#  vuelve a crear. NUNCA borra la base: puede ser la misma de otro servicio,
#  con su esquema al lado.
#
#  Uso:  ./db/reset.sh
#
#  Conexión: DATABASE_URL (del entorno o de ../.env). Con psql en el PATH se
#  conecta directo; si no, usa el psql del contenedor de docker-compose.yml.
#  La contraseña no aparece en los argumentos de ningún proceso (va en PGPASSWORD).
#
#  Contra un host que no es local exige CONFIRMAR_RESET=si: borra suscripciones
#  reales (y con ellas los secretos de los terceros, que no se pueden recuperar).
# =============================================================================
set -euo pipefail

CONTENEDOR="${CONTENEDOR:-quinde_notifier_db}"
ESQUEMA_ESPERADO="notificaciones"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Valor de una variable en ../.env (sin comillas), para no pedir exportarla a mano.
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

# Una parte de la URL, leída con Node (la URL va por el entorno, no como argumento).
parte_url() {
    URL_ENTRADA="$URL_BASE" node -e '
        const u = new URL(process.env.URL_ENTRADA);
        const partes = {
            esquema: u.searchParams.get("schema") ?? "notificaciones",
            host: u.hostname.replace(/^\[|\]$/g, ""),
            usuario: decodeURIComponent(u.username),
            contrasena: decodeURIComponent(u.password),
            base: decodeURIComponent(u.pathname.replace(/^\//, "")),
            // psql no conoce ?schema=: se quita; sslmode y los demás se conservan
            url_psql: (() => { u.searchParams.delete("schema"); u.password = ""; return u.href; })(),
        };
        process.stdout.write(partes[process.argv[1]]);
    ' "$1"
}

ESQUEMA="$(parte_url esquema)"
HOST="$(parte_url host)"
if [[ "$ESQUEMA" != "$ESQUEMA_ESPERADO" ]]; then
    echo "DATABASE_URL apunta al esquema \"$ESQUEMA\"; el .sql crea \"$ESQUEMA_ESPERADO\"." >&2
    exit 1
fi
case "$HOST" in
    localhost|127.0.0.1|::1|postgres) ;;
    *)
        if [[ "${CONFIRMAR_RESET:-}" != "si" ]]; then
            echo "DATABASE_URL apunta a $HOST, que no es local: esto borra el esquema $ESQUEMA_ESPERADO" >&2
            echo "con todas sus suscripciones. Si es lo que quieres, repite con CONFIRMAR_RESET=si." >&2
            exit 1
        fi
        ;;
esac

PGPASSWORD="$(parte_url contrasena)"
export PGPASSWORD
if command -v psql >/dev/null 2>&1; then
    URL_PSQL="$(parte_url url_psql)"
    psql_n() { psql "$URL_PSQL" -v ON_ERROR_STOP=1 -q "$@"; }
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTENEDOR"; then
    USUARIO_BD="$(parte_url usuario)"
    BASE="$(parte_url base)"
    psql_n() { docker exec -i -e PGPASSWORD "$CONTENEDOR" psql -U "$USUARIO_BD" -d "$BASE" -v ON_ERROR_STOP=1 -q "$@"; }
else
    echo "No hay psql en el PATH ni está corriendo el contenedor $CONTENEDOR (docker compose up -d)." >&2
    exit 1
fi

printf 'Esperando a PostgreSQL'
for _ in $(seq 1 30); do
    if psql_n -c 'SELECT 1' >/dev/null 2>&1; then break; fi
    printf '.'; sleep 1
done
echo
psql_n -c 'SELECT 1' >/dev/null || { echo "PostgreSQL no responde." >&2; exit 1; }

# --- 1. borrar y crear el esquema (solo el esquema) ---------------------------
echo "Borrando el esquema $ESQUEMA_ESPERADO..."
psql_n -c "DROP SCHEMA IF EXISTS $ESQUEMA_ESPERADO CASCADE"

echo "Cargando esquema_notificaciones.sql..."
psql_n < "$DIR/esquema_notificaciones.sql"

# --- 2. verificación ----------------------------------------------------------
echo
echo "--- Tablas del esquema $ESQUEMA_ESPERADO ---"
psql_n -c "
SELECT table_name AS tabla
FROM information_schema.tables
WHERE table_schema = '$ESQUEMA_ESPERADO' AND table_type = 'BASE TABLE'
ORDER BY table_name;"
echo "Listo."
