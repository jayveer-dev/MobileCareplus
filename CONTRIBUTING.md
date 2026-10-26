# Contributing to Mobile Care Plus

Thanks for wanting to help. Mobile Care Plus is free and open source, and it gets better through
people who try it on their own phones, report what happens, and send improvements.

## Report a bug

Open an [issue](../../issues/new/choose) with the **Bug report** form. The most useful reports include:
- the Mobile Care Plus version and your Windows (or macOS) version,
- your phone model and its iOS or Android version,
- what you did, what you expected, and what happened instead,
- a screenshot, if it helps.

Before attaching a screenshot, hide anything personal: names, phone numbers, photos, chats.

## Tell us how it works with your phone

Phones differ a lot. A quick "works with my Pixel 9 on Android 15" or "Photos don't load on my
iPhone 13" helps more than you'd think. Use the **Bug report** form and pick the area that applies.

## Suggest a feature

Use the **Feature idea** form. Tell us what you're trying to do rather than how the button should
look; that helps us find the simplest way to get you there. See the README's
[Upcoming features](README.md#upcoming-features) for what's already planned.

## Contribute code

1. Set up the app from source: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
2. For anything bigger than a small fix, open an issue first so we can agree on the approach.
3. Fork the repository and make your change on a branch.
4. Make sure `npm test` and `npm run typecheck` pass, and add tests for new logic.
5. Open a pull request. Say what changed, why, and how you tested it, including which phones (model
   and system version) you tried it with.

A few rules that keep the app trustworthy:
- **Ask before changing a phone.** Anything that writes to, deletes from or restores to a phone
  needs a clear confirmation first, and should prefer reversible actions (like the phone's Trash).
- **No internet.** The app doesn't connect to the internet; changes shouldn't add network access,
  analytics or tracking.
- **Never store secrets.** Backup passwords and WhatsApp keys are used in memory for one job only.
- **No personal data in the repository.** Tests, fixtures and screenshots use made-up data only.
- **Say what's not possible.** If a phone doesn't allow something, the app says so plainly instead
  of offering a button that can't work.

By contributing, you agree that your contribution is licensed under the project's
[GPL-3.0-or-later](LICENSE) license.

## Be kind

Be respectful and patient with everyone here. Harassment or personal attacks aren't welcome and
will be removed.

## Security issues

If you find something that could put people's data at risk, don't post the details in a public
issue. Use **Report a vulnerability** on the repository's **Security** tab, which reaches us privately.
