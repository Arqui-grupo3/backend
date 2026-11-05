#!/usr/bin/env bash
# Experimento de span (RF06 / RDOC05): rota el span ciclo a ciclo entre tres valores.
#
# Inserta una versión nueva de strategy_config copiando la vigente y cambiando solo
# span_seconds (ADR AD6: cambio por configuración, sin redeploy). El master congela la
# versión vigente al llegar cada status-statement, así que cada ciclo queda atribuido a
# un solo span. updated_by = 'cron-experimento-span' deja rastro en /config/history.
#
# Instalar en el EC2 (los ciclos abren en :05, :25 y :45; esto corre 5 min antes):
#   chmod +x ~/energyshark/rotar-span.sh
#   (sudo crontab -l 2>/dev/null; echo '0,20,40 * * * * /home/ubuntu/energyshark/rotar-span.sh >> /home/ubuntu/energyshark/rotar-span.log 2>&1') | sudo crontab -
# Detener:
#   sudo crontab -l | grep -v rotar-span.sh | sudo crontab -
set -euo pipefail

SPANS=(120 300 480)
# Un índice distinto cada 20 minutos: ciclos consecutivos usan spans distintos.
idx=$(( ($(date -u +%s) / 1200) % ${#SPANS[@]} ))
span=${SPANS[$idx]}

cd /home/ubuntu/energyshark
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U energyshark -d energyshark -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO strategy_config
      (market_enabled, price_factor, max_quantity, span_seconds, price_decay_minutes, updated_by, note)
    SELECT market_enabled, price_factor, max_quantity, ${span}, price_decay_minutes,
           'cron-experimento-span', 'RF06: rotación de span ciclo a ciclo'
    FROM strategy_config ORDER BY version DESC LIMIT 1;"

echo "$(date -u +%FT%TZ) span=${span}"
