# islandsettlers.com — setup, and what your money actually buys

---

## Part 1 — What $5 and $10 a month gets you

Railway bills by what you actually use, at these rates: **$20.01 per vCPU per
month**, **$10.00 per GB of memory per month**, and **$0.05 per GB of network
traffic**.

From the load testing, one running match costs:

| | per match | per match-hour |
|---|---|---|
| Processor | 0.0089 vCPU | $0.00025 |
| Memory | ~20 MB | $0.00028 |
| **Network traffic** | ~11 KB/sec | **$0.00198** |
| **Total** | | **~$0.0025** |

**Network traffic is 80% of the cost**, not the computer. That's worth knowing
because it means the thing that drives your bill is *how many people are
playing*, almost linearly — there's no cliff to fall off.

A match lasts about 3.5 minutes.

### So:

| | What it covers |
|---|---|
| **Idle server, nobody playing** | ~$1–2/month |
| **$5/month** | ~1,400 match-hours ≈ **24,000 complete matches** ≈ **800 matches every day** |
| **$10/month** | ~3,400 match-hours ≈ **58,000 matches** ≈ **1,900 a day** |

Another way to picture it: **500 matches running simultaneously costs about
$1.25 an hour.** So $10 covers roughly 8 hours at absolute full blast — or, far
more realistically, months of a few dozen people playing in the evenings.

Railway's Hobby plan is **$5/month and includes $5 of usage**, so that first
$5 isn't on top — it *is* your allowance.

**Practical take:** set your hard cap at $25. You'd have to be running about
5,000 matches a day to reach it, and if that ever happens you'll want to raise
the cap rather than have the game go offline.

---

## Part 2 — Setting up the domain

You own `islandsettlers.com` at GoDaddy. Here's the plan:

| Address | Points at | What it's for |
|---|---|---|
| `islandsettlers.com` | GitHub Pages | the game |
| `www.islandsettlers.com` | GitHub Pages | redirects to the above |
| `play.islandsettlers.com` | Railway | the multiplayer server |

### Should you move the nameservers to Cloudflare?

**Yes, I'd recommend it** — but it's optional and you can do all of this on
GoDaddy if you'd rather not. Cloudflare is free, the DNS controls are much
easier to get right, changes take effect in seconds instead of hours, and it
gives you somewhere to move the website later without touching anything else.

To move: make a free Cloudflare account, choose "Add a site", enter
`islandsettlers.com`, and it will read your existing records and give you two
nameservers. Paste those into GoDaddy under **My Products → Domain → Manage DNS
→ Nameservers → Change → I'll use my own**. Takes anywhere from minutes to a
few hours to take effect.

**If you'd rather stay on GoDaddy, everything below works exactly the same** —
just add the records in GoDaddy's DNS manager instead.

### The records to add

**For the game (apex domain):** four A records, all with name `@`:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

**For www:** one CNAME record, name `www`, value `otterholte.github.io`

**For the server:** one CNAME record, name `play`, value — *Railway will give
you this*, see below.

> If you use Cloudflare, set the orange cloud to **DNS only (grey)** for the
> `play` record. Proxying a WebSocket game server through Cloudflare's CDN adds
> latency and can cut long-lived connections. The website records can stay
> orange/proxied.

### Then, in three places

**1. GitHub** — Repo → **Settings** → **Pages** → Custom domain → enter
`islandsettlers.com` → Save. Wait for the green check, then tick **Enforce
HTTPS**. (That checkbox can take up to 24 hours to become available — that's
normal.) I've already added the `CNAME` file to the repo, which is the same
thing from the other direction.

**2. Railway** — your project → the service → **Settings** → **Networking** →
**Custom Domain** → enter `play.islandsettlers.com`. Railway will show you the
CNAME target to put in your DNS. Add that record, wait for Railway to show the
domain as active.

**3. Google Play Console** — update the privacy policy URL to
`https://islandsettlers.com/privacy.html`.

### ⚠️ Order matters

I've already pointed the game's code at `wss://play.islandsettlers.com/ws`.

**Do the Railway custom domain and the `play` DNS record BEFORE you push and
deploy.** If the code goes live before that address exists, multiplayer stops
working for everyone until it does. Single player is unaffected either way.

The safe order is: DNS records → Railway custom domain → confirm
`https://play.islandsettlers.com/health` loads in your browser → *then* push.

Once that's done, test with:

```
https://play.islandsettlers.com/health
```

You should see the same JSON you get from the Railway address today.

### Why this was worth doing now

Your Android app has the server address **built into it**. Every phone that has
installed the game is locked to whatever that line said when they installed.
With your own domain in front, changing hosts, adding a second server, or moving
to a different provider entirely becomes a DNS edit that nobody notices. Doing
this while you have no users costs nothing. Doing it after you have users means
broken apps until everybody updates.
