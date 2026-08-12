# Island Settlers — what changed, and what to do next

Written 12 Aug 2026, in plain language. The technical version is `SCALING.md`.

---

## What was wrong

Your server had a limit written into it: **6 matches at once, which is 24
players.** Player 25 was turned away. That number was chosen years ago for a
much smaller machine and never revisited — it had nothing to do with the
computer you're actually running on, which was sitting at about 3% busy when
it started refusing people.

Worse, when the server got genuinely busy it didn't slow down gracefully. It
started **shutting down games that were already being played** to free up
space. So a rush of new players would have knocked existing players out of
their matches.

## What's fixed

**1. The ceiling now comes from the machine.** The server measures how much
computer it actually has when it starts up and works out how many games that
can hold. On your current Railway setup that's roughly **150–200 players
instead of 24**. If you give it a bigger machine, the number goes up on its
own — nothing to edit.

**2. A busy server turns away new games, never running ones.** If things get
tight it stops accepting *new* matches and tells those players "the server is
full right now, try again in a minute." Games in progress are left alone.
That's the important one.

**3. Nobody can flood it.** There was no limit on how many rooms one person
could create — a simple script could have filled every slot you own. Now
capped.

**4. A slow memory leak is closed.** Two cleanup routines had been written but
were never actually being run, so every abandoned lobby and every visitor who
ever connected stayed in memory until the server restarted. They run now.

All 51 of your existing tests still pass, and I load-tested it with 48
simultaneous matches (192 players) running perfectly smoothly.

---

## Step 1 — Put it live

The changes are sitting in your project folder but aren't live yet. Railway
redeploys automatically when you push to GitHub, so publishing them means
committing and pushing.

**I can do this for you — just say so.** Or if you'd rather do it yourself,
it's three commands in the project folder:

```bash
git add .
git commit -m "Size match capacity to the machine; shed new matches under load"
git push
```

Railway picks it up within a minute or two.

**To check it worked**, open this in your browser:

```
https://island-settlers-production.up.railway.app/health
```

You should see `"matchCap"` showing a number far larger than 6, and
`"full": false`. That page is now your dashboard — if players ever complain,
look there first. `"full": true` means the server is at capacity.

---

## Step 2 — Set a spending cap (5 minutes)

This is what makes a surprise bill impossible.

1. Go to **railway.app** and sign in.
2. Click your **workspace name** (top left) → **Usage**.
3. Find **Usage Limits**. There are two boxes.
4. Set the **soft limit** to something like **$10** — this just emails you.
5. Set the **hard limit** to something like **$25**.

Railway will email you at 75%, 90%, and 100% of the hard limit.

**The one thing to understand:** at 100%, Railway *takes your game offline*
rather than charging more. That's the trade — you can't be surprised by a
bill, but you can be surprised by downtime. Given you have no users yet, a $25
hard cap is very safe. Your realistic bill right now is about **$5/month**.
If you ever get the two warning emails, that means people are genuinely
playing, and raising the cap is a good problem to have.

---

## Step 3 — Get your domain

Buy a domain name (~$10–12/year). Good places: **Cloudflare Registrar** (sells
at cost, cheapest), **Porkbun**, or **Namecheap**. Something like
`islandsettlers.com` if it's available.

**Then tell me the name and I'll do the rest.** For reference, what I'd set up:

- `islandsettlers.com` → your game (currently on GitHub Pages)
- `play.islandsettlers.com` → your multiplayer server (currently Railway)

### Why this matters more than it sounds

Your Android app has your server's Railway address **built into it**. Every
copy already installed on a phone will keep dialling that exact address
forever. So today, if you ever changed hosting companies, every installed app
would break until each person updated it — and app updates aren't instant or
guaranteed.

Once the server lives at `play.islandsettlers.com`, that address is *yours*.
Changing hosts later becomes a five-minute settings change that nobody
notices. **Doing this while you have no users costs nothing. Doing it after you
have users is genuinely painful.**

It also means the answer to "should I move off GitHub Pages?" stops mattering —
you can move whenever you like, and your address never changes.

---

## What I'd leave alone for now

- **Don't move to a cheap bare server** (Hetzner and similar). Cheaper on
  paper, but you'd be personally responsible for security patches, restarts at
  3am, and certificate renewals. Only worth it if the bill ever reaches a few
  hundred a month.
- **Don't rebuild anything for scale yet.** The next real step up — splitting
  across several servers so a crash or an update doesn't interrupt everyone —
  is a couple of weeks of work and buys nothing until you have hundreds of
  people playing at once. It's written up in `SCALING.md` for when that day
  comes.
