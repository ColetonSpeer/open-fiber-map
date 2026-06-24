# Building the Open Fiber Map iOS app (TestFlight)

The app is a [Capacitor](https://capacitorjs.com/) wrapper around the existing
`frontend/`. The web layer is bundled into a native iOS shell; at runtime it
talks to your backend at the **Server URL** you enter on the login screen
(Settings → ⚙ Server). Bundle id: **`com.hky.openfibermap`**.

> **You build/sign/upload on a Mac or a macOS CI runner.** Everything else
> (the project, icons, config) is already done in this repo on Linux.

---

## One-time Apple setup (do in a browser — no Mac needed)

1. **Apple Developer Program** — enroll at <https://developer.apple.com/programs/>
   ($99/yr). Organization (needs a D-U-N-S number) is best for a company app;
   Individual is faster if it's just you.
2. **App ID** — Certificates, Identifiers & Profiles → Identifiers → register
   `com.hky.openfibermap`.
3. **App Store Connect record** — <https://appstoreconnect.apple.com> → My Apps →
   ➕ → New App → platform iOS, bundle id `com.hky.openfibermap`, pick a name + SKU.
4. **TestFlight internal group** — in that app → TestFlight → Internal Testing →
   create a group, add testers (they must be Users in App Store Connect). Internal
   testers (≤100) need **no review** and get builds within minutes.
5. **App Store Connect API key** (for CI uploads) — Users and Access → Integrations
   → App Store Connect API → ➕. Role: App Manager. Download the `.p8` **once**.
   Note the **Key ID** and **Issuer ID**.

---

## Option A — First build on a Mac (recommended to start)

Do the very first build interactively to shake out signing, then switch to CI.

```bash
# on a Mac with Xcode installed
git clone https://github.com/ColetonSpeer/open-fiber-map.git
cd open-fiber-map
npm ci
npx cap sync ios          # installs pods, copies web assets
npx cap open ios          # opens Xcode
```

In Xcode:
1. Select the **App** target → Signing & Capabilities → check **Automatically
   manage signing**, pick your **Team**. Xcode creates the cert + profile.
2. Set the build's version/build number if prompted.
3. Product → **Archive** → when done, **Distribute App** → **App Store Connect**
   → **Upload**.
4. The build appears in App Store Connect → TestFlight after processing (a few
   minutes). Add it to your Internal group; testers install via the **TestFlight**
   app on their iPhone/iPad.

---

## Option B — Automated builds via GitHub Actions (no Mac required)

The workflow `.github/workflows/ios.yml` builds, signs, and uploads to TestFlight
on a hosted macOS runner. Trigger it from the **Actions** tab (Run workflow) or by
pushing a tag like `v1.0.1`.

### Secrets to add (Settings → Secrets and variables → Actions)

| Secret | What it is / how to get it |
| --- | --- |
| `APPLE_DEVELOPMENT_TEAM` | Your 10-char Team ID (App Store Connect → Membership). |
| `ASC_KEY_ID` | The API Key ID from step 5 above. |
| `ASC_ISSUER_ID` | The API Issuer ID from step 5 above. |
| `ASC_KEY_P8_BASE64` | `base64 -i AuthKey_XXXX.p8` of the downloaded `.p8`. |
| `BUILD_CERTIFICATE_BASE64` | base64 of your **Apple Distribution** cert as a `.p12` (see below). |
| `P12_PASSWORD` | The password you set when exporting the `.p12`. |

> The `-allowProvisioningUpdates` flag plus the API key let the runner create/refresh
> the provisioning profile automatically, so you don't manage `.mobileprovision`
> files by hand.

### Getting the distribution certificate as a `.p12`

Easiest on a Mac (Keychain Access → export your "Apple Distribution" identity as
`.p12`). Without a Mac, generate it once via the Developer portal + `openssl`:

```bash
# create a key + CSR, upload Distribution.csr in the portal, download distribution.cer
openssl req -new -newkey rsa:2048 -nodes -keyout dist.key -out Distribution.csr \
  -subj "/CN=Open Fiber Map Distribution/O=HKY"
# after downloading distribution.cer from the portal:
openssl x509 -in distribution.cer -inform DER -out dist.pem -outform PEM
openssl pkcs12 -export -inkey dist.key -in dist.pem -out distribution.p12   # set a password
base64 -i distribution.p12        # -> BUILD_CERTIFICATE_BASE64
```

These `.p12`/`.p8`/`.cer` files are git-ignored — never commit them.

---

## Day-to-day

- **Change the app** — edit `frontend/` (or backend) as usual and deploy the web app
  like always. For the native app, the bundled copy updates on the next build
  (`npx cap sync ios` runs in CI).
- **Re-release** — TestFlight builds **expire after 90 days**. Push a new `v*` tag
  (or run the workflow) to ship a fresh build.
- **App icon** — edit `scripts/make-icons.js` (or drop a 1024×1024 `assets/icon-only.png`)
  then run `npm run icons`, commit, rebuild.
- **Server URL** — testers set it in-app (login screen → ⚙ Server). LAN IP today;
  a VPN/public HTTPS URL later. Once the backend is HTTPS-only, tighten the ATS
  exception in `ios/App/App/Info.plist` from `NSAllowsArbitraryLoads` to a specific
  `NSExceptionDomains` entry.

## Offline (Phase 4 — not in this build)

This build needs a connection to the server for map data and tiles. True
field-offline (cached data, offline map tiles, offline editing) is a separate,
larger phase tracked in the project plan.
