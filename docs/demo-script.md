# 90-second demo script

## Before you record

```bash
npm install
npm run build && npm start          # port 3000, production build
```

Checklist:

- [ ] Browser at **1440 × 900**, zoom 100%, bookmarks bar hidden
- [ ] "Demo story" checkbox is **ticked** (it is by default)
- [ ] Scene selector on **"Morning: which bus do I take at RiverFront?"**
- [ ] Campus destination on **Science Hill**
- [ ] Theme set to **Light** (more legible after video compression than Auto)
- [ ] Hit **Reset scene** immediately before the take, so the demo clock starts at 08:03
- [ ] Notifications silenced; no other tabs visible
- [ ] If you have a `GOOGLE_API_KEY`, confirm the header reads **Live Gemma · gemma-4-31b-it**.
      If you don't, it reads **Deterministic Demo** — say so out loud rather than glossing over
      it. Judges reward the honesty and every number is identical either way.

Each scene begins at a fixed clock and then runs forward in real time. Countdowns are genuinely
live, so don't pause mid-take for more than a few seconds.

---

## 0:00–0:12 — The commute, and why it's two problems

> "I commute from Scotts Valley to UCSC. The 35 gets me downtown — but that's only half of it.
> Then I still have to choose the 11, the 18 or the 19."

**On screen:** the map. Point at the long blue Route 35 line coming down Highway 9, then at the
three dashed campus loops. Point at markers **2** and **1** — two different boarding areas about
a hundred metres apart.

> "These are three separate stops, not one. That walk between them is the whole problem."

---

## 0:12–0:30 — Ask, and watch Gemma work

Click the first suggestion chip: *"I'm on the 35 from Scotts Valley. Which bus should I transfer
to for campus?"*

> "Gemma calls transit tools — it doesn't guess. It builds the journey, then compares the
> campus routes using the same transfer time."

**On screen:** the recommendation card appears — **35 → RiverFront · then take the 11**, with
*Route 11 vehicle updated 34s ago* and a live countdown.

---

## 0:30–0:45 — Why the 11, and when it isn't

Scroll to **11 vs 18 vs 19**. Expand *"Why it scored…"* on the 11.

> "Every term is in seconds, so I can read the reasoning. The 11 wins on arrival time. My saved
> note that it feels less crowded is worth ninety seconds — it breaks ties, it can't overrule a
> better bus."

Click scene **"Morning, harder: the 11 never turned up."** Click the second suggestion chip.

> "This is the gamble I actually live with. It's 8:22 and the 8:20 eleven never appeared. The
> next 11 isn't until 8:50 — so CruzSync takes the 19 it can actually see. Notice it never says
> 'cancelled'. It says no vehicle position is visible, because that's all the feed knows."

---

## 0:45–1:02 — The evening gap

Click scene **"Evening: 48 minutes downtown before the 35."**

> "Going home, the 35 drops to hourly after eight. That's a 48-minute hole — and that number
> comes from the real timetable, not from me."

Click the suggestion chip: *"The next 35 is ages away — where can I hang out without missing
it?"*

---

## 1:02–1:18 — Give the wait back

**On screen:** the wait panel.

> "Thirty-eight usable minutes. Verified walk back, real opening hours, and a hard leave-by
> time."

Point at the ruled-out disclosure.

> "Eight places were rejected — closing too early, or hours it couldn't verify. If CruzSync
> can't confirm somewhere is open, it won't send me there."

Point at the amenity chips.

> "And it says 'unknown' instead of guessing. It won't invent step-free access."

Click **Wait here**, then scroll to the notification previews.

> "Two alarms — wrap up, then leave now. It rechecks the bus before each one."

---

## 1:18–1:30 — Evidence, and the close

Scroll to **How Gemma reasoned**.

> "Every tool call, its arguments, its source, its timestamp. Sanitised — no chain-of-thought.
> And the deterministic engine does all the arithmetic, so if the model goes down the
> recommendation doesn't change."

Scroll to the civic panel.

> "Every time the data fails a rider, that's recorded — anonymously. CruzSync doesn't just tell
> me when the bus comes. **It gives me my waiting time back.**"

---

## Fallbacks if something misbehaves

| If | Do |
|---|---|
| The agent call is slow | Keep talking over it; the tool trace appearing *is* the story |
| Live Gemma errors mid-take | Don't cut. The card says "Gemma failed — deterministic fallback" and the recommendation is unchanged. Say that out loud: it's the resilience point |
| Map tiles are slow | They're OpenStreetMap tiles over the network. Pre-load the page once before recording so they're cached |
| A countdown reaches zero | Click **Reset scene** and re-take from the scene boundary |
| You want live data | Untick "Demo story" — but don't script around it; live METRO may legitimately have nothing useful at that moment, and CruzSync will say so |

## Recording checklist

- [ ] Under 90 seconds
- [ ] The two legs are visually distinct in the first 12 seconds
- [ ] A tool trace is visible on screen at least once
- [ ] The Live/Demo badge is legible in at least one frame
- [ ] The leave-by countdown is on screen for at least 3 seconds
- [ ] The words "not affiliated with Santa Cruz METRO" appear in the footer or are said aloud
- [ ] Audio has no background noise; captions or a transcript are supplied
- [ ] Exported at 1080p or better
