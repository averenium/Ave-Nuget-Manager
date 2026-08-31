#!/bin/sh
# Idempotent Nexus 3 bootstrap: admin password, nuget user, proxy + hosted + group.
set -eu

NEXUS_URL="${NEXUS_URL:-http://nexus:8081}"
ADMIN_NEW="${NEXUS_ADMIN_PASSWORD:-admin123}"
NUGET_USER="${NUGET_USER:-nuget}"
NUGET_PASSWORD="${NUGET_PASSWORD:-nuget}"
AUTH="admin:${ADMIN_NEW}"

apk add --no-cache curl jq >/dev/null

echo "waiting for Nexus at ${NEXUS_URL} ..."
i=0
while [ "$i" -lt 90 ]; do
  if curl -sf "${NEXUS_URL}/service/rest/v1/status" >/dev/null; then
    echo "Nexus is up"
    break
  fi
  i=$((i + 1))
  sleep 4
done
if [ "$i" -ge 90 ]; then
  echo "Nexus did not become ready in time" >&2
  exit 1
fi

change_password() {
  old="$1"
  new="$2"
  code=$(curl -sS -o /tmp/pw.out -w "%{http_code}" \
    -u "admin:${old}" \
    -X PUT "${NEXUS_URL}/service/rest/v1/security/users/admin/change-password" \
    -H "Content-Type: text/plain" \
    --data-binary "${new}")
  if [ "$code" = "204" ] || [ "$code" = "200" ]; then
    echo "admin password set"
    return 0
  fi
  echo "change-password HTTP ${code}: $(cat /tmp/pw.out)" >&2
  return 1
}

login_ok() {
  curl -sf -u "admin:${1}" "${NEXUS_URL}/service/rest/v1/repositories" >/dev/null
}

if login_ok "${ADMIN_NEW}"; then
  echo "admin already uses the lab password"
elif [ -s /nexus-data/admin.password ]; then
  OLD=$(tr -d '\r\n' </nexus-data/admin.password)
  echo "using generated password from /nexus-data/admin.password"
  if ! login_ok "${OLD}"; then
    echo "generated password did not authenticate (UI wizard already completed?)" >&2
    echo "docker compose -f docker/nexus/docker-compose.yml exec nexus cat /nexus-data/admin.password" >&2
    exit 1
  fi
  change_password "${OLD}" "${ADMIN_NEW}"
else
  echo "no admin.password and lab password failed" >&2
  echo "docker compose -f docker/nexus/docker-compose.yml down -v   then up again" >&2
  exit 1
fi

if ! login_ok "${ADMIN_NEW}"; then
  echo "cannot authenticate as admin with NEXUS_ADMIN_PASSWORD=${ADMIN_NEW}" >&2
  exit 1
fi

api() {
  method="$1"
  path="$2"
  shift 2
  curl -sS -o /tmp/api.out -w "%{http_code}" -u "${AUTH}" -X "${method}" \
    "${NEXUS_URL}${path}" \
    -H "Content-Type: application/json" \
    "$@"
}

repo_exists() {
  name="$1"
  code=$(curl -sS -o /dev/null -w "%{http_code}" -u "${AUTH}" \
    "${NEXUS_URL}/service/rest/v1/repositories/${name}")
  [ "$code" = "200" ]
}

create_if_missing() {
  name="$1"
  kind="$2"
  body="$3"
  if repo_exists "${name}"; then
    echo "repo ${name} already exists"
    return 0
  fi
  code=$(api POST "/service/rest/v1/repositories/nuget/${kind}" --data "${body}")
  if [ "$code" = "201" ] || [ "$code" = "204" ]; then
    echo "created ${kind} ${name}"
    return 0
  fi
  echo "create ${name} HTTP ${code}: $(cat /tmp/api.out)" >&2
  return 1
}

create_if_missing "nuget.org-proxy" "proxy" '{
  "name": "nuget.org-proxy",
  "online": true,
  "storage": { "blobStoreName": "default", "strictContentTypeValidation": true },
  "proxy": {
    "remoteUrl": "https://api.nuget.org/v3/index.json",
    "contentMaxAge": 1440,
    "metadataMaxAge": 1440
  },
  "negativeCache": { "enabled": true, "timeToLive": 1440 },
  "httpClient": { "blocked": false, "autoBlock": true },
  "nugetProxy": { "queryCacheItemMaxAge": 3600, "nugetVersion": "V3" }
}'

create_if_missing "nuget-hosted" "hosted" '{
  "name": "nuget-hosted",
  "online": true,
  "storage": {
    "blobStoreName": "default",
    "strictContentTypeValidation": true,
    "writePolicy": "ALLOW"
  },
  "component": { "proprietaryComponents": true }
}'

create_if_missing "nuget-group" "group" '{
  "name": "nuget-group",
  "online": true,
  "storage": { "blobStoreName": "default", "strictContentTypeValidation": true },
  "group": { "memberNames": ["nuget-hosted", "nuget.org-proxy"] }
}'

code=$(api PUT "/service/rest/v1/security/realms/active" --data \
  '["NexusAuthenticatingRealm","NexusAuthorizingRealm","NuGetApiKey"]')
echo "realms HTTP ${code}"

anon=$(curl -sS -u "${AUTH}" "${NEXUS_URL}/service/rest/v1/security/anonymous")
echo "${anon}" | jq '.enabled = true' >/tmp/anon.json
code=$(api PUT "/service/rest/v1/security/anonymous" --data @/tmp/anon.json)
echo "anonymous HTTP ${code}"

user_login_ok() {
  curl -sf -u "${NUGET_USER}:${1}" "${NEXUS_URL}/service/rest/v1/repositories" >/dev/null
}

user_exists() {
  users=$(curl -sS -u "${AUTH}" "${NEXUS_URL}/service/rest/v1/security/users?userId=${NUGET_USER}")
  echo "${users}" | jq -e --arg id "${NUGET_USER}" 'any(.[]; .userId == $id)' >/dev/null 2>&1
}

set_user_password() {
  curl -sS -o /tmp/pw.out -w "%{http_code}" -u "${AUTH}" \
    -X PUT "${NEXUS_URL}/service/rest/v1/security/users/${NUGET_USER}/change-password" \
    -H "Content-Type: text/plain" \
    --data-binary "${1}"
}

create_user() {
  api POST "/service/rest/v1/security/users" --data "$(jq -n \
    --arg id "${NUGET_USER}" \
    --arg pw "${1}" \
    '{
      userId: $id,
      firstName: "NuGet",
      lastName: "Lab",
      emailAddress: "nuget@localhost",
      password: $pw,
      status: "active",
      source: "default",
      roles: ["nx-admin"]
    }')"
}

ensure_user() {
  pw="$1"
  if user_exists; then
    echo "user ${NUGET_USER} already exists"
    if user_login_ok "${pw}"; then
      return 0
    fi
    code=$(set_user_password "${pw}")
    echo "reset ${NUGET_USER} password HTTP ${code} $(cat /tmp/pw.out)"
  else
    code=$(create_user "${pw}")
    echo "create user ${NUGET_USER} HTTP ${code} $(cat /tmp/api.out)"
    case "${code}" in
      201|204) ;;
      *) return 1 ;;
    esac
  fi
  user_login_ok "${pw}"
}

if ensure_user "${NUGET_PASSWORD}"; then
  echo "user ${NUGET_USER} can log in"
elif [ "${NUGET_PASSWORD}" != "${ADMIN_NEW}" ] && ensure_user "${ADMIN_NEW}"; then
  NUGET_PASSWORD="${ADMIN_NEW}"
  echo "password '${NUGET_USER}' rejected by Nexus policy; ${NUGET_USER} / ${NUGET_PASSWORD} works"
else
  echo "failed to create a working ${NUGET_USER} login" >&2
  exit 1
fi

cat <<EOF

Nexus NuGet lab is ready.

  UI:              ${NEXUS_URL}   (admin / ${ADMIN_NEW})
  nuget user:      ${NUGET_USER} / ${NUGET_PASSWORD}
  push:            username/password in nuget.config — no API key

  proxy:           http://localhost:8081/repository/nuget.org-proxy/index.json
  hosted (private):http://localhost:8081/repository/nuget-hosted/index.json
  group:           http://localhost:8081/repository/nuget-group/index.json

Push a private package:
  docker/nexus/push-private.ps1

EOF
