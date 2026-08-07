#!/bin/sh
set -eu

CERT_DIR=/var/lib/postgresql/tls
mkdir -p "$CERT_DIR"

if [ ! -s "$CERT_DIR/server.crt" ] || [ ! -s "$CERT_DIR/server.key" ]; then
  openssl req -new -x509 -nodes -days 1 \
    -subj /CN=mcp-gw-test-ca \
    -out "$CERT_DIR/ca.crt" \
    -keyout "$CERT_DIR/ca.key" >/dev/null 2>&1
  openssl req -new -nodes \
    -subj /CN=token-store \
    -addext subjectAltName=DNS:token-store \
    -out "$CERT_DIR/server.csr" \
    -keyout "$CERT_DIR/server.key" >/dev/null 2>&1
  printf '%s\n' 'subjectAltName=DNS:token-store' >"$CERT_DIR/server.ext"
  openssl x509 -req -days 1 \
    -in "$CERT_DIR/server.csr" \
    -CA "$CERT_DIR/ca.crt" \
    -CAkey "$CERT_DIR/ca.key" \
    -CAcreateserial \
    -extfile "$CERT_DIR/server.ext" \
    -out "$CERT_DIR/server.crt" >/dev/null 2>&1
  chown postgres:postgres "$CERT_DIR/server.crt" "$CERT_DIR/server.key"
  chmod 0644 "$CERT_DIR/ca.crt"
  chmod 0600 "$CERT_DIR/server.key"
fi

exec docker-entrypoint.sh "$@" \
  -c ssl=on \
  -c ssl_cert_file="$CERT_DIR/server.crt" \
  -c ssl_key_file="$CERT_DIR/server.key"
