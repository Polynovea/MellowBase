#!/bin/sh
# ExecCondition for polynovea-caddy.service: run Caddy only when POLYNOVEA_DOMAIN is set.
grep -Eq '^POLYNOVEA_DOMAIN=.+' /etc/polynovea/polynovea.env 2>/dev/null
