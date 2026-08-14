# Getting Island Settlers onto the Play Store for real

Checked 12 August 2026. Read the first section before anything else — it is the
thing that will surprise you.

---

## ⚠️ The one that catches everybody

**Internal testing does not count toward being allowed to publish.**

If your developer account is a **personal** account created **after 13 November
2023**, Google requires you to run a **closed** test — **12 testers, opted in
continuously for 14 days** — before you can even *apply* for permission to
publish publicly. Your app being on internal testing does not satisfy this.

**Check which situation you're in first:** Play Console → **Setup** →
**Developer account**. Look at the account type and creation date.

- **Organisation account**, or a **personal account created on or before 13 Nov
  2023** → this doesn't apply to you. Skip to step 2 below.
- **Personal account created after 13 Nov 2023** → you need the 14-day closed
  test, and your realistic timeline to being live is **3–5 weeks**, not days.

Two details worth knowing: the requirement used to be *20* testers and was
lowered to **12 on 11 December 2024**, so any guide saying 20 is out of date.
And Google measures **engagement**, not installs — testers who install and never
open the app again are the single most common reason applications get refused.
Ask your 12 people to actually play it a few times across the fortnight.

Avoid paid "get 12 testers" services. Google's own community guidance calls them
out, and they fail for exactly the engagement reason above.

**Good news:** your app already targets API level 36, so the 31 August 2026
deadline that's about to block a lot of developers isn't a problem for you.

---

## Step 1 — Start the closed test today (if it applies to you)

The 14-day clock is the long pole. Start it now and do everything else while it
runs.

**Test and release → Testing → Closed testing → Create track.** Add 12 email
addresses. They each need to accept the opt-in link and install from Play.

Give it **16–20 days** rather than exactly 14, and apply once you have real
engagement to point at.

---

## Step 2 — Where the screenshots actually are

You're not missing anything — it is not where you'd expect. It is **not** part of
creating a release.

> **Play Console → your app → left sidebar `Grow users` → `Store presence` →
> `Main store listing`** → scroll to **Graphics**.

Screenshots are grouped by device tabs there: Phone, 7-inch tablet, 10-inch
tablet, and so on.

### What you need

| Asset | Size | Format | How many |
|---|---|---|---|
| **App icon** | 512 × 512 px | PNG, 32-bit with transparency, max 1 MB | 1 |
| **Feature graphic** | 1024 × 500 px | PNG or JPEG, **no** transparency | 1 |
| **Phone screenshots** | 1920 × 1080 px works well for a landscape game | PNG or JPEG, no transparency | **minimum 2**, up to 8 — do 4–6 |
| **7-inch tablet** | 16:9, at least 1080 px on the long side | same | up to 8 |
| **10-inch tablet** | 16:9, at least 1080 px on the long side | same | up to 8 |
| **Promo video** | a YouTube link | — | optional, but games convert much better with one |

Tablet screenshots are **not** a hard blocker for publishing, but without them
your game gets downranked or left out of tablet and Chromebook listings
entirely. For a landscape 3D game that's worth doing — and you can reuse the
same captures, since the game is landscape anyway.

You already have a capture rig for this:

```bash
node tools/shoot.mjs --stage=play --w=1920 --h=1080
```

Get shots of: the island mid-match, the board map, a build placement, the trade
screen, and the scoreboard. Avoid adding fake buttons or text overlays that
aren't really in the game — that's a listing violation.

### The text fields

| Field | Limit |
|---|---|
| App name | **30 characters** |
| Short description | **80 characters** |
| Full description | **4,000 characters** |

**Title rules that get listings rejected:** no "Free", no "#1" or "Best", no
ALL CAPS, no emojis, nothing implying a link to another company. So
"Island Settlers" is fine; "Island Settlers — #1 FREE Catan Game!" is three
separate violations. Also: don't put "Catan" anywhere. Your README is careful to
say the game is inspired by the genre and uses no trademarked names — keep the
listing equally careful, because trademark complaints are handled fast and
unsympathetically.

---

## Step 3 — The declarations

**Play Console → your app → `Policy and programs` → `App content`.** Every one
of these must be green before you can submit.

| Declaration | Your answer |
|---|---|
| **Privacy policy URL** | Update it to `https://islandsettlers.com/privacy.html` once your domain is live. Must be a real reachable page — not a Google Doc |
| **App access** | "All functionality is available without special access" — you have no logins |
| **Ads** | No |
| **Content rating** (IARC questionnaire) | See below |
| **Target audience** | You already filed 13+ |
| **Data safety** | Data collected: Name, Device or other IDs, and App activity → Other actions. Collection is optional and used for multiplayer app functionality; the device ID also supports reconnects and security. No advertising, analytics or sale. See the exact answers below. |
| **Advertising ID** | No |
| **Government apps** | No |
| **Financial features** | None of these |
| **Health** | No |
| **News** | No |

Also required, outside App content: **Store settings** (set app type to **Game**
and pick a category — Strategy or Casual), **contact email**, **countries**, and
**pricing** (free — and note you can go paid→free later but **never**
free→paid).

### Content rating — games get more questions than apps

Games are rated by more authorities than ordinary apps: ESRB, PEGI, USK,
ClassInd, plus the **Australian Classification Board** and **GRAC (South
Korea)**, which only apply to games. Answer honestly about violence, purchases,
and player interaction.

Two answers that matter for you specifically:

- **"Does your app allow users to interact or exchange content?"** — **Yes.**
  Your multiplayer lets strangers share a room via a code. Under-declaring this
  is a common rejection cause.
- **Purchases / loot boxes / gambling** — No, none.

### Data safety — exact multiplayer answers

Play defines data as collected when it is transmitted off the device. Keeping
it only in server memory does not make the answer “No.” Multiplayer is optional,
uses encrypted `wss://` transport, and sends:

- **Personal info → Name:** the player-chosen display name.
- **Device or other IDs:** the random app-specific identifier used to restore a
  seat after a reload or connection loss.
- **App activity → Other actions:** live movement, gathering, building and
  trading actions.

Mark each as **collected**, **optional**, and used for **App functionality**.
Mark the device identifier as also used for **Security, fraud prevention and
compliance**. Do not mark advertising, marketing, analytics or personalization.
The data is not sold. Transfers to the hosting provider are service-provider
processing; display names and live actions shown to the room are user-initiated
multiplayer behavior. Use the Console's user-initiated/service-provider sharing
exceptions rather than marking the data as sold or broadly shared.

---

## Step 4 — Before you submit, open the Pre-launch report

**Test and release → Pre-launch report.** Google runs your app on real devices
automatically and most developers never look at it. Fix every crash and ANR it
lists. This is free evidence and it's also what reviewers see.

Given your README notes that frame rate has never been measured on real hardware
and the audio has never actually been heard, this report is the first time you'll
get real-device data. Read it carefully.

---

## Step 5 — Apply for production, then submit

**Dashboard → Apply for production.** Ten questions across three sections: how
you recruited testers, what feedback you got, what you changed, and why it's
ready.

**Write real answers.** The most common failure is one-line replies where 300
characters were allowed. Name actual features, actual bugs you found and fixed,
actual build numbers. You have genuinely good material here — the capacity work,
the verification suite, the balance passes.

Review takes **up to 7 days**. Then the production release itself gets reviewed,
typically **up to another 7 days** for a first-time app.

---

## The rejection list, short version

1. Privacy policy missing, dead, or not actually about your app
2. Data safety answers that don't match what the app does
3. Content rating that doesn't match the app — especially not declaring user interaction
4. Title or screenshots breaking listing rules ("Free", "#1", fake UI in screenshots)
5. Testers who installed but never played
6. Thin answers on the production access form
7. Unfixed crashes sitting in the Pre-launch report

None of these are about code quality. They're all about being consistent and
complete in the paperwork — which is good news, because that part is entirely
under your control.

---

## Realistic timeline from today

| | |
|---|---|
| Closed testing (if it applies) | 14 days minimum, do 16–20 |
| Production access review | up to 7 days |
| First release review | up to 7 days |
| **Total** | **3–5 weeks** |

They're sequential, not parallel. But everything in steps 2–4 can be done while
the testing clock runs, so start the closed test first and fill in the listing
while you wait.
