# Development

Production installs come from a root-owned clone, because root runs the
installer and the code it installs ([setup](setup.md)). Development needs a
checkout you can edit, so it's kept apart and installed only on purpose.

## The layout

| | Where | Owner |
|---|---|---|
| Your development checkout | e.g. `~/repos/omb-webreports` | you |
| The production clone (optional on a dev machine) | `/usr/local/src/omb-webreports` | root |
| The installed program | `/usr/local/lib/omb-webreports` | root |
| Settings, install record, webdata-skills' session | `/etc/omb-webreports/` | root |
| Content: reports, published data, jobs | `/var/lib/omb-webreports` (`DATA_DIR`) | you |

## Working in the checkout

The tools find their code next to themselves and everything else from
`/etc/omb-webreports/config.env`, so you can run them **straight from the
checkout**, as yourself, against the live content:

```bash
cd ~/repos/omb-webreports
bin/webdata-sync --once            # your sync code, against the live data
bin/webdata-check blue-jays-2026   # your checker; the page is served by the installed site
bin/webdata-skills package         # regenerate skills/omb-webreports.openmaus.json after editing skills/
```

What the site *serves* (the front page, `/lib/`, the gallery) and what the
services *run* is the installed copy. To try a change there, install the
checkout:

```bash
sudo ~/repos/omb-webreports/admin/update.sh --from-unsafe-dev
```

That skips git (the checkout is installed as it is), warns, logs the install
as unsafe in the system journal (`journalctl -t omb-webreports`), and records it
in `/etc/omb-webreports/installed.json`; `webdata-info` shows "installed from
… UNSAFE" until the next normal install. It's unsafe because anything that can
write the checkout, including bots running as you, decides what root runs.
`admin/install.sh` and `admin/openmausbot-upgrade.sh` take `--from-unsafe-dev`
too; without it they refuse a source that isn't root-only.

## Testing the installer without root

```bash
bash admin/install.sh --destdir /tmp/omb-test --from-unsafe-dev --yes   # WEBREPORTS_OWNER=you in the environment
bash admin/install.sh --print --destdir /tmp/omb-test --from-unsafe-dev
```

`--destdir` writes the whole system layout (program, settings, content folder,
Apache and systemd files, tool links) under that folder and skips everything
that needs root (packages, ownership, ACLs, services). Point the tools at it
with `OMB_WEBREPORTS_CONFIG=/tmp/omb-test/etc/omb-webreports/config.env` plus
`DATA_DIR`/`PLATFORM_DIR` overrides. Test against a throwaway OpenMausBot
(`openmausbot serve --port 18799 --data-dir /tmp/omb-test-omb`, then
`OMB_URL=http://127.0.0.1:18799`), never your real bots.

## Releasing

Commit and push; production machines then run `sudo …/admin/update.sh` (or
`--ref <tag>`). After editing `skills/`, run `bin/webdata-skills package` and
commit the regenerated package with the skills.
