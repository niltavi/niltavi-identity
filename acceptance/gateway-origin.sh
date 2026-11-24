#!/bin/sh
set -eu

host=identity.testenv.niltavi.com
origin=https://identity.testenv.niltavi.com
gateway=http://127.0.0.1:18107
primary=https://40.160.59.116:36100
umask 077
scratch=$(mktemp -d)
cleanup() {
  rm -f "$scratch/headers" "$scratch/cookie.conf"
  rmdir "$scratch"
}
trap cleanup EXIT

request() {
  curl --noproxy '*' --silent --show-error --max-time 12 -H "Host: $host" "$@"
}
primary_request() {
  curl --noproxy '*' --silent --show-error --max-time 12 --connect-to 40.160.59.116:36100:127.0.0.1:36100 "$@"
}

request --fail "$gateway/" | grep -q 'Niltavi Identity'
request --fail "$gateway/.well-known/openid-configuration" | grep -q '"issuer":"https://identity.testenv.niltavi.com"'
primary_request --fail "$primary/.well-known/openid-configuration" |
  grep -q '"issuer":"https://40.160.59.116:36100"'
test "$(request -o /dev/null -w '%{http_code}' "$gateway/account/session")" = 401
test "$(request -o /dev/null -w '%{http_code}' -H "Origin: $primary" -H 'Content-Type: application/json' \
  --data '{"email":"acceptance@niltavi.test","password":"invalid"}' "$gateway/account/login")" = 403

password=$(cat /opt/niltavi-acceptance/credentials/password)
case "$password" in ''|*[!A-Za-z0-9_-]*) exit 1 ;; esac
status=$(printf '{"email":"acceptance@niltavi.test","password":"%s"}' "$password" |
  request -D "$scratch/headers" -o /dev/null -w '%{http_code}' -H "Origin: $origin" -H 'Content-Type: application/json' \
  --data-binary @- "$gateway/account/login")
unset password
test "$status" = 204
cookie=$(tr -d '\r' < "$scratch/headers" | grep -i '^set-cookie: __Host-niltavi-session=')
printf '%s\n' "$cookie" | grep -qi '; Path=/;.*; HttpOnly; Secure; SameSite=Lax'
if printf '%s\n' "$cookie" | grep -qi '; Domain='; then exit 1; fi
printf 'header = "Cookie: %s"\n' "$(printf '%s' "$cookie" | cut -d: -f2- | cut -d';' -f1 | sed 's/^ *//')" > "$scratch/cookie.conf"
unset cookie

test "$(request --config "$scratch/cookie.conf" -o /dev/null -w '%{http_code}' "$gateway/account/session")" = 200
test "$(primary_request --config "$scratch/cookie.conf" -o /dev/null -w '%{http_code}' "$primary/account/session")" = 401
test "$(request --config "$scratch/cookie.conf" -o /dev/null -w '%{http_code}' -H "Origin: $origin" \
  -H 'Content-Type: application/json' --data '{}' "$gateway/account/logout")" = 204
test "$(request --config "$scratch/cookie.conf" -o /dev/null -w '%{http_code}' "$gateway/account/session")" = 401

printf '%s\n' 'Gateway preflight passed for the app, both issuers, Origin enforcement, host-only login cookie, session isolation and logout.'
