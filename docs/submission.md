# Submission

What the assessment asks for in section 11, checked against what is actually
true of the repository right now.

> **Nothing in this document has been sent.** The email below is a draft, and
> sending it is the project owner's step.

---

## What section 11 requires

| # | Requirement | State |
|---|---|---|
| 1 | Push the work to a GitHub repo (private is fine) | **Done** - <https://github.com/YoussefHussein57/Limaz-Assessment>, branch `main` |
| 2 | Invite `tarek-ragab-abdelal` as a collaborator | **Invitation sent** 19 Nov 2026 with `write` permission. **Not yet accepted** - it is still in the repository's pending invitations |
| 3 | Email the repo link to `tragab@limaz.co` by Tue 24 Nov 2026, 23:59 Riyadh | **Not sent.** Draft below |
| 4 | It must run in Docker; one `docker compose up` starts everything | **Verified from a clean clone** in an isolated compose project |
| 5 | A seed fills both companies, their users, API keys, policies and enough sample data | **Verified** - 2 companies, 3 users, 2 keys, 2 differing policies, 12 expenses, 7 rule hits, 3 reviews |
| 6 | A README someone new can understand on its own | Rewritten in F10 for a reviewer opening the repository for the first time |

### One thing to decide before sending

**The repository is PUBLIC.** The assessment allows either ("private is fine"),
so this is not a failure - but it is worth being deliberate about, because the
README publishes three development passwords and two development API keys by
design, so a reviewer can run the stack.

Those credentials grant nothing: they only work against a database the reader
seeds themselves, the seed refuses to run under `NODE_ENV=production` without
an explicit opt-in, and no deployment of this system exists. **Making the
repository private changes no code and nothing about the review** - the
collaborator invitation already grants access. It is a one-click choice, and
the project owner's to make.

---

## Reviewer-access checklist

Run through this immediately before sending the email.

- [ ] `git status` is clean and `git log origin/main..HEAD` is empty
- [ ] The latest commit on `origin/main` is the one you intend to submit
- [ ] <https://github.com/YoussefHussein57/Limaz-Assessment> opens, and the
      README renders - including the two Mermaid diagrams
- [ ] The screenshots in the README display (they are committed under
      `docs/screenshots/`, so they render on the remote too)
- [ ] `tarek-ragab-abdelal` appears under **Settings → Collaborators**, either
      as a collaborator or as a pending invitation. If the invitation has
      expired, re-send it
- [ ] Decide public vs private (see above)
- [ ] From a clean directory: `git clone`, `cp .env.example .env`,
      `docker compose up` - all three containers healthy, and
      `manager@nile-logistics.test` can sign in at <http://localhost:3000>

If the invitation needs re-sending:

> GitHub → the repository → **Settings** → **Collaborators** → **Add people** →
> `tarek-ragab-abdelal` → **Write**.

---

## Draft email

**To:** `tragab@limaz.co`
**Subject:** Software Engineer Assessment - Youssef Hussein

> Hello Tarek,
>
> My submission for the LIMAZ Software Engineer Assessment is ready for review:
>
> **https://github.com/YoussefHussein57/Limaz-Assessment** (branch `main`)
>
> You have been invited as a collaborator.
>
> It is a multi-tenant expense policy service: company backends submit
> expenses with an API key and receive APPROVE, REVIEW or REJECT with every
> rule that fired; managers work through the REVIEW cases and edit their
> company's policy in a dashboard; and a platform administrator creates
> companies, provisions their managers and manages their API keys. NestJS and
> PostgreSQL with Prisma on the backend, Next.js on the frontend.
>
> **The optional card webhook bonus in section 10 is also implemented**, built
> after the mandatory core was finished and verified - the tag `v1.0.0-core`
> marks that point, so the core stands on its own without any of it. Card
> transactions arrive as HMAC-signed webhooks, verified against the raw
> request bytes with a per-company secret, land in a durable PostgreSQL
> inbox, and are processed asynchronously through the same policy engine and
> review lifecycle as an ordinary submission.
>
> So you can see it work without a payment provider or a real card, there is
> a sandbox simulator in the admin panel. It signs a synthetic provider event
> on the server and delivers it over real HTTP to the real endpoint, so the
> actual verifier runs - including for the deliberately invalid and expired
> signature presets, which are refused. No money moves and no card details
> are involved anywhere.
>
> To run it: `cp .env.example .env` then `docker compose up`. That starts
> everything, applies the migrations and seeds two companies with different
> policies, their users, API keys and sample expenses. The web application is
> at http://localhost:3000 and the credentials are in the README.
>
> There are 649 automated tests, 534 of them against real PostgreSQL rather
> than mocks - including four negative controls that remove a mechanism and
> show the failure it was preventing reappear. The README covers how to run
> and test it, how it is put together, my answers to the eight decisions, how
> I would deploy it, and what I would do next. It also lists the limitations I
> chose to accept and why - including the one part of the webhook bonus I
> explained rather than built, which is how you would find an event the
> provider never delivered.
>
> AI_LOG.md records how I used Claude Code and the defects I found and fixed
> along the way, including the ones that were my own mistakes.
>
> There is a five-minute walkthrough near the top of the README if you would
> like the quickest path through the system, and a second one after it for
> the card webhook if you want to see that part.
>
> Thank you for the opportunity - I am happy to go through any part of it with
> you.
>
> Best regards,
> Youssef Hussein

---

## What the email deliberately does not do

- It claims no cloud deployment, no load-tested capacity and no accessibility
  conformance, because none of those were done.
- It contains no password, API key or any other credential. The credentials
  are in the README, where they belong, labelled development-only.
- It does not describe the repository as "complete" without qualification: the
  optional card webhook was not built, and the README says so in its first
  screen.
