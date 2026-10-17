# Omarchy kiosk

The user services run the board, a dedicated fullscreen Chromium profile, and a
sleep inhibitor with panel-only rests. They restart after failures and start with
the user's desktop session. These units target the installed Omarchy / Hyprland
Lua API, using `hl.dsp.dpms`.

Install the built app (including production Node dependencies) at
`~/.local/share/service-board/app`, and symlink the Node 24 installation to
`~/.local/share/service-board/node`. Put live configuration, secrets and the
read-only observer kubeconfig in `~/.config/service-board`, mode 0600, in a 0700
directory. The unit filenames show the expected configuration filenames.

Copy the three `.service` files to `~/.config/systemd/user`, reload the user
manager, then enable/start them:

```sh
systemctl --user daemon-reload
systemctl --user enable --now service-board.service service-board-browser.service service-board-display.service
```

The browser uses `http://localhost:8098/?kiosk=1`, which enables small periodic
pixel shifts without clipping the interface. Its profile is separate from the
normal browser. The installed backend listens on IPv4 (`0.0.0.0:8098`) and the
LAN board is available at `http://10.7.1.91:8098/`. Anonymous LAN clients can fetch
the board assets, health probes, status summaries and filtered Checks/Probes in the
diagnostics modal/sidebar. Logs, raw diagnostic evidence,
measurements, internal links, source details, metrics and runtime operations stay
local. Known secrets are redacted from status text. Service names, availability,
mining status, garage relay states and Garmin write age are intentionally visible
to network clients; this is not an authenticated public website.

Omarchy's UFW firewall needs a rule for the local network. Run as the laptop's
administrator (the installer's SSH account has no passwordless sudo):

```sh
sudo ufw allow from 10.7.0.0/16 to 10.7.1.91 port 8098 proto tcp comment 'Service Board LAN'
```

The laptop's OPNsense DHCP reservation is `10.7.1.91` for Wi-Fi MAC
`68:ec:c5:3c:4d:df` (`omarchy-lt`), replacing `10.7.102.91`. Keep NetworkManager
on DHCP. When migrating, add the firewall rule above before renewing the `Phox`
connection with `sudo nmcli connection up uuid 5411a682-df08-4b79-9273-94cbbdd629dc`.
Existing tabs at the old IP must open the new URL; the local kiosk uses localhost.
Unlock codes are saved per origin, so LAN browsers need the existing code again
at the new address. The locked JSON export is
`http://10.7.1.91:8098/api/v1/status/locked`.

The installed Network group includes separate core-router (`10.7.1.1`),
under-stairs AP (`10.7.1.2`), upstairs AP (`10.7.1.3`), and modem (`192.168.1.254`)
cards. The router and APs require ping and TCP 443; the modem uses ping. Each ping
has a one-second timeout and a second attempt after five seconds on loss/latency.
The Managed domains card has one TLS component per domain, initially `phoxis.xyz`:
TCP 443 plus chain/hostname/date validation, no ping, checked every five minutes,
with an expiry warning starting fourteen days before expiry.

Full diagnostics require the configured unlock code, or a loopback socket with
a localhost/loopback Host header while `server.localLock` is `false` (the default).
Set `server.localLock: true` to require the same code locally. Forwarded headers
cannot grant access. LAN locking is always enforced; `remoteAccess: 'full'` is
rejected. These settings control the dashboard UI independently of the OS lock.

The user service loads `~/.config/service-board/unlock.env` (mode 0600), containing
`SERVICE_BOARD_UNLOCK_CODE=<random-code>`. On the Omarchy host, display it with:

```sh
cat ~/.config/service-board/unlock.env
```

Select **Unlock** on the LAN dashboard and enter the code. It is validated by
the backend and remembered in `service-board.unlock-code` in this browser's
local storage. **Lock UI** removes it. Rotate it by editing the environment file
and running `systemctl --user restart service-board.service`; saved old codes
then become invalid. The browser and laptop session lock do not need restarting.
With the environment variable empty or absent, LAN unlocking is disabled.
Localhost still has full access unless `server.localLock: true` is configured.
The current HTTP LAN URL sends the code without transport encryption; use HTTPS
if the network is not trusted.

Theme, compact mode and other saved display preferences are shared by all browsers
and saved in `~/.config/service-board/display-settings.json`. Changes appear on
the next normal status poll. Changing these settings requires full access; locked
clients receive updates automatically. Refresh existing tabs once after the
upgrade. Browser credentials and fullscreen remain local.

The display service keeps the laptop awake (including lid-switch inhibition),
turns off ordinary Omarchy idle behavior, retains 20% Intel-panel brightness,
and locks after **30 minutes without keyboard, mouse or touch activity**.
The first five-minute panel rest starts only after Omarchy confirms that the
Wayland session lock is secure. It then repeats **30 minutes on / 5 minutes off**
while locked. Monitoring and the live browser continue throughout. Input can
wake the panel early but cannot unlock the desktop; the normal account password
is required. A successful unlock starts a fresh inactivity period.

The installed `slyke.lock` plugin is a supported user clone of `omarchy.lock`,
with `kiosk-lock.patch` applied to Omarchy 4.0.3's native lock. It preserves the
native Wayland lock, PAM password verification, rate limiting and crash recovery.
The explicit kiosk mode has a transparent background and a bottom password field.
Normal/manual locks stay opaque. Transparency is selected only for the dedicated
fullscreen `service-board-kiosk` browser on a single display. If another window
opens or the kiosk closes/changes workspace, the lock becomes opaque.

`~/.config/hypr/service-board.lua` enables Hyprland's `session_lock_xray`, loaded
from `hyprland.lua`. This allows rendering beneath a session lock; it does not
grant input to the browser. No remote unlock endpoint or password storage was
added. The lock plugin remains an authentication-capable clone, held privately
by Omarchy's native authentication service store.

Set `KIOSK_ON_SECONDS` (also the unlocked inactivity timeout) and
`KIOSK_OFF_SECONDS` in a systemd override to change the cycle. Quickshell 0.3's
live-timeout notification issue is handled by disabling and re-enabling the
idle monitor across event-loop turns. The display service turns the panel back
on when stopped, **without unlocking it**. This reduces static exposure; it is
not a guarantee against image retention or panel wear.

To reproduce the lock customization, stop the display controller while unlocked,
clone `omarchy.lock` using `omarchy-plugin-clone omarchy.lock`, and apply the
patch with `patch --batch --fuzz=0 -p0 -d ~/.config/omarchy/plugins/$USER.lock -i
/path/to/kiosk-lock.patch`. Parse both QML files with Qt's `qmlformat` before
restarting the shell. Install `kiosk-lock.lua` as `~/.config/hypr/service-board.lua`
and add `require("hypr.service-board")` to `hyprland.lua`. Reload the compositor
configuration, restart the shell while unlocked, install the supplied browser
and display units, then reload systemd and restart those two services. Do not
restart the monitoring backend. A future Omarchy update needs the patch reviewed
against its updated native lock source; do not force a mismatched patch.

Inspect the lock and timer with:

```sh
omarchy-shell lock status
cat ~/.local/state/service-board/display.json
journalctl --user -u service-board-display.service -n 20
```

The controller's timing/security regressions run with
`python3 tests/test_display_cycle.py -v`. They cover inactivity, confirmation of
the compositor lock before blanking, continued locking on wake, password unlock,
and deferring screen rest while password authentication is in progress.

```sh
systemctl --user status service-board{,-browser,-display}.service
systemd-inhibit --list
curl -fsS http://localhost:8098/readyz
journalctl --user -u service-board.service -n 30
```

To return to a normal desktop, stop/disable the browser and display units and run
`omarchy-toggle-idle allow-idle`. Re-enable notification popups with
`omarchy-shell notifications setDnd false` if desired. Stopping only the display
unit leaves Omarchy's stay-awake preference enabled deliberately.

## Installed monitoring semantics

- Bitaxe requires increasing accepted-share counters before reporting pool
  connectivity. No new shares for 3 minutes warns; 10 minutes fails. Zero hash
  rate, paused mining, or overheat fails. Restarts require fresh share evidence.
- Garmin checks timestamped successful InfluxDB writes in importer logs, plus
  importer and database workload health. It warns at 20 hours and fails at 24
  hours. A recent poll alone is not proof of a write. Missing or inaccessible
  evidence reports unknown. This observes importer-confirmed writes, not direct
  database row contents.
- Garage observes only POWER3 through live Tasmota telemetry and immediate
  `stat/.../POWER3` publications, never publishes commands, and treats ON and OFF
  as valid states. Every MQTT event is processed, including pulses shorter than
  the five-second check interval. Last observed change is saved in
  `~/.local/state/service-board/garage-power3.json` and rendered as
  `yyyy-mm-dd hh:mm:ss` in each browser's timezone. First observation and
  retained replay never invent a change time. After a disconnect, an altered
  state has an unknown change time until a subsequent live change. Unchanged
  reconnects preserve the last observed change. The installed monitor uses
  `warningAfterSeconds: 720` and `criticalAfterSeconds: 1080` (12/18 minutes);
  reusable module defaults remain 10/15 minutes. An MQTT helper failure reports
  observer unavailability explicitly. The device at `10.7.102.208`, topic
  `tasmota_C91575`, reports POWER1 through POWER4: it is the four-output garage
  controller, not the eight-output Tesla indicator. The shared MQTT account reads the controller's exact
  STATE, LWT and POWER3 topics plus the three Z-Wave battery-monitor topics.
- Kubernetes workload checks follow owner references so pod replacement does
  not break monitoring. Large resource pages shrink to stay within response
  byte limits. A lifetime restart count at or above `restartWarning` (default 5)
  warns only when the last restart was within `restartWarningWindow` (default
  `1h`). It clears after an hour without another restart. This is not a count
  of restarts within that hour: Kubernetes exposes only a cumulative count and
  the latest termination. Missing restart timestamps do not prove recent trouble.
  Readiness failures and current crash loops still report regardless of age.
- Nodes have two combined cards: Masters and Workers, with one component square
  per node. Each master combines ping and TCP 6443: both must pass for green,
  a partial failure is yellow, and both failing is red. Workers use ping alone.
  Pings wait up to one second for a reply. The installed node checks warn at
  one-second average latency. Packet loss or elevated latency triggers one retry after a five-second
  pause; only the second result is published. Healthy pings return immediately.
  Each node check has a 20-second timeout to fit two bounded ping attempts plus
  the pause. API port failures still affect master squares independently.
  These check network reachability, not the Kubernetes Node Ready condition.
- Z-Wave batteries observes Laundry HVAC LCD through the existing MQTT source.
  It reads only battery level, last-active time, and gateway status; temperature
  and motion sensors are excluded. Battery level warns at 30% and fails at 10%
  (or the Z-Wave 255 low-battery sentinel). Producer timestamps survive retained
  replay: reports warn at 14 days and become unknown at 30 days. Device silence
  warns at 48 hours and becomes unknown at 7 days. Gateway/MQTT loss is unknown.
  No device polling or commands are published. The battery report timestamp
  uses the browser's timezone. These are configurable monitoring thresholds,
  not manufacturer guarantees about remaining battery runtime.
- Servarr groups its eight deployments; MCP groups the four deployments in
  `mcps`; documents groups Nextcloud, Paperless and SilverBullet plus their
  namespace support deployments. rem-conn groups MeshCentral and Syncthing;
  TeslaMate groups the app, PostgreSQL and Grafana. Jellyfin has its own card.

Private home configuration and credentials are kept out of Git in `.local/`
and on the laptop. The deployment uses the HA Kubernetes IP with the original
TLS server name and CA validation, so the laptop does not require a hosts-file
alias.
