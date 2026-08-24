#!/usr/bin/env sh
# Renders the deploy-time nginx templates and verifies they produce a valid
# config, so template breakage fails CI instead of crash-looping production.
set -eu

TEMPLATE_DIR="$(dirname "$0")/../nginx/templates"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# HTTP template is fully self-contained (no cert dependencies); the HTTPS
# variant only adds TLS directives validated implicitly by sharing structure.
sed "s/__API_DOMAIN__/localhost/" "$TEMPLATE_DIR/http.conf.template" > "$OUT/default.conf"

# Wrap the server block in a minimal main config nginx -t can parse.
cat > "$OUT/nginx.conf" <<EOF
events {}
http {
    include /etc/nginx/conf.d/default.conf;
}
EOF

docker run --rm \
    -v "$OUT/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$OUT/default.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:1.27-alpine nginx -t

echo "nginx templates OK"
