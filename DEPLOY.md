# Running KevCal somewhere that is always on

KevCal *is* the machine it runs on. Your phone only ever loads a page the server
is serving — there is no copy of the app or your data on the phone. So if the
host sleeps, KevCal is gone until it wakes.

This is the guide for moving it off your laptop.

---

## First: do you actually need this?

| | |
|---|---|
| **Laptop with you, awake** | A tunnel is enough. `cloudflared tunnel --url http://localhost:4321`, set `KEVCAL_TOKEN`, done. No server, no monthly cost. |
| **Laptop at home, lid open, on power** | Also enough. System Settings → Battery → Options → *Prevent automatic sleeping when the display is off*. Closing the lid still sleeps it. |
| **Neither reliable** | Read on. A $5/month VPS or a Raspberry Pi on your desk. |

If capture-at-the-moment is the thing you actually want, note that the iOS
Shortcut works from anywhere the server is reachable — so "always on" and
"reachable from the street" are the same problem, solved once.

## What you give up by leaving macOS

KevCal reads a page twice: once with the model, once on-device with Apple's
Vision framework. The second read is what supplies **pixel-accurate boxes** for
the "where did this come from" overlay, and it is the **offline fallback** when
the reader is unavailable or over budget.

Neither exists on Linux. Concretely:

- **Provenance still works, but boxes come from the model.** Gemini returns them
  natively and is good at it; OpenAI is measurably weaker
  (1.5 vs 13.3 mAP on RF100-VL). On a Linux host, prefer Gemini.
- **The cross-check still works.** It re-reads the model's own quoted text with
  the deterministic grammar and compares weekday, year and date — none of that
  needs OCR. The strongest safety rule survives the move intact.
- **There is no fallback.** If the key is wrong, the budget is spent or the
  network is down, an imported photo yields nothing. `npm run doctor` says so.

That is the whole trade. It is smaller than it sounds, but it is real.

---

## A small VPS, start to finish

Any $5/month box with 1 GB of RAM is plenty. KevCal has no dependencies, no
build step and no database server.

### 1. A user that owns nothing else

```bash
sudo adduser --system --group --home /opt/kevcal kevcal
sudo mkdir -p /opt/kevcal && sudo chown kevcal:kevcal /opt/kevcal
```

### 2. Node 22.5 or newer

`node:sqlite` needs it. Check with `node -v`; most distro packages are older, so
use nodesource or a tarball.

### 3. The code

```bash
sudo -u kevcal git clone <your repo> /opt/kevcal
cd /opt/kevcal
sudo -u kevcal cp .env.example .env
sudo -u kevcal chmod 600 .env
sudo -u kevcal nano .env
```

Minimum for a public host:

```ini
GEMINI_API_KEY=...            # or OPENAI_API_KEY
KEVCAL_MONTHLY_BUDGET=5       # cannot be raised from the browser
KEVCAL_TOKEN=                 # openssl rand -base64 24
KEVCAL_HOST=127.0.0.1         # the proxy is the only thing that talks to it
KEVCAL_TRUST_PROXY=1          # believe X-Forwarded-For / -Proto
```

`KEVCAL_HOST=127.0.0.1` and `KEVCAL_TRUST_PROXY=1` belong together. Trusting
forwarded headers while also listening on a public interface lets anyone claim
any IP, which defeats the rate limiter.

### 4. Check before you start

```bash
sudo -u kevcal npm run doctor
```

It refuses to pass on a public bind with no token, an unwritable data directory,
or a world-readable `.env`. The systemd unit runs it too, so a broken config
fails to start rather than starting unsafely.

### 5. Service

```bash
sudo cp deploy/kevcal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kevcal
journalctl -u kevcal -f
```

Edit `TZ=` in the unit first. A server left on UTC exports calendar times in the
wrong hour, and nothing will warn you except a meeting you turn up late to.

### 6. HTTPS

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # set your hostname
sudo systemctl reload caddy
```

Caddy gets a certificate on its own. Now open
`https://kevcal.example.com/?k=YOUR_TOKEN` once on your phone — the token moves
into a cookie and the URL can be forgotten. Add to Home Screen.

**No domain?** Use a tunnel instead and skip Caddy entirely:

```bash
cloudflared tunnel --url http://localhost:4321
```

Nothing is exposed, no ports are opened, no certificate to manage. Keep
`KEVCAL_TRUST_PROXY=1` — cloudflared sets the same headers.

---

## Afterwards

**Back up one directory.** Everything is in `/opt/kevcal/data`: the SQLite file
and the original images. Stop the service first so SQLite is not mid-write.

```bash
sudo systemctl stop kevcal
sudo tar czf ~/kevcal-$(date +%F).tar.gz -C /opt/kevcal data
sudo systemctl start kevcal
```

**Updating.**

```bash
cd /opt/kevcal
sudo -u kevcal git pull
sudo -u kevcal npm test
sudo systemctl restart kevcal
```

Schema changes are additive and run themselves at startup.

**Rotating the token.** Change it in `.env`, restart, and visit `/?k=` once with
the new value on each device. Old cookies stop working immediately.

---

## Checklist before you trust it with real post

- [ ] `npm run doctor` is all clear
- [ ] `KEVCAL_TOKEN` is long, and the link works from a device that has never seen it
- [ ] Opening the site **without** `?k=` gives the lock screen, not your dates
- [ ] `KEVCAL_MONTHLY_BUDGET` is set, and a cap exists at the provider too
- [ ] Gemini billing is attached, or you have accepted that the free tier trains
      on what you send (see README)
- [ ] `TZ` is right — import a timed event and check the `.ics` lands at the
      right hour
- [ ] One backup has been taken and you have opened the tarball to confirm it
