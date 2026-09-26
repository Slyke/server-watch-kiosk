# Local protocol lab

This lab runs all six example modules through the real board. MQTT and Postgres are local services; the other endpoints produce clearly synthetic values. No endpoint points at an external service or physical device.

From the repository root:

```sh
docker compose -f examples/lab/compose.yml build board
docker compose -f examples/lab/compose.yml up -d --wait
# http://localhost:8131
curl -f http://localhost:8131/livez
curl -f http://localhost:8131/readyz
docker compose -f examples/lab/compose.yml logs --tail=50 board
```

Set `EXAMPLES_PORT` to use another host port. The board is in live mode to exercise actual workers and helpers; its **Protocol lab** service groups and this configuration identify its synthetic data. The seven cards should become healthy within a few polls. Modbus/MQTT read 42.5, the queue metric is 42, and the database heartbeat is refreshed every three seconds.

The Postgres reader role has SELECT only. A separate fixture process writes the heartbeat. The MQTT fixture publishes retained, timestamped synthetic telemetry. The anonymous broker and lab database are only accessible on the Compose network; their ports are not published. Credentials in `secrets.example.json5` and the SQL initializer are public lab-only values.

## Observe an outage and recovery

```sh
docker compose -f examples/lab/compose.yml stop fixtures
# HTTP/GraphQL/Modbus/Prometheus become unknown; MQTT expires.
# Postgres freshness first degrades and then fails as its heartbeat ages.
curl -f http://localhost:8131/livez
curl -f http://localhost:8131/readyz
docker compose -f examples/lab/compose.yml start fixtures
```

The probes remain successful while monitored fixtures fail: the board is still able to display the outage. This is different from readiness of an application that requires a working database to serve requests.

## Stop and reset

```sh
docker compose -f examples/lab/compose.yml down
```

Postgres uses tmpfs, so stopping its container discards all lab data. Starting again recreates the schema. There is no production data or persistent volume to preserve.

## Editing modules

The plugin directory is mounted read-only into the board, while remaining editable on the host. Use **Options → Reload modules** after editing, or watch top-level module files. Manual reload is needed for shared `plugins/lib/` files. Config changes require a restart. The fixture server intentionally supports only the response shapes needed by these examples; it is not a full Prometheus server or general-purpose Modbus simulator.
